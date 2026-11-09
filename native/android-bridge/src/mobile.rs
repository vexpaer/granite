use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Manager, Runtime,
};
use thiserror::Error;
use zeroize::Zeroizing;

use crate::{validate_request, HostCallRequest};

const PLUGIN_IDENTIFIER: &str = "com.granite.androidbridge";
const PLUGIN_CLASS: &str = "AndroidBridgePlugin";

#[derive(Debug, Error)]
pub enum AndroidBridgeError {
    #[error("invalid Android bridge request: {0}")]
    InvalidRequest(&'static str),
    #[error("Android bridge invocation failed: {0}")]
    Invoke(#[from] tauri::plugin::mobile::PluginInvokeError),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackEvent {
    pub sequence: u64,
    pub pressed_at_ms: i64,
    pub elapsed_realtime_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleEvent {
    pub sequence: u64,
    pub state: String,
    pub occurred_at_ms: i64,
    pub elapsed_realtime_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareAvailableEvent {
    pub count: u64,
}

#[derive(Debug, Deserialize)]
struct CredentialResponse {
    secret: String,
}

/// Native handle used by the Rust host. It is intentionally not registered as
/// a Tauri command.
#[derive(Debug)]
pub struct AndroidBridge<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Clone for AndroidBridge<R> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

pub(crate) fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> Result<AndroidBridge<R>, tauri::plugin::mobile::PluginInvokeError> {
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, PLUGIN_CLASS)?;
    Ok(AndroidBridge(handle))
}

impl<R: Runtime> AndroidBridge<R> {
    /// Executes one Android implementation of a contract operation.
    pub async fn dispatch(&self, request: HostCallRequest) -> Result<Value, AndroidBridgeError> {
        validate_request(&request).map_err(AndroidBridgeError::InvalidRequest)?;
        self.0
            .run_mobile_plugin_async::<Value>("hostCall", request)
            .await
            .map_err(Into::into)
    }

    /// Mirrors the authoritative Note objects into Markdown files in the
    /// selected SAF root. This is a Rust-only call and is not a `host_call`
    /// operation.
    pub async fn mirror_notebook(&self, state: &Value) -> Result<Value, AndroidBridgeError> {
        self.0
            .run_mobile_plugin_async::<Value>(
                "mirrorNotebook",
                serde_json::json!({ "state": state }),
            )
            .await
            .map_err(Into::into)
    }

    /// Reads Markdown notes from the selected SAF root and returns an updated
    /// AppData value. This is a Rust-only call and is not a `host_call`
    /// operation.
    pub async fn sync_notebook(&self, state: &Value) -> Result<Value, AndroidBridgeError> {
        self.0
            .run_mobile_plugin_async::<Value>("syncNotebook", serde_json::json!({ "state": state }))
            .await
            .map_err(Into::into)
    }

    /// Long-polls the native Back dispatcher. The caller enables interception
    /// through `lifecycle.back`; when disabled, Android's normal dispatcher
    /// remains the fallback and closes the app or navigates the WebView.
    pub async fn wait_for_back(&self) -> Result<BackEvent, AndroidBridgeError> {
        self.0
            .run_mobile_plugin_async::<BackEvent>("awaitBack", serde_json::json!({}))
            .await
            .map_err(Into::into)
    }

    /// Long-polls native Activity foreground/background transitions.
    pub async fn wait_for_lifecycle(&self) -> Result<LifecycleEvent, AndroidBridgeError> {
        self.0
            .run_mobile_plugin_async::<LifecycleEvent>("awaitLifecycle", serde_json::json!({}))
            .await
            .map_err(Into::into)
    }

    /// Long-polls notifications that an ACTION_SEND/SEND_MULTIPLE intent has
    /// been copied into Granite's private queue.
    pub async fn wait_for_share(&self) -> Result<ShareAvailableEvent, AndroidBridgeError> {
        self.0
            .run_mobile_plugin_async::<ShareAvailableEvent>("awaitShare", serde_json::json!({}))
            .await
            .map_err(Into::into)
    }

    /// Rust-only credential resolution for provider signing.
    ///
    /// This method has no `host_call` operation and therefore cannot be reached
    /// by the webview or a plugin.
    pub async fn resolve_credential(
        &self,
        credential_id: impl Into<String>,
    ) -> Result<Zeroizing<String>, AndroidBridgeError> {
        let response = self
            .0
            .run_mobile_plugin_async::<CredentialResponse>(
                "resolveCredential",
                serde_json::json!({ "id": credential_id.into() }),
            )
            .await?;
        Ok(Zeroizing::new(response.secret))
    }
}

/// Convenience access for the single Rust `host_call` dispatcher.
pub trait AndroidBridgeExt<R: Runtime>: Manager<R> {
    fn android_bridge(&self) -> tauri::State<'_, AndroidBridge<R>> {
        self.state::<AndroidBridge<R>>()
    }
}

impl<R: Runtime, T: Manager<R>> AndroidBridgeExt<R> for T {}
