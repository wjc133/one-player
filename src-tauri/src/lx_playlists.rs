use std::{collections::HashSet, path::PathBuf, time::Duration};

use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use tauri::Emitter;

use crate::playlist_import::{
    ImportFailure, ImportPlaylistCatalog, ImportPlaylistSummary, ImportedPlaylist,
    PlaylistImportResult,
};

pub(crate) fn database_path() -> Result<PathBuf, String> {
    let root = crate::lx_import::lx_user_data_path()?;
    ["LxDatas/lx.data.db", "lx.data.db"]
        .into_iter()
        .map(|relative| root.join(relative))
        .find(|path| path.is_file())
        .ok_or_else(|| "未找到 LX Music 歌单数据库，请先启动 LX Music 并打开我的列表".into())
}

fn open_database() -> Result<Connection, String> {
    let connection = Connection::open_with_flags(
        database_path()?,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("无法读取 LX Music 歌单：{error}"))?;
    connection
        .busy_timeout(Duration::from_secs(2))
        .and_then(|()| connection.execute_batch("BEGIN"))
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

fn read_catalog(connection: &Connection) -> Result<ImportPlaylistCatalog, String> {
    let mut lists = vec![
        ("default".to_string(), "默认列表".to_string(), "created"),
        ("love".to_string(), "我的收藏".to_string(), "subscribed"),
    ];
    let mut statement = connection
        .prepare("SELECT id, name, source FROM my_list ORDER BY position, id")
        .map_err(|error| format!("LX Music 歌单格式暂不支持：{error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut seen = HashSet::from(["default".to_string(), "love".to_string()]);
    for row in rows {
        let (id, name, source) = row.map_err(|error| error.to_string())?;
        if seen.insert(id.clone()) {
            let kind = if source.as_deref().is_some_and(|source| !source.is_empty()) {
                "subscribed"
            } else {
                "created"
            };
            lists.push((id, name, kind));
        }
    }
    let mut playlists = Vec::new();
    for (id, name, kind) in lists {
        let track_count = connection
            .query_row(
                "SELECT COUNT(*) FROM my_list_music_info WHERE listId=?1",
                [&id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        playlists.push(ImportPlaylistSummary {
            id,
            name,
            cover_url: None,
            track_count,
            kind: kind.into(),
        });
    }
    Ok(ImportPlaylistCatalog {
        account_name: "LX Music".into(),
        playlists,
    })
}

pub(crate) fn list_playlists() -> Result<ImportPlaylistCatalog, String> {
    read_catalog(&open_database()?)
}

fn normalize_track(mut track: Value) -> Result<Value, String> {
    let meta = track.get("meta").cloned().unwrap_or(Value::Null);
    let source = track["source"].as_str().unwrap_or_default().to_string();
    if !["kw", "kg", "tx", "wy", "mg", "local"].contains(&source.as_str()) {
        return Err(format!("不支持的 LX Music 歌曲平台：{source}"));
    }
    let songmid = meta
        .get("songId")
        .filter(|id| id.is_number() || id.as_str().is_some_and(|id| !id.is_empty()))
        .ok_or_else(|| "LX Music 歌曲缺少播放标识".to_string())?;
    track["songmid"] = songmid.clone();
    track["albumName"] = meta.get("albumName").cloned().unwrap_or(json!(""));
    track["img"] = meta.get("picUrl").cloned().unwrap_or(Value::Null);
    track["types"] = meta
        .get("qualitys")
        .filter(|value| value.is_array())
        .cloned()
        .unwrap_or(json!([]));
    track["_types"] = meta
        .get("_qualitys")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or(json!({}));
    track["typeUrl"] = json!({});
    for field in [
        "albumId",
        "hash",
        "albumAudioId",
        "strMediaMid",
        "albumMid",
        "copyrightId",
        "lrcUrl",
        "mrcUrl",
        "trcUrl",
        "filePath",
        "ext",
    ] {
        if let Some(value) = meta.get(field) {
            track[field] = value.clone();
        }
    }
    if let Some(id) = meta.get("id") {
        track["songId"] = id.clone();
    }
    if source == "local" {
        if meta["filePath"].as_str().is_none_or(|path| path.is_empty()) {
            return Err("LX Music 本地歌曲缺少文件路径".into());
        }
        track["isLocalLibrary"] = json!(true);
    }
    track.as_object_mut().unwrap().remove("meta");
    Ok(track)
}

fn read_playlist(
    connection: &Connection,
    summary: ImportPlaylistSummary,
) -> Result<ImportedPlaylist, String> {
    let mut statement = connection
        .prepare(
            "SELECT music.id, music.name, music.singer, music.source, music.interval, music.meta
         FROM my_list_music_info music
         LEFT JOIN my_list_music_info_order ordering
           ON music.id=ordering.musicInfoId AND music.listId=ordering.listId
         WHERE music.listId=?1
         ORDER BY ordering.\"order\", music.rowid",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([&summary.id], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "singer": row.get::<_, String>(2)?,
                "source": row.get::<_, String>(3)?,
                "interval": row.get::<_, Option<String>>(4)?,
                "meta": row.get::<_, String>(5)?,
            }))
        })
        .map_err(|error| error.to_string())?;
    let mut tracks = Vec::new();
    for row in rows {
        let mut track = row.map_err(|error| error.to_string())?;
        track["meta"] = serde_json::from_str(track["meta"].as_str().unwrap_or_default())
            .map_err(|error| format!("LX Music 歌曲信息无效：{error}"))?;
        tracks.push(normalize_track(track)?);
    }
    let cover_url = tracks
        .iter()
        .find_map(|track| track["img"].as_str().map(str::to_string));
    Ok(ImportedPlaylist {
        external_id: summary.id,
        name: summary.name,
        cover_url,
        tracks,
    })
}

pub(crate) fn import_playlists(
    app: &tauri::AppHandle,
    ids: Vec<String>,
) -> Result<PlaylistImportResult, String> {
    let connection = open_database()?;
    let catalog = read_catalog(&connection)?;
    let selected: HashSet<_> = ids.into_iter().collect();
    if !selected
        .iter()
        .all(|id| catalog.playlists.iter().any(|playlist| &playlist.id == id))
    {
        return Err("所选 LX Music 歌单已变化，请重新读取后重试".into());
    }
    let total = selected.len();
    let mut result = PlaylistImportResult {
        playlists: Vec::new(),
        failures: Vec::new(),
    };
    for summary in catalog
        .playlists
        .into_iter()
        .filter(|item| selected.contains(&item.id))
    {
        let id = summary.id.clone();
        let name = summary.name.clone();
        match read_playlist(&connection, summary) {
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

    #[test]
    fn preserves_platform_specific_playback_fields() {
        let track = normalize_track(json!({
            "id": "tx_123", "source": "tx", "name": "歌曲", "singer": "歌手",
            "meta": {"songId": "mid123", "id": 123, "strMediaMid": "media123",
                "qualitys": [{"type": "flac", "size": null}], "_qualitys": {"flac": {"size": null}}}
        }))
        .unwrap();
        assert_eq!(track["songmid"], "mid123");
        assert_eq!(track["songId"], 123);
        assert_eq!(track["strMediaMid"], "media123");
        assert_eq!(track["types"][0]["type"], "flac");
        assert!(track.get("meta").is_none());
        let local = normalize_track(json!({
            "id": "local_1", "source": "local",
            "meta": {"songId": "/music/a.flac", "filePath": "/music/a.flac", "ext": "flac"}
        }))
        .unwrap();
        assert_eq!(local["isLocalLibrary"], true);
        assert!(normalize_track(json!({"source": "wy", "meta": {}})).is_err());
    }

    #[test]
    fn reads_built_in_and_custom_lists_in_saved_track_order() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE my_list (id TEXT, name TEXT, source TEXT, position INTEGER);
             CREATE TABLE my_list_music_info (id TEXT, listId TEXT, name TEXT, singer TEXT, source TEXT, interval TEXT, meta TEXT);
             CREATE TABLE my_list_music_info_order (listId TEXT, musicInfoId TEXT, \"order\" INTEGER);
             INSERT INTO my_list VALUES ('custom', '自建歌单', NULL, 0);
             INSERT INTO my_list_music_info VALUES ('wy_1', 'custom', '第一首', '歌手', 'wy', NULL, '{\"songId\":1}');
             INSERT INTO my_list_music_info VALUES ('kg_2', 'custom', '第二首', '歌手', 'kg', NULL, '{\"songId\":2,\"hash\":\"hash2\"}');
             INSERT INTO my_list_music_info_order VALUES ('custom', 'wy_1', 1), ('custom', 'kg_2', 0);"
        ).unwrap();
        let mut catalog = read_catalog(&connection).unwrap();
        assert_eq!(
            catalog
                .playlists
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["default", "love", "custom"]
        );
        let playlist = read_playlist(&connection, catalog.playlists.pop().unwrap()).unwrap();
        assert_eq!(playlist.tracks[0]["id"], "kg_2");
        assert_eq!(playlist.tracks[0]["hash"], "hash2");
        assert_eq!(playlist.tracks[1]["songmid"], 1);
    }

    #[test]
    #[ignore = "requires a local LX Music installation"]
    fn reads_installed_lx_playlists_without_modifying_them() {
        let connection = open_database().unwrap();
        let catalog = read_catalog(&connection).unwrap();
        let mut total = 0;
        for summary in catalog.playlists {
            let expected = summary.track_count;
            let playlist = read_playlist(&connection, summary).unwrap();
            assert_eq!(playlist.tracks.len(), expected);
            total += expected;
        }
        assert!(total > 0);
        println!("read {total} LX Music tracks");
    }
}
