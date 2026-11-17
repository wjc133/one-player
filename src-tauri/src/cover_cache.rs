use std::{
    collections::HashMap,
    io::Cursor,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
    time::Duration,
};

use image::{ImageReader, Limits};
use sha2::{Digest, Sha256};
use tauri::Manager;
use tokio::{
    io::AsyncWriteExt,
    sync::{OnceCell, Semaphore},
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_ATTEMPTS: usize = 3;
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
type CoverResult = Result<PathBuf, String>;
type CoverRequest = OnceCell<CoverResult>;

pub(crate) struct CoverCache {
    requests: Mutex<HashMap<String, Weak<CoverRequest>>>,
    slots: Semaphore,
    timeout: Duration,
}

impl Default for CoverCache {
    fn default() -> Self {
        Self {
            requests: Mutex::new(HashMap::new()),
            slots: Semaphore::new(8),
            timeout: REQUEST_TIMEOUT,
        }
    }
}

impl CoverCache {
    async fn load(&self, directory: &Path, url: &str, proxy: Option<&str>) -> CoverResult {
        let parsed = reqwest::Url::parse(url).map_err(|_| "封面地址无效".to_string())?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err("封面仅支持 HTTP 与 HTTPS 地址".into());
        }
        let key = format!("{:x}", Sha256::digest(url.as_bytes()));
        let request = {
            let mut requests = self.requests.lock().map_err(|error| error.to_string())?;
            requests.retain(|_, request| request.strong_count() > 0);
            match requests.get(&key).and_then(Weak::upgrade) {
                Some(request) => request,
                None => {
                    let request = Arc::new(OnceCell::new());
                    requests.insert(key.clone(), Arc::downgrade(&request));
                    request
                }
            }
        };
        request
            .get_or_init(|| self.load_uncached(directory, &key, url, proxy))
            .await
            .clone()
    }

    async fn load_uncached(
        &self,
        directory: &Path,
        key: &str,
        url: &str,
        proxy: Option<&str>,
    ) -> CoverResult {
        let target = directory.join(format!("{key}.img"));
        let existing = target.clone();
        if tokio::task::spawn_blocking(move || {
            std::fs::metadata(&existing)
                .ok()
                .filter(|metadata| metadata.len() <= MAX_IMAGE_BYTES as u64)
                .and_then(|_| std::fs::read(&existing).ok())
                .is_some_and(|bytes| validate_image(&bytes).is_ok())
        })
        .await
        .map_err(|error| error.to_string())?
        {
            return Ok(target);
        }
        let _ = tokio::fs::remove_file(&target).await;
        let _slot = self
            .slots
            .acquire()
            .await
            .map_err(|error| error.to_string())?;
        let client = crate::network::build_client(proxy, self.timeout.as_millis() as u64)?;
        let mut last_error = String::new();
        for _ in 0..MAX_ATTEMPTS {
            let result = async {
                let mut response = client
                    .get(url)
                    .timeout(self.timeout)
                    .send()
                    .await
                    .map_err(|error| error.to_string())?
                    .error_for_status()
                    .map_err(|error| error.to_string())?;
                if response
                    .content_length()
                    .is_some_and(|size| size > MAX_IMAGE_BYTES as u64)
                {
                    return Err("封面图片过大".to_string());
                }
                let mut bytes = Vec::new();
                while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
                    if bytes.len() + chunk.len() > MAX_IMAGE_BYTES {
                        return Err("封面图片过大".to_string());
                    }
                    bytes.extend_from_slice(&chunk);
                }
                tokio::task::spawn_blocking(move || {
                    validate_image(&bytes)?;
                    Ok::<_, String>(bytes)
                })
                .await
                .map_err(|error| error.to_string())?
            }
            .await;
            match result {
                Ok(bytes) => {
                    tokio::fs::create_dir_all(directory)
                        .await
                        .map_err(|error| format!("创建封面缓存目录失败：{error}"))?;
                    let temporary = directory.join(format!("{key}.{}.tmp", uuid::Uuid::new_v4()));
                    let saved = async {
                        let mut file = tokio::fs::File::create(&temporary).await?;
                        file.write_all(&bytes).await?;
                        file.flush().await?;
                        file.sync_all().await?;
                        drop(file);
                        tokio::fs::rename(&temporary, &target).await
                    }
                    .await;
                    if let Err(error) = saved {
                        let _ = tokio::fs::remove_file(&temporary).await;
                        return Err(format!("保存封面缓存失败：{error}"));
                    }
                    return Ok(target);
                }
                Err(error) => last_error = error,
            }
        }
        Err(format!(
            "封面获取失败，已尝试 {MAX_ATTEMPTS} 次：{last_error}"
        ))
    }
}

fn validate_image(bytes: &[u8]) -> Result<(), String> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| error.to_string())?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    reader
        .decode()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

async fn cached_path(app: &tauri::AppHandle, url: &str, proxy: Option<&str>) -> CoverResult {
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("covers")
        .join("v1");
    app.state::<CoverCache>().load(&directory, url, proxy).await
}

pub(crate) async fn fetch_cover(
    app: &tauri::AppHandle,
    url: Option<&str>,
    proxy: Option<&str>,
) -> Result<Option<Vec<u8>>, String> {
    let Some(url) = url.filter(|url| url.starts_with("http://") || url.starts_with("https://"))
    else {
        return Ok(None);
    };
    let path = cached_path(app, url, proxy).await?;
    tokio::fs::read(path)
        .await
        .map(Some)
        .map_err(|error| format!("读取封面缓存失败：{error}"))
}

#[tauri::command]
pub async fn get_cached_cover(
    app: tauri::AppHandle,
    url: String,
    proxy: Option<String>,
) -> Result<String, String> {
    let path = cached_path(&app, &url, proxy.as_deref()).await?;
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|error| error.to_string())?;
    app.get_webview_window("main")
        .ok_or("主窗口不可用")?
        .convert_file_src(path, None)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        future::Future,
        io::{Read, Write},
        net::TcpListener,
        sync::atomic::{AtomicBool, AtomicUsize, Ordering},
        thread,
        time::Instant,
    };

    const PNG: &[u8] = include_bytes!("../icons/32x32.png");

    #[derive(Clone)]
    struct Reply {
        status: u16,
        body: Vec<u8>,
        delay: Duration,
        extra_length: usize,
    }

    impl Reply {
        fn image() -> Self {
            Self {
                status: 200,
                body: PNG.to_vec(),
                delay: Duration::ZERO,
                extra_length: 0,
            }
        }

        fn failure() -> Self {
            Self {
                status: 503,
                body: Vec::new(),
                ..Self::image()
            }
        }
    }

    struct Server {
        url: String,
        count: Arc<AtomicUsize>,
        stopped: Arc<AtomicBool>,
        worker: Option<thread::JoinHandle<()>>,
    }

    impl Server {
        fn new(replies: Vec<Reply>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let url = format!("http://{}/cover", listener.local_addr().unwrap());
            let count = Arc::new(AtomicUsize::new(0));
            let stopped = Arc::new(AtomicBool::new(false));
            let worker = thread::spawn({
                let count = count.clone();
                let stopped = stopped.clone();
                move || {
                    let mut handlers = Vec::new();
                    while !stopped.load(Ordering::SeqCst) {
                        if let Ok((mut socket, _)) = listener.accept() {
                            let index = count.fetch_add(1, Ordering::SeqCst);
                            let reply = replies[index.min(replies.len() - 1)].clone();
                            handlers.push(thread::spawn(move || {
                                socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                                let mut request = [0; 4096];
                                let _ = socket.read(&mut request);
                                let _ = write!(
                                    socket,
                                    "HTTP/1.1 {} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                    reply.status,
                                    reply.body.len() + reply.extra_length,
                                );
                                thread::sleep(reply.delay);
                                let _ = socket.write_all(&reply.body);
                            }));
                        } else {
                            thread::sleep(Duration::from_millis(1));
                        }
                    }
                    for handler in handlers {
                        handler.join().unwrap();
                    }
                }
            });
            Self {
                url,
                count,
                stopped,
                worker: Some(worker),
            }
        }

        fn requests(&self) -> usize {
            self.count.load(Ordering::SeqCst)
        }
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.stopped.store(true, Ordering::SeqCst);
            self.worker.take().unwrap().join().unwrap();
        }
    }

    fn run(test: impl Future<Output = ()>) {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap()
            .block_on(test);
    }

    #[test]
    fn retries_twice_then_persists_original_bytes_and_reuses_cache_offline() {
        run(async {
            let directory = tempfile::tempdir().unwrap();
            let server = Server::new(vec![Reply::failure(), Reply::failure(), Reply::image()]);
            let cache = CoverCache::default();
            let path = cache
                .load(directory.path(), &server.url, None)
                .await
                .unwrap();
            assert_eq!(server.requests(), 3);
            assert_eq!(std::fs::read(&path).unwrap(), PNG);
            let url = server.url.clone();
            drop(server);
            let reopened = CoverCache::default();
            assert_eq!(
                reopened
                    .load(directory.path(), &url, Some("invalid proxy"))
                    .await
                    .unwrap(),
                path
            );
            assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
        });
    }

    #[test]
    fn three_failures_leave_no_cache_and_next_open_can_retry() {
        run(async {
            let directory = tempfile::tempdir().unwrap();
            let server = Server::new(vec![
                Reply::failure(),
                Reply::failure(),
                Reply::failure(),
                Reply::image(),
            ]);
            let cache = CoverCache::default();
            assert!(cache
                .load(directory.path(), &server.url, None)
                .await
                .is_err());
            assert_eq!(server.requests(), 3);
            assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
            assert!(cache
                .load(directory.path(), &server.url, None)
                .await
                .is_ok());
            assert_eq!(server.requests(), 4);
        });
    }

    #[test]
    fn concurrent_consumers_share_success_and_failed_retry_cycles() {
        run(async {
            for failed in [false, true] {
                let directory = tempfile::tempdir().unwrap();
                let reply = Reply {
                    status: if failed { 503 } else { 200 },
                    delay: Duration::from_millis(30),
                    ..Reply::image()
                };
                let server = Server::new(vec![reply]);
                let cache = Arc::new(CoverCache::default());
                let mut tasks = Vec::new();
                for _ in 0..12 {
                    let cache = cache.clone();
                    let directory = directory.path().to_path_buf();
                    let url = server.url.clone();
                    tasks.push(tokio::spawn(async move {
                        cache.load(&directory, &url, None).await
                    }));
                }
                for task in tasks {
                    assert_eq!(task.await.unwrap().is_err(), failed);
                }
                assert_eq!(server.requests(), if failed { 3 } else { 1 });
            }
        });
    }

    #[test]
    fn invalid_images_and_incomplete_responses_never_enter_cache() {
        run(async {
            for reply in [
                Reply {
                    body: b"<html>error</html>".to_vec(),
                    ..Reply::image()
                },
                Reply {
                    extra_length: 10,
                    ..Reply::image()
                },
            ] {
                let directory = tempfile::tempdir().unwrap();
                let server = Server::new(vec![reply]);
                assert!(CoverCache::default()
                    .load(directory.path(), &server.url, None)
                    .await
                    .is_err());
                assert_eq!(server.requests(), 3);
                assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
            }
        });
    }

    #[test]
    fn damaged_disk_cache_is_replaced_with_a_valid_image() {
        run(async {
            let directory = tempfile::tempdir().unwrap();
            let server = Server::new(vec![Reply::image()]);
            let key = format!("{:x}", Sha256::digest(server.url.as_bytes()));
            std::fs::write(directory.path().join(format!("{key}.img")), b"damaged").unwrap();
            let path = CoverCache::default()
                .load(directory.path(), &server.url, None)
                .await
                .unwrap();
            assert_eq!(server.requests(), 1);
            assert_eq!(std::fs::read(path).unwrap(), PNG);
        });
    }

    #[test]
    fn timeout_covers_response_body_and_stops_after_three_attempts() {
        assert_eq!(REQUEST_TIMEOUT, Duration::from_secs(30));
        assert_eq!(MAX_ATTEMPTS, 3);
        run(async {
            let directory = tempfile::tempdir().unwrap();
            let server = Server::new(vec![Reply {
                delay: Duration::from_millis(500),
                ..Reply::image()
            }]);
            let cache = CoverCache {
                timeout: Duration::from_millis(80),
                ..CoverCache::default()
            };
            let started = Instant::now();
            assert!(cache
                .load(directory.path(), &server.url, None)
                .await
                .is_err());
            assert_eq!(server.requests(), 3);
            assert!(started.elapsed() < Duration::from_millis(900));
            assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
        });
    }
}
