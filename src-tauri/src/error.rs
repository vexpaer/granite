use std::io;

use thiserror::Error;

pub type HostResult<T> = Result<T, HostError>;

#[derive(Debug, Error)]
pub enum HostError {
    #[error("invalid_args: {0}")]
    InvalidArgs(String),
    #[error("forbidden: {0}")]
    Forbidden(String),
    #[error("not_found: {0}")]
    NotFound(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("unsupported: {0}")]
    Unsupported(String),
    #[error("cancelled: {0}")]
    Cancelled(String),
    #[error("storage: {0}")]
    Storage(String),
    #[error("database: {0}")]
    Database(String),
    #[error("credential: {0}")]
    Credential(String),
    #[error("network: {0}")]
    Network(String),
    #[error("internal: {0}")]
    Internal(String),
}

impl HostError {
    pub fn io(context: impl AsRef<str>, error: io::Error) -> Self {
        Self::Storage(format!("{}: {error}", context.as_ref()))
    }

    pub fn db(context: impl AsRef<str>, error: rusqlite::Error) -> Self {
        Self::Database(format!("{}: {error}", context.as_ref()))
    }

    pub fn json(context: impl AsRef<str>, error: serde_json::Error) -> Self {
        Self::Storage(format!("{}: {error}", context.as_ref()))
    }
}

impl From<io::Error> for HostError {
    fn from(error: io::Error) -> Self {
        Self::Storage(error.to_string())
    }
}

impl From<rusqlite::Error> for HostError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Database(error.to_string())
    }
}

impl From<serde_json::Error> for HostError {
    fn from(error: serde_json::Error) -> Self {
        Self::Storage(format!("JSON serialization failed: {error}"))
    }
}

impl From<reqwest::Error> for HostError {
    fn from(error: reqwest::Error) -> Self {
        Self::Network(error.to_string())
    }
}
