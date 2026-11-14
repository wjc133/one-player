mod lx_import;
mod network;
mod source_store;

use std::sync::Mutex;

pub struct AppState {
    source_store_lock: Mutex<()>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            source_store_lock: Mutex::new(()),
        })
        .invoke_handler(tauri::generate_handler![
            lx_import::detect_lx_music_source,
            lx_import::import_lx_music_default_source,
            source_store::list_custom_sources,
            source_store::get_custom_source_script,
            source_store::import_custom_source_script,
            source_store::import_custom_source_file,
            source_store::remove_custom_source,
            source_store::set_custom_source_update_alert,
            network::proxy_http_request,
            network::download_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running One Player");
}
