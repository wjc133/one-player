use std::{fs, io::Write, path::Path};

use fs2::FileExt;
use serde_json::Value;
use tauri::Manager;
use uuid::Uuid;

fn validate(playlists: &[Value]) -> Result<(), String> {
    if playlists.iter().any(|playlist| {
        !playlist["id"].is_string()
            || !playlist["name"].is_string()
            || !playlist["tracks"].is_array()
            || !playlist["createdAt"].is_number()
    }) {
        return Err("歌单数据格式不正确，原有文件已保留".into());
    }
    Ok(())
}

fn read_store(path: &Path) -> Result<Option<Vec<Value>>, String> {
    let raw = match fs::read(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("读取本机歌单失败：{error}")),
    };
    let playlists: Vec<Value> =
        serde_json::from_slice(&raw).map_err(|_| "本机歌单文件损坏，原有文件已保留".to_string())?;
    validate(&playlists)?;
    Ok(Some(playlists))
}

fn write_store(path: &Path, playlists: &[Value]) -> Result<(), String> {
    validate(playlists)?;
    let directory = path
        .parent()
        .ok_or_else(|| "无法定位歌单目录".to_string())?;
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join("playlists.lock"))
        .map_err(|error| error.to_string())?;
    lock.lock_exclusive().map_err(|error| error.to_string())?;
    let temporary = directory.join(format!(".playlists-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let raw = serde_json::to_vec(playlists).map_err(|error| error.to_string())?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(&raw).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        fs::rename(&temporary, path).map_err(|error| format!("保存本机歌单失败：{error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[tauri::command]
pub async fn load_stored_playlists(app: tauri::AppHandle) -> Result<Option<Vec<Value>>, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("playlists.json");
    tauri::async_runtime::spawn_blocking(move || read_store(&path))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn save_stored_playlists(
    app: tauri::AppHandle,
    playlists: Vec<Value>,
) -> Result<(), String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("playlists.json");
    tauri::async_runtime::spawn_blocking(move || write_store(&path, &playlists))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stores_libraries_larger_than_browser_local_storage_and_replaces_atomically() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("playlists.json");
        assert!(read_store(&path).unwrap().is_none());
        let playlists = vec![
            json!({"id":"large","name":"大量歌单","createdAt":1,"tracks":[{"name":"曲目","metadata":"x".repeat(6 * 1024 * 1024)}]}),
        ];
        write_store(&path, &playlists).unwrap();
        assert_eq!(read_store(&path).unwrap().unwrap(), playlists);
        write_store(&path, &[]).unwrap();
        assert!(read_store(&path).unwrap().unwrap().is_empty());
    }

    #[test]
    fn invalid_updates_preserve_existing_data_and_corruption_is_reported() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("playlists.json");
        let playlists = vec![json!({"id":"one","name":"收藏","createdAt":1,"tracks":[]})];
        write_store(&path, &playlists).unwrap();
        assert!(write_store(&path, &[json!({"id":"broken"})]).is_err());
        assert_eq!(read_store(&path).unwrap().unwrap(), playlists);
        fs::write(&path, b"broken").unwrap();
        assert!(read_store(&path).is_err());
    }
}
