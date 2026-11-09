use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use chrono::{SecondsFormat, Utc};
use uuid::Uuid;

use crate::error::{HostError, HostResult};
use crate::models::{LibraryRoot, RootKind, RootPermission, RootScanState};

const SUPPORTED_EXTENSIONS: &[&str] = &["epub", "pdf", "txt", "mobi"];
const WINDOWS_RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

#[derive(Debug, Clone)]
pub struct SafeRoot {
    pub canonical_path: PathBuf,
}

pub fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn default_library_root_path() -> PathBuf {
    dirs::document_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Granite Library")
}

pub fn make_default_root(path: PathBuf) -> LibraryRoot {
    fs::create_dir_all(&path).ok();
    let display_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Granite Library")
        .to_owned();
    LibraryRoot {
        id: Uuid::new_v5(&Uuid::NAMESPACE_URL, path.to_string_lossy().as_bytes()).to_string(),
        display_name,
        path: path.to_string_lossy().into_owned(),
        kind: RootKind::Filesystem,
        permission: RootPermission::Granted,
        enabled: true,
        is_default: true,
        readonly: false,
        scan_state: RootScanState::Idle,
        last_validated_at: None,
    }
}

#[cfg(not(target_os = "android"))]
pub fn make_picked_root(path: PathBuf) -> LibraryRoot {
    fs::create_dir_all(&path).ok();
    let display_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Library")
        .to_owned();
    LibraryRoot {
        id: Uuid::new_v4().to_string(),
        display_name,
        path: path.to_string_lossy().into_owned(),
        kind: RootKind::Filesystem,
        permission: RootPermission::Granted,
        enabled: true,
        is_default: false,
        readonly: false,
        scan_state: RootScanState::Idle,
        last_validated_at: None,
    }
}

pub fn validate_library_root(mut root: LibraryRoot) -> LibraryRoot {
    root.last_validated_at = Some(now_rfc3339());
    root.scan_state = RootScanState::Idle;

    if root.kind != RootKind::Filesystem {
        root.permission = RootPermission::Unavailable;
        root.scan_state = RootScanState::Error;
        return root;
    }

    let path = Path::new(&root.path);
    let canonical = match fs::canonicalize(path) {
        Ok(path) => path,
        Err(_) => {
            root.permission = RootPermission::Unavailable;
            root.scan_state = RootScanState::Error;
            return root;
        }
    };
    let metadata = match fs::metadata(&canonical) {
        Ok(metadata) if metadata.is_dir() => metadata,
        _ => {
            root.permission = RootPermission::Unavailable;
            root.scan_state = RootScanState::Error;
            return root;
        }
    };
    if fs::read_dir(&canonical).is_err() {
        root.permission = RootPermission::Denied;
        root.scan_state = RootScanState::Error;
        return root;
    }
    if metadata.permissions().readonly() {
        root.readonly = true;
        root.permission = RootPermission::Readonly;
        return root;
    }

    match probe_writable_directory(&canonical) {
        Ok(()) => {
            root.path = canonical.to_string_lossy().into_owned();
            root.readonly = false;
            root.permission = RootPermission::Granted;
        }
        Err(_) => {
            root.path = canonical.to_string_lossy().into_owned();
            root.readonly = true;
            root.permission = RootPermission::Readonly;
        }
    }
    root
}

pub fn require_filesystem_root(root: &LibraryRoot, writable: bool) -> HostResult<SafeRoot> {
    if root.kind != RootKind::Filesystem {
        return Err(HostError::Unsupported(
            "this desktop host supports filesystem roots; Android SAF roots must be handled by the Android bridge"
                .into(),
        ));
    }
    let canonical_path = fs::canonicalize(&root.path).map_err(|_| {
        HostError::NotFound(format!(
            "library root '{}' is unavailable",
            root.display_name
        ))
    })?;
    let metadata = fs::metadata(&canonical_path)
        .map_err(|error| HostError::io("failed to inspect library root", error))?;
    if !metadata.is_dir() {
        return Err(HostError::InvalidArgs(
            "library root path is not a directory".into(),
        ));
    }
    fs::read_dir(&canonical_path).map_err(|error| {
        HostError::io(
            format!("library root '{}' is not readable", root.display_name),
            error,
        )
    })?;
    if writable {
        if metadata.permissions().readonly() || root.readonly {
            return Err(HostError::Forbidden(format!(
                "library root '{}' is read-only",
                root.display_name
            )));
        }
        probe_writable_directory(&canonical_path).map_err(|error| {
            HostError::io(
                format!("library root '{}' is not writable", root.display_name),
                error,
            )
        })?;
    }
    Ok(SafeRoot { canonical_path })
}

pub fn safe_relative_path(value: &str) -> HostResult<PathBuf> {
    if value.is_empty() {
        return Err(HostError::Forbidden("relative path is empty".into()));
    }
    if value.contains('\0') {
        return Err(HostError::Forbidden(
            "relative path contains a NUL character".into(),
        ));
    }
    if value.starts_with('/') || value.starts_with('\\') || value.contains(':') {
        return Err(HostError::Forbidden(
            "absolute or drive-qualified paths are not allowed".into(),
        ));
    }

    let mut result = PathBuf::new();
    for component in value.split(['/', '\\']) {
        if component.is_empty() || component == "." || component == ".." {
            return Err(HostError::Forbidden(
                "relative path contains an empty, current, or parent component".into(),
            ));
        }
        if component.chars().any(char::is_control) {
            return Err(HostError::Forbidden(
                "relative path contains a control character".into(),
            ));
        }
        let portable = sanitize_component(component)?;
        if portable != component {
            return Err(HostError::Forbidden(
                "relative path contains a Windows-reserved or non-portable component".into(),
            ));
        }
        result.push(portable);
    }

    if result.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(HostError::Forbidden(
            "relative path escapes the library root".into(),
        ));
    }
    Ok(result)
}

pub fn safe_existing_file(root: &LibraryRoot, relative_path: &str) -> HostResult<PathBuf> {
    let safe_root = require_filesystem_root(root, false)?;
    let relative = safe_relative_path(relative_path)?;
    let candidate = safe_root.canonical_path.join(&relative);
    let candidate_metadata = fs::symlink_metadata(&candidate)
        .map_err(|_| HostError::NotFound(format!("file '{relative_path}' does not exist")))?;
    if candidate_metadata.file_type().is_symlink() {
        return Err(HostError::Forbidden(format!(
            "file '{relative_path}' is a symbolic link"
        )));
    }
    let canonical = fs::canonicalize(&candidate)
        .map_err(|_| HostError::NotFound(format!("file '{relative_path}' does not exist")))?;
    ensure_within(&safe_root.canonical_path, &canonical)?;
    let metadata =
        fs::metadata(&canonical).map_err(|error| HostError::io("failed to inspect file", error))?;
    if !metadata.is_file() {
        return Err(HostError::InvalidArgs(format!(
            "'{relative_path}' is not a regular file"
        )));
    }
    Ok(canonical)
}

pub fn safe_new_file(root: &LibraryRoot, relative_path: &str) -> HostResult<PathBuf> {
    let safe_root = require_filesystem_root(root, true)?;
    let relative = safe_relative_path(relative_path)?;
    let file_name = relative
        .file_name()
        .ok_or_else(|| HostError::InvalidArgs("file path has no file name".into()))?;
    let parent_relative = relative.parent().ok_or_else(|| {
        HostError::Forbidden("file path has no safe parent inside the library root".into())
    })?;
    let parent = create_safe_directory(&safe_root.canonical_path, parent_relative)?;
    let target = parent.join(file_name);
    match fs::symlink_metadata(&target) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(HostError::Forbidden(
                    "target path is an existing symbolic link".into(),
                ));
            }
            if metadata.is_dir() {
                return Err(HostError::Conflict(
                    "target path is an existing directory".into(),
                ));
            }
            let canonical = fs::canonicalize(&target)
                .map_err(|error| HostError::io("failed to validate existing target", error))?;
            ensure_within(&safe_root.canonical_path, &canonical)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(HostError::io("failed to inspect existing target", error)),
    }
    Ok(target)
}

pub fn create_safe_directory(root: &Path, relative_path: &Path) -> HostResult<PathBuf> {
    let canonical_root = fs::canonicalize(root)
        .map_err(|error| HostError::io("failed to validate directory root", error))?;
    let metadata = fs::metadata(&canonical_root)
        .map_err(|error| HostError::io("failed to inspect directory root", error))?;
    if !metadata.is_dir() {
        return Err(HostError::InvalidArgs(
            "directory root is not a directory".into(),
        ));
    }

    let mut current = canonical_root.clone();
    for component in relative_path.components() {
        let Component::Normal(name) = component else {
            return Err(HostError::Forbidden(
                "directory path contains an unsafe component".into(),
            ));
        };
        current.push(name);
        match fs::create_dir(&current) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(HostError::io(
                    "failed to create a validated library subdirectory",
                    error,
                ));
            }
        }
        let metadata = fs::symlink_metadata(&current)
            .map_err(|error| HostError::io("failed to inspect library subdirectory", error))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(HostError::Forbidden(
                "library subdirectory is a link or is not a directory".into(),
            ));
        }
        let canonical = fs::canonicalize(&current)
            .map_err(|error| HostError::io("failed to validate library subdirectory", error))?;
        ensure_within(&canonical_root, &canonical)?;
        current = canonical;
    }
    Ok(current)
}

pub fn ensure_within(root: &Path, candidate: &Path) -> HostResult<()> {
    if candidate.starts_with(root) {
        Ok(())
    } else {
        Err(HostError::Forbidden(
            "path resolves outside the selected library root".into(),
        ))
    }
}

pub fn relative_path_string(root: &Path, path: &Path) -> HostResult<String> {
    let relative = path.strip_prefix(root).map_err(|_| {
        HostError::Forbidden("file path resolves outside the selected library root".into())
    })?;
    let mut parts = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(value) => {
                let value = value.to_str().ok_or_else(|| {
                    HostError::InvalidArgs("library paths must be valid Unicode".into())
                })?;
                parts.push(value.to_owned());
            }
            _ => {
                return Err(HostError::Forbidden(
                    "relative file path contains an unsafe component".into(),
                ));
            }
        }
    }
    Ok(parts.join("/"))
}

pub fn format_from_path(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    SUPPORTED_EXTENSIONS
        .iter()
        .copied()
        .find(|candidate| *candidate == extension)
}

pub fn sanitize_filename(value: &str) -> HostResult<String> {
    let name = value
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty() && !name.contains('\0'))
        .ok_or_else(|| HostError::InvalidArgs("file name is missing or invalid".into()))?;
    if name == "." || name == ".." {
        return Err(HostError::Forbidden(
            "file name is a reserved path component".into(),
        ));
    }
    let safe = sanitize_component(name)?;
    if Path::new(&safe).extension().is_none() {
        return Err(HostError::InvalidArgs(
            "file name must include a supported extension".into(),
        ));
    }
    if format_from_path(Path::new(&safe)).is_none() {
        return Err(HostError::Unsupported(
            "only EPUB, PDF, TXT, and MOBI files are supported".into(),
        ));
    }
    Ok(safe)
}

pub fn sanitize_component(value: &str) -> HostResult<String> {
    let trimmed = value.trim_end_matches([' ', '.']);
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return Err(HostError::InvalidArgs(
            "path component is empty or reserved".into(),
        ));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(HostError::InvalidArgs(
            "path component contains a control character".into(),
        ));
    }
    const INVALID: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    let mut output = String::with_capacity(trimmed.len());
    for character in trimmed.chars() {
        output.push(if INVALID.contains(&character) || character == '\0' {
            '_'
        } else {
            character
        });
    }
    while output.ends_with([' ', '.']) {
        output.pop();
    }
    if output.is_empty() {
        output.push('_');
    }
    let stem = output
        .split('.')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_uppercase();
    if WINDOWS_RESERVED.contains(&stem.as_str()) {
        output.insert(0, '_');
    }
    if output.len() > 180 {
        output.truncate(180);
        while output.ends_with([' ', '.']) {
            output.pop();
        }
    }
    Ok(output)
}

fn probe_writable_directory(path: &Path) -> std::io::Result<()> {
    let probe = path.join(format!(".granite-write-probe-{}", Uuid::new_v4()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)?;
    use std::io::Write;
    file.write_all(b"granite")?;
    file.sync_all()?;
    drop(file);
    fs::remove_file(probe)?;
    Ok(())
}

pub fn extension_set() -> HashSet<&'static str> {
    SUPPORTED_EXTENSIONS.iter().copied().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn rejects_traversal_and_absolute_paths() {
        for value in [
            "../outside.pdf",
            "books/../../outside.pdf",
            "C:/outside.pdf",
            "/tmp/outside.pdf",
            "\\\\server\\share\\book.pdf",
            "books//book.pdf",
            "books/./book.pdf",
        ] {
            assert!(safe_relative_path(value).is_err(), "{value} was accepted");
        }
    }

    #[test]
    fn sanitizes_windows_invalid_names() {
        assert_eq!(
            sanitize_filename("A:B?.epub").expect("sanitize filename"),
            "A_B_.epub"
        );
        assert_eq!(
            sanitize_filename("C:\\fakepath\\A:B?.epub").expect("sanitize full filename"),
            "A_B_.epub"
        );
        assert_eq!(
            sanitize_component("CON.txt").expect("sanitize component"),
            "_CON.txt"
        );
        assert!(sanitize_filename("../").is_err());
        assert!(sanitize_filename("book.azw3").is_err());
    }

    #[test]
    fn existing_file_cannot_escape_root() {
        let root_dir = tempdir().expect("root");
        let outside_dir = tempdir().expect("outside");
        let outside = outside_dir.path().join("outside.pdf");
        fs::write(&outside, b"outside").expect("write outside");

        let root = make_default_root(root_dir.path().to_path_buf());
        assert!(safe_existing_file(&root, "../outside.pdf").is_err());
    }

    #[test]
    fn validates_available_and_missing_roots() {
        let directory = tempdir().expect("root");
        let root = make_default_root(directory.path().to_path_buf());
        let validated = validate_library_root(root.clone());
        assert_eq!(validated.permission, RootPermission::Granted);

        let mut missing = root;
        missing.path = directory
            .path()
            .join("missing")
            .to_string_lossy()
            .into_owned();
        let validated = validate_library_root(missing);
        assert_eq!(validated.permission, RootPermission::Unavailable);
    }

    #[test]
    fn safe_directory_creation_rejects_file_components() {
        let root_directory = tempdir().expect("root");
        fs::write(root_directory.path().join("blocked"), b"not a directory").expect("blocker");
        assert!(create_safe_directory(root_directory.path(), Path::new("blocked/child")).is_err());
        assert!(!root_directory.path().join("blocked/child").exists());
    }

    #[test]
    fn new_file_creation_rejects_file_components_before_writing() {
        let root_directory = tempdir().expect("root");
        fs::write(root_directory.path().join("books"), b"not a directory").expect("blocker");
        let root = make_default_root(root_directory.path().to_path_buf());
        assert!(safe_new_file(&root, "books/book.pdf").is_err());
        assert_eq!(
            fs::read(root_directory.path().join("books")).expect("blocker preserved"),
            b"not a directory"
        );
    }
}
