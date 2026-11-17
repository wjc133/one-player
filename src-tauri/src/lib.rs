mod audio_tags;
mod cover_art;
mod cover_cache;
mod downloads;
mod lx_import;
mod network;
mod playlist_import;
mod playlist_store;
mod source_store;
mod walkman;

use std::sync::Mutex;

pub struct AppState {
    source_store_lock: Mutex<()>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState {
            source_store_lock: Mutex::new(()),
        })
        .manage(cover_cache::CoverCache::default())
        .invoke_handler(tauri::generate_handler![
            lx_import::detect_lx_music_source,
            lx_import::import_lx_music_default_source,
            source_store::list_custom_sources,
            source_store::get_custom_source_script,
            source_store::import_custom_source_script,
            source_store::import_custom_source_file,
            source_store::inspect_custom_source_update,
            source_store::update_custom_source_script,
            source_store::remove_custom_source,
            source_store::set_custom_source_update_alert,
            network::proxy_http_request,
            cover_cache::get_cached_cover,
            playlist_import::detect_playlist_import_platforms,
            playlist_import::list_import_playlists,
            playlist_import::import_platform_playlists,
            playlist_store::load_stored_playlists,
            playlist_store::save_stored_playlists,
            walkman::detect_walkman,
            walkman::list_walkman_music,
            walkman::get_walkman_artwork,
            walkman::transfer_walkman_file,
            walkman::update_walkman_tags,
            walkman::delete_walkman_file,
            downloads::download_file,
            downloads::claim_download_file,
            downloads::list_downloads,
            downloads::get_download_file_url,
            downloads::delete_download,
            downloads::get_local_music_file_url,
            downloads::inspect_local_music_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running One Player");
}
