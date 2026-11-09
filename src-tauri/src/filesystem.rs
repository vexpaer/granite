use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use sha2::{Digest, Sha256};
use uuid::Uuid;
use walkdir::WalkDir;

use crate::error::{HostError, HostResult};
use crate::models::{
    ImportedBook, LibraryRoot, MigrationIssue, MigrationProgress, MigrationReport, ScannedFile,
    WrittenBook,
};
use crate::paths::{
    ensure_within, extension_set, format_from_path, relative_path_string, require_filesystem_root,
    safe_existing_file, safe_new_file, safe_relative_path, sanitize_filename,
};

pub const MAX_IPC_FILE_BYTES: u64 = 512 * 1024 * 1024;

pub fn sha256_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub fn sha256_file(path: &Path) -> HostResult<String> {
    let mut file = File::open(path)
        .map_err(|error| HostError::io("failed to open file for checksum verification", error))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| HostError::io("failed while reading file checksum", error))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

pub fn read_file(path: &Path) -> HostResult<Vec<u8>> {
    let metadata =
        fs::metadata(path).map_err(|error| HostError::io("failed to inspect file", error))?;
    if metadata.len() > MAX_IPC_FILE_BYTES {
        return Err(HostError::Unsupported(format!(
            "file is {} bytes; the native JSON bridge limit is {MAX_IPC_FILE_BYTES} bytes",
            metadata.len()
        )));
    }
    fs::read(path).map_err(|error| HostError::io("failed to read file", error))
}

pub fn scan_root(root: &LibraryRoot) -> HostResult<Vec<ScannedFile>> {
    let safe_root = require_filesystem_root(root, false)?;
    let supported = extension_set();
    let mut files = Vec::new();

    for entry in WalkDir::new(&safe_root.canonical_path)
        .follow_links(false)
        .into_iter()
    {
        let entry = entry.map_err(|error| {
            HostError::Storage(format!(
                "library scan failed while traversing root: {error}"
            ))
        })?;
        let file_type = entry.file_type();
        if file_type.is_symlink() || !file_type.is_file() {
            continue;
        }
        let path = entry.path();
        let Some(format) = format_from_path(path) else {
            continue;
        };
        let canonical = fs::canonicalize(path).map_err(|error| {
            HostError::io(
                format!(
                    "failed to validate '{}'",
                    relative_path_string(&safe_root.canonical_path, path)
                        .unwrap_or_else(|_| "a library file".into())
                ),
                error,
            )
        })?;
        ensure_within(&safe_root.canonical_path, &canonical)?;
        let metadata = fs::metadata(&canonical)
            .map_err(|error| HostError::io("failed to inspect scanned file", error))?;
        let relative_path = relative_path_string(&safe_root.canonical_path, &canonical)?;
        let name = canonical
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| HostError::InvalidArgs("library file name is not valid Unicode".into()))?
            .to_owned();
        if supported.contains(format) {
            files.push(ScannedFile {
                name,
                relative_path,
                size: metadata.len(),
                format: format.to_owned(),
            });
        }
    }
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(files)
}

pub fn import_book(root: &LibraryRoot, filename: &str, bytes: &[u8]) -> HostResult<ImportedBook> {
    if bytes.is_empty() {
        return Err(HostError::InvalidArgs(
            "refusing to import an empty book file".into(),
        ));
    }
    let safe_name = sanitize_filename(filename)?;
    let relative_path = format!("books/{}/{}", Uuid::new_v4(), safe_name);
    let target = safe_new_file(root, &relative_path)?;
    let hash = sha256_bytes(bytes);
    let temporary = write_temporary_verified(target.parent().expect("safe target parent"), bytes)?;
    let result = commit_new(&temporary.path, &target);
    if let Err(error) = result {
        cleanup_temporary(&temporary);
        return Err(error);
    }

    let written_hash = sha256_file(&target)?;
    if written_hash != hash {
        let _ = fs::remove_file(&target);
        return Err(HostError::Storage(
            "checksum mismatch after importing book; partial file removed".into(),
        ));
    }
    Ok(ImportedBook {
        relative_path,
        sha256: hash,
        size: bytes.len() as u64,
    })
}

pub fn read_book(root: &LibraryRoot, relative_path: &str) -> HostResult<Vec<u8>> {
    let path = safe_existing_file(root, relative_path)?;
    read_file(&path)
}

pub fn write_book(
    root: &LibraryRoot,
    relative_path: &str,
    bytes: &[u8],
    backup_root: &Path,
) -> HostResult<WrittenBook> {
    if bytes.is_empty() {
        return Err(HostError::InvalidArgs(
            "refusing to replace a book with an empty file".into(),
        ));
    }
    let target = safe_existing_file(root, relative_path)?;
    let metadata = fs::metadata(&target)
        .map_err(|error| HostError::io("failed to inspect book before write", error))?;
    if metadata.permissions().readonly() {
        return Err(HostError::Forbidden(
            "book file is read-only; no bytes were written".into(),
        ));
    }

    let safe_root = require_filesystem_root(root, true)?;
    ensure_within(&safe_root.canonical_path, &target)?;
    let backup = create_file_backup(
        backup_root,
        &safe_root.canonical_path,
        relative_path,
        &target,
    )?;
    let expected_hash = sha256_bytes(bytes);
    let parent = target
        .parent()
        .ok_or_else(|| HostError::Forbidden("book has no safe parent directory".into()))?;
    let temporary = write_temporary_verified(parent, bytes)?;
    if let Err(error) = commit_replace(&temporary.path, &target) {
        cleanup_temporary(&temporary);
        return Err(error);
    }

    let actual_hash = sha256_file(&target)?;
    if actual_hash != expected_hash {
        let restore_result = restore_file_backup(&backup, &target);
        let suffix = match restore_result {
            Ok(()) => "the verified backup was restored".to_owned(),
            Err(restore_error) => format!(
                "backup restoration also failed: {restore_error}; backup remains at {}",
                backup.display()
            ),
        };
        return Err(HostError::Storage(format!(
            "checksum mismatch after atomic book write; {suffix}"
        )));
    }
    prune_file_backups(
        backup
            .parent()
            .ok_or_else(|| HostError::Storage("invalid backup destination".into()))?,
        20,
    );
    Ok(WrittenBook {
        sha256: expected_hash,
        size: bytes.len() as u64,
    })
}

pub fn reveal_file(root: &LibraryRoot, relative_path: &str) -> HostResult<bool> {
    let path = safe_existing_file(root, relative_path)?;
    reveal_path(&path)
}

#[cfg(target_os = "windows")]
fn reveal_path(path: &Path) -> HostResult<bool> {
    let argument = format!("/select,{}", path.to_string_lossy());
    std::process::Command::new("explorer.exe")
        .arg(argument)
        .spawn()
        .map_err(|error| HostError::io("failed to open File Explorer", error))?;
    Ok(true)
}

#[cfg(target_os = "macos")]
fn reveal_path(path: &Path) -> HostResult<bool> {
    let status = std::process::Command::new("open")
        .arg("-R")
        .arg(path)
        .status()
        .map_err(|error| HostError::io("failed to reveal file", error))?;
    Ok(status.success())
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn reveal_path(_path: &Path) -> HostResult<bool> {
    Err(HostError::Unsupported(
        "revealing a library file is not implemented for this host".into(),
    ))
}

pub fn atomic_write_path(path: &Path, bytes: &[u8]) -> HostResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| HostError::InvalidArgs("destination has no parent directory".into()))?;
    fs::create_dir_all(parent)
        .map_err(|error| HostError::io("failed to create destination directory", error))?;
    let expected_hash = sha256_bytes(bytes);
    let temporary = write_temporary_verified(parent, bytes)?;
    if let Err(error) = commit_replace(&temporary.path, path) {
        cleanup_temporary(&temporary);
        return Err(error);
    }
    if sha256_file(path)? != expected_hash {
        return Err(HostError::Storage(
            "checksum mismatch after atomic file write".into(),
        ));
    }
    Ok(())
}

pub fn migrate_roots<F>(
    from: &LibraryRoot,
    to: &LibraryRoot,
    operation_id: &str,
    cancel: &std::sync::atomic::AtomicBool,
    mut progress: F,
) -> HostResult<MigrationReport>
where
    F: FnMut(MigrationProgress),
{
    use std::sync::atomic::Ordering;

    let source = require_filesystem_root(from, false)?;
    let destination = require_filesystem_root(to, true)?;
    if source.canonical_path == destination.canonical_path
        || source
            .canonical_path
            .starts_with(&destination.canonical_path)
        || destination
            .canonical_path
            .starts_with(&source.canonical_path)
    {
        return Err(HostError::Forbidden(
            "source and destination roots must be separate, non-nested directories".into(),
        ));
    }

    let mut entries = Vec::new();
    let mut total_files = 0_usize;
    for entry in WalkDir::new(&source.canonical_path)
        .follow_links(false)
        .into_iter()
    {
        let entry = entry.map_err(|error| {
            HostError::Storage(format!(
                "migration scan failed while traversing source: {error}"
            ))
        })?;
        if cancel.load(Ordering::Acquire) {
            return Ok(MigrationReport {
                operation_id: operation_id.to_owned(),
                completed: false,
                cancelled: true,
                source_preserved: true,
                copied: 0,
                skipped: 0,
                verified: 0,
                failed: Vec::new(),
            });
        }
        if entry.path() == source.canonical_path {
            continue;
        }
        if is_internal_temporary(entry.path()) {
            continue;
        }
        let file_type = entry.file_type();
        if file_type.is_file() || file_type.is_symlink() {
            total_files += 1;
        }
        entries.push(entry.into_path());
    }

    let mut report = MigrationReport {
        operation_id: operation_id.to_owned(),
        completed: false,
        cancelled: false,
        source_preserved: true,
        copied: 0,
        skipped: 0,
        verified: 0,
        failed: Vec::new(),
    };
    progress(MigrationProgress {
        operation_id: operation_id.to_owned(),
        phase: "copying".into(),
        current: 0,
        total: total_files,
        relative_path: None,
    });

    let mut current = 0_usize;
    for path in entries {
        if cancel.load(Ordering::Acquire) {
            report.cancelled = true;
            progress(MigrationProgress {
                operation_id: operation_id.to_owned(),
                phase: "cancelled".into(),
                current,
                total: total_files,
                relative_path: None,
            });
            return Ok(report);
        }
        let relative = relative_path_string(&source.canonical_path, &path)?;
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| HostError::io("failed to inspect migration source", error))?;
        if metadata.file_type().is_symlink() {
            report.failed.push(MigrationIssue {
                relative_path: relative.clone(),
                error: "symbolic links are not migrated".into(),
            });
            current += 1;
            continue;
        }
        if metadata.is_dir() {
            let target = destination
                .canonical_path
                .join(safe_relative_path(&relative)?);
            if let Err(error) =
                create_safe_destination_directory(&destination.canonical_path, &target, from)
            {
                report.failed.push(MigrationIssue {
                    relative_path: relative.clone(),
                    error: error.to_string(),
                });
            }
            continue;
        }
        if !metadata.is_file() {
            report.failed.push(MigrationIssue {
                relative_path: relative.clone(),
                error: "unsupported filesystem entry".into(),
            });
            current += 1;
            continue;
        }

        current += 1;
        let target = match prepare_migration_target(&destination.canonical_path, &relative) {
            Ok(target) => target,
            Err(error) => {
                report.failed.push(MigrationIssue {
                    relative_path: relative.clone(),
                    error: error.to_string(),
                });
                continue;
            }
        };
        if target.exists() {
            let source_hash = match sha256_file(&path) {
                Ok(hash) => hash,
                Err(error) => {
                    report.failed.push(MigrationIssue {
                        relative_path: relative.clone(),
                        error: error.to_string(),
                    });
                    continue;
                }
            };
            let destination_hash = match sha256_file(&target) {
                Ok(hash) => hash,
                Err(error) => {
                    report.failed.push(MigrationIssue {
                        relative_path: relative.clone(),
                        error: error.to_string(),
                    });
                    continue;
                }
            };
            if source_hash == destination_hash {
                report.skipped += 1;
            } else {
                report.failed.push(MigrationIssue {
                    relative_path: relative.clone(),
                    error: "destination already contains different content; source and destination were preserved"
                        .into(),
                });
            }
            continue;
        }

        match copy_file_to_new(&path, &target, cancel) {
            Ok(source_hash) => {
                match sha256_file(&target) {
                    Ok(destination_hash) if destination_hash == source_hash => {
                        report.copied += 1;
                        report.verified += 1;
                    }
                    Ok(_) => {
                        report.failed.push(MigrationIssue {
                            relative_path: relative.clone(),
                            error: "destination checksum verification failed".into(),
                        });
                    }
                    Err(error) => {
                        report.failed.push(MigrationIssue {
                            relative_path: relative.clone(),
                            error: error.to_string(),
                        });
                    }
                }
                progress(MigrationProgress {
                    operation_id: operation_id.to_owned(),
                    phase: "verifying".into(),
                    current,
                    total: total_files,
                    relative_path: Some(relative.clone()),
                });
            }
            Err(HostError::Cancelled(_)) => {
                report.cancelled = true;
                progress(MigrationProgress {
                    operation_id: operation_id.to_owned(),
                    phase: "cancelled".into(),
                    current,
                    total: total_files,
                    relative_path: Some(relative.clone()),
                });
                return Ok(report);
            }
            Err(error) => {
                report.failed.push(MigrationIssue {
                    relative_path: relative,
                    error: error.to_string(),
                });
            }
        }
    }

    report.completed = !report.cancelled && report.failed.is_empty();
    progress(MigrationProgress {
        operation_id: operation_id.to_owned(),
        phase: if report.cancelled {
            "cancelled".into()
        } else if report.completed {
            "completed".into()
        } else {
            "failed".into()
        },
        current,
        total: total_files,
        relative_path: None,
    });
    Ok(report)
}

struct TemporaryFile {
    path: PathBuf,
}

impl Drop for TemporaryFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn write_temporary_verified(parent: &Path, bytes: &[u8]) -> HostResult<TemporaryFile> {
    let path = parent.join(format!(".granite-{}.tmp", Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| HostError::io("failed to create temporary file", error))?;
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(&path);
        return Err(HostError::io("failed to write temporary file", error));
    }
    drop(file);
    let temporary = TemporaryFile { path };
    let actual = sha256_file(&temporary.path)?;
    if actual != sha256_bytes(bytes) {
        return Err(HostError::Storage(
            "temporary file checksum did not match input bytes".into(),
        ));
    }
    Ok(temporary)
}

fn cleanup_temporary(temporary: &TemporaryFile) {
    let _ = fs::remove_file(&temporary.path);
}

fn commit_new(source: &Path, destination: &Path) -> HostResult<()> {
    if destination.exists() {
        return Err(HostError::Conflict(
            "destination already exists; import never overwrites an existing file".into(),
        ));
    }
    platform_move(source, destination, false)?;
    sync_parent(destination)?;
    Ok(())
}

fn commit_replace(source: &Path, destination: &Path) -> HostResult<()> {
    platform_move(source, destination, true)?;
    sync_parent(destination)?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn platform_move(source: &Path, destination: &Path, replace: bool) -> HostResult<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source_wide: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut flags = MOVEFILE_WRITE_THROUGH;
    if replace {
        flags |= MOVEFILE_REPLACE_EXISTING;
    }
    let moved = unsafe { MoveFileExW(source_wide.as_ptr(), destination_wide.as_ptr(), flags) };
    if moved == 0 {
        Err(HostError::io(
            "atomic file replacement failed",
            std::io::Error::last_os_error(),
        ))
    } else {
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
fn platform_move(source: &Path, destination: &Path, replace: bool) -> HostResult<()> {
    if !replace && destination.exists() {
        return Err(HostError::Conflict("destination already exists".into()));
    }
    if replace {
        fs::rename(source, destination)
            .map_err(|error| HostError::io("atomic file replacement failed", error))
    } else {
        fs::hard_link(source, destination)
            .map_err(|error| HostError::io("failed to create destination link", error))?;
        fs::remove_file(source)
            .map_err(|error| HostError::io("failed to remove temporary link", error))
    }
}

#[cfg(unix)]
fn sync_parent(path: &Path) -> HostResult<()> {
    if let Some(parent) = path.parent() {
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| HostError::io("failed to flush directory metadata", error))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn sync_parent(_path: &Path) -> HostResult<()> {
    Ok(())
}

fn create_file_backup(
    backup_root: &Path,
    canonical_root: &Path,
    relative_path: &str,
    target: &Path,
) -> HostResult<PathBuf> {
    let root_key = sha256_bytes(canonical_root.to_string_lossy().as_bytes());
    let file_key = sha256_bytes(relative_path.as_bytes());
    let backup_directory = backup_root.join(&root_key[..16]).join(&file_key[..16]);
    fs::create_dir_all(&backup_directory)
        .map_err(|error| HostError::io("failed to create private backup directory", error))?;
    let source_hash = sha256_file(target)?;
    let extension = target
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("book");
    let timestamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ");
    let backup = backup_directory.join(format!(
        "{timestamp}-{}-{}.{extension}.bak",
        Uuid::new_v4(),
        &source_hash[..16]
    ));
    let parent = backup
        .parent()
        .ok_or_else(|| HostError::Storage("backup path has no parent".into()))?;
    let mut source = File::open(target)
        .map_err(|error| HostError::io("failed to open book for backup", error))?;
    let mut destination = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&backup)
        .map_err(|error| HostError::io("failed to create book backup", error))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = source
            .read(&mut buffer)
            .map_err(|error| HostError::io("failed while reading book backup", error))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        destination
            .write_all(&buffer[..read])
            .map_err(|error| HostError::io("failed while writing book backup", error))?;
    }
    destination
        .sync_all()
        .map_err(|error| HostError::io("failed to flush book backup", error))?;
    drop(destination);
    let backup_hash = hex::encode(hasher.finalize());
    if backup_hash != source_hash || sha256_file(&backup)? != source_hash {
        let _ = fs::remove_file(&backup);
        return Err(HostError::Storage(
            "book backup checksum verification failed; write was aborted".into(),
        ));
    }
    let checksum_path = backup.with_extension(format!(
        "{}.sha256",
        backup
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("bak")
    ));
    atomic_write_path(&checksum_path, source_hash.as_bytes())?;
    let _ = parent;
    Ok(backup)
}

fn restore_file_backup(backup: &Path, target: &Path) -> HostResult<()> {
    let bytes = fs::read(backup)
        .map_err(|error| HostError::io("failed to read book backup for restoration", error))?;
    atomic_write_path(target, &bytes)
}

fn prune_file_backups(directory: &Path, keep: usize) {
    let Ok(read_dir) = fs::read_dir(directory) else {
        return;
    };
    let mut backups: Vec<(SystemTime, PathBuf)> = read_dir
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            if path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".bak"))
            {
                let modified = entry.metadata().ok()?.modified().ok()?;
                Some((modified, path))
            } else {
                None
            }
        })
        .collect();
    backups.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    let remove_after = SystemTime::now()
        .checked_sub(Duration::from_secs(60))
        .unwrap_or(SystemTime::UNIX_EPOCH);
    for (modified, path) in backups.into_iter().skip(keep.max(1)) {
        if modified < remove_after && !path.is_dir() {
            let _ = fs::remove_file(path);
        }
    }
}

fn prepare_migration_target(destination_root: &Path, relative: &str) -> HostResult<PathBuf> {
    let relative = safe_relative_path(relative)?;
    let target = destination_root.join(&relative);
    let parent = target
        .parent()
        .ok_or_else(|| HostError::Forbidden("migration target has no parent".into()))?;
    fs::create_dir_all(parent).map_err(|error| {
        HostError::io("failed to create migration destination directory", error)
    })?;
    let canonical_parent = fs::canonicalize(parent).map_err(|error| {
        HostError::io("failed to validate migration destination directory", error)
    })?;
    ensure_within(destination_root, &canonical_parent)?;
    Ok(target)
}

fn create_safe_destination_directory(
    destination_root: &Path,
    target: &Path,
    _source: &LibraryRoot,
) -> HostResult<()> {
    fs::create_dir_all(target)
        .map_err(|error| HostError::io("failed to create migration directory", error))?;
    let canonical = fs::canonicalize(target)
        .map_err(|error| HostError::io("failed to validate migration directory", error))?;
    ensure_within(destination_root, &canonical)
}

fn copy_file_to_new(
    source: &Path,
    target: &Path,
    cancel: &std::sync::atomic::AtomicBool,
) -> HostResult<String> {
    use std::sync::atomic::Ordering;

    let parent = target
        .parent()
        .ok_or_else(|| HostError::Forbidden("migration target has no parent".into()))?;
    let temporary_path = parent.join(format!(".granite-migrate-{}.tmp", Uuid::new_v4()));
    let mut source_file = File::open(source)
        .map_err(|error| HostError::io("failed to open migration source", error))?;
    let mut destination = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary_path)
        .map_err(|error| HostError::io("failed to create migration temporary file", error))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        if cancel.load(Ordering::Acquire) {
            drop(source_file);
            drop(destination);
            let _ = fs::remove_file(&temporary_path);
            return Err(HostError::Cancelled(
                "library migration was cancelled".into(),
            ));
        }
        let read = source_file
            .read(&mut buffer)
            .map_err(|error| HostError::io("failed while reading migration source", error))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        if let Err(error) = destination.write_all(&buffer[..read]) {
            drop(destination);
            let _ = fs::remove_file(&temporary_path);
            return Err(HostError::io("failed while writing migration copy", error));
        }
    }
    if let Err(error) = destination.sync_all() {
        drop(destination);
        let _ = fs::remove_file(&temporary_path);
        return Err(HostError::io("failed to flush migration copy", error));
    }
    drop(destination);
    let hash = hex::encode(hasher.finalize());
    if sha256_file(&temporary_path)? != hash {
        let _ = fs::remove_file(&temporary_path);
        return Err(HostError::Storage(
            "migration copy checksum verification failed".into(),
        ));
    }
    if let Err(error) = commit_new(&temporary_path, target) {
        let _ = fs::remove_file(&temporary_path);
        return Err(error);
    }
    Ok(hash)
}

fn is_internal_temporary(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.starts_with(".granite-")
                && (name.ends_with(".tmp") || name.contains("write-probe"))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::make_default_root;
    use std::sync::atomic::AtomicBool;
    use tempfile::tempdir;

    #[test]
    fn import_read_and_safe_rewrite_round_trip() {
        let library = tempdir().expect("library");
        let private = tempdir().expect("private");
        let root = make_default_root(library.path().to_path_buf());
        let imported = import_book(&root, "A Tale.epub", b"first edition").expect("import");
        assert_eq!(
            read_book(&root, &imported.relative_path).expect("read"),
            b"first edition"
        );

        let written = write_book(
            &root,
            &imported.relative_path,
            b"second edition",
            private.path(),
        )
        .expect("safe rewrite");
        assert_eq!(written.sha256, sha256_bytes(b"second edition"));
        assert_eq!(
            read_book(&root, &imported.relative_path).expect("read rewritten"),
            b"second edition"
        );
        assert!(WalkDir::new(private.path())
            .into_iter()
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().ends_with(".bak")));
    }

    #[test]
    fn scan_returns_only_supported_regular_books() {
        let library = tempdir().expect("library");
        fs::write(library.path().join("book.pdf"), b"pdf").expect("pdf");
        fs::write(library.path().join("notes.md"), b"md").expect("md");
        fs::create_dir(library.path().join("nested")).expect("nested");
        fs::write(library.path().join("nested/book.txt"), b"txt").expect("txt");
        let root = make_default_root(library.path().to_path_buf());
        let files = scan_root(&root).expect("scan");
        let paths: Vec<_> = files
            .iter()
            .map(|file| file.relative_path.as_str())
            .collect();
        assert_eq!(paths, vec!["book.pdf", "nested/book.txt"]);
    }

    #[test]
    fn migration_copies_and_preserves_source() {
        let source_dir = tempdir().expect("source");
        let destination_dir = tempdir().expect("destination");
        fs::create_dir(source_dir.path().join("books")).expect("books");
        fs::write(source_dir.path().join("books/book.epub"), b"book").expect("book");
        fs::write(source_dir.path().join("Notebook.md"), b"# Note").expect("note");
        let source = make_default_root(source_dir.path().to_path_buf());
        let destination = make_default_root(destination_dir.path().to_path_buf());
        let report = migrate_roots(
            &source,
            &destination,
            "test",
            &AtomicBool::new(false),
            |_| {},
        )
        .expect("migrate");
        assert!(report.completed);
        assert!(report.source_preserved);
        assert_eq!(report.verified, 2);
        assert_eq!(
            fs::read(source_dir.path().join("books/book.epub")).expect("source preserved"),
            b"book"
        );
        assert_eq!(
            fs::read(destination_dir.path().join("books/book.epub")).expect("copy"),
            b"book"
        );
    }

    #[test]
    fn cancelled_migration_keeps_source_and_reports_cancellation() {
        let source_dir = tempdir().expect("source");
        let destination_dir = tempdir().expect("destination");
        fs::write(source_dir.path().join("book.epub"), b"book").expect("book");
        let source = make_default_root(source_dir.path().to_path_buf());
        let destination = make_default_root(destination_dir.path().to_path_buf());
        let cancel = AtomicBool::new(true);
        let report =
            migrate_roots(&source, &destination, "test", &cancel, |_| {}).expect("migrate");
        assert!(report.cancelled);
        assert!(!report.completed);
        assert!(report.source_preserved);
        assert!(source_dir.path().join("book.epub").exists());
        assert!(!destination_dir.path().join("book.epub").exists());
    }

    #[test]
    fn import_rejects_unknown_or_empty_files() {
        let library = tempdir().expect("library");
        let root = make_default_root(library.path().to_path_buf());
        assert!(import_book(&root, "book.epub", b"").is_err());
        assert!(import_book(&root, "book.azw3", b"book").is_err());
    }
}
