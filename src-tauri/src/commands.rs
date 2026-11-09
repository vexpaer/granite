use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::{DialogExt, FilePath};
use uuid::Uuid;

use crate::credentials;
use crate::database::Database;
use crate::error::{HostError, HostResult};
use crate::filesystem::{
    atomic_write_path, import_book, migrate_roots, read_book, read_file, reveal_file, scan_root,
    write_book, MAX_IPC_FILE_BYTES,
};
use crate::models::{
    Diagnostics, HostRequest, LibraryRoot, MigrationProgress, PickedBook, ProviderProfile,
};
use crate::network;
use crate::notebook;
use crate::paths::{
    format_from_path, make_default_root, make_picked_root, sanitize_component,
    validate_library_root,
};

pub struct HostState {
    database: Arc<Mutex<Database>>,
    app_data_directory: PathBuf,
    default_library_root: PathBuf,
    file_backup_directory: PathBuf,
    migration_cancel: Arc<AtomicBool>,
    migration_active: Arc<AtomicBool>,
}

impl HostState {
    pub fn new(app_data_directory: PathBuf, default_library_root: PathBuf) -> HostResult<Self> {
        let database = Database::open(&app_data_directory)?;
        let file_backup_directory = app_data_directory.join("backups").join("books");
        fs::create_dir_all(&file_backup_directory).map_err(|error| {
            HostError::io("failed to create private file backup directory", error)
        })?;
        Ok(Self {
            database: Arc::new(Mutex::new(database)),
            app_data_directory,
            default_library_root,
            file_backup_directory,
            migration_cancel: Arc::new(AtomicBool::new(false)),
            migration_active: Arc::new(AtomicBool::new(false)),
        })
    }

    fn database(&self) -> MutexGuard<'_, Database> {
        self.database
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[tauri::command]
pub async fn host_call(
    app: AppHandle,
    state: State<'_, HostState>,
    request: HostRequest,
) -> Result<Value, String> {
    dispatch(&app, &state, request)
        .await
        .map_err(|error| error.to_string())
}

async fn dispatch(app: &AppHandle, state: &HostState, request: HostRequest) -> HostResult<Value> {
    #[cfg(target_os = "android")]
    if is_android_managed_operation(&request.op) {
        use tauri_plugin_android_bridge::{AndroidBridgeExt, HostCallRequest};

        return app
            .android_bridge()
            .dispatch(HostCallRequest {
                op: request.op,
                args: request.args,
            })
            .await
            .map_err(|error| HostError::Internal(format!("Android bridge failed: {error}")));
    }

    let args = Args::new(request.args)?;
    match request.op.as_str() {
        "state.load" => state_load(app, state).await,
        "state.save" => state_save(app, state, &args).await,
        "root.default" => root_default(state),
        "root.pick" => root_pick(app, state, &args),
        "root.scan" => {
            let root = args.root("root")?;
            serde_json::to_value(scan_root(&root)?).map_err(Into::into)
        }
        "root.validate" => {
            let root = args.root("root")?;
            serde_json::to_value(validate_library_root(root)).map_err(Into::into)
        }
        "root.migrate" => root_migrate(app, state, &args).await,
        "root.migrateCancel" => {
            state.migration_cancel.store(true, Ordering::Release);
            Ok(Value::Bool(true))
        }
        "book.import" => book_import(&args, state),
        "book.read" => {
            let root = args.root("root")?;
            let relative_path = args.string("relativePath")?;
            serde_json::to_value(read_book(&root, relative_path)?).map_err(Into::into)
        }
        "book.write" => book_write(state, &args),
        "book.export" => {
            let filename = args.string("filename")?;
            let bytes = args.bytes("bytes")?;
            save_export_dialog(app, filename, &bytes, "Export book")
        }
        "book.locate" => {
            let root = args.root("root")?;
            let relative_path = args.string("relativePath")?;
            Ok(Value::Bool(reveal_file(&root, relative_path)?))
        }
        "file.pickBooks" => file_pick_books(app),
        "file.readPaths" => file_read_paths(&args),
        "credential.set" => {
            let id = args.string("id")?;
            let secret = args.string("secret")?;
            credentials::set_credential(id, secret)?;
            Ok(Value::Bool(true))
        }
        "credential.delete" => {
            let id = args.string("id")?;
            credentials::delete_credential(id)?;
            Ok(Value::Bool(true))
        }
        "provider.request" => provider_request(app, &args).await,
        "backup.export" => {
            let filename = args.string("filename")?;
            let bytes = args.bytes("bytes")?;
            save_export_dialog(app, filename, &bytes, "Export Granite backup")
        }
        "diagnostics" => diagnostics(state),
        "share.consume" => Err(HostError::Unsupported(
            "share.consume is available only through the Android native bridge".into(),
        )),
        other => Err(HostError::Unsupported(format!(
            "unknown host operation '{other}'"
        ))),
    }
}

#[cfg(target_os = "android")]
fn is_android_managed_operation(op: &str) -> bool {
    matches!(
        op,
        "root.pick"
            | "root.scan"
            | "root.validate"
            | "root.migrate"
            | "root.migrateCancel"
            | "book.import"
            | "book.read"
            | "book.write"
            | "book.export"
            | "book.locate"
            | "file.pickBooks"
            | "credential.set"
            | "credential.delete"
            | "backup.export"
            | "lifecycle.keepAwake"
            | "lifecycle.immersive"
            | "lifecycle.back"
            | "share.consume"
    )
}

async fn state_load(app: &AppHandle, state: &HostState) -> HostResult<Value> {
    let _ = app;
    let stored = {
        let database = state.database();
        database.load_document()?
    };
    let Some(stored) = stored else {
        return Ok(Value::Null);
    };
    #[cfg(not(target_os = "android"))]
    let synchronized = notebook::sync_from_disk(&stored, &state.default_library_root)?;
    #[cfg(target_os = "android")]
    let synchronized = {
        use tauri_plugin_android_bridge::AndroidBridgeExt;
        let value = app
            .android_bridge()
            .sync_notebook(&stored)
            .await
            .map_err(|error| {
                HostError::Storage(format!("Android Notebook synchronization failed: {error}"))
            })?;
        if value.is_object() {
            value
        } else {
            return Err(HostError::Storage(
                "Android Notebook synchronization returned an invalid state".into(),
            ));
        }
    };
    if synchronized != stored {
        state.database().save_document(&synchronized)?;
    }
    Ok(synchronized)
}

async fn state_save(app: &AppHandle, state: &HostState, args: &Args) -> HostResult<Value> {
    let _ = app;
    let document = args.value("state")?.clone();
    if !document.is_object() {
        return Err(HostError::InvalidArgs(
            "state.save requires a full AppData object".into(),
        ));
    }
    #[cfg(not(target_os = "android"))]
    notebook::mirror_state(&document, &state.default_library_root)?;
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_android_bridge::AndroidBridgeExt;
        app.android_bridge()
            .mirror_notebook(&document)
            .await
            .map_err(|error| {
                HostError::Storage(format!("Android Notebook mirror failed: {error}"))
            })?;
    }
    state.database().save_document(&document)?;
    Ok(Value::Bool(true))
}

fn root_default(state: &HostState) -> HostResult<Value> {
    fs::create_dir_all(&state.default_library_root).map_err(|error| {
        HostError::io("failed to create the default Granite Library folder", error)
    })?;
    let root = validate_library_root(make_default_root(state.default_library_root.clone()));
    serde_json::to_value(root).map_err(Into::into)
}

fn root_pick(app: &AppHandle, state: &HostState, args: &Args) -> HostResult<Value> {
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Choose a Granite library folder");
    if state.default_library_root.exists() {
        dialog = dialog.set_directory(&state.default_library_root);
    }
    let Some(selected) = dialog.blocking_pick_folder() else {
        return Ok(Value::Null);
    };
    let path = file_path_to_path(selected)?;
    let mut root = make_picked_root(path);
    if let Some(is_default) = args.optional_bool("isDefault")? {
        root.is_default = is_default;
    }
    serde_json::to_value(validate_library_root(root)).map_err(Into::into)
}

async fn root_migrate(app: &AppHandle, state: &HostState, args: &Args) -> HostResult<Value> {
    if state
        .migration_active
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err(HostError::Conflict(
            "another library migration is already running".into(),
        ));
    }
    state.migration_cancel.store(false, Ordering::Release);
    let from = match args.root("from") {
        Ok(root) => root,
        Err(error) => {
            state.migration_active.store(false, Ordering::Release);
            return Err(error);
        }
    };
    let to = match args.root("to") {
        Ok(root) => root,
        Err(error) => {
            state.migration_active.store(false, Ordering::Release);
            return Err(error);
        }
    };
    let operation_id = args
        .optional_string("operationId")?
        .map(str::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let cancel = Arc::clone(&state.migration_cancel);
    let active = Arc::clone(&state.migration_active);
    let event_app = app.clone();
    let task_operation_id = operation_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        migrate_roots(&from, &to, &task_operation_id, &cancel, |progress| {
            emit_migration_progress(&event_app, progress);
        })
    })
    .await
    .map_err(|error| HostError::Internal(format!("migration task failed: {error}")));
    active.store(false, Ordering::Release);
    serde_json::to_value(result??).map_err(Into::into)
}

fn emit_migration_progress(app: &AppHandle, progress: MigrationProgress) {
    let _ = app.emit("root.migrate-progress", progress);
}

fn book_import(args: &Args, state: &HostState) -> HostResult<Value> {
    let root = args.root("root")?;
    if let Some(root_id) = args.optional_string("rootId")? {
        if root_id != root.id {
            return Err(HostError::InvalidArgs(
                "rootId does not match the supplied library root".into(),
            ));
        }
    }
    let filename = args.string("filename")?;
    let bytes = args.bytes("bytes")?;
    let _ = &state.file_backup_directory;
    serde_json::to_value(import_book(&root, filename, &bytes)?).map_err(Into::into)
}

fn book_write(state: &HostState, args: &Args) -> HostResult<Value> {
    let root = args.root("root")?;
    let relative_path = args.string("relativePath")?;
    let bytes = args.bytes("bytes")?;
    serde_json::to_value(write_book(
        &root,
        relative_path,
        &bytes,
        &state.file_backup_directory,
    )?)
    .map_err(Into::into)
}

fn file_pick_books(app: &AppHandle) -> HostResult<Value> {
    let selected = app
        .dialog()
        .file()
        .set_title("Import books into Granite")
        .add_filter("Ebooks", &["epub", "pdf", "txt", "mobi"])
        .blocking_pick_files()
        .unwrap_or_default();
    let mut files = Vec::new();
    for file_path in selected {
        let path = file_path_to_path(file_path)?;
        files.push(picked_book_from_path(&path)?);
    }
    serde_json::to_value(files).map_err(Into::into)
}

fn file_read_paths(args: &Args) -> HostResult<Value> {
    let values = args
        .value("paths")?
        .as_array()
        .ok_or_else(|| HostError::InvalidArgs("file.readPaths requires a paths array".into()))?;
    if values.len() > 100 {
        return Err(HostError::Unsupported(
            "file.readPaths accepts at most 100 files per call".into(),
        ));
    }
    let mut files = Vec::with_capacity(values.len());
    for value in values {
        let path = value
            .as_str()
            .ok_or_else(|| HostError::InvalidArgs("file.readPaths paths must be strings".into()))?;
        files.push(picked_book_from_path(Path::new(path))?);
    }
    serde_json::to_value(files).map_err(Into::into)
}

fn picked_book_from_path(path: &Path) -> HostResult<PickedBook> {
    if format_from_path(path).is_none() {
        return Err(HostError::Unsupported(format!(
            "'{}' is not a supported EPUB, PDF, TXT, or MOBI file",
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("selected file")
        )));
    }
    let metadata =
        fs::metadata(path).map_err(|error| HostError::io("selected file is unavailable", error))?;
    if !metadata.is_file() {
        return Err(HostError::InvalidArgs("selected path is not a file".into()));
    }
    if metadata.len() > MAX_IPC_FILE_BYTES {
        return Err(HostError::Unsupported(format!(
            "selected file exceeds the {MAX_IPC_FILE_BYTES}-byte native bridge limit"
        )));
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| HostError::InvalidArgs("selected file name is not valid Unicode".into()))?
        .to_owned();
    Ok(PickedBook {
        name,
        bytes: read_file(path)?,
    })
}

fn save_export_dialog(
    app: &AppHandle,
    filename: &str,
    bytes: &[u8],
    title: &str,
) -> HostResult<Value> {
    if bytes.len() as u64 > MAX_IPC_FILE_BYTES {
        return Err(HostError::Unsupported(format!(
            "export exceeds the {MAX_IPC_FILE_BYTES}-byte native bridge limit"
        )));
    }
    let safe_name = export_filename(filename)?;
    let mut dialog = app
        .dialog()
        .file()
        .set_title(title)
        .set_file_name(safe_name);
    if let Some(format) = Path::new(filename)
        .extension()
        .and_then(|value| value.to_str())
    {
        let format = format.to_ascii_lowercase();
        if matches!(format.as_str(), "epub" | "pdf" | "txt" | "mobi") {
            dialog = dialog.add_filter("Book", &["epub", "pdf", "txt", "mobi"]);
        } else if format == "gra" || format == "zip" {
            dialog = dialog.add_filter("Granite backup", &["gra", "zip"]);
        }
    }
    let Some(selected) = dialog.blocking_save_file() else {
        return Ok(Value::Bool(false));
    };
    let destination = file_path_to_path(selected)?;
    atomic_write_path(&destination, bytes)?;
    Ok(Value::Bool(true))
}

fn export_filename(filename: &str) -> HostResult<String> {
    let name = Path::new(filename)
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| HostError::InvalidArgs("export filename is invalid".into()))?;
    sanitize_component(name)
        .map_err(|_| HostError::InvalidArgs("export filename is invalid".into()))
}

async fn provider_request(app: &AppHandle, args: &Args) -> HostResult<Value> {
    let _ = app;
    let profile: ProviderProfile = serde_json::from_value(args.value("profile")?.clone())
        .map_err(|error| HostError::InvalidArgs(format!("invalid provider profile: {error}")))?;
    let method = args.string("method")?.to_owned();
    let key = args.string("key")?.to_owned();
    let body = args.optional_bytes("body")?;
    let headers = args.optional_string_map("headers")?;

    #[cfg(target_os = "windows")]
    let secret = {
        use zeroize::Zeroizing;

        let credential_id = profile.credential_id.clone();
        Zeroizing::new(
            tauri::async_runtime::spawn_blocking(move || {
                credentials::resolve_secret(&credential_id)
            })
            .await
            .map_err(|error| {
                HostError::Credential(format!("credential lookup task failed: {error}"))
            })??,
        )
    };
    #[cfg(target_os = "android")]
    let secret = {
        use tauri_plugin_android_bridge::AndroidBridgeExt;
        app.android_bridge()
            .resolve_credential(profile.credential_id.clone())
            .await
            .map_err(|error| {
                HostError::Credential(format!("Android Keystore lookup failed: {error}"))
            })?
    };
    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    let secret = {
        let _ = app;
        return Err(HostError::Unsupported(
            "provider credential storage is unavailable on this platform".into(),
        ));
    };

    let response =
        network::provider_request(profile, method, key, body, headers, secret.as_str()).await?;
    serde_json::to_value(response).map_err(Into::into)
}

fn diagnostics(state: &HostState) -> HostResult<Value> {
    let database = state.database();
    let schema = database.schema_version()?;
    let diagnostics = Diagnostics {
        app_version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        tauri_version: tauri::VERSION,
        native: true,
        database: format!("SQLite schema {schema}, WAL, private app-data directory"),
        storage_mode: "local-first",
    };
    let _ = &state.app_data_directory;
    serde_json::to_value(diagnostics).map_err(Into::into)
}

fn file_path_to_path(path: FilePath) -> HostResult<PathBuf> {
    path.into_path().map_err(|error| {
        HostError::Storage(format!(
            "native dialog returned an unsupported path: {error}"
        ))
    })
}

struct Args {
    value: Value,
}

impl Args {
    fn new(value: Value) -> HostResult<Self> {
        if value.is_null() {
            return Ok(Self { value: json!({}) });
        }
        if !value.is_object() {
            return Err(HostError::InvalidArgs(
                "host_call args must be a JSON object".into(),
            ));
        }
        Ok(Self { value })
    }

    fn value(&self, field: &str) -> HostResult<&Value> {
        self.value
            .get(field)
            .ok_or_else(|| HostError::InvalidArgs(format!("missing '{field}' argument")))
    }

    fn string(&self, field: &str) -> HostResult<&str> {
        self.value
            .get(field)
            .and_then(Value::as_str)
            .ok_or_else(|| HostError::InvalidArgs(format!("'{field}' must be a string")))
    }

    fn optional_string(&self, field: &str) -> HostResult<Option<&str>> {
        match self.value.get(field) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(value)) => Ok(Some(value)),
            Some(_) => Err(HostError::InvalidArgs(format!(
                "'{field}' must be a string when present"
            ))),
        }
    }

    fn optional_bool(&self, field: &str) -> HostResult<Option<bool>> {
        match self.value.get(field) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::Bool(value)) => Ok(Some(*value)),
            Some(_) => Err(HostError::InvalidArgs(format!(
                "'{field}' must be a boolean when present"
            ))),
        }
    }

    fn root(&self, field: &str) -> HostResult<LibraryRoot> {
        serde_json::from_value(self.value(field)?.clone()).map_err(|error| {
            HostError::InvalidArgs(format!("invalid '{field}' library root: {error}"))
        })
    }

    fn bytes(&self, field: &str) -> HostResult<Vec<u8>> {
        let values = self
            .value(field)?
            .as_array()
            .ok_or_else(|| HostError::InvalidArgs(format!("'{field}' must be a byte array")))?;
        if values.len() as u64 > MAX_IPC_FILE_BYTES {
            return Err(HostError::Unsupported(format!(
                "'{field}' exceeds the {MAX_IPC_FILE_BYTES}-byte native bridge limit"
            )));
        }
        values
            .iter()
            .enumerate()
            .map(|(index, value)| {
                value
                    .as_u64()
                    .and_then(|value| u8::try_from(value).ok())
                    .ok_or_else(|| {
                        HostError::InvalidArgs(format!(
                            "'{field}' byte at index {index} is not an integer from 0 through 255"
                        ))
                    })
            })
            .collect()
    }

    fn optional_bytes(&self, field: &str) -> HostResult<Option<Vec<u8>>> {
        match self.value.get(field) {
            None | Some(Value::Null) => Ok(None),
            Some(_) => self.bytes(field).map(Some),
        }
    }

    fn optional_string_map(&self, field: &str) -> HostResult<BTreeMap<String, String>> {
        let Some(value) = self.value.get(field) else {
            return Ok(BTreeMap::new());
        };
        if value.is_null() {
            return Ok(BTreeMap::new());
        }
        let object = value
            .as_object()
            .ok_or_else(|| HostError::InvalidArgs(format!("'{field}' must be an object")))?;
        object
            .iter()
            .map(|(name, value)| {
                let value = value.as_str().ok_or_else(|| {
                    HostError::InvalidArgs(format!("header '{name}' must have a string value"))
                })?;
                Ok((name.clone(), value.to_owned()))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn byte_arrays_reject_out_of_range_values() {
        let args = Args::new(json!({"bytes": [0, 1, 255]})).expect("args");
        assert_eq!(args.bytes("bytes").expect("bytes"), vec![0, 1, 255]);
        let invalid = Args::new(json!({"bytes": [256]})).expect("args");
        assert!(invalid.bytes("bytes").is_err());
    }

    #[test]
    fn exports_use_only_a_file_name_component() {
        assert_eq!(
            export_filename("../Granite backup.gra").expect("safe name"),
            "Granite backup.gra"
        );
        assert!(export_filename("").is_err());
    }
}
