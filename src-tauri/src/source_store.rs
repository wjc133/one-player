use std::{
    fs,
    path::{Path, PathBuf},
};

use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

use crate::AppState;

const MAX_SOURCES: usize = 20;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomSource {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub author: String,
    pub homepage: String,
    pub allow_show_update_alert: bool,
    pub script: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomSourceInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub author: String,
    pub homepage: String,
    pub allow_show_update_alert: bool,
}

impl From<&CustomSource> for CustomSourceInfo {
    fn from(source: &CustomSource) -> Self {
        Self {
            id: source.id.clone(),
            name: source.name.clone(),
            description: source.description.clone(),
            version: source.version.clone(),
            author: source.author.clone(),
            homepage: source.homepage.clone(),
            allow_show_update_alert: source.allow_show_update_alert,
        }
    }
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("custom-sources.json"))
}

fn load_sources(app: &AppHandle) -> Result<Vec<CustomSource>, String> {
    let path = store_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|error| format!("自定义源数据损坏：{error}"))
}

fn save_sources(app: &AppHandle, sources: &[CustomSource]) -> Result<(), String> {
    let path = store_path(app)?;
    let raw = serde_json::to_vec_pretty(sources).map_err(|error| error.to_string())?;
    fs::write(path, raw).map_err(|error| error.to_string())
}

fn clip(value: Option<String>, limit: usize) -> String {
    let value = value.unwrap_or_default();
    if value.chars().count() <= limit {
        return value;
    }
    let mut clipped = value.chars().take(limit).collect::<String>();
    clipped.push_str("...");
    clipped
}

pub(crate) fn parse_script_info(
    script: &str,
) -> Result<(String, String, String, String, String), String> {
    let comment_expression = Regex::new(r"(?s)^/\*.*?\*/").expect("valid source header regex");
    let info_expression =
        Regex::new(r"^\s?\*\s?@(\w+)\s(.+)$").expect("valid source metadata regex");
    let header = comment_expression
        .find(script)
        .ok_or_else(|| "无效的自定义源文件：文件开头缺少元信息注释".to_string())?
        .as_str();

    let mut name = None;
    let mut description = None;
    let mut version = None;
    let mut author = None;
    let mut homepage = None;

    for line in header.lines() {
        let Some(captures) = info_expression.captures(line) else {
            continue;
        };
        let key = captures
            .get(1)
            .map(|value| value.as_str())
            .unwrap_or_default();
        let value = captures
            .get(2)
            .map(|value| value.as_str().trim().to_string())
            .unwrap_or_default();
        match key {
            "name" => name = Some(value),
            "description" => description = Some(value),
            "version" => version = Some(value),
            "author" => author = Some(value),
            "homepage" => homepage = Some(value),
            _ => {}
        }
    }

    let name = clip(name, 24);
    let name = if name.is_empty() {
        format!("user_api_{}", Uuid::new_v4().simple())
    } else {
        name
    };

    Ok((
        name,
        clip(description, 36),
        clip(version, 36),
        clip(author, 56),
        clip(homepage, 1024),
    ))
}

#[derive(Debug)]
pub(crate) struct SourceImportResult {
    pub source: CustomSourceInfo,
    pub already_imported: bool,
}

fn prepare_source_import(
    sources: &mut Vec<CustomSource>,
    script: String,
    reuse_existing: bool,
) -> Result<SourceImportResult, String> {
    if let Some(existing) = sources.iter().find(|source| source.script == script) {
        if reuse_existing {
            return Ok(SourceImportResult {
                source: CustomSourceInfo::from(existing),
                already_imported: true,
            });
        }
        return Err(format!(
            "导入失败，脚本内容与已有的源「{}」相同",
            existing.name
        ));
    }
    if sources.len() >= MAX_SOURCES {
        return Err(format!("最多只能同时存在 {MAX_SOURCES} 个自定义源"));
    }

    let (name, description, version, author, homepage) = parse_script_info(&script)?;
    let source = CustomSource {
        id: format!("user_api_{}", Uuid::new_v4().simple()),
        name,
        description,
        version,
        author,
        homepage,
        allow_show_update_alert: true,
        script,
    };
    let info = CustomSourceInfo::from(&source);
    sources.push(source);
    Ok(SourceImportResult {
        source: info,
        already_imported: false,
    })
}

pub(crate) fn import_source_script(
    app: &AppHandle,
    state: &AppState,
    script: String,
    reuse_existing: bool,
) -> Result<SourceImportResult, String> {
    let _guard = state
        .source_store_lock
        .lock()
        .map_err(|_| "无法写入自定义源锁".to_string())?;
    let mut sources = load_sources(app)?;
    let result = prepare_source_import(&mut sources, script, reuse_existing)?;
    if !result.already_imported {
        save_sources(app, &sources)?;
    }
    Ok(result)
}

#[tauri::command]
pub fn list_custom_sources(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<CustomSourceInfo>, String> {
    let _guard = state
        .source_store_lock
        .lock()
        .map_err(|_| "无法读取自定义源锁".to_string())?;
    Ok(load_sources(&app)?
        .iter()
        .map(CustomSourceInfo::from)
        .collect())
}

#[tauri::command]
pub fn get_custom_source_script(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<String, String> {
    let _guard = state
        .source_store_lock
        .lock()
        .map_err(|_| "无法读取自定义源锁".to_string())?;
    load_sources(&app)?
        .into_iter()
        .find(|source| source.id == id)
        .map(|source| source.script)
        .ok_or_else(|| "自定义源不存在".to_string())
}

#[tauri::command]
pub fn import_custom_source_script(
    app: AppHandle,
    state: State<'_, AppState>,
    script: String,
) -> Result<CustomSourceInfo, String> {
    import_source_script(&app, &state, script, false).map(|result| result.source)
}

#[tauri::command]
pub fn import_custom_source_file(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<CustomSourceInfo, String> {
    let script = fs::read_to_string(Path::new(&path))
        .map_err(|error| format!("读取自定义源失败：{error}"))?;
    import_custom_source_script(app, state, script)
}

#[tauri::command]
pub fn remove_custom_source(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<CustomSourceInfo>, String> {
    let _guard = state
        .source_store_lock
        .lock()
        .map_err(|_| "无法写入自定义源锁".to_string())?;
    let mut sources = load_sources(&app)?;
    sources.retain(|source| source.id != id);
    save_sources(&app, &sources)?;
    Ok(sources.iter().map(CustomSourceInfo::from).collect())
}

#[tauri::command]
pub fn set_custom_source_update_alert(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    let _guard = state
        .source_store_lock
        .lock()
        .map_err(|_| "无法写入自定义源锁".to_string())?;
    let mut sources = load_sources(&app)?;
    let source = sources
        .iter_mut()
        .find(|source| source.id == id)
        .ok_or_else(|| "自定义源不存在".to_string())?;
    source.allow_show_update_alert = enabled;
    save_sources(&app, &sources)
}

#[cfg(test)]
mod tests {
    use super::{parse_script_info, prepare_source_import};

    #[test]
    fn parses_lx_source_header() {
        let source = r#"/**
 * @name 测试音乐源
 * @description 测试描述
 * @version 1.0.0
 * @author one-player
 * @homepage https://example.com
 */
console.log('ok')
"#;
        let info = parse_script_info(source).expect("header should parse");
        assert_eq!(info.0, "测试音乐源");
        assert_eq!(info.1, "测试描述");
        assert_eq!(info.2, "1.0.0");
        assert_eq!(info.3, "one-player");
        assert_eq!(info.4, "https://example.com");
    }

    #[test]
    fn reuses_an_existing_source_for_lx_imports() {
        let source = r#"/**
 * @name 测试音乐源
 * @version 1.0.0
 */
console.log('ok')
"#
        .to_string();
        let mut sources = Vec::new();

        let imported =
            prepare_source_import(&mut sources, source.clone(), true).expect("first import");
        let reused =
            prepare_source_import(&mut sources, source.clone(), true).expect("repeat import");
        let manual_error = prepare_source_import(&mut sources, source, false)
            .expect_err("manual duplicate should fail");

        assert!(!imported.already_imported);
        assert!(reused.already_imported);
        assert_eq!(imported.source.id, reused.source.id);
        assert_eq!(sources.len(), 1);
        assert!(manual_error.contains("脚本内容与已有的源"));
    }
}
