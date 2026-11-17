use std::{
    collections::{HashMap, HashSet},
    env,
    io::Cursor,
    path::{Path, PathBuf},
    time::Duration,
};

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::Emitter;

use crate::network::build_client;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPlatform {
    source: String,
    name: String,
    installed: bool,
    can_import: bool,
    message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPlaylistSummary {
    id: String,
    name: String,
    cover_url: Option<String>,
    track_count: usize,
    kind: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPlaylistCatalog {
    account_name: String,
    playlists: Vec<ImportPlaylistSummary>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedPlaylist {
    external_id: String,
    name: String,
    cover_url: Option<String>,
    tracks: Vec<Value>,
}

#[derive(Serialize)]
pub struct ImportFailure {
    id: String,
    name: String,
    message: String,
}

#[derive(Serialize)]
pub struct PlaylistImportResult {
    playlists: Vec<ImportedPlaylist>,
    failures: Vec<ImportFailure>,
}

struct CachedPlaylist {
    summary: ImportPlaylistSummary,
    track_ids: Vec<String>,
    has_complete_ids: bool,
}

struct Catalog {
    account_name: String,
    playlists: Vec<CachedPlaylist>,
    tracks: HashMap<String, Value>,
}

fn text(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        _ => String::new(),
    }
}

fn home_dir() -> Result<PathBuf, String> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "无法定位用户目录".into())
}

fn netease_storage() -> Result<PathBuf, String> {
    let home = home_dir()?;
    let candidates = [
        home.join("Library/Containers/com.netease.163music/Data/Documents/storage"),
        home.join("Library/Application Support/NeteaseMusic/storage"),
    ];
    candidates
        .into_iter()
        .find(|path| path.join("sqlite_storage.sqlite3").is_file())
        .ok_or_else(|| "未找到网易云歌单数据，请先打开网易云并登录、加载个人歌单后重试".into())
}

fn platform_installed(app_names: &[&str]) -> bool {
    let mut roots = vec![PathBuf::from("/Applications")];
    if let Ok(home) = home_dir() {
        roots.push(home.join("Applications"));
    }
    roots
        .iter()
        .any(|root| app_names.iter().any(|name| root.join(name).is_dir()))
}

#[tauri::command]
pub async fn detect_playlist_import_platforms() -> Result<Vec<ImportPlatform>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        [
            (
                "wy",
                "网易云音乐",
                vec!["NeteaseMusic.app", "网易云音乐.app"],
            ),
            ("tx", "QQ 音乐", vec!["QQMusic.app", "QQ音乐.app"]),
            ("kg", "酷狗音乐", vec!["KugouMusic.app", "酷狗音乐.app"]),
            ("kw", "酷我音乐", vec!["KuwoMusic.app", "酷我音乐.app"]),
            ("mg", "咪咕音乐", vec!["MiguMusic.app", "咪咕音乐.app"]),
        ]
        .into_iter()
        .map(|(source, name, apps)| {
            let installed = platform_installed(&apps);
            let supported = source == "wy" && cfg!(target_os = "macos");
            ImportPlatform {
                source: source.into(),
                name: name.into(),
                installed,
                can_import: installed && supported,
                message: if !installed {
                    "未安装".into()
                } else if !supported {
                    "暂不支持读取此平台的本地歌单".into()
                } else {
                    "从本机导入创建和收藏的歌单".into()
                },
            }
        })
        .collect()
    })
    .await
    .map_err(|error| error.to_string())
}

fn open_database(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| "无法只读打开网易云数据，请检查文件访问权限或稍后重试".to_string())?;
    connection
        .busy_timeout(Duration::from_secs(2))
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

fn json_rows(
    connection: &Connection,
    table: &str,
    query: &str,
) -> Result<Vec<(String, Value)>, String> {
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
            [table],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !exists {
        return Ok(Vec::new());
    }
    let mut statement = connection
        .prepare(query)
        .map_err(|_| "网易云数据格式暂不支持，请更新客户端后重试".to_string())?;
    let rows = statement
        .query_map([], |row| {
            let id = match row.get_ref(0)? {
                rusqlite::types::ValueRef::Integer(value) => value.to_string(),
                rusqlite::types::ValueRef::Text(value) => {
                    String::from_utf8_lossy(value).into_owned()
                }
                _ => String::new(),
            };
            Ok((id, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?;
    let mut result = Vec::new();
    for row in rows {
        let (id, raw) = row.map_err(|error| error.to_string())?;
        if let Ok(value) = serde_json::from_str(&raw) {
            result.push((id, value));
        }
    }
    Ok(result)
}

fn account_from_storage(directory: &Path) -> Option<(String, String)> {
    for file in ["localstorage_3.db", "localstorage.db"] {
        let Some(account) = (|| {
            let connection = open_database(&directory.join(file)).ok()?;
            let raw: Vec<u8> = connection
                .query_row(
                    "SELECT nm_value FROM nm_table WHERE nm_key='NM_USER_SWITCH'",
                    [],
                    |row| row.get(0),
                )
                .optional()
                .ok()??;
            let archive = plist::Value::from_reader(Cursor::new(raw)).ok()?;
            let dictionary = archive.as_dictionary()?;
            let objects = dictionary.get("$objects")?.as_array()?;
            let index = dictionary
                .get("$top")?
                .as_dictionary()?
                .get("root")?
                .as_uid()?
                .get() as usize;
            let value: Value = serde_json::from_str(objects.get(index)?.as_string()?).ok()?;
            let id = text(&value["userId"]);
            if id.is_empty() || id == "0" {
                return None;
            }
            Some((id, text(&value["host"]["profile"]["nickname"])))
        })() else {
            continue;
        };
        return Some(account);
    }
    None
}

fn ids(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| text(if item.is_object() { &item["id"] } else { item }))
        .filter(|id| !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit()))
        .collect()
}

fn read_catalog(
    connection: &Connection,
    account: Option<(String, String)>,
) -> Result<Catalog, String> {
    let mut statement = connection
        .prepare("SELECT CAST(uid AS TEXT), pids FROM web_user_playlist")
        .map_err(|_| "此版本的网易云数据暂不支持个人歌单导入".to_string())?;
    let accounts = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let (account_id, account_name) = match account {
        Some(account) => account,
        None if accounts.len() == 1 => (accounts[0].0.clone(), String::new()),
        _ => {
            return Err("无法确认网易云当前账号，请先在网易云中登录并打开「我的音乐」后重试".into())
        }
    };
    let membership = accounts
        .iter()
        .find(|(id, _)| id == &account_id)
        .map(|(_, raw)| raw)
        .ok_or_else(|| {
            "未找到当前账号的个人歌单，请先在网易云中打开「我的音乐」后重试".to_string()
        })?;
    let personal_ids: Vec<String> = membership
        .split(|character: char| !character.is_ascii_digit())
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .collect();
    let mut metadata: HashMap<String, Value> = json_rows(
        connection,
        "web_playlist",
        "SELECT pid, playlist FROM web_playlist",
    )?
    .into_iter()
    .collect();
    let mut tracks: HashMap<String, Value> =
        json_rows(connection, "web_track", "SELECT tid, track FROM web_track")?
            .into_iter()
            .collect();
    tracks.extend(json_rows(
        connection,
        "dbTrack",
        "SELECT id, jsonStr FROM dbTrack",
    )?);
    let mut snapshots: HashMap<String, Value> = json_rows(
        connection,
        "playlistTrackIds",
        "SELECT id, jsonStr FROM playlistTrackIds",
    )?
    .into_iter()
    .collect();
    for (_, page) in json_rows(
        connection,
        "persistentModel",
        "SELECT uniKey, jsonStr FROM persistentModel WHERE uniKey='page:playlist'",
    )? {
        if let Some(entities) = page["data"]["entities"].as_object() {
            for (id, entity) in entities {
                metadata.insert(id.clone(), entity.clone());
                if entity["trackIds"].is_array() && !snapshots.contains_key(id) {
                    snapshots.insert(id.clone(), entity.clone());
                }
            }
        }
        if let Some(entities) = page["data"]["trackEntities"].as_object() {
            tracks.extend(
                entities
                    .iter()
                    .map(|(id, track)| (id.clone(), track.clone())),
            );
        }
    }
    let mut seen = HashSet::new();
    let mut playlists = Vec::new();
    for id in personal_ids {
        if !seen.insert(id.clone()) {
            continue;
        }
        let Some(info) = metadata.get(&id) else {
            continue;
        };
        let owner = text(
            info.get("userId")
                .or_else(|| {
                    info.get("creator")
                        .and_then(|creator| creator.get("userId"))
                })
                .unwrap_or(&Value::Null),
        );
        let created = owner == account_id;
        if !created && info["subscribed"] != true {
            continue;
        }
        let name = text(&info["name"]);
        if name.trim().is_empty() {
            continue;
        }
        let snapshot = snapshots
            .get(&id)
            .filter(|value| value["trackIds"].is_array());
        let track_ids = snapshot
            .map(|value| ids(&value["trackIds"]))
            .unwrap_or_default();
        let declared = info["trackCount"].as_u64().unwrap_or(0) as usize;
        let track_count = if snapshot.is_some() {
            track_ids.len()
        } else {
            declared
        };
        playlists.push(CachedPlaylist {
            summary: ImportPlaylistSummary {
                id,
                name,
                cover_url: info["coverImgUrl"].as_str().map(str::to_string),
                track_count,
                kind: if created { "created" } else { "subscribed" }.into(),
            },
            track_ids,
            has_complete_ids: snapshot.is_some(),
        });
    }
    Ok(Catalog {
        account_name,
        playlists,
        tracks,
    })
}

fn load_catalog(source: &str) -> Result<Catalog, String> {
    if source != "wy" || !cfg!(target_os = "macos") {
        return Err("暂不支持此平台的本地歌单导入".into());
    }
    if !platform_installed(&["NeteaseMusic.app", "网易云音乐.app"]) {
        return Err("请先安装网易云音乐".into());
    }
    let directory = netease_storage()?;
    let connection = open_database(&directory.join("sqlite_storage.sqlite3"))?;
    connection
        .execute_batch("BEGIN")
        .map_err(|error| error.to_string())?;
    read_catalog(&connection, account_from_storage(&directory))
}

#[tauri::command]
pub async fn list_import_playlists(source: String) -> Result<ImportPlaylistCatalog, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let catalog = load_catalog(&source)?;
        Ok(ImportPlaylistCatalog {
            account_name: catalog.account_name,
            playlists: catalog
                .playlists
                .into_iter()
                .map(|item| item.summary)
                .collect(),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

fn normalize_track(song: &Value) -> Option<Value> {
    let id = text(&song["id"]);
    let name = text(&song["name"]);
    let artists = song.get("artists").or_else(|| song.get("ar"))?.as_array()?;
    let singer = artists
        .iter()
        .filter_map(|artist| artist["name"].as_str())
        .collect::<Vec<_>>()
        .join("、");
    if id.is_empty() || name.is_empty() || singer.is_empty() {
        return None;
    }
    let album = song.get("album").or_else(|| song.get("al"));
    let seconds = song
        .get("duration")
        .or_else(|| song.get("dt"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
        / 1000;
    Some(json!({
        "id": format!("wy_{id}"),
        "source": "wy",
        "songmid": id,
        "name": name,
        "singer": singer,
        "albumName": album.map(|album| text(&album["name"])).unwrap_or_default(),
        "albumId": album.map(|album| text(&album["id"])).unwrap_or_default(),
        "img": album.and_then(|album| album["picUrl"].as_str()).map(|url| url.replacen("http:", "https:", 1)),
        "interval": format!("{:02}:{:02}", seconds / 60, seconds % 60),
        "types": [{"type":"128k","size":null},{"type":"320k","size":null},{"type":"flac","size":null}],
        "_types": {"128k":{"size":null},"320k":{"size":null},"flac":{"size":null}},
        "typeUrl": {}
    }))
}

async fn api_json(
    client: &reqwest::Client,
    path: &str,
    form: &[(&str, String)],
) -> Result<Value, String> {
    let response = client
        .post(format!("https://music.163.com{path}"))
        .header("Referer", "https://music.163.com/")
        .header("User-Agent", "Mozilla/5.0")
        .form(form)
        .send()
        .await
        .map_err(|_| "连接网易云失败，请检查网络或代理设置".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "网易云请求失败（HTTP {}）",
            response.status().as_u16()
        ));
    }
    let data: Value = response
        .json()
        .await
        .map_err(|_| "网易云返回了无法识别的数据".to_string())?;
    if data["code"] != 200 {
        return Err(
            "无法读取完整歌单，请先在网易云中打开该歌单后重试；私密歌单需要完整本地缓存".into(),
        );
    }
    Ok(data)
}

async fn resolve_playlist(
    playlist: CachedPlaylist,
    tracks: &mut HashMap<String, Value>,
    client: &reqwest::Client,
) -> Result<ImportedPlaylist, String> {
    let mut track_ids = playlist.track_ids;
    if !playlist.has_complete_ids {
        let data = api_json(
            client,
            "/api/v6/playlist/detail",
            &[
                ("id", playlist.summary.id.clone()),
                ("n", "100000".into()),
                ("s", "0".into()),
            ],
        )
        .await?;
        let detail = &data["playlist"];
        if !detail["trackIds"].is_array() {
            return Err("网易云未返回完整曲目列表，请先在网易云中打开该歌单后重试".into());
        }
        track_ids = ids(&detail["trackIds"]);
        if detail["trackCount"]
            .as_u64()
            .is_some_and(|count| count as usize != track_ids.len())
        {
            return Err("歌单曲目列表不完整，请先在网易云中加载该歌单后重试".into());
        }
        for song in detail["tracks"].as_array().into_iter().flatten() {
            tracks.insert(text(&song["id"]), song.clone());
        }
    }
    let missing: Vec<_> = track_ids
        .iter()
        .filter(|id| tracks.get(*id).and_then(normalize_track).is_none())
        .cloned()
        .collect();
    for batch in missing.chunks(200) {
        let payload: Vec<_> = batch.iter().map(|id| json!({"id":id})).collect();
        let data = api_json(
            client,
            "/api/v3/song/detail",
            &[("c", json!(payload).to_string())],
        )
        .await?;
        for song in data["songs"].as_array().into_iter().flatten() {
            tracks.insert(text(&song["id"]), song.clone());
        }
    }
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for id in track_ids {
        if !seen.insert(id.clone()) {
            continue;
        }
        let track = tracks.get(&id).and_then(normalize_track).ok_or_else(|| {
            "部分歌曲详情缺失，该歌单未导入，请在网易云中加载完整后重试".to_string()
        })?;
        normalized.push(track);
    }
    Ok(ImportedPlaylist {
        external_id: playlist.summary.id,
        name: playlist.summary.name,
        cover_url: playlist.summary.cover_url,
        tracks: normalized,
    })
}

#[tauri::command]
pub async fn import_platform_playlists(
    app: tauri::AppHandle,
    source: String,
    playlist_ids: Vec<String>,
    proxy: Option<String>,
) -> Result<PlaylistImportResult, String> {
    if playlist_ids.is_empty() || playlist_ids.len() > 2000 {
        return Err("请选择 1 至 2000 个歌单".into());
    }
    let mut catalog = tauri::async_runtime::spawn_blocking(move || load_catalog(&source))
        .await
        .map_err(|error| error.to_string())??;
    let selected: HashSet<_> = playlist_ids.into_iter().collect();
    let known: HashSet<_> = catalog
        .playlists
        .iter()
        .map(|item| item.summary.id.clone())
        .collect();
    if !selected.is_subset(&known) {
        return Err("所选歌单不属于当前账号的创建或收藏列表，请刷新后重试".into());
    }
    let client = build_client(proxy.as_deref(), 15_000)?;
    let mut result = PlaylistImportResult {
        playlists: Vec::new(),
        failures: Vec::new(),
    };
    let total = selected.len();
    for playlist in catalog
        .playlists
        .into_iter()
        .filter(|item| selected.contains(&item.summary.id))
    {
        let id = playlist.summary.id.clone();
        let name = playlist.summary.name.clone();
        match resolve_playlist(playlist, &mut catalog.tracks, &client).await {
            Ok(playlist) => result.playlists.push(playlist),
            Err(message) => result.failures.push(ImportFailure { id, name, message }),
        }
        let _ = app.emit(
            "playlist-import-progress",
            json!({
                "completed": result.playlists.len() + result.failures.len(),
                "total": total,
            }),
        );
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Connection {
        let database = Connection::open_in_memory().unwrap();
        database.execute_batch(
            "CREATE TABLE web_user_playlist (uid INTEGER, pids TEXT);
             CREATE TABLE web_playlist (pid INTEGER, playlist TEXT);
             CREATE TABLE playlistTrackIds (id TEXT, jsonStr TEXT);
             CREATE TABLE dbTrack (id TEXT, jsonStr TEXT);
             INSERT INTO web_user_playlist VALUES (7, ',10,20,30,');
             INSERT INTO web_playlist VALUES (10, '{\"name\":\"我的歌单\",\"userId\":7,\"trackCount\":1}');
             INSERT INTO web_playlist VALUES (20, '{\"name\":\"收藏歌单\",\"userId\":8,\"subscribed\":true,\"trackCount\":2}');
             INSERT INTO web_playlist VALUES (30, '{\"name\":\"仅浏览\",\"userId\":8,\"subscribed\":false}');
             INSERT INTO web_playlist VALUES (40, '{\"name\":\"历史记录\",\"userId\":7}');
             INSERT INTO playlistTrackIds VALUES ('10', '{\"trackIds\":[{\"id\":2},{\"id\":1}]}');",
        ).unwrap();
        database
    }

    #[test]
    fn lists_only_account_created_and_subscribed_playlists() {
        let catalog = read_catalog(&fixture(), Some(("7".into(), "测试账号".into()))).unwrap();
        assert_eq!(catalog.account_name, "测试账号");
        assert_eq!(
            catalog
                .playlists
                .iter()
                .map(|item| item.summary.id.as_str())
                .collect::<Vec<_>>(),
            ["10", "20"]
        );
        assert_eq!(catalog.playlists[0].summary.kind, "created");
        assert_eq!(catalog.playlists[1].summary.kind, "subscribed");
    }

    #[test]
    fn newer_ordered_snapshots_override_stale_counts() {
        let catalog = read_catalog(&fixture(), Some(("7".into(), String::new()))).unwrap();
        assert_eq!(catalog.playlists[0].summary.track_count, 2);
        assert_eq!(catalog.playlists[0].track_ids, ["2", "1"]);
        assert!(catalog.playlists[0].has_complete_ids);
        assert!(!catalog.playlists[1].has_complete_ids);
    }

    #[test]
    fn unknown_or_ambiguous_accounts_fail_closed() {
        let database = fixture();
        assert!(read_catalog(&database, Some(("99".into(), String::new()))).is_err());
        database
            .execute("INSERT INTO web_user_playlist VALUES (8, ',30,')", [])
            .unwrap();
        assert!(read_catalog(&database, None).is_err());
    }

    #[test]
    fn normalizes_both_client_and_api_songs() {
        for song in [
            json!({"id":123,"name":"歌曲","artists":[{"name":"歌手"}],"album":{"id":4,"name":"专辑","picUrl":"http://example.com/a.jpg"},"duration":185000}),
            json!({"id":123,"name":"歌曲","ar":[{"name":"歌手"}],"al":{"id":4,"name":"专辑","picUrl":"http://example.com/a.jpg"},"dt":185000}),
        ] {
            let track = normalize_track(&song).unwrap();
            assert_eq!(track["id"], "wy_123");
            assert_eq!(track["interval"], "03:05");
            assert_eq!(track["img"], "https://example.com/a.jpg");
        }
        assert!(normalize_track(&json!({"id":123,"name":"缺少歌手"})).is_none());
    }

    #[test]
    #[ignore = "requires a local NetEase installation"]
    fn inspects_installed_personal_catalog_read_only() {
        let catalog = load_catalog("wy").unwrap();
        assert!(!catalog.playlists.is_empty());
        assert!(catalog
            .playlists
            .iter()
            .all(|item| ["created", "subscribed"].contains(&item.summary.kind.as_str())));
        println!(
            "personal playlists: {}, locally complete: {}",
            catalog.playlists.len(),
            catalog
                .playlists
                .iter()
                .filter(|item| item.has_complete_ids
                    && item.track_ids.iter().all(|id| catalog
                        .tracks
                        .get(id)
                        .and_then(normalize_track)
                        .is_some()))
                .count()
        );
    }

    #[test]
    #[ignore = "requires a local NetEase installation"]
    fn resolves_a_large_local_playlist_without_network() {
        let mut catalog = load_catalog("wy").unwrap();
        let playlist = catalog
            .playlists
            .into_iter()
            .filter(|item| {
                item.has_complete_ids
                    && item
                        .track_ids
                        .iter()
                        .all(|id| catalog.tracks.get(id).and_then(normalize_track).is_some())
            })
            .max_by_key(|item| item.track_ids.len())
            .unwrap();
        let expected: Vec<_> = playlist
            .track_ids
            .iter()
            .map(|id| format!("wy_{id}"))
            .collect();
        let client = build_client(Some("http://127.0.0.1:9"), 1000).unwrap();
        let imported = tauri::async_runtime::block_on(resolve_playlist(
            playlist,
            &mut catalog.tracks,
            &client,
        ))
        .unwrap();
        assert_eq!(
            imported
                .tracks
                .iter()
                .map(|track| text(&track["id"]))
                .collect::<Vec<_>>(),
            expected
        );
        println!(
            "resolved local tracks without network: {}",
            imported.tracks.len()
        );
    }

    #[test]
    #[ignore = "requires access to the public NetEase API"]
    fn resolves_a_public_playlist_with_incomplete_initial_details() {
        let playlist = CachedPlaylist {
            summary: ImportPlaylistSummary {
                id: "24381616".into(),
                name: "公开接口验证".into(),
                cover_url: None,
                track_count: 0,
                kind: "subscribed".into(),
            },
            track_ids: Vec::new(),
            has_complete_ids: false,
        };
        let client = build_client(None, 15000).unwrap();
        let imported = tauri::async_runtime::block_on(resolve_playlist(
            playlist,
            &mut HashMap::new(),
            &client,
        ))
        .unwrap();
        assert!(imported.tracks.len() > 1000);
        assert!(imported.tracks.iter().all(|track| track["source"] == "wy"));
        println!("resolved public tracks: {}", imported.tracks.len());
    }
}
