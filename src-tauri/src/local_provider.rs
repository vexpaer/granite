use std::collections::BTreeMap;
use std::fs::{self, File, Metadata};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::error::{HostError, HostResult};
use crate::filesystem::{atomic_write_path, sha256_bytes, sha256_file, MAX_IPC_FILE_BYTES};
use crate::models::{LibraryRoot, ProviderProfile, ProviderResponse, ProviderType};
use crate::paths::{
    create_safe_directory, relative_path_string, require_filesystem_root, safe_relative_path,
};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalProviderObject {
    key: String,
    size: u64,
    etag: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_modified: Option<String>,
}

struct LocalProvider {
    root: LibraryRoot,
    canonical_root: PathBuf,
    prefix_path: PathBuf,
}

pub fn request(
    profile: &ProviderProfile,
    method: &str,
    key: &str,
    body: Option<&[u8]>,
    headers: &BTreeMap<String, String>,
    lock: &Mutex<()>,
) -> HostResult<ProviderResponse> {
    if profile.provider_type != ProviderType::Local {
        return Err(HostError::InvalidArgs(
            "local provider request requires a local profile".into(),
        ));
    }
    let _guard = lock
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let provider = LocalProvider::new(profile)?;
    match method.trim().to_ascii_uppercase().as_str() {
        "LIST" => provider.list(key),
        "GET" => provider.read(key, false, headers),
        "HEAD" => provider.read(key, true, headers),
        "PUT" => provider.write(key, body.unwrap_or_default(), headers),
        "DELETE" => provider.delete(key, headers),
        other => Err(HostError::Unsupported(format!(
            "local provider does not support method '{other}'"
        ))),
    }
}

impl LocalProvider {
    fn new(profile: &ProviderProfile) -> HostResult<Self> {
        let root = profile.root.clone().ok_or_else(|| {
            HostError::InvalidArgs("local provider profile requires a library root".into())
        })?;
        if profile.endpoint != root.path {
            return Err(HostError::InvalidArgs(
                "local provider endpoint must match the library root path".into(),
            ));
        }
        let prefix_path = normalize_prefix(&profile.prefix)?;
        let safe_root = require_filesystem_root(&root, false)?;
        Ok(Self {
            root,
            canonical_root: safe_root.canonical_path,
            prefix_path,
        })
    }

    fn list(&self, key: &str) -> HostResult<ProviderResponse> {
        let (_, relative) = self.object_key(key, true)?;
        let directory = self.canonical_root.join(&relative);
        ensure_no_link_components(&self.canonical_root, &relative)?;
        let metadata = match fs::symlink_metadata(&directory) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return list_response(Vec::new());
            }
            Err(error) => {
                return Err(HostError::io(
                    "failed to inspect local provider prefix",
                    error,
                ))
            }
        };

        let mut objects = Vec::new();
        if metadata.is_file() {
            objects.push(self.object_for_path(&directory)?);
        } else if metadata.is_dir() {
            for entry in WalkDir::new(&directory).follow_links(false).into_iter() {
                let entry = entry.map_err(|error| {
                    HostError::Storage(format!(
                        "local provider listing failed while traversing a directory: {error}"
                    ))
                })?;
                if entry.depth() == 0
                    || entry.file_type().is_symlink()
                    || !entry.file_type().is_file()
                {
                    continue;
                }
                if entry.file_name().to_string_lossy().starts_with(".granite-")
                    && entry.file_name().to_string_lossy().ends_with(".tmp")
                {
                    continue;
                }
                let relative = relative_path_string(&self.canonical_root, entry.path())?;
                if !Path::new(&relative).starts_with(&self.prefix_path) {
                    continue;
                }
                objects.push(self.object_for_path(entry.path())?);
            }
        } else {
            return Err(HostError::Forbidden(
                "local provider prefix is not a regular directory or file".into(),
            ));
        }
        objects.sort_by(|left, right| left.key.cmp(&right.key));
        list_response(objects)
    }

    fn read(
        &self,
        key: &str,
        head_only: bool,
        headers: &BTreeMap<String, String>,
    ) -> HostResult<ProviderResponse> {
        let (_, relative) = self.object_key(key, false)?;
        let Some(path) = self.existing_file(&relative)? else {
            return Ok(empty_response(404));
        };
        let metadata = fs::metadata(&path)
            .map_err(|error| HostError::io("failed to inspect local provider object", error))?;
        let etag = etag_for_path(&path)?;
        if let Some(response) = precondition_response(headers, Some(&etag), true, true) {
            return Ok(response);
        }
        let total = metadata.len();
        let requested_range = match header_value(headers, "range") {
            Some(value) => match parse_byte_range(value, total) {
                Ok(range) => Some(range),
                Err(()) => return Ok(range_not_satisfiable_response(total)),
            },
            None => None,
        };
        let (status, start, length) = match requested_range.as_ref() {
            Some(range) => (206, range.start, range.length()),
            None => {
                if total > MAX_IPC_FILE_BYTES {
                    return Err(HostError::Unsupported(format!(
                        "local provider object exceeds the {MAX_IPC_FILE_BYTES}-byte native bridge limit"
                    )));
                }
                (200, 0, total)
            }
        };
        let mut response_headers = object_headers(&metadata, &etag);
        response_headers.insert("accept-ranges".into(), "bytes".into());
        response_headers.insert("content-length".into(), length.to_string());
        if let Some(range) = requested_range.as_ref() {
            response_headers.insert(
                "content-range".into(),
                format!("bytes {}-{}/{}", range.start, range.end, total),
            );
        }
        if head_only {
            return Ok(ProviderResponse {
                status,
                headers: response_headers,
                body: Vec::new(),
            });
        }
        let mut file = File::open(&path)
            .map_err(|error| HostError::io("failed to open local provider object", error))?;
        if start > 0 {
            file.seek(SeekFrom::Start(start))
                .map_err(|error| HostError::io("failed to seek local provider object", error))?;
        }
        let length = usize::try_from(length)
            .map_err(|_| HostError::Unsupported("local provider range is too large".into()))?;
        let mut body = vec![0_u8; length];
        file.read_exact(&mut body)
            .map_err(|error| HostError::io("failed to read local provider object", error))?;
        Ok(ProviderResponse {
            status,
            headers: response_headers,
            body,
        })
    }

    fn write(
        &self,
        key: &str,
        body: &[u8],
        headers: &BTreeMap<String, String>,
    ) -> HostResult<ProviderResponse> {
        let (_, relative) = self.object_key(key, false)?;
        let safe_root = require_filesystem_root(&self.root, true)?;
        let existing = self.existing_file(&relative)?;
        let current_etag = existing
            .as_ref()
            .map(|path| etag_for_path(path))
            .transpose()?;
        if let Some(response) =
            precondition_response(headers, current_etag.as_deref(), existing.is_some(), false)
        {
            return Ok(response);
        }
        let checksum = sha256_bytes(body);
        if let Some(expected) = header_value(headers, "x-granite-sha256") {
            if !is_sha256(expected) {
                return Ok(empty_response(400));
            }
            if !expected.eq_ignore_ascii_case(&checksum) {
                return Ok(empty_response(400));
            }
        }
        let parent = relative
            .parent()
            .ok_or_else(|| HostError::Forbidden("local provider object has no parent".into()))?;
        create_safe_directory(&safe_root.canonical_path, parent)?;
        let target = safe_root.canonical_path.join(&relative);
        atomic_write_path(&target, body)?;
        let metadata = fs::metadata(&target)
            .map_err(|error| HostError::io("failed to inspect written provider object", error))?;
        let written_etag = etag_for_path(&target)?;
        let mut response_headers = object_headers(&metadata, &written_etag);
        response_headers.insert("x-granite-sha256".into(), checksum);
        Ok(ProviderResponse {
            status: if existing.is_some() { 204 } else { 201 },
            headers: response_headers,
            body: Vec::new(),
        })
    }

    fn delete(
        &self,
        key: &str,
        headers: &BTreeMap<String, String>,
    ) -> HostResult<ProviderResponse> {
        let (_, relative) = self.object_key(key, false)?;
        let _writable_root = require_filesystem_root(&self.root, true)?;
        let Some(path) = self.existing_file(&relative)? else {
            return Ok(empty_response(404));
        };
        let current_etag = etag_for_path(&path)?;
        if let Some(response) = precondition_response(headers, Some(&current_etag), true, false) {
            return Ok(response);
        }
        fs::remove_file(&path)
            .map_err(|error| HostError::io("failed to delete local provider object", error))?;
        Ok(empty_response(204))
    }

    fn existing_file(&self, relative: &Path) -> HostResult<Option<PathBuf>> {
        ensure_no_link_components(&self.canonical_root, relative)?;
        let candidate = self.canonical_root.join(relative);
        let metadata = match fs::symlink_metadata(&candidate) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(HostError::io(
                    "failed to inspect local provider object",
                    error,
                ))
            }
        };
        if !metadata.is_file() {
            return Err(HostError::Conflict(
                "local provider object path is not a regular file".into(),
            ));
        }
        let canonical = fs::canonicalize(&candidate)
            .map_err(|error| HostError::io("failed to validate local provider object", error))?;
        if !canonical.starts_with(&self.canonical_root) {
            return Err(HostError::Forbidden(
                "local provider object resolves outside its library root".into(),
            ));
        }
        let prefix = self.canonical_root.join(&self.prefix_path);
        if !canonical.starts_with(&prefix) {
            return Err(HostError::Forbidden(
                "local provider object resolves outside its provider prefix".into(),
            ));
        }
        Ok(Some(canonical))
    }

    fn object_key(&self, key: &str, allow_directory: bool) -> HostResult<(String, PathBuf)> {
        let normalized = normalize_key(key)?;
        let relative = safe_relative_path(&normalized)?;
        if !relative.starts_with(&self.prefix_path) {
            return Err(HostError::Forbidden(
                "local provider key is outside the configured provider prefix".into(),
            ));
        }
        if !allow_directory && relative == self.prefix_path {
            return Err(HostError::Forbidden(
                "local provider object key must be below the provider prefix".into(),
            ));
        }
        Ok((normalized, relative))
    }

    fn object_for_path(&self, path: &Path) -> HostResult<LocalProviderObject> {
        let metadata = fs::metadata(path)
            .map_err(|error| HostError::io("failed to inspect listed provider object", error))?;
        if !metadata.is_file() {
            return Err(HostError::Conflict(
                "local provider listing contains a non-file object".into(),
            ));
        }
        Ok(LocalProviderObject {
            key: relative_path_string(&self.canonical_root, path)?,
            size: metadata.len(),
            etag: etag_for_path(path)?,
            last_modified: last_modified(&metadata),
        })
    }
}

fn normalize_prefix(value: &str) -> HostResult<PathBuf> {
    if value.trim().is_empty() {
        return Err(HostError::InvalidArgs(
            "local provider prefix cannot be empty".into(),
        ));
    }
    safe_relative_path(value.trim_end_matches(['/', '\\']))
}

fn normalize_key(value: &str) -> HostResult<String> {
    let normalized = value.replace('\\', "/");
    let normalized = normalized.trim_end_matches('/');
    if normalized.is_empty() {
        return Err(HostError::InvalidArgs(
            "local provider key cannot be empty".into(),
        ));
    }
    Ok(normalized.to_owned())
}

fn ensure_no_link_components(root: &Path, relative: &Path) -> HostResult<()> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(HostError::Forbidden(
                "local provider path contains an unsafe component".into(),
            ));
        };
        current.push(name);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if is_link_or_reparse_point(&metadata) => {
                return Err(HostError::Forbidden(
                    "local provider paths cannot traverse links or reparse points".into(),
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(HostError::io(
                    "failed to inspect local provider path",
                    error,
                ))
            }
        }
    }
    Ok(())
}

fn is_link_or_reparse_point(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

fn etag_for_path(path: &Path) -> HostResult<String> {
    Ok(format!("\"{}\"", sha256_file(path)?))
}

fn last_modified(metadata: &Metadata) -> Option<String> {
    metadata
        .modified()
        .ok()
        .map(DateTime::<Utc>::from)
        .map(|time| time.to_rfc2822())
}

fn object_headers(metadata: &Metadata, etag: &str) -> BTreeMap<String, String> {
    let mut headers = BTreeMap::new();
    headers.insert("content-type".into(), "application/octet-stream".into());
    headers.insert("etag".into(), etag.to_owned());
    headers.insert("content-length".into(), metadata.len().to_string());
    if let Some(last_modified) = last_modified(metadata) {
        headers.insert("last-modified".into(), last_modified);
    }
    headers
}

fn list_response(objects: Vec<LocalProviderObject>) -> HostResult<ProviderResponse> {
    let body = serde_json::to_vec(&objects)
        .map_err(|error| HostError::json("failed to serialize local provider listing", error))?;
    let mut headers = BTreeMap::new();
    headers.insert("content-type".into(), "application/json".into());
    headers.insert("content-length".into(), body.len().to_string());
    Ok(ProviderResponse {
        status: 200,
        headers,
        body,
    })
}

fn empty_response(status: u16) -> ProviderResponse {
    ProviderResponse {
        status,
        headers: BTreeMap::new(),
        body: Vec::new(),
    }
}

fn range_not_satisfiable_response(total: u64) -> ProviderResponse {
    let mut response = empty_response(416);
    response
        .headers
        .insert("content-range".into(), format!("bytes */{total}"));
    response
}

fn precondition_response(
    headers: &BTreeMap<String, String>,
    current_etag: Option<&str>,
    exists: bool,
    read_request: bool,
) -> Option<ProviderResponse> {
    if let Some(value) = header_value(headers, "if-match") {
        if !etag_list_matches(value, current_etag, exists) {
            return Some(precondition_failed_response(current_etag));
        }
    }
    if let Some(value) = header_value(headers, "if-none-match") {
        if etag_list_matches(value, current_etag, exists) {
            return Some(if read_request {
                not_modified_response(current_etag)
            } else {
                precondition_failed_response(current_etag)
            });
        }
    }
    None
}

fn precondition_failed_response(current_etag: Option<&str>) -> ProviderResponse {
    let mut response = empty_response(412);
    if let Some(etag) = current_etag {
        response.headers.insert("etag".into(), etag.to_owned());
    }
    response
}

fn not_modified_response(current_etag: Option<&str>) -> ProviderResponse {
    let mut response = empty_response(304);
    if let Some(etag) = current_etag {
        response.headers.insert("etag".into(), etag.to_owned());
    }
    response
}

fn etag_list_matches(value: &str, current_etag: Option<&str>, exists: bool) -> bool {
    let current = current_etag.map(unquote_etag);
    value.split(',').any(|candidate| {
        let candidate = candidate.trim();
        if candidate == "*" {
            return exists;
        }
        current
            .as_deref()
            .is_some_and(|current| unquote_etag(candidate).eq_ignore_ascii_case(current))
    })
}

fn unquote_etag(value: &str) -> &str {
    value
        .trim()
        .strip_prefix("W/")
        .unwrap_or(value.trim())
        .trim()
        .trim_matches('"')
}

fn header_value<'a>(headers: &'a BTreeMap<String, String>, name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

struct ByteRange {
    start: u64,
    end: u64,
}

impl ByteRange {
    fn length(&self) -> u64 {
        self.end - self.start + 1
    }
}

fn parse_byte_range(value: &str, total: u64) -> Result<ByteRange, ()> {
    if total == 0 {
        return Err(());
    }
    let value = value.trim();
    let range = value.strip_prefix("bytes=").ok_or(())?;
    if range.contains(',') {
        return Err(());
    }
    let (start, end) = range.split_once('-').ok_or(())?;
    if start.is_empty() {
        let suffix = end.parse::<u64>().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        let length = suffix.min(total);
        return Ok(ByteRange {
            start: total - length,
            end: total - 1,
        });
    }
    let start = start.parse::<u64>().map_err(|_| ())?;
    if start >= total {
        return Err(());
    }
    let end = if end.is_empty() {
        total - 1
    } else {
        end.parse::<u64>().map_err(|_| ())?.min(total - 1)
    };
    if end < start {
        return Err(());
    }
    Ok(ByteRange { start, end })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::make_default_root;
    use tempfile::tempdir;

    fn local_profile(root: &LibraryRoot) -> ProviderProfile {
        ProviderProfile {
            id: "local-sync".into(),
            provider_type: ProviderType::Local,
            name: "Local".into(),
            endpoint: root.path.clone(),
            username: None,
            region: None,
            bucket: None,
            prefix: ".granite-provider".into(),
            credential_id: String::new(),
            access_key_id: None,
            root: Some(root.clone()),
        }
    }

    #[test]
    fn local_provider_crud_range_and_listing_are_prefix_bound() {
        let directory = tempdir().expect("library");
        let root = make_default_root(directory.path().to_path_buf());
        let profile = local_profile(&root);
        let lock = Mutex::new(());
        let headers = BTreeMap::new();
        let key = ".granite-provider/sync/device-a.json";

        let put = request(
            &profile,
            "PUT",
            key,
            Some(br#"{"revision":1}"#),
            &headers,
            &lock,
        )
        .expect("put");
        assert_eq!(put.status, 201);
        assert!(put.headers.contains_key("x-granite-sha256"));

        let mut range_headers = BTreeMap::new();
        range_headers.insert("Range".into(), "bytes=2-9".into());
        let ranged = request(&profile, "GET", key, None, &range_headers, &lock).expect("range");
        assert_eq!(ranged.status, 206);
        assert_eq!(ranged.body, br#"revision"#);
        assert_eq!(
            ranged.headers.get("content-range").map(String::as_str),
            Some("bytes 2-9/14")
        );

        let head = request(&profile, "HEAD", key, None, &headers, &lock).expect("head");
        assert_eq!(head.status, 200);
        assert_eq!(
            head.headers.get("content-length").map(String::as_str),
            Some("14")
        );

        fs::write(directory.path().join("external.txt"), b"external").expect("external file");
        let listed = request(
            &profile,
            "LIST",
            ".granite-provider/sync/",
            None,
            &headers,
            &lock,
        )
        .expect("list");
        let objects: Vec<LocalProviderObject> =
            serde_json::from_slice(&listed.body).expect("listing JSON");
        assert_eq!(objects.len(), 1);
        assert_eq!(objects[0].key, key);

        let deleted = request(
            &profile,
            "DELETE",
            ".granite-provider/../external.txt",
            None,
            &headers,
            &lock,
        );
        assert!(deleted.is_err());
        assert_eq!(
            fs::read(directory.path().join("external.txt")).expect("external preserved"),
            b"external"
        );
        assert!(request(
            &profile,
            "HEAD",
            ".granite-provider-evil/file.txt",
            None,
            &headers,
            &lock,
        )
        .is_err());

        let deleted = request(&profile, "DELETE", key, None, &headers, &lock).expect("delete");
        assert_eq!(deleted.status, 204);
        assert!(!directory.path().join(key).exists());
    }

    #[test]
    fn local_provider_enforces_conditional_writes_without_replacing_on_failure() {
        let directory = tempdir().expect("library");
        let root = make_default_root(directory.path().to_path_buf());
        let profile = local_profile(&root);
        let lock = Mutex::new(());
        let empty_headers = BTreeMap::new();
        let key = ".granite-provider/sync/protocol.json";

        let first = request(&profile, "PUT", key, Some(b"first"), &empty_headers, &lock)
            .expect("initial put");
        assert_eq!(first.status, 201);
        let etag = first.headers.get("etag").expect("etag").clone();

        let mut create_only = BTreeMap::new();
        create_only.insert("If-None-Match".into(), "*".into());
        let rejected = request(
            &profile,
            "PUT",
            key,
            Some(b"replacement"),
            &create_only,
            &lock,
        )
        .expect("conditional put");
        assert_eq!(rejected.status, 412);
        assert_eq!(
            fs::read(directory.path().join(key)).expect("unchanged"),
            b"first"
        );

        let mut stale_match = BTreeMap::new();
        stale_match.insert("If-Match".into(), "\"stale\"".into());
        let rejected = request(
            &profile,
            "PUT",
            key,
            Some(b"replacement"),
            &stale_match,
            &lock,
        )
        .expect("stale conditional put");
        assert_eq!(rejected.status, 412);

        let mut matching = BTreeMap::new();
        matching.insert("If-Match".into(), etag);
        let replaced = request(&profile, "PUT", key, Some(b"replacement"), &matching, &lock)
            .expect("matching conditional put");
        assert_eq!(replaced.status, 204);
        assert_eq!(
            fs::read(directory.path().join(key)).expect("replaced"),
            b"replacement"
        );
    }

    #[test]
    fn local_provider_rejects_invalid_ranges_and_checksum_headers() {
        let directory = tempdir().expect("library");
        let root = make_default_root(directory.path().to_path_buf());
        let profile = local_profile(&root);
        let lock = Mutex::new(());
        let key = ".granite-provider/sync/data.bin";
        let empty_headers = BTreeMap::new();
        request(
            &profile,
            "PUT",
            key,
            Some(b"0123456789"),
            &empty_headers,
            &lock,
        )
        .expect("put");

        let mut range_headers = BTreeMap::new();
        range_headers.insert("Range".into(), "bytes=99-".into());
        let ranged = request(&profile, "GET", key, None, &range_headers, &lock).expect("range");
        assert_eq!(ranged.status, 416);

        let mut checksum_headers = BTreeMap::new();
        checksum_headers.insert("x-granite-sha256".into(), "0".repeat(64));
        let rejected = request(
            &profile,
            "PUT",
            key,
            Some(b"replacement"),
            &checksum_headers,
            &lock,
        )
        .expect("checksum response");
        assert_eq!(rejected.status, 400);
        assert_eq!(
            fs::read(directory.path().join(key)).expect("unchanged"),
            b"0123456789"
        );
    }
}
