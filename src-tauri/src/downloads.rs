use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tokio::io::AsyncWriteExt;

use crate::network::build_client;

const DOWNLOAD_PROGRESS_EVENT: &str = "download-progress";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadMetadata {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub cover_url: Option<String>,
    pub track_key: Option<String>,
    pub import_source: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadPayload {
    pub task_id: String,
    pub walkman_id: Option<String>,
    pub url: String,
    pub directory: Option<String>,
    pub file_name: String,
    pub proxy: Option<String>,
    pub metadata: DownloadMetadata,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadClaimPayload {
    pub path: String,
    pub metadata: DownloadMetadata,
    pub proxy: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedAudio {
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub format: String,
    pub size: u64,
    pub modified_at: u64,
    pub cover_data_url: Option<String>,
    pub track_key: Option<String>,
    pub import_source: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMusicMetadata {
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_seconds: u64,
    pub cover_data_url: Option<String>,
    pub track_key: Option<String>,
    pub extension: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    task_id: String,
    progress: Option<u8>,
    received_bytes: u64,
    total_bytes: Option<u64>,
}

struct AudioFileInfo {
    path: PathBuf,
    size: u64,
    modified_at: u64,
    format: &'static str,
}

pub(crate) fn resolve_download_directory(
    app: &tauri::AppHandle,
    directory: Option<&str>,
) -> Result<PathBuf, String> {
    match directory.filter(|path| !path.trim().is_empty()) {
        Some(path) => Ok(PathBuf::from(path)),
        None => app
            .path()
            .download_dir()
            .map_err(|error| format!("无法获取系统下载目录：{error}")),
    }
}

fn is_supported_audio(path: &Path) -> Option<&'static str> {
    crate::audio_tags::audio_format(path)
}

fn is_playable_local_audio(path: &Path) -> Option<String> {
    is_supported_audio(path).map(str::to_string)
}

fn inspect_local_music_file(path: PathBuf) -> Result<LocalMusicMetadata, String> {
    let extension = is_playable_local_audio(&path).ok_or("不支持的本地音乐格式")?;
    let tags = crate::audio_tags::read_tags(&path, true)?;
    Ok(LocalMusicMetadata {
        title: if tags.title.trim().is_empty() {
            path.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into()
        } else {
            tags.title
        },
        path: path.to_string_lossy().into(),
        artist: tags.artist,
        album: tags.album,
        duration_seconds: tags.duration_seconds,
        cover_data_url: tags.cover_data_url,
        track_key: tags.track_key,
        extension,
    })
}

pub(crate) async fn fetch_cover(
    client: &reqwest::Client,
    cover_url: Option<&str>,
) -> Result<Option<Vec<u8>>, String> {
    let Some(cover_url) = cover_url.filter(|url| !url.trim().is_empty()) else {
        return Ok(None);
    };
    if !cover_url.starts_with("http://") && !cover_url.starts_with("https://") {
        return Ok(None);
    }

    let bytes = client
        .get(cover_url)
        .send()
        .await
        .map_err(|error| format!("获取封面失败：{error}"))?
        .error_for_status()
        .map_err(|error| format!("获取封面失败：{error}"))?
        .bytes()
        .await
        .map_err(|error| format!("获取封面失败：{error}"))?;
    Ok(Some(bytes.to_vec()))
}

fn write_download_metadata(
    path: &Path,
    metadata: &DownloadMetadata,
    cover: Option<Vec<u8>>,
) -> Result<Option<String>, String> {
    crate::audio_tags::write_tags(path, metadata, cover, true)
}

async fn claim_audio_file(payload: DownloadClaimPayload) -> Result<String, String> {
    let path = PathBuf::from(&payload.path);
    if is_supported_audio(&path).is_none() {
        return Err("不支持标记此音频格式".to_string());
    }
    if !path.is_file() {
        return Err("下载文件不存在".to_string());
    }

    let client = build_client(payload.proxy.as_deref(), 60_000)?;
    let cover = fetch_cover(&client, payload.metadata.cover_url.as_deref()).await?;
    write_download_metadata(&path, &payload.metadata, cover)?;
    Ok(payload.path)
}

pub(crate) async fn validated_download_path(
    app: &tauri::AppHandle,
    path: &str,
    directory: Option<&str>,
) -> Result<PathBuf, String> {
    let target = PathBuf::from(path);
    if is_supported_audio(&target).is_none() {
        return Err("不支持访问此音频格式".to_string());
    }

    let download_directory_path = resolve_download_directory(app, directory)?;
    let download_directory = tokio::fs::canonicalize(&download_directory_path)
        .await
        .map_err(|error| format!("读取下载目录失败：{error}"))?;
    let target = tokio::fs::canonicalize(&target)
        .await
        .map_err(|error| format!("下载文件不存在：{error}"))?;
    if !target.is_file() {
        return Err("下载文件不存在".to_string());
    }
    if !target.starts_with(&download_directory) {
        return Err("只能访问下载目录中的文件".to_string());
    }

    let marked = tokio::task::spawn_blocking({
        let target = target.clone();
        move || read_downloaded_audio_path(target).is_some()
    })
    .await
    .map_err(|error| error.to_string())?;
    if !marked {
        return Err("只能访问 One Player 下载的文件".to_string());
    }

    Ok(target)
}

#[tauri::command]
pub async fn get_download_file_url(
    app: tauri::AppHandle,
    path: String,
    directory: Option<String>,
) -> Result<String, String> {
    let target = validated_download_path(&app, &path, directory.as_deref()).await?;
    app.asset_protocol_scope()
        .allow_file(&target)
        .map_err(|error| format!("允许播放下载文件失败：{error}"))?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不可用".to_string())?;
    window
        .convert_file_src(&target, None)
        .map_err(|error| format!("生成播放地址失败：{error}"))
}

#[tauri::command]
pub async fn get_local_music_file_url(
    app: tauri::AppHandle,
    path: String,
) -> Result<String, String> {
    let target = PathBuf::from(&path);
    if is_playable_local_audio(&target).is_none() {
        return Err("不支持的本地音乐格式".to_string());
    }
    let target = tokio::fs::canonicalize(&target)
        .await
        .map_err(|error| format!("本地音乐文件不存在：{error}"))?;
    if !target.is_file() {
        return Err("本地音乐文件不存在".to_string());
    }

    app.asset_protocol_scope()
        .allow_file(&target)
        .map_err(|error| format!("允许播放本地音乐失败：{error}"))?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不可用".to_string())?;
    window
        .convert_file_src(&target, None)
        .map_err(|error| format!("生成播放地址失败：{error}"))
}

#[tauri::command]
pub async fn inspect_local_music_files(
    paths: Vec<String>,
) -> Result<Vec<LocalMusicMetadata>, String> {
    tokio::task::spawn_blocking(move || {
        let mut metadata = Vec::new();
        let mut last_error = None;
        for path in paths {
            let result = (|| {
                let canonical = PathBuf::from(&path)
                    .canonicalize()
                    .map_err(|error| format!("本地音乐文件不存在：{error}"))?;
                if !canonical.is_file() {
                    return Err("本地音乐文件不存在".to_string());
                }
                inspect_local_music_file(canonical)
            })();
            match result {
                Ok(item) => metadata.push(item),
                Err(error) => last_error = Some(error),
            }
        }
        if metadata.is_empty() {
            if let Some(error) = last_error {
                return Err(error);
            }
        }
        Ok(metadata)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn download_file(
    app: tauri::AppHandle,
    payload: DownloadPayload,
) -> Result<DownloadedAudio, String> {
    if !payload.url.starts_with("http://") && !payload.url.starts_with("https://") {
        return Err("下载地址必须是 HTTP 与 HTTPS".to_string());
    }

    let task_id = uuid::Uuid::parse_str(&payload.task_id)
        .map_err(|_| "下载任务标识无效".to_string())?
        .to_string();
    let file_name = Path::new(&payload.file_name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty() && *name != "." && *name != "..")
        .ok_or_else(|| "缺少下载文件名".to_string())?;
    let device_root = payload
        .walkman_id
        .as_deref()
        .map(crate::walkman::music_root)
        .transpose()?;
    let directory = if let Some(root) = &device_root {
        crate::walkman::album_directory(root, &payload.metadata)?
    } else {
        resolve_download_directory(&app, payload.directory.as_deref())?
    };
    let target = directory.join(file_name);

    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| error.to_string())?;
    }

    if target.is_file() {
        let existing_path = target.clone();
        if let Some(existing) =
            tokio::task::spawn_blocking(move || read_downloaded_audio_path(existing_path))
                .await
                .map_err(|error| error.to_string())?
        {
            let track_key_matches = payload
                .metadata
                .track_key
                .as_deref()
                .zip(existing.track_key.as_deref())
                .is_some_and(|(expected, actual)| expected == actual);
            let metadata_matches = existing
                .title
                .trim()
                .eq_ignore_ascii_case(payload.metadata.title.trim())
                && existing
                    .artist
                    .trim()
                    .eq_ignore_ascii_case(payload.metadata.artist.trim());
            if track_key_matches || metadata_matches {
                emit_download_progress(
                    &app,
                    &task_id,
                    Some(100),
                    existing.size,
                    Some(existing.size),
                );
                return Ok(existing);
            }
        }
    }

    let client = build_client(payload.proxy.as_deref(), 60_000)?;
    let mut response = client
        .get(&payload.url)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?;
    let total_bytes = response.content_length();
    emit_download_progress(&app, &task_id, Some(0), 0, total_bytes);

    // Keep the audio extension so the tag reader can identify the staged file.
    let temporary_target = directory.join(format!(".{task_id}.{file_name}"));
    let transfer_result: Result<u64, String> = async {
        let mut file = tokio::fs::File::create(&temporary_target)
            .await
            .map_err(|error| error.to_string())?;
        let mut received_bytes = 0_u64;
        let mut last_progress = Some(0_u8);
        let mut last_emitted_bytes = 0_u64;

        while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
            file.write_all(&chunk)
                .await
                .map_err(|error| error.to_string())?;
            received_bytes = received_bytes.saturating_add(chunk.len() as u64);
            let progress = total_bytes.filter(|total| *total > 0).map(|total| {
                received_bytes
                    .saturating_mul(98)
                    .checked_div(total)
                    .unwrap_or_default()
                    .min(98) as u8
            });
            if progress != last_progress
                || received_bytes.saturating_sub(last_emitted_bytes) >= 256 * 1024
            {
                emit_download_progress(&app, &task_id, progress, received_bytes, total_bytes);
                last_progress = progress;
                last_emitted_bytes = received_bytes;
            }
        }

        file.flush().await.map_err(|error| error.to_string())?;
        Ok(received_bytes)
    }
    .await;

    let received_bytes = match transfer_result {
        Ok(received_bytes) => received_bytes,
        Err(error) => {
            let _ = tokio::fs::remove_file(&temporary_target).await;
            return Err(error);
        }
    };

    emit_download_progress(
        &app,
        &task_id,
        Some(98),
        received_bytes,
        total_bytes.or(Some(received_bytes)),
    );
    let cover = match fetch_cover(&client, payload.metadata.cover_url.as_deref()).await {
        Ok(cover) => cover,
        Err(error) => {
            let _ = tokio::fs::remove_file(&temporary_target).await;
            return Err(error);
        }
    };
    let metadata_target = temporary_target.clone();
    let metadata = payload.metadata.clone();
    let cover_data_url = match tokio::task::spawn_blocking(move || {
        write_download_metadata(&metadata_target, &metadata, cover)
    })
    .await
    .map_err(|e| e.to_string())?
    {
        Ok(cover) => cover,
        Err(error) => {
            let _ = tokio::fs::remove_file(&temporary_target).await;
            return Err(error);
        }
    };
    if let Some(id) = &payload.walkman_id {
        if let Err(error) = crate::walkman::music_root(id) {
            let _ = tokio::fs::remove_file(&temporary_target).await;
            return Err(error);
        }
    }
    let target = match crate::walkman::commit_copy(&temporary_target, &directory, file_name) {
        Ok(path) => path,
        Err(error) => {
            let _ = tokio::fs::remove_file(&temporary_target).await;
            return Err(error);
        }
    };
    let file_metadata = tokio::fs::metadata(&target)
        .await
        .map_err(|error| error.to_string())?;
    let modified_at = file_metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default();
    let format =
        is_supported_audio(&target).ok_or_else(|| "下载完成，但无法识别音频格式".to_string())?;
    let downloaded = DownloadedAudio {
        path: target.to_string_lossy().into_owned(),
        title: payload.metadata.title,
        artist: payload.metadata.artist,
        album: payload.metadata.album,
        format: format.to_string(),
        size: file_metadata.len(),
        modified_at,
        cover_data_url,
        track_key: payload.metadata.track_key,
        import_source: payload.metadata.import_source,
    };
    emit_download_progress(
        &app,
        &task_id,
        Some(100),
        received_bytes,
        total_bytes.or(Some(received_bytes)),
    );
    Ok(downloaded)
}

#[tauri::command]
pub async fn claim_download_file(payload: DownloadClaimPayload) -> Result<String, String> {
    claim_audio_file(payload).await
}

#[tauri::command]
pub async fn delete_download(
    app: tauri::AppHandle,
    path: String,
    directory: Option<String>,
) -> Result<(), String> {
    let target = validated_download_path(&app, &path, directory.as_deref()).await?;
    tokio::fs::remove_file(&target)
        .await
        .map_err(|error| format!("删除下载文件失败：{error}"))
}

async fn collect_audio_files(directory: &Path) -> Result<Vec<AudioFileInfo>, String> {
    let mut pending = vec![directory.to_path_buf()];
    let mut files = Vec::new();

    while let Some(current) = pending.pop() {
        let mut entries = tokio::fs::read_dir(&current)
            .await
            .map_err(|error| format!("读取下载目录失败：{error}"))?;

        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|error| format!("读取下载目录失败：{error}"))?
        {
            let path = entry.path();
            let file_type = entry
                .file_type()
                .await
                .map_err(|error| format!("读取文件信息失败：{error}"))?;
            if file_type.is_dir() {
                pending.push(path);
                continue;
            }
            if !file_type.is_file() || entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let Some(format) = is_supported_audio(&path) else {
                continue;
            };
            let metadata = tokio::fs::metadata(&path)
                .await
                .map_err(|error| format!("读取文件信息失败：{error}"))?;
            files.push(AudioFileInfo {
                path,
                size: metadata.len(),
                modified_at: metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis() as u64)
                    .unwrap_or_default(),
                format,
            });
        }
    }

    Ok(files)
}

fn read_downloaded_audio(file: AudioFileInfo) -> Option<DownloadedAudio> {
    let tags = crate::audio_tags::read_tags(&file.path, true).ok()?;
    if !tags.managed {
        return None;
    }
    let title = if tags.title.trim().is_empty() {
        file.path.file_stem()?.to_string_lossy().into()
    } else {
        tags.title
    };
    Some(DownloadedAudio {
        path: file.path.to_string_lossy().into(),
        title,
        artist: tags.artist,
        album: tags.album,
        format: file.format.into(),
        size: file.size,
        modified_at: file.modified_at,
        cover_data_url: tags.cover_data_url,
        track_key: tags.track_key,
        import_source: tags.import_source,
    })
}

fn read_downloaded_audio_path(path: PathBuf) -> Option<DownloadedAudio> {
    let format = is_supported_audio(&path)?;
    let metadata = std::fs::metadata(&path).ok()?;
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default();
    read_downloaded_audio(AudioFileInfo {
        path,
        size: metadata.len(),
        modified_at,
        format,
    })
}

fn emit_download_progress(
    app: &tauri::AppHandle,
    task_id: &str,
    progress: Option<u8>,
    received_bytes: u64,
    total_bytes: Option<u64>,
) {
    let _ = app.emit(
        DOWNLOAD_PROGRESS_EVENT,
        DownloadProgress {
            task_id: task_id.to_string(),
            progress,
            received_bytes,
            total_bytes,
        },
    );
}

#[tauri::command]
pub async fn list_downloads(
    app: tauri::AppHandle,
    directory: Option<String>,
) -> Result<Vec<DownloadedAudio>, String> {
    let download_directory = resolve_download_directory(&app, directory.as_deref())?;
    if !download_directory.is_dir() {
        return Ok(Vec::new());
    }

    let files = collect_audio_files(&download_directory).await?;
    tokio::task::spawn_blocking(move || {
        files
            .into_iter()
            .filter_map(read_downloaded_audio)
            .map(|mut item| {
                item.title = item.title.trim().to_string();
                item.artist = item.artist.trim().to_string();
                item.album = item.album.trim().to_string();
                item
            })
            .collect()
    })
    .await
    .map_err(|error| error.to_string())
}
