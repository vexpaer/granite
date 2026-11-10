use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};

use serde::Serialize;

use crate::error::{HostError, HostResult};
use crate::models::LibraryRoot;
use crate::paths::safe_existing_file;

pub const MAX_RANGE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookStreamStat {
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

pub fn stat(root: &LibraryRoot, relative_path: &str) -> HostResult<BookStreamStat> {
    let path = safe_existing_file(root, relative_path)?;
    let metadata =
        fs::metadata(&path).map_err(|error| HostError::io("failed to inspect book", error))?;
    if !metadata.is_file() {
        return Err(HostError::InvalidArgs(
            "book path does not point to a regular file".into(),
        ));
    }
    Ok(BookStreamStat {
        size: metadata.len(),
        sha256: None,
    })
}

pub fn read_range(
    root: &LibraryRoot,
    relative_path: &str,
    offset: u64,
    length: u64,
) -> HostResult<Vec<u8>> {
    if length == 0 {
        return Err(HostError::InvalidArgs(
            "book range length must be greater than zero".into(),
        ));
    }
    if length > MAX_RANGE_BYTES {
        return Err(HostError::InvalidArgs(format!(
            "book range length {length} exceeds the {MAX_RANGE_BYTES}-byte limit"
        )));
    }

    let path = safe_existing_file(root, relative_path)?;
    let mut file = File::open(&path)
        .map_err(|error| HostError::io("failed to open book for ranged read", error))?;
    let size = file
        .metadata()
        .map_err(|error| HostError::io("failed to inspect open book", error))?
        .len();
    let end = offset
        .checked_add(length)
        .ok_or_else(|| HostError::InvalidArgs("book range offset and length overflow".into()))?;
    if end > size {
        return Err(HostError::InvalidArgs(format!(
            "book range {offset}..{end} exceeds file size {size}"
        )));
    }

    file.seek(SeekFrom::Start(offset))
        .map_err(|error| HostError::io("failed to seek within book", error))?;
    let capacity = usize::try_from(length)
        .map_err(|_| HostError::InvalidArgs("book range is too large for this host".into()))?;
    let mut bytes = vec![0_u8; capacity];
    file.read_exact(&mut bytes)
        .map_err(|error| HostError::io("failed to read requested book range", error))?;
    Ok(bytes)
}
