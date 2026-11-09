//! Android implementation details for Granite's single `host_call` bridge.
//!
//! This crate deliberately does not expose a second web-facing Tauri command.
//! The Rust host owns `host_call`, dispatches Android operations through
//! [`AndroidBridge::dispatch`], and retains all policy and user-facing errors.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};
#[cfg(target_os = "android")]
use tauri::{Emitter, Manager};

pub const ANDROID_BACK_EVENT: &str = "granite://android-back";
pub const ANDROID_LIFECYCLE_EVENT: &str = "granite://android-lifecycle";
pub const ANDROID_SHARE_EVENT: &str = "granite://android-share-available";

#[cfg(target_os = "android")]
mod mobile;

#[cfg(target_os = "android")]
pub use mobile::{
    AndroidBridge, AndroidBridgeError, AndroidBridgeExt, BackEvent, LifecycleEvent,
    ShareAvailableEvent,
};

/// The exact request envelope accepted by the application's `host_call`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HostCallRequest {
    pub op: String,
    #[serde(default = "empty_object")]
    pub args: Value,
}

fn empty_object() -> Value {
    Value::Object(Default::default())
}

/// Initializes the Android bridge plugin.
///
/// Register this plugin on Android. On non-Android targets it is a no-op so a
/// shared source tree can still type-check and build.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let builder = Builder::new("android-bridge");

    #[cfg(target_os = "android")]
    let builder = builder.setup(|app, api| {
        let bridge = mobile::init(app, api)?;
        let back_bridge = bridge.clone();
        let app_handle = app.clone();

        tauri::async_runtime::spawn(async move {
            loop {
                match back_bridge.wait_for_back().await {
                    Ok(event) => {
                        let _ = app_handle.emit(ANDROID_BACK_EVENT, event);
                    }
                    Err(error) => {
                        eprintln!("Granite Android back listener stopped: {error}");
                        break;
                    }
                }
            }
        });

        let lifecycle_bridge = bridge.clone();
        let lifecycle_app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                match lifecycle_bridge.wait_for_lifecycle().await {
                    Ok(event) => {
                        let _ = lifecycle_app_handle.emit(ANDROID_LIFECYCLE_EVENT, event);
                    }
                    Err(error) => {
                        eprintln!("Granite Android lifecycle listener stopped: {error}");
                        break;
                    }
                }
            }
        });

        let share_bridge = bridge.clone();
        let share_app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                match share_bridge.wait_for_share().await {
                    Ok(event) => {
                        let _ = share_app_handle.emit(ANDROID_SHARE_EVENT, event);
                    }
                    Err(error) => {
                        eprintln!("Granite Android share listener stopped: {error}");
                        break;
                    }
                }
            }
        });

        app.manage(bridge);
        Ok(())
    });

    #[cfg(not(target_os = "android"))]
    let builder = builder.setup(|_app, _api| Ok(()));

    builder.build()
}

/// Dispatch validation shared by the Rust host and unit tests.
///
/// The Android implementation performs the real operation. Keeping this
/// validation here ensures malformed calls fail before crossing JNI.
pub fn validate_request(request: &HostCallRequest) -> Result<(), &'static str> {
    if request.op.is_empty() || request.op.len() > 80 {
        return Err("invalid host operation name");
    }
    if !request.args.is_object() && !request.args.is_null() {
        return Err("host operation arguments must be a JSON object");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_missing_args_to_empty_object() {
        let request: HostCallRequest = serde_json::from_value(json!({"op": "root.pick"})).unwrap();
        assert_eq!(request.args, json!({}));
        assert!(validate_request(&request).is_ok());
    }

    #[test]
    fn rejects_empty_or_oversized_operation() {
        let empty = HostCallRequest {
            op: String::new(),
            args: json!({}),
        };
        let oversized = HostCallRequest {
            op: "x".repeat(81),
            args: json!({}),
        };
        assert!(validate_request(&empty).is_err());
        assert!(validate_request(&oversized).is_err());
    }

    #[test]
    fn rejects_non_object_arguments() {
        let request = HostCallRequest {
            op: "book.read".to_string(),
            args: json!([]),
        };
        assert!(validate_request(&request).is_err());
    }
}
