use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use crate::{
    audio_tags::{self, AudioTags},
    downloads::{self, DownloadMetadata},
};
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkmanDevice {
    pub id: String,
    pub name: String,
    pub music_directory: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkmanTrack {
    pub path: String,
    pub relative_path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub format: String,
    pub size: u64,
    pub modified_at: u64,
    pub has_cover: bool,
    pub inferred_fields: Vec<String>,
    pub missing_fields: Vec<String>,
    pub tag_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkmanLibrary {
    pub files: Vec<WalkmanTrack>,
    pub issues: Vec<String>,
}

fn volume_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    #[cfg(target_os = "macos")]
    if let Ok(entries) = fs::read_dir("/Volumes") {
        roots.extend(entries.flatten().map(|e| e.path()).filter(|p| {
            p.file_name()
                .is_some_and(|n| n.to_string_lossy().to_uppercase().starts_with("WALKMAN"))
        }));
    }
    #[cfg(target_os = "linux")]
    for base in ["/media", "/run/media", "/mnt"] {
        if let Ok(entries) = fs::read_dir(base) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path
                    .file_name()
                    .is_some_and(|n| n.to_string_lossy().to_uppercase().starts_with("WALKMAN"))
                {
                    roots.push(path.clone());
                }
                if let Ok(children) = fs::read_dir(path) {
                    roots.extend(children.flatten().map(|e| e.path()).filter(|p| {
                        p.file_name().is_some_and(|n| {
                            n.to_string_lossy().to_uppercase().starts_with("WALKMAN")
                        })
                    }));
                }
            }
        }
    }
    #[cfg(target_os = "windows")]
    if let Ok(output) = std::process::Command::new("powershell").args(["-NoProfile", "-NonInteractive", "-Command", "Get-Volume | Where-Object { $_.FileSystemLabel -like 'WALKMAN*' -and $_.DriveLetter } | ForEach-Object { $_.DriveLetter + ':\\' }"]).output() {
        if output.status.success() { roots.extend(String::from_utf8_lossy(&output.stdout).lines().map(|s| PathBuf::from(s.trim()))); }
    }
    roots.sort();
    roots.dedup();
    roots
}

pub(crate) fn devices() -> Result<Vec<WalkmanDevice>, String> {
    volume_roots()
        .into_iter()
        .filter(|root| root.join("MUSIC").is_dir())
        .map(|root| {
            let root = root.canonicalize().map_err(|e| e.to_string())?;
            let music = root
                .join("MUSIC")
                .canonicalize()
                .map_err(|e| e.to_string())?;
            if !music.starts_with(&root) {
                return Err("WALKMAN MUSIC 目录无效".into());
            }
            Ok(WalkmanDevice {
                id: root.to_string_lossy().into(),
                name: root
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into(),
                music_directory: music.to_string_lossy().into(),
                total_bytes: fs2::total_space(&root).map_err(|e| e.to_string())?,
                free_bytes: fs2::available_space(&root).map_err(|e| e.to_string())?,
            })
        })
        .collect()
}

pub(crate) fn music_root(device_id: &str) -> Result<PathBuf, String> {
    devices()?
        .into_iter()
        .find(|d| d.id == device_id)
        .map(|d| PathBuf::from(d.music_directory))
        .ok_or_else(|| "WALKMAN 已断开连接，请重新连接后再试".into())
}

fn device_file(root: &Path, path: &str) -> Result<PathBuf, String> {
    let canonical = Path::new(path)
        .canonicalize()
        .map_err(|e| format!("文件不可用：{e}"))?;
    if !canonical.starts_with(root)
        || !canonical.is_file()
        || audio_tags::audio_format(&canonical).is_none()
    {
        return Err("只能管理 WALKMAN MUSIC 目录中的音频文件".into());
    }
    Ok(canonical)
}

fn delete_music_file(root: &Path, path: &str) -> Result<(), String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let metadata = fs::symlink_metadata(path).map_err(|e| format!("文件不可用：{e}"))?;
    if metadata.file_type().is_symlink() {
        return Err("不能删除符号链接指向的音乐文件".into());
    }
    let target = device_file(&root, path)?;
    fs::remove_file(target).map_err(|e| format!("删除 WALKMAN 音乐失败：{e}"))
}

#[tauri::command]
pub async fn delete_walkman_file(device_id: String, path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let root = music_root(&device_id)?;
        delete_music_file(&root, &path)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn safe_component(value: &str) -> String {
    let result: String = value
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .take(100)
        .collect();
    let result = result.trim().trim_matches('.');
    if result.is_empty() {
        "未分类".into()
    } else {
        result.into()
    }
}

pub(crate) fn album_directory(root: &Path, metadata: &DownloadMetadata) -> Result<PathBuf, String> {
    create_subdirectory(
        root,
        &PathBuf::from(safe_component(&metadata.artist)).join(safe_component(&metadata.album)),
    )
}

fn create_subdirectory(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    let base = root.canonicalize().map_err(|e| e.to_string())?;
    let mut directory = base.clone();
    for component in relative.components() {
        let std::path::Component::Normal(name) = component else {
            return Err("音乐子目录无效".into());
        };
        directory.push(name);
        match fs::symlink_metadata(&directory) {
            Ok(metadata) if metadata.is_symlink() || !metadata.is_dir() => {
                return Err("音乐目录不能是符号链接或文件".into())
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if let Err(error) = fs::create_dir(&directory) {
                    if error.kind() != std::io::ErrorKind::AlreadyExists {
                        return Err(error.to_string());
                    }
                }
            }
            Err(error) => return Err(error.to_string()),
        }
        let canonical = directory.canonicalize().map_err(|e| e.to_string())?;
        if !canonical.starts_with(&base) {
            return Err("音乐目录不能指向根目录外部".into());
        }
    }
    Ok(directory)
}

// Reserve a name with create_new; never replace an existing song, even under concurrent downloads.
pub(crate) fn commit_copy(
    temporary: &Path,
    directory: &Path,
    name: &str,
) -> Result<PathBuf, String> {
    commit_staged_file(temporary, directory, name, None)
}

fn commit_staged_file(
    temporary: &Path,
    directory: &Path,
    name: &str,
    original: Option<&Path>,
) -> Result<PathBuf, String> {
    let name_path = Path::new(name);
    if name_path.file_name().and_then(|n| n.to_str()) != Some(name) || name.contains(['/', '\\']) {
        return Err("音乐文件名无效".into());
    }
    let stem = name_path.file_stem().unwrap_or_default().to_string_lossy();
    let extension = name_path.extension().unwrap_or_default().to_string_lossy();
    for index in 0..10_000 {
        let target = directory.join(if index == 0 {
            name.to_string()
        } else {
            format!("{stem} ({index}).{extension}")
        });
        if original.is_some_and(|source| {
            target == source
                || (fs::symlink_metadata(&target).is_ok_and(|metadata| metadata.is_file())
                    && target.canonicalize().is_ok_and(|path| path == source))
        }) {
            fs::rename(temporary, &target).map_err(|e| e.to_string())?;
            return Ok(target);
        }
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(reservation) => {
                drop(reservation);
                if let Err(error) = fs::rename(temporary, &target) {
                    let _ = fs::remove_file(&target);
                    return Err(error.to_string());
                }
                if let Some(source) = original {
                    if let Err(error) = fs::remove_file(source) {
                        return match fs::remove_file(&target) {
                            Ok(()) => Err(format!("重命名失败，已保留原文件：{error}")),
                            Err(cleanup) => Err(format!(
                                "新文件已保存至 {}，原文件移除失败：{error}；新文件回滚失败：{cleanup}",
                                target.display()
                            )),
                        };
                    }
                }
                return Ok(target);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("同名文件过多，请更换文件名".into())
}

fn tagged_file_name(source: &Path, metadata: &DownloadMetadata) -> Result<String, String> {
    if metadata.title.trim().is_empty() {
        return Err("歌曲名不能为空".into());
    }
    if metadata.artist.trim().is_empty() {
        return Err("歌手不能为空".into());
    }
    let component = |value: &str| {
        let mut name = safe_component(value);
        // Leave room for both names, the extension, and a collision suffix on the device.
        while name.len() > 100 {
            name.pop();
        }
        name
    };
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .ok_or("不支持的音频格式")?;
    Ok(format!(
        "{}-{}.{}",
        component(&metadata.artist),
        component(&metadata.title),
        extension
    ))
}

fn copy_audio_file(
    source: &Path,
    destination: &Path,
    metadata: &DownloadMetadata,
    mark_export: bool,
    verify_device: impl FnOnce() -> Result<(), String>,
) -> Result<String, String> {
    let original = source.metadata().map_err(|e| e.to_string())?;
    if fs2::available_space(destination).map_err(|e| e.to_string())?
        < original.len().saturating_add(2 * 1024 * 1024)
    {
        return Err("目标存储空间不足".into());
    }
    let name = source.file_name().unwrap_or_default().to_string_lossy();
    let temporary = destination.join(format!(".{}.{}", uuid::Uuid::new_v4(), name));
    let result = (|| {
        fs::copy(source, &temporary).map_err(|e| format!("复制音乐失败：{e}"))?;
        if mark_export {
            audio_tags::write_tags(&temporary, metadata, None, true)?;
        } else {
            // A local download may predate cover compatibility normalization.
            audio_tags::normalize_embedded_cover(&temporary)?;
        }
        fs::OpenOptions::new()
            .write(true)
            .open(&temporary)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
        verify_device()?;
        let current = source.metadata().map_err(|e| e.to_string())?;
        if current.len() != original.len() || current.modified().ok() != original.modified().ok() {
            return Err("复制期间原文件发生变化，请重试".into());
        }
        commit_copy(&temporary, destination, &name).map(|p| p.to_string_lossy().into_owned())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn fallback_metadata(path: &Path, tags: &AudioTags) -> DownloadMetadata {
    let stem = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .replace("+-+", " - ");
    let parts = stem.split_once(" - ");
    DownloadMetadata {
        title: if tags.title.trim().is_empty() {
            parts.map(|(_, t)| t).unwrap_or(&stem).trim().into()
        } else {
            tags.title.clone()
        },
        artist: if tags.artist.trim().is_empty() {
            parts.map(|(a, _)| a).unwrap_or("").trim().into()
        } else {
            tags.artist.clone()
        },
        album: tags.album.clone(),
        cover_url: None,
        track_key: tags.track_key.clone(),
        import_source: tags.import_source.clone(),
    }
}

fn scan_music(root: &Path) -> Result<WalkmanLibrary, String> {
    let mut pending = vec![root.to_path_buf()];
    let mut files = Vec::new();
    let mut issues = Vec::new();
    while let Some(directory) = pending.pop() {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(e) => {
                issues.push(format!("{}：{e}", directory.display()));
                continue;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(e) => {
                    issues.push(e.to_string());
                    continue;
                }
            };
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let path = entry.path();
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                pending.push(path);
                continue;
            }
            if !kind.is_file() {
                continue;
            }
            if audio_tags::audio_format(&path).is_none() {
                continue;
            }
            files.push(inspect_track(root, &path)?);
        }
    }
    files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(WalkmanLibrary { files, issues })
}

fn inspect_track(root: &Path, path: &Path) -> Result<WalkmanTrack, String> {
    let format = audio_tags::audio_format(path).ok_or("不支持的音频格式")?;
    let file_metadata = path.metadata().map_err(|e| e.to_string())?;
    let (tags, tag_error) = match audio_tags::read_tags(path, false) {
        Ok(tags) => (tags, None),
        Err(e) => (AudioTags::default(), Some(e)),
    };
    let mut missing_fields = Vec::new();
    if tags.title.trim().is_empty() {
        missing_fields.push("歌曲名".into());
    }
    if tags.artist.trim().is_empty() {
        missing_fields.push("歌手".into());
    }
    if tags.album.trim().is_empty() {
        missing_fields.push("专辑".into());
    }
    if !tags.has_cover {
        missing_fields.push("封面".into());
    }
    let metadata = fallback_metadata(path, &tags);
    let mut inferred_fields = Vec::new();
    if tags.title.trim().is_empty() && !metadata.title.trim().is_empty() {
        inferred_fields.push("歌曲名".into());
    }
    if tags.artist.trim().is_empty() && !metadata.artist.trim().is_empty() {
        inferred_fields.push("歌手".into());
    }
    Ok(WalkmanTrack {
        relative_path: path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .into(),
        path: path.to_string_lossy().into(),
        title: metadata.title,
        artist: metadata.artist,
        album: metadata.album,
        format: format.into(),
        size: file_metadata.len(),
        modified_at: file_metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos() / 1_000_000)
            .unwrap_or_default() as u64,
        has_cover: tags.has_cover,
        inferred_fields,
        missing_fields,
        tag_error,
    })
}

#[tauri::command]
pub async fn detect_walkman() -> Result<Vec<WalkmanDevice>, String> {
    tokio::task::spawn_blocking(devices)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_walkman_music(device_id: String) -> Result<WalkmanLibrary, String> {
    tokio::task::spawn_blocking(move || scan_music(&music_root(&device_id)?))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_walkman_artwork(
    device_id: String,
    path: String,
) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let root = music_root(&device_id)?;
        let file = device_file(&root, &path)?;
        audio_tags::read_tags(&file, true).map(|tags| tags.cover_data_url)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn transfer_walkman_file(
    app: tauri::AppHandle,
    device_id: String,
    path: String,
    to_walkman: bool,
    directory: Option<String>,
) -> Result<String, String> {
    let root = music_root(&device_id)?;
    let source = if to_walkman {
        downloads::validated_download_path(&app, &path, directory.as_deref()).await?
    } else {
        device_file(&root, &path)?
    };
    let download_directory = downloads::resolve_download_directory(&app, directory.as_deref())?;
    tokio::task::spawn_blocking(move || {
        let tags = audio_tags::read_tags(&source, false)?;
        let mut metadata = fallback_metadata(&source, &tags);
        if !to_walkman {
            metadata.import_source = Some("WALKMAN".into());
        }
        let destination = if to_walkman {
            album_directory(&root, &metadata)?
        } else {
            let relative = source.strip_prefix(&root).map_err(|e| e.to_string())?;
            fs::create_dir_all(&download_directory).map_err(|e| e.to_string())?;
            create_subdirectory(
                &download_directory,
                &Path::new("WALKMAN").join(relative.parent().unwrap_or(Path::new(""))),
            )?
        };
        copy_audio_file(&source, &destination, &metadata, !to_walkman, || {
            music_root(&device_id).map(|_| ())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn update_walkman_tags(
    app: tauri::AppHandle,
    device_id: String,
    path: String,
    metadata: DownloadMetadata,
    proxy: Option<String>,
) -> Result<WalkmanTrack, String> {
    let root = music_root(&device_id)?;
    let source = device_file(&root, &path)?;
    tagged_file_name(&source, &metadata)?;
    let cover = crate::cover_cache::fetch_cover(
        &app,
        metadata.cover_url.as_deref(),
        proxy.as_deref(),
    )
    .await?;
    if metadata
        .cover_url
        .as_deref()
        .is_some_and(|url| !url.trim().is_empty())
        && cover.is_none()
    {
        return Err("封面地址无效，请选择匹配歌曲的封面或填写 HTTP/HTTPS 图片地址".into());
    }
    tokio::task::spawn_blocking(move || {
        update_music_tags(&root, &source, &metadata, cover, || {
            music_root(&device_id).map(|_| ())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn update_music_tags(
    root: &Path,
    source: &Path,
    metadata: &DownloadMetadata,
    cover: Option<Vec<u8>>,
    verify_device: impl FnOnce() -> Result<(), String>,
) -> Result<WalkmanTrack, String> {
    let name = tagged_file_name(source, metadata)?;
    let temporary = source.with_file_name(format!(
        ".{}.{}",
        uuid::Uuid::new_v4(),
        source.extension().unwrap_or_default().to_string_lossy()
    ));
    let result = (|| {
        let original = source.metadata().map_err(|e| e.to_string())?;
        if fs2::available_space(root).map_err(|e| e.to_string())?
            < original.len().saturating_add(2 * 1024 * 1024)
        {
            return Err("设备剩余空间不足，无法安全写入标签".into());
        }
        fs::copy(source, &temporary).map_err(|e| e.to_string())?;
        let expected_cover = audio_tags::write_tags(&temporary, metadata, cover, false)?;
        let written = audio_tags::read_tags(&temporary, true)?;
        if expected_cover.is_some() && written.cover_data_url != expected_cover {
            return Err("封面没有成功写入文件，请更换图片后重试".into());
        }
        if !written.has_cover {
            return Err("文件仍缺少封面，请先选择匹配歌曲的封面".into());
        }
        let mut file = fs::OpenOptions::new()
            .write(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        file.flush()
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        // Inspect before committing so a failed tag read leaves the original file untouched.
        let mut updated = inspect_track(root, &temporary)?;
        verify_device()?;
        let current = source.metadata().map_err(|e| e.to_string())?;
        if current.len() != original.len() || current.modified().ok() != original.modified().ok() {
            return Err("原文件已变化，请刷新后重试".into());
        }
        let target = commit_staged_file(
            &temporary,
            source.parent().ok_or("音乐文件路径无效")?,
            &name,
            Some(source),
        )?;
        updated.relative_path = target
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .into();
        updated.path = target.to_string_lossy().into();
        Ok(updated)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn untagged_dsf(path: &Path) -> Vec<u8> {
        let mut bytes = b"DSD ".to_vec();
        bytes.extend(28u64.to_le_bytes());
        bytes.extend(128u64.to_le_bytes());
        bytes.extend(0u64.to_le_bytes());
        bytes.extend([42u8; 100]);
        fs::write(path, &bytes).unwrap();
        bytes
    }

    fn test_metadata() -> DownloadMetadata {
        DownloadMetadata {
            title: "歌曲".into(),
            artist: "歌手".into(),
            album: "专辑".into(),
            cover_url: None,
            track_key: Some("wy_test".into()),
            import_source: None,
        }
    }

    #[test]
    fn tag_update_renames_in_place_and_preserves_audio_cover_and_extension() {
        let directory = tempfile::tempdir().unwrap();
        let album = directory.path().join("子目录");
        fs::create_dir(&album).unwrap();
        let source = album.join("01 - unknown.DSF");
        let original = untagged_dsf(&source);
        let metadata = test_metadata();
        let picture = include_bytes!("../icons/32x32.png").to_vec();
        let updated =
            update_music_tags(directory.path(), &source, &metadata, Some(picture), || {
                Ok(())
            })
            .unwrap();
        let expected = album.join("歌手-歌曲.DSF");
        assert_eq!(Path::new(&updated.path), expected);
        assert_eq!(
            Path::new(&updated.relative_path),
            Path::new("子目录").join("歌手-歌曲.DSF")
        );
        assert!(!source.exists());
        assert!(updated.missing_fields.is_empty());
        let tags = audio_tags::read_tags(&expected, true).unwrap();
        assert_eq!(tags.title, metadata.title);
        assert_eq!(tags.artist, metadata.artist);
        assert_eq!(tags.track_key, metadata.track_key);
        let saved_cover = tags.cover_data_url.unwrap();
        // Saving an already normalized name again must keep that name and its embedded cover.
        let again =
            update_music_tags(directory.path(), &expected, &metadata, None, || Ok(())).unwrap();
        assert_eq!(again.path, updated.path);
        assert_eq!(
            audio_tags::read_tags(&expected, true)
                .unwrap()
                .cover_data_url,
            Some(saved_cover)
        );
        assert_eq!(&fs::read(&expected).unwrap()[28..128], &original[28..]);
        assert_eq!(fs::read_dir(&album).unwrap().count(), 1);
    }

    #[test]
    fn tag_update_keeps_colliding_songs_and_reuses_its_own_suffix() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("old.dsf");
        untagged_dsf(&source);
        let existing = directory.path().join("歌手-歌曲.dsf");
        fs::write(&existing, b"another song").unwrap();
        let metadata = test_metadata();
        let updated = update_music_tags(
            directory.path(),
            &source,
            &metadata,
            Some(include_bytes!("../icons/32x32.png").to_vec()),
            || Ok(()),
        )
        .unwrap();
        let expected = directory.path().join("歌手-歌曲 (1).dsf");
        assert_eq!(Path::new(&updated.path), expected);
        assert_eq!(fs::read(&existing).unwrap(), b"another song");
        let again =
            update_music_tags(directory.path(), &expected, &metadata, None, || Ok(())).unwrap();
        assert_eq!(again.path, updated.path);
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 2);
        assert!(!source.exists());
    }

    #[test]
    fn failed_tag_update_leaves_original_name_and_bytes_untouched() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("old.dsf");
        let original = untagged_dsf(&source);
        let mut metadata = test_metadata();
        // Missing artwork and a disconnect both fail before committing the new name.
        assert!(update_music_tags(directory.path(), &source, &metadata, None, || Ok(())).is_err());
        assert!(update_music_tags(
            directory.path(),
            &source,
            &metadata,
            Some(include_bytes!("../icons/32x32.png").to_vec()),
            || Err("disconnected".into()),
        )
        .is_err());
        metadata.artist.clear();
        assert_eq!(
            update_music_tags(directory.path(), &source, &metadata, None, || Ok(())).unwrap_err(),
            "歌手不能为空"
        );
        assert_eq!(fs::read(&source).unwrap(), original);
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn tag_update_sanitizes_long_names_without_changing_metadata_or_directory() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("old.dsf");
        untagged_dsf(&source);
        let mut metadata = test_metadata();
        metadata.artist = format!("演:唱*者{}", "歌手".repeat(80));
        metadata.title = format!("../夜/空?{}", "歌曲".repeat(80));
        let updated = update_music_tags(
            directory.path(),
            &source,
            &metadata,
            Some(include_bytes!("../icons/32x32.png").to_vec()),
            || Ok(()),
        )
        .unwrap();
        let path = Path::new(&updated.path);
        assert_eq!(path.parent(), Some(directory.path()));
        let name = path.file_name().unwrap().to_str().unwrap();
        assert!(name.len() < 255);
        assert!(!name.contains(['/', '\\', ':', '*', '?']));
        assert_eq!(path.extension().unwrap(), "dsf");
        let tags = audio_tags::read_tags(path, false).unwrap();
        assert_eq!(tags.artist, metadata.artist);
        assert_eq!(tags.title, metadata.title);
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn tag_rename_does_not_replace_an_existing_symlink() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("old.dsf");
        untagged_dsf(&source);
        let link = directory.path().join("歌手-歌曲.dsf");
        std::os::unix::fs::symlink(&source, &link).unwrap();
        let source = source.canonicalize().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let updated = update_music_tags(
            &root,
            &source,
            &test_metadata(),
            Some(include_bytes!("../icons/32x32.png").to_vec()),
            || Ok(()),
        )
        .unwrap();
        assert_eq!(Path::new(&updated.path), root.join("歌手-歌曲 (1).dsf"));
        assert!(fs::symlink_metadata(&link).unwrap().is_symlink());
        assert_eq!(
            fs::read_link(&link).unwrap(),
            directory.path().join("old.dsf")
        );
    }

    #[test]
    fn deletes_only_selected_audio_inside_music_directory() {
        let music = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(music.path().join("album")).unwrap();
        let selected = music.path().join("album/selected.mp3");
        let retained = music.path().join("album/retained.flac");
        let other = outside.path().join("other.mp3");
        let picture = music.path().join("cover.jpg");
        for file in [&selected, &retained, &other, &picture] {
            fs::write(file, b"fixture").unwrap();
        }
        assert!(delete_music_file(music.path(), other.to_str().unwrap()).is_err());
        assert!(delete_music_file(music.path(), picture.to_str().unwrap()).is_err());
        assert!(
            delete_music_file(music.path(), music.path().join("album").to_str().unwrap()).is_err()
        );
        delete_music_file(music.path(), selected.to_str().unwrap()).unwrap();
        assert!(!selected.exists());
        for file in [&retained, &other, &picture] {
            assert_eq!(fs::read(file).unwrap(), b"fixture");
        }
    }
    #[cfg(unix)]
    #[test]
    fn refuses_to_delete_a_symlink_target() {
        let music = tempfile::tempdir().unwrap();
        let original = music.path().join("original.mp3");
        let link = music.path().join("link.mp3");
        fs::write(&original, b"fixture").unwrap();
        std::os::unix::fs::symlink(&original, &link).unwrap();
        assert!(delete_music_file(music.path(), link.to_str().unwrap()).is_err());
        assert_eq!(fs::read(&original).unwrap(), b"fixture");
    }
    #[test]
    fn inferred_names_are_distinct_from_embedded_tags_and_cover_is_required_for_completeness() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("歌手 - 歌曲.dsf");
        let mut original = b"DSD ".to_vec();
        original.extend(28u64.to_le_bytes());
        original.extend(128u64.to_le_bytes());
        original.extend(0u64.to_le_bytes());
        original.extend([42u8; 100]);
        fs::write(&path, original).unwrap();
        let before = inspect_track(directory.path(), &path).unwrap();
        assert_eq!(before.title, "歌曲");
        assert_eq!(before.artist, "歌手");
        assert_eq!(before.inferred_fields, ["歌曲名", "歌手"]);
        assert!(before.missing_fields.contains(&"封面".into()));
        let metadata = DownloadMetadata {
            title: "歌曲".into(),
            artist: "歌手".into(),
            album: "专辑".into(),
            cover_url: None,
            track_key: None,
            import_source: None,
        };
        audio_tags::write_tags(&path, &metadata, None, false).unwrap();
        let text_only = inspect_track(directory.path(), &path).unwrap();
        assert!(text_only.inferred_fields.is_empty());
        assert_eq!(text_only.missing_fields, ["封面"]);
        audio_tags::write_tags(
            &path,
            &metadata,
            Some(include_bytes!("../icons/32x32.png").to_vec()),
            false,
        )
        .unwrap();
        let complete = inspect_track(directory.path(), &path).unwrap();
        assert!(complete.has_cover);
        assert!(complete.missing_fields.is_empty());
    }
    #[test]
    fn selected_export_marks_copy_and_disconnect_discards_partial_file() {
        let source_dir = tempfile::tempdir().unwrap();
        let destination = tempfile::tempdir().unwrap();
        let source = source_dir.path().join("artist - song.dsf");
        let mut original = b"DSD ".to_vec();
        original.extend(28u64.to_le_bytes());
        original.extend(128u64.to_le_bytes());
        original.extend(0u64.to_le_bytes());
        original.extend([42u8; 100]);
        fs::write(&source, &original).unwrap();
        let metadata = DownloadMetadata {
            title: "song".into(),
            artist: "artist".into(),
            album: "album".into(),
            cover_url: None,
            track_key: None,
            import_source: Some("WALKMAN".into()),
        };
        assert!(
            copy_audio_file(&source, destination.path(), &metadata, true, || Err(
                "disconnected".into()
            ))
            .is_err()
        );
        assert_eq!(fs::read_dir(destination.path()).unwrap().count(), 0);
        let copy =
            copy_audio_file(&source, destination.path(), &metadata, true, || Ok(())).unwrap();
        let tags = audio_tags::read_tags(Path::new(&copy), false).unwrap();
        assert!(tags.managed);
        assert_eq!(tags.import_source.as_deref(), Some("WALKMAN"));
        assert_eq!(fs::read(&source).unwrap(), original);
        let imported = tempfile::tempdir().unwrap();
        let copy_back =
            copy_audio_file(Path::new(&copy), imported.path(), &metadata, false, || {
                Ok(())
            })
            .unwrap();
        assert_eq!(fs::read(copy_back).unwrap(), fs::read(copy).unwrap());
    }
    #[test]
    #[ignore = "requires a connected WALKMAN and ffmpeg; writes only temporary copies"]
    fn connected_device_audio_roundtrip() {
        let devices = devices().unwrap();
        let device = devices.first().expect("connect a WALKMAN");
        assert!(device.total_bytes > device.free_bytes);
        let library = scan_music(Path::new(&device.music_directory)).unwrap();
        println!(
            "device: {} files, {} free / {} total",
            library.files.len(),
            device.free_bytes,
            device.total_bytes
        );
        let directory = tempfile::tempdir().unwrap();
        let checksum = |path: &Path| {
            let output = std::process::Command::new("ffmpeg")
                .args(["-v", "error", "-i"])
                .arg(path)
                .args(["-map", "0:a:0", "-f", "md5", "-"])
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            output.stdout
        };
        for format in ["mp3", "flac", "wav", "ape", "dsf"] {
            let Some(sample) = library
                .files
                .iter()
                .filter(|f| f.format == format)
                .min_by_key(|f| f.size)
            else {
                println!("{format}: no connected-device fixture; covered by local format tests");
                continue;
            };
            let copy = directory.path().join(format!("test.{format}"));
            fs::copy(&sample.path, &copy).unwrap();
            let before = checksum(&copy);
            let metadata = DownloadMetadata {
                title: "One Player 标签验证".into(),
                artist: "测试歌手".into(),
                album: "测试专辑".into(),
                cover_url: None,
                track_key: Some("kw_test".into()),
                import_source: Some("WALKMAN".into()),
            };
            let picture = include_bytes!("../icons/32x32.png").to_vec();
            let expected_cover =
                audio_tags::write_tags(&copy, &metadata, Some(picture), true).unwrap();
            assert!(expected_cover.is_some());
            assert_eq!(
                audio_tags::read_tags(&copy, true).unwrap().cover_data_url,
                expected_cover,
                "{format} embedded cover"
            );
            // The complete edit flow must rename the copy and preserve embedded artwork.
            let renamed =
                update_music_tags(directory.path(), &copy, &metadata, None, || Ok(())).unwrap();
            assert!(!copy.exists());
            let copy = PathBuf::from(renamed.path);
            assert_eq!(
                copy.file_name().unwrap().to_string_lossy(),
                format!("测试歌手-One Player 标签验证.{format}")
            );
            let again =
                update_music_tags(directory.path(), &copy, &metadata, None, || Ok(())).unwrap();
            assert_eq!(Path::new(&again.path), copy);
            let tags = audio_tags::read_tags(&copy, false).unwrap();
            assert_eq!(tags.title, metadata.title, "{format}");
            assert_eq!(tags.artist, metadata.artist, "{format}");
            assert_eq!(tags.album, metadata.album, "{format}");
            assert!(tags.managed, "{format} marker");
            assert!(
                tags.has_cover,
                "{format} cover detection without loading image data"
            );
            assert_eq!(tags.track_key.as_deref(), Some("kw_test"), "{format}");
            assert_eq!(tags.import_source.as_deref(), Some("WALKMAN"), "{format}");
            assert_eq!(before, checksum(&copy), "{format} audio changed");
            assert_eq!(
                audio_tags::read_tags(&copy, true).unwrap().cover_data_url,
                expected_cover,
                "{format} preserved cover"
            );
            println!(
                "{format}: tags saved, renamed twice without duplication, cover preserved, decoded audio unchanged"
            );
        }
    }
    #[test]
    fn copies_never_replace_existing_files() {
        let dir = tempfile::tempdir().unwrap();
        let tmp = dir.path().join(".part");
        fs::write(dir.path().join("song.mp3"), b"original").unwrap();
        fs::write(&tmp, b"new").unwrap();
        assert_eq!(
            commit_copy(&tmp, dir.path(), "song.mp3")
                .unwrap()
                .file_name()
                .unwrap(),
            "song (1).mp3"
        );
        assert_eq!(fs::read(dir.path().join("song.mp3")).unwrap(), b"original");
    }
    #[test]
    fn confines_device_files_and_sanitizes_directories() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let path = outside.path().join("song.mp3");
        fs::write(&path, b"x").unwrap();
        assert!(device_file(dir.path(), path.to_str().unwrap()).is_err());
        assert!(!safe_component("../../artist").contains('/'));
    }
    #[test]
    fn recursively_finds_supported_files_and_skips_hidden_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("album")).unwrap();
        for name in [
            "album/a.APE",
            "album/b.dsf",
            "c.wav",
            ".hidden.mp3",
            "cover.jpg",
        ] {
            fs::write(dir.path().join(name), b"x").unwrap();
        }
        let result = scan_music(dir.path()).unwrap();
        assert_eq!(result.files.len(), 3);
        assert!(result.files.iter().all(|f| f.tag_error.is_some()));
    }
}
