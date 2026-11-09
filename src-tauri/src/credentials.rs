use crate::error::{HostError, HostResult};

const SERVICE_NAME: &str = "app.granite.reader.credentials";

fn validate_credential_id(id: &str) -> HostResult<()> {
    if id.trim().is_empty() || id.len() > 1024 || id.chars().any(char::is_control) {
        return Err(HostError::InvalidArgs(
            "credential ID must be non-empty, at most 1024 characters, and contain no control characters"
                .into(),
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn set_credential(id: &str, secret: &str) -> HostResult<()> {
    validate_credential_id(id)?;
    if secret.is_empty() {
        return Err(HostError::InvalidArgs(
            "credential secret cannot be empty".into(),
        ));
    }
    let entry = keyring::Entry::new(SERVICE_NAME, id).map_err(|error| {
        HostError::Credential(format!("Credential Manager entry failed: {error}"))
    })?;
    entry
        .set_password(secret)
        .map_err(|error| HostError::Credential(format!("failed to store credential: {error}")))
}

#[cfg(target_os = "windows")]
pub fn delete_credential(id: &str) -> HostResult<()> {
    validate_credential_id(id)?;
    let entry = keyring::Entry::new(SERVICE_NAME, id).map_err(|error| {
        HostError::Credential(format!("Credential Manager entry failed: {error}"))
    })?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(HostError::Credential(format!(
            "failed to delete credential: {error}"
        ))),
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn resolve_secret(id: &str) -> HostResult<String> {
    validate_credential_id(id)?;
    let entry = keyring::Entry::new(SERVICE_NAME, id).map_err(|error| {
        HostError::Credential(format!("Credential Manager entry failed: {error}"))
    })?;
    entry.get_password().map_err(|error| match error {
        keyring::Error::NoEntry => {
            HostError::NotFound("provider credential is not stored on this device".into())
        }
        other => HostError::Credential(format!("failed to read provider credential: {other}")),
    })
}

#[cfg(not(target_os = "windows"))]
pub fn set_credential(_id: &str, _secret: &str) -> HostResult<()> {
    Err(HostError::Unsupported(
        "desktop credential storage is unavailable on this platform".into(),
    ))
}

#[cfg(not(target_os = "windows"))]
pub fn delete_credential(_id: &str) -> HostResult<()> {
    Err(HostError::Unsupported(
        "desktop credential storage is unavailable on this platform".into(),
    ))
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn resolve_secret(_id: &str) -> HostResult<String> {
    Err(HostError::Unsupported(
        "desktop credential storage is unavailable on this platform".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_credential_ids_without_touching_os_store() {
        assert!(validate_credential_id("provider-profile-1").is_ok());
        assert!(validate_credential_id("").is_err());
        assert!(validate_credential_id("bad\nid").is_err());
        assert!(validate_credential_id(&"x".repeat(1025)).is_err());
    }
}
