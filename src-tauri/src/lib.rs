mod commands;
mod credentials;
mod database;
mod error;
mod filesystem;
mod models;
mod network;
mod notebook;
mod paths;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_android_bridge::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            use tauri::Manager;

            let app_data_directory = app.path().app_data_dir()?;
            let default_library_root = paths::default_library_root_path();
            let _ = std::fs::create_dir_all(&default_library_root);
            let state = commands::HostState::new(app_data_directory, default_library_root)
                .map_err(std::io::Error::other)?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![commands::host_call])
        .run(tauri::generate_context!());
    if let Err(error) = result {
        eprintln!("Granite failed to start: {error}");
    }
}
