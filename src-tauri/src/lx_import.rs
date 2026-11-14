use std::{
    env, fs,
    io::Read,
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use flate2::read::ZlibDecoder;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::{
    source_store::{self, CustomSourceInfo},
    AppState,
};

const MAX_LX_SCRIPT_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LxMusicSourceSummary {
    id: String,
    name: String,
    description: String,
    version: String,
    author: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LxMusicSourceStatus {
    installed: bool,
    can_import: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    install_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    selected_source_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<LxMusicSourceSummary>,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LxMusicImportResult {
    source: CustomSourceInfo,
    already_imported: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LxStoredSource {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    author: String,
    script: String,
}

struct LxInspection {
    status: LxMusicSourceStatus,
    script: Option<String>,
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

#[cfg(target_os = "windows")]
fn push_env_path(paths: &mut Vec<PathBuf>, variable: &str, suffix: &str) {
    if let Some(root) = env::var_os(variable) {
        paths.push(PathBuf::from(root).join(suffix));
    }
}

fn install_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    #[cfg(target_os = "macos")]
    {
        paths.push(PathBuf::from("/Applications/lx-music-desktop.app"));
        paths.push(PathBuf::from("/Applications/洛雪音乐助手.app"));
        if let Some(home) = home_dir() {
            paths.push(home.join("Applications/lx-music-desktop.app"));
            paths.push(home.join("Applications/洛雪音乐助手.app"));
        }
    }

    #[cfg(target_os = "windows")]
    {
        push_env_path(
            &mut paths,
            "LOCALAPPDATA",
            "Programs/lx-music-desktop/lx-music-desktop.exe",
        );
        push_env_path(
            &mut paths,
            "LOCALAPPDATA",
            "lx-music-desktop/lx-music-desktop.exe",
        );
        push_env_path(
            &mut paths,
            "ProgramFiles",
            "lx-music-desktop/lx-music-desktop.exe",
        );
        push_env_path(
            &mut paths,
            "ProgramFiles(x86)",
            "lx-music-desktop/lx-music-desktop.exe",
        );
    }

    #[cfg(target_os = "linux")]
    {
        paths.extend([
            PathBuf::from("/usr/bin/lx-music-desktop"),
            PathBuf::from("/usr/local/bin/lx-music-desktop"),
            PathBuf::from("/opt/lx-music-desktop/lx-music-desktop"),
        ]);
        if let Some(home) = home_dir() {
            paths.push(home.join(".local/bin/lx-music-desktop"));
            paths.push(home.join("Applications/lx-music-desktop.AppImage"));
        }
    }

    if let Some(search_path) = env::var_os("PATH") {
        for directory in env::split_paths(&search_path) {
            #[cfg(target_os = "windows")]
            paths.push(directory.join("lx-music-desktop.exe"));
            #[cfg(not(target_os = "windows"))]
            paths.push(directory.join("lx-music-desktop"));
        }
    }

    paths
}

fn find_install_path() -> Option<PathBuf> {
    install_candidates().into_iter().find(|path| path.exists())
}

fn user_data_candidates(_install_path: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();

    #[cfg(target_os = "windows")]
    if let Some(directory) = _install_path.parent() {
        paths.push(directory.join("portable/userData"));
    }

    #[cfg(target_os = "macos")]
    if let Some(home) = home_dir() {
        paths.push(home.join("Library/Application Support/lx-music-desktop"));
    }

    #[cfg(target_os = "windows")]
    push_env_path(&mut paths, "APPDATA", "lx-music-desktop");

    #[cfg(target_os = "linux")]
    {
        if let Some(config_home) = env::var_os("XDG_CONFIG_HOME") {
            paths.push(PathBuf::from(config_home).join("lx-music-desktop"));
        } else if let Some(home) = home_dir() {
            paths.push(home.join(".config/lx-music-desktop"));
        }
    }

    paths
}

fn find_user_data_path(install_path: &Path) -> Option<PathBuf> {
    user_data_candidates(install_path)
        .into_iter()
        .find(|path| path.exists())
}

fn find_existing_file(root: &Path, candidates: &[&str]) -> Option<PathBuf> {
    candidates
        .iter()
        .map(|relative| root.join(relative))
        .find(|path| path.is_file())
}

fn read_json(path: &Path, label: &str) -> Result<Value, String> {
    let raw = fs::read(path).map_err(|error| format!("读取 LX {label}失败：{error}"))?;
    serde_json::from_slice(&raw).map_err(|error| format!("解析 LX {label}失败：{error}"))
}

fn selected_source_id(value: &Value) -> Option<String> {
    let settings = value.get("setting").unwrap_or(value);
    settings
        .get("common.apiSource")
        .or_else(|| settings.get("apiSource"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn stored_sources(value: Value) -> Result<Vec<LxStoredSource>, String> {
    let sources = value
        .get("userApis")
        .cloned()
        .or_else(|| value.as_array().map(|_| value.clone()))
        .ok_or_else(|| "LX 自定义源配置中缺少 userApis".to_string())?;
    serde_json::from_value(sources).map_err(|error| format!("解析 LX 自定义源失败：{error}"))
}

fn decode_lx_script(stored_script: &str) -> Result<String, String> {
    if !stored_script.starts_with("gz_") {
        if stored_script.len() as u64 > MAX_LX_SCRIPT_BYTES {
            return Err("LX 自定义源脚本过大".to_string());
        }
        return Ok(stored_script.to_string());
    }

    let compressed = STANDARD
        .decode(&stored_script[3..])
        .map_err(|error| format!("解码 LX 自定义源失败：{error}"))?;
    let decoder = ZlibDecoder::new(compressed.as_slice());
    let mut limited = decoder.take(MAX_LX_SCRIPT_BYTES + 1);
    let mut script = Vec::new();
    limited
        .read_to_end(&mut script)
        .map_err(|error| format!("解压 LX 自定义源失败：{error}"))?;
    if script.len() as u64 > MAX_LX_SCRIPT_BYTES {
        return Err("LX 自定义源脚本解压后过大".to_string());
    }
    String::from_utf8(script).map_err(|error| format!("LX 自定义源不是 UTF-8 文本：{error}"))
}

fn unavailable_status(message: impl Into<String>) -> LxMusicSourceStatus {
    LxMusicSourceStatus {
        installed: false,
        can_import: false,
        install_path: None,
        data_path: None,
        selected_source_id: None,
        source: None,
        message: message.into(),
    }
}

fn inspect_lx_music() -> LxInspection {
    let Some(install_path) = find_install_path() else {
        return LxInspection {
            status: unavailable_status("未检测到 LX Music Desktop，安装后可一键导入"),
            script: None,
        };
    };

    let mut status = LxMusicSourceStatus {
        installed: true,
        can_import: false,
        install_path: Some(path_text(&install_path)),
        data_path: None,
        selected_source_id: None,
        source: None,
        message: String::new(),
    };

    let Some(data_path) = find_user_data_path(&install_path) else {
        status.message = "已检测到 LX Music，但尚未找到本地配置；请先启动 LX Music".to_string();
        return LxInspection {
            status,
            script: None,
        };
    };
    status.data_path = Some(path_text(&data_path));

    let Some(settings_path) = find_existing_file(
        &data_path,
        &[
            "LxDatas/config_v2.json",
            "config_v2.json",
            "config.json",
            "LxDatas/config.json",
        ],
    ) else {
        status.message = "未找到 LX 的设置文件；请先在 LX Music 中完成初始化".to_string();
        return LxInspection {
            status,
            script: None,
        };
    };

    let settings = match read_json(&settings_path, "设置") {
        Ok(settings) => settings,
        Err(message) => {
            status.message = message;
            return LxInspection {
                status,
                script: None,
            };
        }
    };
    let Some(selected_source_id) = selected_source_id(&settings) else {
        status.message = "LX 设置中没有默认音源".to_string();
        return LxInspection {
            status,
            script: None,
        };
    };
    status.selected_source_id = Some(selected_source_id.clone());

    if !selected_source_id.starts_with("user_api") {
        status.message = "LX 当前默认音源不是自定义源，请先在 LX 中启用一个自定义源".to_string();
        return LxInspection {
            status,
            script: None,
        };
    }

    let Some(sources_path) = find_existing_file(
        &data_path,
        &[
            "LxDatas/user_api.json",
            "user_api.json",
            "userApi.json",
            "LxDatas/userApi.json",
        ],
    ) else {
        status.message = "未找到 LX 的自定义源配置".to_string();
        return LxInspection {
            status,
            script: None,
        };
    };

    let sources = match read_json(&sources_path, "自定义源配置").and_then(stored_sources) {
        Ok(sources) => sources,
        Err(message) => {
            status.message = message;
            return LxInspection {
                status,
                script: None,
            };
        }
    };
    let Some(source) = sources
        .into_iter()
        .find(|source| source.id == selected_source_id)
    else {
        status.message = "LX 当前默认自定义源已不存在".to_string();
        return LxInspection {
            status,
            script: None,
        };
    };

    let script = match decode_lx_script(&source.script) {
        Ok(script) => script,
        Err(message) => {
            status.message = message;
            return LxInspection {
                status,
                script: None,
            };
        }
    };
    let (name, description, version, author, _) = match source_store::parse_script_info(&script) {
        Ok(info) => info,
        Err(message) => {
            status.message = format!("LX 默认自定义源无效：{message}");
            return LxInspection {
                status,
                script: None,
            };
        }
    };

    status.source = Some(LxMusicSourceSummary {
        id: source.id,
        name: if name.is_empty() { source.name } else { name },
        description: if description.is_empty() {
            source.description
        } else {
            description
        },
        version: if version.is_empty() {
            source.version
        } else {
            version
        },
        author: if author.is_empty() {
            source.author
        } else {
            author
        },
    });
    status.can_import = true;
    status.message = "已检测到 LX 当前默认自定义源".to_string();

    LxInspection {
        status,
        script: Some(script),
    }
}

#[tauri::command]
pub fn detect_lx_music_source() -> LxMusicSourceStatus {
    inspect_lx_music().status
}

#[tauri::command]
pub fn import_lx_music_default_source(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<LxMusicImportResult, String> {
    let inspection = inspect_lx_music();
    let script = inspection
        .script
        .ok_or_else(|| inspection.status.message.clone())?;
    let imported = source_store::import_source_script(&app, &state, script, true)?;
    Ok(LxMusicImportResult {
        source: imported.source,
        already_imported: imported.already_imported,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{decode_lx_script, selected_source_id, stored_sources};

    #[test]
    fn reads_current_and_legacy_default_source_fields() {
        assert_eq!(
            selected_source_id(&json!({
                "setting": { "common.apiSource": "user_api_current" }
            }))
            .as_deref(),
            Some("user_api_current")
        );
        assert_eq!(
            selected_source_id(&json!({
                "setting": { "apiSource": "user_api_legacy" }
            }))
            .as_deref(),
            Some("user_api_legacy")
        );
    }

    #[test]
    fn reads_wrapped_and_direct_source_lists() {
        let wrapped = stored_sources(json!({
            "userApis": [{
                "id": "user_api_1",
                "script": "source"
            }]
        }))
        .expect("wrapped source list should parse");
        let direct = stored_sources(json!([{
            "id": "user_api_2",
            "script": "source"
        }]))
        .expect("direct source list should parse");

        assert_eq!(wrapped[0].id, "user_api_1");
        assert_eq!(direct[0].id, "user_api_2");
    }

    #[test]
    fn decodes_plain_and_zlib_scripts() {
        assert_eq!(
            decode_lx_script("hello source").expect("plain script should pass"),
            "hello source"
        );
        assert_eq!(
            decode_lx_script("gz_eJzLSM3JyVcozi8tSk4FAB7RBMY=").expect("zlib script should decode"),
            "hello source"
        );
    }
}
