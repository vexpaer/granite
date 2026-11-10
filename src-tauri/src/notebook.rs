use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use uuid::Uuid;
use walkdir::WalkDir;

use crate::error::{HostError, HostResult};
use crate::filesystem::{atomic_write_path, sha256_bytes};
use crate::paths::{
    create_safe_directory, ensure_within, now_rfc3339, safe_relative_path, sanitize_component,
};

const NOTEBOOK_DIRECTORY_NAME: &str = "Notebook";
const INDEX_DIRECTORY_NAME: &str = ".granite";
const INDEX_FILE_NAME: &str = "notebook-index.json";
const INDEX_SCHEMA_VERSION: u32 = 1;
const MAX_MARKDOWN_BYTES: u64 = 64 * 1024 * 1024;
const ATTACHMENT_DIRECTORY_NAME: &str = "attachments";
const ATTACHMENT_HASH_DIRECTORY_NAME: &str = "sha256";
const NOTE_ID_NAMESPACE: Uuid = Uuid::from_u128(0x2a2a6d4d_6234_4c5b_9e21_5f1c7f7f92d0);

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct NotebookIndex {
    #[serde(default = "default_index_schema_version")]
    schema_version: u32,
    #[serde(default)]
    entries: BTreeMap<String, IndexedNote>,
}

fn default_index_schema_version() -> u32 {
    INDEX_SCHEMA_VERSION
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexedNote {
    relative_path: String,
    sha256: String,
}

#[derive(Debug)]
struct DiskNote {
    relative_path: String,
    sha256: String,
    id: String,
    title: String,
    body: String,
    folder: String,
    metadata: Map<String, Value>,
    updated_at: String,
}

pub fn mirror_state(state: &Value, fallback_library_root: &Path) -> HostResult<()> {
    let canonical_notebook = notebook_directory(state, fallback_library_root, true)?;

    let previous_index = load_index(&canonical_notebook).unwrap_or_default();
    let mut index = NotebookIndex {
        schema_version: INDEX_SCHEMA_VERSION,
        entries: BTreeMap::new(),
    };
    let mut used_paths: HashSet<String> = HashSet::new();
    let existing_paths = visible_markdown_path_keys(&canonical_notebook)?;
    let notes = match state.get("notes") {
        Some(Value::Array(notes)) => notes.as_slice(),
        None => {
            return Err(HostError::InvalidArgs(
                "state.notes must be an array before Notebook mirroring".into(),
            ));
        }
        Some(_) => {
            return Err(HostError::InvalidArgs(
                "state.notes must be an array before Notebook mirroring".into(),
            ));
        }
    };
    let current_ids: HashSet<String> = notes
        .iter()
        .filter_map(|note| note.get("id").and_then(Value::as_str))
        .map(str::to_owned)
        .collect();

    for (index_number, note) in notes.iter().enumerate() {
        let note = note.as_object().ok_or_else(|| {
            HostError::InvalidArgs(format!("state.notes[{index_number}] is not an object"))
        })?;
        let id = required_string(note, "id", "note")?;
        let title = note
            .get("title")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("Untitled");
        let folder = note.get("folder").and_then(Value::as_str).unwrap_or("");
        let body = note
            .get("body")
            .and_then(Value::as_str)
            .ok_or_else(|| HostError::InvalidArgs(format!("note '{id}' has no string body")))?;

        let relative_path = select_note_path(
            id,
            title,
            folder,
            previous_index.entries.get(id),
            &mut used_paths,
            &existing_paths,
        )?;
        let relative = safe_relative_path(&relative_path)?;
        let target = canonical_notebook.join(&relative);
        let parent = target.parent().ok_or_else(|| {
            HostError::Forbidden("Notebook path has no safe parent directory".into())
        })?;
        let parent_relative = parent.strip_prefix(&canonical_notebook).map_err(|_| {
            HostError::Forbidden("Notebook folder escapes the Notebook directory".into())
        })?;
        let canonical_parent = create_safe_directory(&canonical_notebook, parent_relative)?;
        let target = canonical_parent.join(
            target
                .file_name()
                .ok_or_else(|| HostError::Forbidden("Notebook file has no file name".into()))?,
        );
        match fs::symlink_metadata(&target) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(HostError::Forbidden(
                    "Notebook target is an existing symbolic link".into(),
                ))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(HostError::io("failed to inspect Notebook target", error)),
        }

        let document = render_markdown(note, id, title, folder, body)?;
        if document.len() as u64 > MAX_MARKDOWN_BYTES {
            return Err(HostError::Unsupported(format!(
                "Notebook document for note '{id}' exceeds the {MAX_MARKDOWN_BYTES}-byte limit"
            )));
        }
        let document_hash = sha256_bytes(document.as_bytes());
        if let Some(previous) = previous_index.entries.get(id) {
            let indexed_path = previous.relative_path.replace('\\', "/");
            if indexed_path == relative_path {
                if !target.is_file() {
                    write_recovery_copy(
                        &canonical_notebook,
                        "conflicts",
                        id,
                        &document_hash,
                        &document,
                    )?;
                    index.entries.insert(id.to_owned(), previous.clone());
                    continue;
                }
                let disk_hash = crate::filesystem::sha256_file(&target)?;
                if let Ok(disk_note) = read_disk_note(&canonical_notebook, &target, &relative_path)
                {
                    if disk_note.id != id {
                        write_recovery_copy(
                            &canonical_notebook,
                            "conflicts",
                            id,
                            &document_hash,
                            &document,
                        )?;
                        return Err(HostError::Conflict(format!(
                            "Notebook index for note '{id}' points to a different Markdown note; the file was preserved"
                        )));
                    }
                }
                if previous.sha256 != disk_hash {
                    if disk_hash == document_hash {
                        index.entries.insert(
                            id.to_owned(),
                            IndexedNote {
                                relative_path: relative_path.clone(),
                                sha256: disk_hash,
                            },
                        );
                    } else {
                        write_recovery_copy(
                            &canonical_notebook,
                            "conflicts",
                            id,
                            &document_hash,
                            &document,
                        )?;
                        index.entries.insert(id.to_owned(), previous.clone());
                    }
                    continue;
                }
            }
        }
        materialize_attachments(note, &canonical_parent, id)?;
        atomic_write_path(&target, document.as_bytes())?;
        index.entries.insert(
            id.to_owned(),
            IndexedNote {
                relative_path,
                sha256: document_hash,
            },
        );
    }

    for (id, previous) in &previous_index.entries {
        if !current_ids.contains(id) {
            move_indexed_note_to_trash(&canonical_notebook, id, &previous.relative_path)?;
        }
    }
    write_index(&canonical_notebook, &index)
}

pub fn sync_from_disk(state: &Value, fallback_library_root: &Path) -> HostResult<Value> {
    let notebook_directory = notebook_directory(state, fallback_library_root, false)?;
    if !notebook_directory.exists() {
        return Ok(state.clone());
    }
    let canonical_notebook = fs::canonicalize(&notebook_directory)
        .map_err(|error| HostError::io("failed to validate Notebook directory", error))?;
    let index = load_index(&canonical_notebook).unwrap_or_default();
    let disk_notes = scan_markdown_notes(&canonical_notebook)?;

    let mut disk_by_id: HashMap<String, DiskNote> = HashMap::new();
    for note in disk_notes {
        if disk_by_id.insert(note.id.clone(), note).is_some() {
            return Err(HostError::Conflict(
                "multiple Markdown files declare the same Granite note ID".into(),
            ));
        }
    }

    let mut updated = state.clone();
    let object = updated.as_object_mut().ok_or_else(|| {
        HostError::InvalidArgs("stored state must be an object to sync Notebook files".into())
    })?;
    let notes = object
        .entry("notes")
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| HostError::InvalidArgs("state.notes must be an array".into()))?;

    let missing_managed_ids: HashSet<String> = index
        .entries
        .iter()
        .filter_map(|(id, entry)| {
            let path = canonical_notebook.join(safe_relative_path(&entry.relative_path).ok()?);
            (!path.is_file()).then(|| id.clone())
        })
        .collect();
    notes.retain(|note| match note.get("id").and_then(Value::as_str) {
        Some(id) => !missing_managed_ids.contains(id),
        None => true,
    });

    let mut existing_by_id: HashMap<String, usize> = HashMap::new();
    for (index, note) in notes.iter().enumerate() {
        if let Some(id) = note.get("id").and_then(Value::as_str) {
            existing_by_id.insert(id.to_owned(), index);
        }
    }

    for (id, disk_note) in &disk_by_id {
        if let Some(index) = existing_by_id.get(id).copied() {
            let note = notes[index].as_object_mut().ok_or_else(|| {
                HostError::InvalidArgs(format!("stored note '{id}' is not an object"))
            })?;
            note.insert("title".into(), Value::String(disk_note.title.clone()));
            note.insert("body".into(), Value::String(disk_note.body.clone()));
            note.insert("folder".into(), Value::String(disk_note.folder.clone()));
            note.insert(
                "updatedAt".into(),
                Value::String(disk_note.updated_at.clone()),
            );
            merge_optional_metadata(note, disk_note.metadata.clone());
        } else {
            let mut note = Map::new();
            note.insert("id".into(), Value::String(id.to_owned()));
            note.insert("title".into(), Value::String(disk_note.title.clone()));
            note.insert("body".into(), Value::String(disk_note.body.clone()));
            note.insert("folder".into(), Value::String(disk_note.folder.clone()));
            note.insert("tagIds".into(), Value::Array(Vec::new()));
            note.insert(
                "createdAt".into(),
                Value::String(disk_note.updated_at.clone()),
            );
            note.insert(
                "updatedAt".into(),
                Value::String(disk_note.updated_at.clone()),
            );
            merge_optional_metadata(&mut note, disk_note.metadata.clone());
            notes.push(Value::Object(note));
        }
    }

    let next_index = NotebookIndex {
        schema_version: INDEX_SCHEMA_VERSION,
        entries: disk_by_id
            .iter()
            .map(|(id, disk_note)| {
                (
                    id.clone(),
                    IndexedNote {
                        relative_path: disk_note.relative_path.clone(),
                        sha256: disk_note.sha256.clone(),
                    },
                )
            })
            .collect(),
    };
    write_index(&canonical_notebook, &next_index)?;
    Ok(updated)
}

fn notebook_directory(
    state: &Value,
    fallback_library_root: &Path,
    writable: bool,
) -> HostResult<PathBuf> {
    let roots = state.get("roots").and_then(Value::as_array);
    let has_configured_roots = roots.is_some_and(|roots| !roots.is_empty());
    let selected = roots.and_then(|roots| {
        roots
            .iter()
            .filter(|root| {
                root.get("kind").and_then(Value::as_str) == Some("filesystem")
                    && root.get("enabled").and_then(Value::as_bool).unwrap_or(true)
                    && matches!(
                        root.get("permission").and_then(Value::as_str),
                        Some("granted") | Some("readonly")
                    )
            })
            .min_by_key(|root| {
                if root.get("isDefault").and_then(Value::as_bool) == Some(true) {
                    0
                } else {
                    1
                }
            })
            .and_then(|root| root.get("path").and_then(Value::as_str))
            .map(PathBuf::from)
    });
    if has_configured_roots && selected.is_none() {
        return Err(HostError::NotFound(
            "no configured local library folder is currently accessible; Notebook files were not read or changed"
                .into(),
        ));
    }
    let library_root = selected.unwrap_or_else(|| fallback_library_root.to_path_buf());
    let canonical_root = fs::canonicalize(&library_root).map_err(|_| {
        HostError::NotFound(
            "the selected local library folder is unavailable; Notebook files were not read or changed"
                .into(),
        )
    })?;
    let metadata = fs::metadata(&canonical_root)
        .map_err(|error| HostError::io("failed to inspect the local library folder", error))?;
    if !metadata.is_dir() {
        return Err(HostError::InvalidArgs(
            "the selected local library path is not a directory".into(),
        ));
    }
    if writable && metadata.permissions().readonly() {
        return Err(HostError::Forbidden(
            "the selected local library folder is read-only".into(),
        ));
    }
    if writable {
        create_safe_directory(&canonical_root, Path::new(NOTEBOOK_DIRECTORY_NAME))
    } else {
        let notebook = canonical_root.join(NOTEBOOK_DIRECTORY_NAME);
        if !notebook.exists() {
            return Ok(notebook);
        }
        let canonical = fs::canonicalize(&notebook)
            .map_err(|error| HostError::io("failed to validate Notebook directory", error))?;
        ensure_within(&canonical_root, &canonical)?;
        if !canonical.is_dir() {
            return Err(HostError::InvalidArgs(
                "Notebook path is not a directory".into(),
            ));
        }
        Ok(canonical)
    }
}

fn select_note_path(
    id: &str,
    title: &str,
    folder: &str,
    indexed: Option<&IndexedNote>,
    used_paths: &mut HashSet<String>,
    existing_paths: &HashSet<String>,
) -> HostResult<String> {
    if let Some(indexed) = indexed {
        let normalized = indexed.relative_path.replace('\\', "/");
        let key = normalized.to_ascii_lowercase();
        if safe_relative_path(&normalized).is_ok() && used_paths.insert(key) {
            return Ok(normalized);
        }
    }

    let folder_path = safe_notebook_folder(folder)?;
    let title_stem = title
        .trim()
        .strip_suffix(".md")
        .unwrap_or_else(|| title.trim())
        .to_owned();
    let safe_title = sanitize_component(if title_stem.is_empty() {
        "Untitled"
    } else {
        &title_stem
    })?;
    let mut candidate = if folder_path.as_os_str().is_empty() {
        format!("{safe_title}.md")
    } else {
        format!(
            "{}/{safe_title}.md",
            folder_path.to_string_lossy().replace('\\', "/")
        )
    };
    let suffix = id.get(..8).unwrap_or(id);
    for attempt in 0..10_000_u32 {
        let key = candidate.to_ascii_lowercase();
        if !used_paths.contains(&key) && !existing_paths.contains(&key) {
            used_paths.insert(key);
            return Ok(candidate);
        }
        let disambiguated = if attempt == 0 {
            format!("{safe_title}-{suffix}")
        } else {
            format!("{safe_title}-{suffix}-{attempt}")
        };
        candidate = if folder_path.as_os_str().is_empty() {
            format!("{disambiguated}.md")
        } else {
            format!(
                "{}/{disambiguated}.md",
                folder_path.to_string_lossy().replace('\\', "/")
            )
        };
    }
    Err(HostError::Conflict(
        "could not derive a unique Markdown file name for a note".into(),
    ))
}

fn safe_notebook_folder(folder: &str) -> HostResult<PathBuf> {
    if folder.trim().is_empty() {
        return Ok(PathBuf::new());
    }
    let mut path = PathBuf::new();
    for component in folder.split(['/', '\\']) {
        if component.is_empty() {
            continue;
        }
        if component == "." || component == ".." {
            return Err(HostError::Forbidden(
                "Notebook folder cannot contain traversal components".into(),
            ));
        }
        path.push(sanitize_component(component)?);
    }
    Ok(path)
}

fn materialize_attachments(
    note: &Map<String, Value>,
    note_parent: &Path,
    note_id: &str,
) -> HostResult<()> {
    let Some(value) = note.get("attachments") else {
        return Ok(());
    };
    let attachments = value.as_array().ok_or_else(|| {
        HostError::InvalidArgs(format!("note '{note_id}' attachments must be an array"))
    })?;
    for (index, attachment) in attachments.iter().enumerate() {
        materialize_attachment(attachment, note_parent, note_id, index)?;
    }
    Ok(())
}

fn materialize_attachment(
    attachment: &Value,
    note_parent: &Path,
    note_id: &str,
    index: usize,
) -> HostResult<()> {
    let attachment = attachment.as_object().ok_or_else(|| {
        HostError::InvalidArgs(format!(
            "note '{note_id}' attachment {index} must be an object"
        ))
    })?;
    let name = required_string(attachment, "name", "attachment")?;
    let path = required_string(attachment, "path", "attachment")?;
    let Some(data_value) = attachment.get("data") else {
        safe_relative_path(path)?;
        return Ok(());
    };
    if data_value.is_null() {
        safe_relative_path(path)?;
        return Ok(());
    }
    let data = data_value
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            HostError::InvalidArgs("attachment has no non-empty string 'data' field".into())
        })?;
    let (relative_path, expected_hash) = parse_attachment_path(path, name)?;
    let bytes = decode_attachment_data_url(data, name)?;
    let actual_hash = sha256_bytes(&bytes);
    if actual_hash != expected_hash {
        return Err(HostError::Conflict(format!(
            "attachment '{name}' content does not match its SHA-256 path"
        )));
    }

    let parent_relative = relative_path
        .parent()
        .ok_or_else(|| HostError::Forbidden("attachment path has no parent directory".into()))?;
    let attachment_parent = create_safe_directory(note_parent, parent_relative)?;
    let file_name = relative_path
        .file_name()
        .ok_or_else(|| HostError::Forbidden("attachment path has no file name".into()))?;
    let target = attachment_parent.join(file_name);
    ensure_within(note_parent, &target)?;

    match fs::symlink_metadata(&target) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(HostError::Forbidden(format!(
                "attachment '{name}' target is an existing symbolic link"
            )));
        }
        Ok(metadata) if metadata.is_dir() => {
            return Err(HostError::Conflict(format!(
                "attachment '{name}' content-addressed target is a directory; it was preserved"
            )));
        }
        Ok(metadata) if metadata.is_file() => {
            let existing_hash = crate::filesystem::sha256_file(&target)?;
            if existing_hash == expected_hash {
                return Ok(());
            }
            return Err(HostError::Conflict(format!(
                "attachment '{name}' content-addressed target already contains different bytes; it was preserved"
            )));
        }
        Ok(_) => {
            return Err(HostError::Conflict(format!(
                "attachment '{name}' target is not a regular file; it was preserved"
            )));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(HostError::io(
                format!("failed to inspect attachment '{name}' target"),
                error,
            ))
        }
    }

    atomic_write_path(&target, &bytes)?;
    if crate::filesystem::sha256_file(&target)? != expected_hash {
        return Err(HostError::Storage(format!(
            "attachment '{name}' checksum changed after atomic write"
        )));
    }
    Ok(())
}

fn parse_attachment_path(path: &str, name: &str) -> HostResult<(PathBuf, String)> {
    if path.contains('\\') {
        return Err(HostError::Forbidden(
            "attachment paths must use forward slashes".into(),
        ));
    }
    let relative = safe_relative_path(path)?;
    let components: Vec<_> = relative
        .iter()
        .map(|component| component.to_str())
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| HostError::InvalidArgs("attachment path must be valid Unicode".into()))?;
    if components.len() != 4
        || components[0] != ATTACHMENT_DIRECTORY_NAME
        || components[1] != ATTACHMENT_HASH_DIRECTORY_NAME
    {
        return Err(HostError::Forbidden(
            "attachment path must be attachments/sha256/<sha256>/<safe-name>".into(),
        ));
    }
    let expected_hash = components[2].to_owned();
    if expected_hash.len() != 64
        || !expected_hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(HostError::InvalidArgs(
            "attachment path contains an invalid lowercase SHA-256 value".into(),
        ));
    }
    let safe_name = sanitize_component(name)?;
    if !is_safe_attachment_name(name) || safe_name != name || components[3] != safe_name {
        return Err(HostError::Forbidden(
            "attachment name must be a safe path component matching the relative path".into(),
        ));
    }
    Ok((relative, expected_hash))
}

fn decode_attachment_data_url(data: &str, name: &str) -> HostResult<Vec<u8>> {
    let (metadata, encoded) = data
        .strip_prefix("data:")
        .and_then(|value| value.split_once(','))
        .ok_or_else(|| {
            HostError::InvalidArgs(format!("attachment '{name}' data is not a Base64 Data URL"))
        })?;
    let mut metadata_parts = metadata.split(';');
    let media_type = metadata_parts.next().unwrap_or_default();
    let encoding = metadata_parts.next();
    if !valid_media_type(media_type)
        || !encoding.is_some_and(|value| value.eq_ignore_ascii_case("base64"))
        || metadata_parts.next().is_some()
    {
        return Err(HostError::Unsupported(format!(
            "attachment '{name}' uses an unsupported or unsafe Data URL; expected data:<mime>;base64,..."
        )));
    }
    if encoded.is_empty() {
        return Err(HostError::InvalidArgs(format!(
            "attachment '{name}' contains an empty Base64 payload"
        )));
    }
    if encoded.len() as u64 > MAX_MARKDOWN_BYTES {
        return Err(HostError::Unsupported(format!(
            "attachment '{name}' encoded data exceeds the native Notebook limit"
        )));
    }
    let bytes = STANDARD.decode(encoded).map_err(|_| {
        HostError::InvalidArgs(format!("attachment '{name}' contains invalid Base64 data"))
    })?;
    if bytes.len() as u64 > MAX_MARKDOWN_BYTES {
        return Err(HostError::Unsupported(format!(
            "attachment '{name}' decoded data exceeds the native Notebook limit"
        )));
    }
    Ok(bytes)
}

fn valid_media_type(value: &str) -> bool {
    let Some((kind, subtype)) = value.split_once('/') else {
        return false;
    };
    !kind.is_empty()
        && !subtype.is_empty()
        && kind.len() <= 127
        && subtype.len() <= 127
        && kind
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && subtype
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && kind.bytes().all(is_media_type_token_byte)
        && subtype.bytes().all(is_media_type_token_byte)
}

fn is_safe_attachment_name(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= 120
        && !value.starts_with(['.', '-'])
        && !value.ends_with(['.', ' '])
        && value.chars().all(|character| {
            character.is_alphanumeric() || matches!(character, '.' | '_' | '-' | ' ')
        })
}

fn is_media_type_token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'!' | b'#' | b'$' | b'&' | b'^' | b'_' | b'.' | b'+' | b'-'
        )
}

fn render_markdown(
    note: &Map<String, Value>,
    id: &str,
    title: &str,
    folder: &str,
    body: &str,
) -> HostResult<String> {
    let mut metadata = Map::new();
    metadata.insert("graniteNoteId".into(), Value::String(id.to_owned()));
    metadata.insert("title".into(), Value::String(title.to_owned()));
    metadata.insert("folder".into(), Value::String(folder.to_owned()));
    for key in [
        "tagIds",
        "bookId",
        "quote",
        "location",
        "attachments",
        "createdAt",
        "updatedAt",
        "conflictOf",
    ] {
        if let Some(value) = note.get(key) {
            metadata.insert(key.to_owned(), value.clone());
        }
    }
    let yaml = serde_yaml::to_string(&Value::Object(metadata)).map_err(|error| {
        HostError::Storage(format!("failed to serialize Note front matter: {error}"))
    })?;
    Ok(format!("---\n{}---\n\n{}", yaml, body))
}

fn scan_markdown_notes(notebook_directory: &Path) -> HostResult<Vec<DiskNote>> {
    let mut notes = Vec::new();
    for entry in WalkDir::new(notebook_directory)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            entry.depth() == 0
                || !entry.file_name().to_string_lossy().starts_with('.')
                    && entry.file_name().to_string_lossy() != "attachments"
        })
    {
        let entry = entry.map_err(|error| {
            HostError::Storage(format!(
                "Notebook scan failed while traversing folder: {error}"
            ))
        })?;
        if entry.file_type().is_symlink() || !entry.file_type().is_file() {
            continue;
        }
        if entry.path().extension().and_then(|value| value.to_str()) != Some("md") {
            continue;
        }
        let metadata = fs::metadata(entry.path())
            .map_err(|error| HostError::io("failed to inspect Markdown note", error))?;
        if metadata.len() > MAX_MARKDOWN_BYTES {
            return Err(HostError::Unsupported(format!(
                "Markdown note '{}' exceeds the {MAX_MARKDOWN_BYTES}-byte limit",
                entry.file_name().to_string_lossy()
            )));
        }
        let canonical = fs::canonicalize(entry.path())
            .map_err(|error| HostError::io("failed to validate Markdown note", error))?;
        ensure_within(notebook_directory, &canonical)?;
        let relative_path = canonical
            .strip_prefix(notebook_directory)
            .map_err(|_| HostError::Forbidden("Markdown note escapes Notebook directory".into()))?
            .to_string_lossy()
            .replace('\\', "/");
        let content = fs::read_to_string(&canonical).map_err(|error| {
            HostError::io("Markdown note is not valid UTF-8 or is unreadable", error)
        })?;
        let sha256 = sha256_bytes(content.as_bytes());
        let modified_at = metadata
            .modified()
            .ok()
            .map(chrono::DateTime::<chrono::Utc>::from)
            .map(|time| time.to_rfc3339())
            .unwrap_or_else(now_rfc3339);
        notes.push(parse_disk_note(
            relative_path,
            sha256,
            content,
            modified_at,
        )?);
    }
    notes.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(notes)
}

fn parse_disk_note(
    relative_path: String,
    sha256: String,
    content: String,
    modified_at: String,
) -> HostResult<DiskNote> {
    let (metadata, body) = split_frontmatter(&content)?;
    let id = metadata
        .get("graniteNoteId")
        .or_else(|| metadata.get("granite_note_id"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| Uuid::new_v5(&NOTE_ID_NAMESPACE, relative_path.as_bytes()).to_string());
    let fallback_title = first_markdown_heading(&body)
        .or_else(|| {
            Path::new(&relative_path)
                .file_stem()
                .and_then(|value| value.to_str())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "Untitled".into());
    let title = metadata
        .get("title")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .unwrap_or(fallback_title);
    let folder = metadata
        .get("folder")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            Path::new(&relative_path)
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .map(|parent| parent.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default()
        });
    let updated_at = metadata
        .get("updatedAt")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or(modified_at);
    Ok(DiskNote {
        relative_path,
        sha256,
        id,
        title,
        body,
        folder,
        metadata,
        updated_at,
    })
}

fn split_frontmatter(content: &str) -> HostResult<(Map<String, Value>, String)> {
    if !content.starts_with("---") {
        return Ok((Map::new(), content.to_owned()));
    }
    let first_line_end = content.find('\n').ok_or_else(|| {
        HostError::InvalidArgs("Markdown front matter has no terminating delimiter".into())
    })?;
    if content[..first_line_end].trim_end_matches('\r').trim() != "---" {
        return Ok((Map::new(), content.to_owned()));
    }
    let mut offset = first_line_end + 1;
    while offset <= content.len() {
        let line_end = content[offset..]
            .find('\n')
            .map(|relative| offset + relative)
            .unwrap_or(content.len());
        let line = content[offset..line_end].trim_end_matches('\r');
        if line.trim() == "---" {
            let yaml = &content[first_line_end + 1..offset];
            let body_start = if line_end < content.len() {
                line_end + 1
            } else {
                line_end
            };
            let yaml_value: Value = serde_yaml::from_str(yaml).map_err(|error| {
                HostError::InvalidArgs(format!(
                    "Markdown Note front matter is invalid YAML: {error}"
                ))
            })?;
            let metadata = yaml_value.as_object().cloned().ok_or_else(|| {
                HostError::InvalidArgs("Note front matter must be a YAML object".into())
            })?;
            let body = content[body_start..]
                .strip_prefix("\r\n")
                .or_else(|| content[body_start..].strip_prefix('\n'))
                .unwrap_or(&content[body_start..]);
            return Ok((metadata, body.to_owned()));
        }
        if line_end == content.len() {
            break;
        }
        offset = line_end + 1;
    }
    Err(HostError::InvalidArgs(
        "Markdown Note front matter has no closing delimiter".into(),
    ))
}

fn first_markdown_heading(body: &str) -> Option<String> {
    body.lines()
        .find_map(|line| line.strip_prefix("# ").map(str::trim))
        .filter(|title| !title.is_empty())
        .map(str::to_owned)
}

fn merge_optional_metadata(note: &mut Map<String, Value>, metadata: Map<String, Value>) {
    for key in [
        "tagIds",
        "bookId",
        "quote",
        "location",
        "attachments",
        "createdAt",
        "conflictOf",
    ] {
        if let Some(value) = metadata.get(key) {
            note.insert(key.to_owned(), value.clone());
        }
    }
}

fn visible_markdown_path_keys(notebook_directory: &Path) -> HostResult<HashSet<String>> {
    let mut paths = HashSet::new();
    for entry in WalkDir::new(notebook_directory)
        .follow_links(false)
        .into_iter()
        .filter_entry(include_visible_entry)
    {
        let entry = entry.map_err(|error| {
            HostError::Storage(format!(
                "Notebook collision scan failed while traversing folder: {error}"
            ))
        })?;
        if entry.file_type().is_symlink() || !entry.file_type().is_file() {
            continue;
        }
        if entry.path().extension().and_then(|value| value.to_str()) != Some("md") {
            continue;
        }
        let canonical = fs::canonicalize(entry.path())
            .map_err(|error| HostError::io("failed to validate Markdown path", error))?;
        ensure_within(notebook_directory, &canonical)?;
        let relative = canonical
            .strip_prefix(notebook_directory)
            .map_err(|_| HostError::Forbidden("Markdown note escapes Notebook directory".into()))?
            .to_string_lossy()
            .replace('\\', "/");
        paths.insert(relative.to_ascii_lowercase());
    }
    Ok(paths)
}

fn read_disk_note(
    notebook_directory: &Path,
    path: &Path,
    relative_path: &str,
) -> HostResult<DiskNote> {
    let metadata = fs::metadata(path)
        .map_err(|error| HostError::io("failed to inspect Markdown note", error))?;
    if metadata.len() > MAX_MARKDOWN_BYTES {
        return Err(HostError::Unsupported(format!(
            "Markdown note exceeds the {MAX_MARKDOWN_BYTES}-byte limit"
        )));
    }
    let canonical = fs::canonicalize(path)
        .map_err(|error| HostError::io("failed to validate Markdown note", error))?;
    ensure_within(notebook_directory, &canonical)?;
    if !canonical.is_file() {
        return Err(HostError::InvalidArgs(
            "indexed Notebook path is not a file".into(),
        ));
    }
    let content = fs::read_to_string(&canonical).map_err(|error| {
        HostError::io("Markdown note is not valid UTF-8 or is unreadable", error)
    })?;
    let sha256 = sha256_bytes(content.as_bytes());
    let modified_at = metadata
        .modified()
        .ok()
        .map(chrono::DateTime::<chrono::Utc>::from)
        .map(|time| time.to_rfc3339())
        .unwrap_or_else(now_rfc3339);
    parse_disk_note(relative_path.to_owned(), sha256, content, modified_at)
}

fn write_recovery_copy(
    notebook_directory: &Path,
    category: &str,
    note_id: &str,
    content_hash: &str,
    document: &str,
) -> HostResult<()> {
    let safe_id = sanitize_component(note_id)?;
    let relative = Path::new(INDEX_DIRECTORY_NAME).join(category).join(safe_id);
    let directory = create_safe_directory(notebook_directory, &relative)?;
    atomic_write_path(
        &directory.join(format!("{content_hash}.md")),
        document.as_bytes(),
    )
}

fn move_indexed_note_to_trash(
    notebook_directory: &Path,
    note_id: &str,
    relative_path: &str,
) -> HostResult<()> {
    let safe_relative = safe_relative_path(relative_path)?;
    let source = notebook_directory.join(&safe_relative);
    if !source.exists() {
        return Ok(());
    }
    let source_metadata = fs::symlink_metadata(&source)
        .map_err(|error| HostError::io("failed to inspect removed Notebook note", error))?;
    if source_metadata.file_type().is_symlink() {
        return Err(HostError::Forbidden(
            "refusing to move a symbolic link from the Notebook folder".into(),
        ));
    }
    if !source_metadata.is_file() {
        return Err(HostError::InvalidArgs(
            "indexed Notebook path is not a regular Markdown file".into(),
        ));
    }
    let canonical_source = fs::canonicalize(&source)
        .map_err(|error| HostError::io("failed to validate removed Notebook note", error))?;
    ensure_within(notebook_directory, &canonical_source)?;

    let safe_id = sanitize_component(note_id)?;
    let trash_relative = Path::new(INDEX_DIRECTORY_NAME).join("trash").join(safe_id);
    let trash_directory = create_safe_directory(notebook_directory, &trash_relative)?;
    let filename = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| HostError::InvalidArgs("Notebook file name is invalid".into()))?;
    let safe_filename = sanitize_component(filename)?;
    let timestamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ");
    let destination =
        trash_directory.join(format!("{timestamp}-{}-{safe_filename}", Uuid::new_v4()));
    fs::rename(&source, &destination).map_err(|error| {
        HostError::io(
            "failed to move removed Notebook note to recoverable trash",
            error,
        )
    })
}

fn include_visible_entry(entry: &walkdir::DirEntry) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    let name = entry.file_name().to_string_lossy();
    !name.starts_with('.') && name != "attachments"
}

fn required_string<'a>(
    note: &'a Map<String, Value>,
    field: &str,
    entity: &str,
) -> HostResult<&'a str> {
    note.get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            HostError::InvalidArgs(format!("{entity} has no non-empty string '{field}' field"))
        })
}

fn load_index(notebook_directory: &Path) -> HostResult<NotebookIndex> {
    let path = notebook_directory
        .join(INDEX_DIRECTORY_NAME)
        .join(INDEX_FILE_NAME);
    if !path.exists() {
        return Ok(NotebookIndex::default());
    }
    let bytes =
        fs::read(&path).map_err(|error| HostError::io("failed to read Notebook index", error))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| HostError::json("Notebook index is invalid; it will not be used", error))
}

fn write_index(notebook_directory: &Path, index: &NotebookIndex) -> HostResult<()> {
    let directory = create_safe_directory(notebook_directory, Path::new(INDEX_DIRECTORY_NAME))?;
    let bytes = serde_json::to_vec(index)
        .map_err(|error| HostError::json("failed to serialize Notebook index", error))?;
    atomic_write_path(&directory.join(INDEX_FILE_NAME), &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    fn state_with_note(body: &str) -> Value {
        json!({
            "schemaVersion": 1,
            "roots": [],
            "notes": [{
                "id": "note-1",
                "title": "Research Note",
                "body": body,
                "folder": "Papers",
                "tagIds": ["tag-1"],
                "createdAt": "2026-11-09T00:00:00.000Z",
                "updatedAt": "2026-11-09T00:00:00.000Z"
            }]
        })
    }

    #[test]
    fn save_mirrors_notes_to_portable_markdown() {
        let library = tempdir().expect("library");
        let state = state_with_note("# First\n\nBody");
        mirror_state(&state, library.path()).expect("mirror");
        let note_path = library.path().join("Notebook/Papers/Research Note.md");
        let content = fs::read_to_string(note_path).expect("markdown note");
        assert!(content.starts_with("---\n"));
        assert!(content.contains("graniteNoteId: note-1"));
        assert!(content.ends_with("# First\n\nBody"));
    }

    #[test]
    fn save_materializes_content_addressed_attachments_without_deleting_them() {
        let library = tempdir().expect("library");
        let bytes = b"portable attachment";
        let hash = sha256_bytes(bytes);
        let relative = format!("attachments/sha256/{hash}/figure.png");
        let mut state = state_with_note(&format!("# Figure\n\n[Figure]({relative})"));
        state["notes"][0]["attachments"] = json!([{
            "name": "figure.png",
            "path": relative,
            "data": format!("data:image/png;base64,{}", STANDARD.encode(bytes))
        }]);

        mirror_state(&state, library.path()).expect("mirror attachment");
        let note_parent = library.path().join("Notebook/Papers");
        assert_eq!(
            fs::read(note_parent.join(&relative)).expect("materialized attachment"),
            bytes
        );
        assert!(note_parent.join("Research Note.md").is_file());

        mirror_state(
            &json!({"schemaVersion": 1, "roots": [], "notes": []}),
            library.path(),
        )
        .expect("remove note");
        assert!(!note_parent.join("Research Note.md").exists());
        assert_eq!(
            fs::read(note_parent.join(&relative)).expect("attachment retained"),
            bytes
        );
    }

    #[test]
    fn attachment_materialization_rejects_traversal_and_unsafe_data_urls() {
        let library = tempdir().expect("library");
        let bytes = b"payload";
        let hash = sha256_bytes(bytes);
        let mut trailing = state_with_note("body");
        trailing["notes"][0]["attachments"] = json!([{
            "name": "payload.txt",
            "path": format!("attachments/sha256/{hash}/../payload.txt"),
            "data": format!("data:text/plain;base64,{}", STANDARD.encode(bytes))
        }]);
        assert!(mirror_state(&trailing, library.path()).is_err());
        assert!(!library
            .path()
            .join("Notebook/Papers/Research Note.md")
            .exists());

        let mut unsafe_url = state_with_note("body");
        unsafe_url["notes"][0]["attachments"] = json!([{
            "name": "payload.txt",
            "path": format!("attachments/sha256/{hash}/payload.txt"),
            "data": "data:text/plain,payload"
        }]);
        assert!(mirror_state(&unsafe_url, library.path()).is_err());
        assert!(!library
            .path()
            .join("Notebook/Papers/Research Note.md")
            .exists());
    }

    #[test]
    fn attachment_materialization_verifies_content_address_hash() {
        let library = tempdir().expect("library");
        let expected = b"expected";
        let wrong = b"wrong";
        let expected_hash = sha256_bytes(expected);
        let mut state = state_with_note("body");
        state["notes"][0]["attachments"] = json!([{
            "name": "payload.bin",
            "path": format!("attachments/sha256/{expected_hash}/payload.bin"),
            "data": format!("application/octet-stream;base64,{}", STANDARD.encode(wrong))
        }]);
        state["notes"][0]["attachments"][0]["data"] = Value::String(format!(
            "data:application/octet-stream;base64,{}",
            STANDARD.encode(wrong)
        ));

        assert!(mirror_state(&state, library.path()).is_err());
        assert!(!library
            .path()
            .join("Notebook/Papers/Research Note.md")
            .exists());
    }

    #[test]
    fn attachment_materialization_preserves_conflicting_hash_path() {
        let library = tempdir().expect("library");
        let expected = b"expected";
        let conflict = b"different existing bytes";
        let hash = sha256_bytes(expected);
        let relative = Path::new("attachments")
            .join("sha256")
            .join(&hash)
            .join("payload.bin");
        let target = library.path().join("Notebook/Papers").join(&relative);
        fs::create_dir_all(target.parent().expect("attachment parent"))
            .expect("attachment directory");
        fs::write(&target, conflict).expect("conflicting attachment");
        let mut state = state_with_note("body");
        state["notes"][0]["attachments"] = json!([{
            "name": "payload.bin",
            "path": relative.to_string_lossy().replace('\\', "/"),
            "data": format!("data:application/octet-stream;base64,{}", STANDARD.encode(expected))
        }]);

        assert!(mirror_state(&state, library.path()).is_err());
        assert_eq!(
            fs::read(target).expect("conflicting bytes preserved"),
            conflict
        );
        assert!(!library
            .path()
            .join("Notebook/Papers/Research Note.md")
            .exists());
    }

    #[test]
    fn save_metadata_only_attachment_preserves_external_file_and_frontmatter() {
        let library = tempdir().expect("library");
        let bytes = b"metadata-only external attachment";
        let relative = "assets/external.pdf";
        let note_parent = library.path().join("Notebook/Papers");
        let external_file = note_parent.join(relative);
        fs::create_dir_all(external_file.parent().expect("attachment parent"))
            .expect("attachment directory");
        fs::write(&external_file, bytes).expect("external attachment");

        let mut state = state_with_note(&format!("# External\n\n[PDF]({relative})"));
        state["notes"][0]["attachments"] = json!([{
            "name": "external.pdf",
            "path": relative
        }]);

        mirror_state(&state, library.path()).expect("state save with metadata-only attachment");
        let note_path = note_parent.join("Research Note.md");
        let content = fs::read_to_string(&note_path).expect("mirrored note");
        assert!(content.contains("path: assets/external.pdf"));
        assert!(!content.contains("data:"));
        assert_eq!(
            fs::read(&external_file).expect("external attachment retained"),
            bytes
        );

        state["notes"][0]["attachments"][0]["data"] = Value::Null;
        mirror_state(&state, library.path()).expect("state save with null attachment data");
        let content = fs::read_to_string(&note_path).expect("mirrored null-data note");
        assert!(content.contains("path: assets/external.pdf"));
        assert!(content.contains("data: null"));
        assert_eq!(
            fs::read(&external_file).expect("external attachment retained after null data"),
            bytes
        );
    }

    #[test]
    fn missing_notes_field_does_not_trash_managed_notes() {
        let library = tempdir().expect("library");
        let mut state = state_with_note("Keep me");
        mirror_state(&state, library.path()).expect("initial mirror");
        let note_path = library.path().join("Notebook/Papers/Research Note.md");
        let original = fs::read_to_string(&note_path).expect("read note");

        state.as_object_mut().expect("state object").remove("notes");
        assert!(mirror_state(&state, library.path()).is_err());
        assert_eq!(
            fs::read_to_string(&note_path).expect("managed note remains"),
            original
        );
        assert!(!library.path().join("Notebook/.granite/trash").exists());
    }

    #[test]
    fn load_uses_modified_markdown_as_source() {
        let library = tempdir().expect("library");
        let state = state_with_note("old body");
        mirror_state(&state, library.path()).expect("mirror");
        let note_path = library.path().join("Notebook/Papers/Research Note.md");
        let existing = fs::read_to_string(&note_path).expect("read note");
        let modified = existing.replace("old body", "new body from Obsidian");
        fs::write(&note_path, modified).expect("external edit");

        let synced = sync_from_disk(&state, library.path()).expect("sync");
        assert_eq!(synced["notes"][0]["body"], "new body from Obsidian");
        assert_eq!(synced["notes"][0]["tagIds"][0], "tag-1");
    }

    #[test]
    fn load_imports_unindexed_markdown_and_removes_deleted_managed_notes() {
        let library = tempdir().expect("library");
        let state = state_with_note("managed body");
        mirror_state(&state, library.path()).expect("mirror");
        fs::write(
            library.path().join("Notebook/External.md"),
            "# External\n\nText",
        )
        .expect("external");
        fs::remove_file(library.path().join("Notebook/Papers/Research Note.md"))
            .expect("delete managed note");

        let synced = sync_from_disk(&state, library.path()).expect("sync");
        let notes = synced["notes"].as_array().expect("notes");
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0]["title"], "External");
        assert_eq!(notes[0]["body"], "# External\n\nText");
    }

    #[test]
    fn rejects_note_folder_traversal() {
        let library = tempdir().expect("library");
        let state = json!({
            "schemaVersion": 1,
            "roots": [],
            "notes": [{
                "id": "note-1",
                "title": "Unsafe",
                "body": "body",
                "folder": "../outside"
            }]
        });
        assert!(mirror_state(&state, library.path()).is_err());
    }

    #[test]
    fn external_edit_during_running_app_is_preserved_with_conflict_copy() {
        let library = tempdir().expect("library");
        let original = state_with_note("original state body");
        mirror_state(&original, library.path()).expect("initial mirror");
        let note_path = library.path().join("Notebook/Papers/Research Note.md");
        let external = fs::read_to_string(&note_path)
            .expect("read note")
            .replace("original state body", "external edit while app was running");
        fs::write(&note_path, &external).expect("external edit");

        let changed = state_with_note("new state body");
        mirror_state(&changed, library.path()).expect("conflict-aware mirror");
        assert_eq!(
            fs::read_to_string(&note_path).expect("external preserved"),
            external
        );
        let conflicts = WalkDir::new(library.path().join("Notebook/.granite/conflicts"))
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_file())
            .collect::<Vec<_>>();
        assert_eq!(conflicts.len(), 1);
        assert!(fs::read_to_string(conflicts[0].path())
            .expect("conflict content")
            .contains("new state body"));
    }

    #[test]
    fn deleted_indexed_note_moves_to_trash_and_unrelated_markdown_is_untouched() {
        let library = tempdir().expect("library");
        let managed = state_with_note("managed");
        mirror_state(&managed, library.path()).expect("mirror managed note");
        let unrelated = library.path().join("Notebook/Unrelated.md");
        fs::write(&unrelated, "# Keep me\n").expect("unrelated note");

        let empty = json!({"schemaVersion": 1, "roots": [], "notes": []});
        mirror_state(&empty, library.path()).expect("remove managed note");
        assert!(!library
            .path()
            .join("Notebook/Papers/Research Note.md")
            .exists());
        assert_eq!(
            fs::read_to_string(&unrelated).expect("unrelated note preserved"),
            "# Keep me\n"
        );
        assert!(WalkDir::new(library.path().join("Notebook/.granite/trash"))
            .into_iter()
            .filter_map(Result::ok)
            .any(|entry| entry.file_type().is_file()
                && entry
                    .file_name()
                    .to_string_lossy()
                    .contains("Research Note.md")));
    }

    #[test]
    fn unrelated_markdown_with_same_derived_name_is_never_overwritten() {
        let library = tempdir().expect("library");
        let directory = library.path().join("Notebook/Papers");
        fs::create_dir_all(&directory).expect("notebook folder");
        let unrelated = directory.join("Research Note.md");
        fs::write(&unrelated, "# Unrelated\n").expect("unrelated note");

        mirror_state(&state_with_note("managed"), library.path()).expect("mirror");
        assert_eq!(
            fs::read_to_string(&unrelated).expect("unrelated preserved"),
            "# Unrelated\n"
        );
        assert!(WalkDir::new(&directory)
            .into_iter()
            .filter_map(Result::ok)
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with("Research Note-note-1")));
    }

    #[test]
    fn inaccessible_configured_root_errors_without_mutating_state() {
        let fallback = tempdir().expect("fallback");
        let state = json!({
            "schemaVersion": 1,
            "roots": [{
                "id": "missing",
                "displayName": "Missing",
                "path": fallback.path().join("not-mounted").to_string_lossy(),
                "kind": "filesystem",
                "permission": "granted",
                "enabled": true,
                "isDefault": true,
                "readonly": false,
                "scanState": "idle"
            }],
            "notes": [{
                "id": "note-1",
                "title": "Note",
                "body": "body",
                "folder": "",
                "tagIds": []
            }]
        });
        let result = sync_from_disk(&state, fallback.path());
        assert!(result.is_err());
        assert_eq!(state["notes"].as_array().expect("notes").len(), 1);
    }

    #[test]
    fn notebook_metadata_file_is_never_replaced_by_a_directory() {
        let library = tempdir().expect("library");
        let notebook = library.path().join("Notebook");
        fs::create_dir(&notebook).expect("notebook");
        fs::write(notebook.join(".granite"), b"keep this metadata").expect("metadata file");

        assert!(mirror_state(&state_with_note("body"), library.path()).is_err());
        assert_eq!(
            fs::read(notebook.join(".granite")).expect("metadata preserved"),
            b"keep this metadata"
        );
    }
}
