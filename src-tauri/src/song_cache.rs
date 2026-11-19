use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
    sync::Mutex,
};

use fs2::FileExt;
use lofty::{file::FileType, probe::Probe};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tokio::{io::AsyncWriteExt, sync::Semaphore};

const MEBIBYTE: u64 = 1024 * 1024;
const DEFAULT_LIMIT: u64 = 512 * MEBIBYTE;

#[derive(Clone, Deserialize, Serialize)]
struct Entry {
    extension: String,
    quality: String,
    bytes: u64,
    frequency: u64,
    last_used: u64,
}

impl Entry {
    fn audio_path(&self, directory: &Path) -> PathBuf {
        directory.join(format!("audio.{}", self.extension))
    }

    fn read(directory: &Path) -> Option<Self> {
        let entry: Self =
            serde_json::from_slice(&fs::read(directory.join("entry.json")).ok()?).ok()?;
        if !matches!(
            entry.extension.as_str(),
            "mp3" | "flac" | "aac" | "m4a" | "ogg" | "opus" | "wav"
        ) {
            return None;
        }
        let audio = fs::symlink_metadata(entry.audio_path(directory)).ok()?;
        (audio.is_file() && entry.bytes > 0 && audio.len() == entry.bytes).then_some(entry)
    }

    fn save(&self, directory: &Path) -> io::Result<()> {
        let temporary = directory.join("entry.tmp");
        fs::write(&temporary, serde_json::to_vec(self)?)?;
        fs::rename(temporary, directory.join("entry.json"))
    }
}

struct Cache {
    directory: PathBuf,
    _lock: File,
    entries: HashMap<String, Entry>,
    limit: u64,
    last_used: u64,
    active_key: Option<String>,
}

impl Cache {
    fn open(directory: PathBuf) -> io::Result<Self> {
        fs::create_dir_all(&directory)?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(directory.join("cache.lock"))?;
        lock.try_lock_exclusive()?;
        let mut entries = HashMap::new();
        let mut last_used = 0;
        for file in fs::read_dir(&directory)? {
            let file = file?;
            if !file.file_type()?.is_dir() {
                continue;
            }
            let key = file.file_name().to_string_lossy().into_owned();
            if key.len() == 64 && key.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                if let Some(entry) = Entry::read(&file.path()) {
                    last_used = last_used.max(entry.last_used);
                    entries.insert(key, entry);
                    continue;
                }
            }
            fs::remove_dir_all(file.path())?;
        }
        Ok(Self {
            directory,
            _lock: lock,
            entries,
            limit: DEFAULT_LIMIT,
            last_used,
            active_key: None,
        })
    }

    fn remove(&mut self, key: &str) -> io::Result<()> {
        match fs::remove_dir_all(self.directory.join(key)) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        self.entries.remove(key);
        Ok(())
    }

    fn trim(&mut self, limit: u64) -> io::Result<bool> {
        let mut bytes: u64 = self.entries.values().map(|entry| entry.bytes).sum();
        if bytes <= limit {
            return Ok(true);
        }
        let mut victims: Vec<_> = self
            .entries
            .iter()
            .filter(|(key, _)| Some(key.as_str()) != self.active_key.as_deref())
            .map(|(key, entry)| (entry.frequency, entry.last_used, key.clone(), entry.bytes))
            .collect();
        victims.sort_unstable();
        for (_, _, key, size) in victims {
            self.remove(&key)?;
            bytes -= size;
            if bytes <= limit {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn lookup(&mut self, key: Option<String>) -> io::Result<Option<(PathBuf, String)>> {
        self.active_key = None;
        self.trim(self.limit)?;
        let Some(key) = key else { return Ok(None) };
        let Some(entry) = self.entries.get_mut(&key) else {
            return Ok(None);
        };
        let directory = self.directory.join(&key);
        let path = entry.audio_path(&directory);
        if !fs::metadata(&path).is_ok_and(|file| file.len() == entry.bytes) {
            self.remove(&key)?;
            return Ok(None);
        }
        self.last_used += 1;
        entry.last_used = self.last_used;
        entry.frequency = entry.frequency.saturating_add(1);
        entry.save(&directory)?;
        self.active_key = Some(key);
        Ok(Some((path, entry.quality.clone())))
    }

    fn insert(&mut self, key: String, staged: &Path, mut entry: Entry) -> io::Result<()> {
        if self.entries.contains_key(&key) || entry.bytes > self.limit {
            return Ok(());
        }
        let budget = self.limit - entry.bytes;
        if self.active_key.as_ref().is_some_and(|active| {
            self.entries
                .get(active)
                .is_some_and(|entry| entry.bytes > budget)
        }) || !self.trim(budget)?
        {
            return Ok(());
        }
        self.last_used += 1;
        entry.last_used = self.last_used;
        entry.save(staged)?;
        fs::rename(staged, self.directory.join(&key))?;
        self.entries.insert(key, entry);
        Ok(())
    }
}

pub struct SongCache {
    cache: Mutex<Option<Cache>>,
    transfer: Semaphore,
}

impl Default for SongCache {
    fn default() -> Self {
        Self {
            cache: Mutex::default(),
            transfer: Semaphore::new(2),
        }
    }
}

async fn with_cache<T: Send + 'static>(
    app: AppHandle,
    operation: impl FnOnce(&mut Cache) -> io::Result<T> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<SongCache>();
        let mut cache = state.cache.lock().map_err(|error| error.to_string())?;
        if cache.is_none() {
            let directory = app
                .path()
                .app_cache_dir()
                .map_err(|error| error.to_string())?
                .join("songs")
                .join("v1");
            *cache = Some(Cache::open(directory).map_err(|error| error.to_string())?);
        }
        operation(cache.as_mut().unwrap()).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn cache_key(key: &str) -> String {
    format!("{:x}", Sha256::digest(key.as_bytes()))
}

#[tauri::command]
pub async fn set_song_cache_limit(app: AppHandle, size_mb: u32) -> Result<(), String> {
    with_cache(app, move |cache| {
        cache.limit = u64::from(size_mb) * MEBIBYTE;
        cache.trim(cache.limit)?;
        Ok(())
    })
    .await
}

#[derive(Serialize)]
pub struct CachedSong {
    url: String,
    quality: String,
}

#[tauri::command]
pub async fn lookup_cached_song(
    app: AppHandle,
    key: Option<String>,
) -> Result<Option<CachedSong>, String> {
    let hit = with_cache(app.clone(), move |cache| {
        cache.lookup(key.as_deref().map(cache_key))
    })
    .await?;
    let Some((path, quality)) = hit else {
        return Ok(None);
    };
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|error| error.to_string())?;
    let url = app
        .get_webview_window("main")
        .ok_or("主窗口不可用")?
        .convert_file_src(path, None)
        .map_err(|error| error.to_string())?;
    Ok(Some(CachedSong { url, quality }))
}

#[tauri::command]
pub async fn discard_cached_song(app: AppHandle, key: String) -> Result<(), String> {
    let key = cache_key(&key);
    with_cache(app, move |cache| {
        cache.remove(&key)?;
        if cache.active_key.as_ref() == Some(&key) {
            cache.active_key = None;
        }
        Ok(())
    })
    .await
}

#[derive(Deserialize)]
pub struct SongCachePayload {
    key: String,
    url: String,
    quality: String,
    proxy: Option<String>,
}

#[tauri::command]
pub async fn store_cached_song(app: AppHandle, payload: SongCachePayload) -> Result<(), String> {
    let url = reqwest::Url::parse(&payload.url).map_err(|error| error.to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Ok(());
    }
    let state = app.state::<SongCache>();
    let Ok(_permit) = state.transfer.try_acquire() else {
        return Ok(());
    };
    let key = cache_key(&payload.key);
    let lookup_key = key.clone();
    let (directory, limit) = with_cache(app.clone(), move |cache| {
        let limit = if cache.entries.contains_key(&lookup_key) {
            0
        } else {
            cache.limit
        };
        Ok((cache.directory.clone(), limit))
    })
    .await?;
    if limit == 0 {
        return Ok(());
    }
    let staged = directory.join(uuid::Uuid::new_v4().to_string());
    tokio::fs::create_dir(&staged)
        .await
        .map_err(|error| error.to_string())?;
    let result = store_song(app.clone(), key, &staged, limit, url, payload).await;
    let _ = tokio::fs::remove_dir_all(&staged).await;
    result
}

async fn store_song(
    app: AppHandle,
    key: String,
    staged: &Path,
    limit: u64,
    url: reqwest::Url,
    payload: SongCachePayload,
) -> Result<(), String> {
    let client = crate::network::build_client(payload.proxy.as_deref(), 60_000)?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if response.status() != reqwest::StatusCode::OK
        || response.content_length().is_some_and(|bytes| bytes > limit)
    {
        return Ok(());
    }
    let path = staged.join("audio.part");
    let mut file = tokio::fs::File::create(&path)
        .await
        .map_err(|error| error.to_string())?;
    let mut bytes = 0;
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        bytes += chunk.len() as u64;
        if bytes > limit {
            return Ok(());
        }
        file.write_all(&chunk)
            .await
            .map_err(|error| error.to_string())?;
    }
    file.flush().await.map_err(|error| error.to_string())?;
    drop(file);
    let staged = staged.to_owned();
    with_cache(app, move |cache| {
        let format = Probe::open(&path)
            .ok()
            .and_then(|probe| probe.guess_file_type().ok())
            .and_then(|probe| probe.file_type());
        let extension = match format {
            Some(FileType::Mpeg) => "mp3",
            Some(FileType::Flac) => "flac",
            Some(FileType::Aac) => "aac",
            Some(FileType::Mp4) => "m4a",
            Some(FileType::Vorbis) => "ogg",
            Some(FileType::Opus) => "opus",
            Some(FileType::Wav) => "wav",
            _ => return Ok(()),
        };
        let entry = Entry {
            extension: extension.into(),
            quality: payload.quality,
            bytes,
            frequency: 1,
            last_used: 0,
        };
        fs::rename(path, entry.audio_path(&staged))?;
        cache.insert(key, &staged, entry)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn insert_song(cache: &mut Cache, name: &str, bytes: usize) {
        let staged = tempfile::tempdir_in(&cache.directory).unwrap();
        let entry = Entry {
            extension: "mp3".into(),
            quality: "320k".into(),
            bytes: bytes as u64,
            frequency: 1,
            last_used: 0,
        };
        fs::write(entry.audio_path(staged.path()), vec![0; bytes]).unwrap();
        cache.insert(cache_key(name), staged.path(), entry).unwrap();
    }

    #[test]
    fn eviction_uses_persisted_frequency_then_least_recent_use() {
        let directory = tempfile::tempdir().unwrap();
        {
            let mut cache = Cache::open(directory.path().to_owned()).unwrap();
            cache.limit = 9;
            insert_song(&mut cache, "frequent", 3);
            assert!(cache.lookup(Some(cache_key("frequent"))).unwrap().is_some());
            insert_song(&mut cache, "old", 3);
            insert_song(&mut cache, "recent", 3);
        }
        let mut cache = Cache::open(directory.path().to_owned()).unwrap();
        cache.limit = 9;
        insert_song(&mut cache, "new", 3);
        assert!(cache.entries.contains_key(&cache_key("frequent")));
        assert!(cache.entries.contains_key(&cache_key("recent")));
        assert!(cache.entries.contains_key(&cache_key("new")));
        assert!(!directory.path().join(cache_key("old")).exists());
        assert_eq!(cache.entries[&cache_key("frequent")].frequency, 2);
    }

    #[test]
    fn resizing_keeps_the_open_song_until_the_next_lookup() {
        let directory = tempfile::tempdir().unwrap();
        let mut cache = Cache::open(directory.path().to_owned()).unwrap();
        cache.limit = 6;
        insert_song(&mut cache, "playing", 3);
        insert_song(&mut cache, "queued", 3);
        insert_song(&mut cache, "oversized", 7);
        assert_eq!(cache.entries.len(), 2);
        let (playing, _) = cache.lookup(Some(cache_key("playing"))).unwrap().unwrap();

        cache.limit = 0;
        assert!(!cache.trim(cache.limit).unwrap());
        assert_eq!(cache.entries.len(), 1);
        assert!(playing.exists());
        assert!(cache.lookup(None).unwrap().is_none());
        assert!(!playing.exists());
        assert!(cache.entries.is_empty());
    }

    #[test]
    fn ignores_incomplete_writes_and_removes_truncated_audio() {
        let directory = tempfile::tempdir().unwrap();
        let incomplete = directory.path().join("staging");
        let key = cache_key("truncated");
        {
            let mut cache = Cache::open(directory.path().to_owned()).unwrap();
            insert_song(&mut cache, "truncated", 3);
            fs::write(directory.path().join(&key).join("audio.mp3"), b"x").unwrap();
            fs::create_dir(&incomplete).unwrap();
        }
        let mut cache = Cache::open(directory.path().to_owned()).unwrap();
        assert!(cache.lookup(Some(key)).unwrap().is_none());
        assert!(!incomplete.exists());
        assert!(cache.entries.is_empty());
    }
}
