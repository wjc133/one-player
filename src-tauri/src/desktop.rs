use std::sync::Mutex;

use serde::Deserialize;
use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WindowEvent,
};

const TRAY_ID: &str = "one-player";

#[derive(Clone, Copy, Default, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CloseBehavior {
    #[default]
    Ask,
    Quit,
    Tray,
}

#[derive(Default)]
pub struct DesktopState {
    close_behavior: Mutex<CloseBehavior>,
    playback: Mutex<Option<DesktopPlayback>>,
}

pub struct TrayMenu {
    track: MenuItem<tauri::Wry>,
    toggle: MenuItem<tauri::Wry>,
    previous: MenuItem<tauri::Wry>,
    next: MenuItem<tauri::Wry>,
    lyrics: CheckMenuItem<tauri::Wry>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPlayback {
    track: Option<String>,
    is_playing: bool,
    player_page_visible: bool,
    lyric: String,
    menu_bar_lyrics: bool,
}

impl DesktopPlayback {
    fn menu_bar_lyric(&self, window_visible: bool, window_minimized: bool) -> String {
        if self.menu_bar_lyrics
            && self.is_playing
            && self.track.is_some()
            && (!self.player_page_visible || !window_visible || window_minimized)
        {
            single_line(&self.lyric, 36)
        } else {
            String::new()
        }
    }
}

fn music_icon() -> Image<'static> {
    let size = 36usize;
    let mut pixels = vec![0u8; size * size * 4];
    for row in 0..size {
        for column in 0..size {
            let mut coverage = 0u32;
            for sample_y in 0..4 {
                for sample_x in 0..4 {
                    let x = (column as f64 + (sample_x as f64 + 0.5) / 4.0) / 2.0;
                    let y = (row as f64 + (sample_y as f64 + 0.5) / 4.0) / 2.0;
                    let stems = ((6.0..=7.5).contains(&x) && (4.0..=13.5).contains(&y))
                        || ((13.0..=14.5).contains(&x) && (2.5..=12.0).contains(&y));
                    let beam = (6.0..=14.5).contains(&x)
                        && y >= 4.0 - (x - 6.0) * 1.5 / 8.5
                        && y <= 6.5 - (x - 6.0) * 1.5 / 8.5;
                    let left_note = ((x - 4.7) / 2.8).powi(2) + ((y - 13.6) / 2.2).powi(2) <= 1.0;
                    let right_note = ((x - 11.7) / 2.8).powi(2) + ((y - 12.1) / 2.2).powi(2) <= 1.0;
                    if stems || beam || left_note || right_note {
                        coverage += 1;
                    }
                }
            }
            let offset = (row * size + column) * 4;
            pixels[offset + 3] = (coverage * 255 / 16) as u8;
        }
    }
    Image::new_owned(pixels, size as u32, size as u32)
}

pub fn show_main_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        window.unminimize()?;
        window.show()?;
        window.set_focus()?;
    }
    if let Err(error) = refresh_desktop_playback(app) {
        eprintln!("更新菜单栏失败：{error}");
    }
    Ok(())
}

pub fn setup(app: &mut tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示 One Player", true, None::<&str>)?;
    let track = MenuItem::with_id(app, "track", "暂无播放", false, None::<&str>)?;
    let previous = MenuItem::with_id(app, "previous", "上一首", false, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "播放", false, None::<&str>)?;
    let next = MenuItem::with_id(app, "next", "下一首", false, None::<&str>)?;
    let lyrics = CheckMenuItem::with_id(
        app,
        "toggle-lyrics",
        "菜单栏歌词",
        true,
        false,
        None::<&str>,
    )?;
    let settings = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 One Player", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &PredefinedMenuItem::separator(app)?,
            &track,
            &previous,
            &toggle,
            &next,
            &PredefinedMenuItem::separator(app)?,
            &lyrics,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    #[cfg(target_os = "macos")]
    let icon = music_icon();
    #[cfg(not(target_os = "macos"))]
    let icon = app
        .default_window_icon()
        .map(|icon| Image::new_owned(icon.rgba().to_vec(), icon.width(), icon.height()))
        .unwrap_or_else(music_icon);

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .tooltip("One Player")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            let result = match event.id().as_ref() {
                "show" => show_main_window(app),
                "quit" => {
                    app.exit(0);
                    Ok(())
                }
                "settings" => show_main_window(app)
                    .and_then(|()| app.emit_to("main", "desktop:action", "settings")),
                action @ ("previous" | "toggle" | "next" | "toggle-lyrics") => {
                    app.emit_to("main", "desktop:action", action)
                }
                _ => Ok(()),
            };
            if let Err(error) = result {
                eprintln!("菜单栏操作失败：{error}");
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } = event
            {
                if let Err(error) = show_main_window(tray.app_handle()) {
                    eprintln!("显示窗口失败：{error}");
                }
            }
        })
        .build(app)?;

    app.manage(TrayMenu {
        track,
        toggle,
        previous,
        next,
        lyrics,
    });
    Ok(())
}

pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    if window.label() != "main" {
        return;
    }
    if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let app = window.app_handle();
        let behavior = app
            .state::<DesktopState>()
            .close_behavior
            .lock()
            .map(|behavior| *behavior)
            .unwrap_or_default();
        let result = match behavior {
            CloseBehavior::Quit => {
                app.exit(0);
                Ok(())
            }
            CloseBehavior::Tray => window.hide(),
            CloseBehavior::Ask => show_main_window(app)
                .and_then(|()| app.emit_to("main", "desktop:close-requested", ())),
        };
        if let Err(error) = result {
            eprintln!("关闭窗口失败：{error}");
        }
    }
    if matches!(
        event,
        WindowEvent::CloseRequested { .. } | WindowEvent::Focused(_) | WindowEvent::Resized(_)
    ) {
        if let Err(error) = refresh_desktop_playback(window.app_handle()) {
            eprintln!("更新菜单栏失败：{error}");
        }
    }
}

#[tauri::command]
pub fn set_desktop_close_behavior(
    state: State<'_, DesktopState>,
    behavior: CloseBehavior,
) -> Result<(), String> {
    *state
        .close_behavior
        .lock()
        .map_err(|error| error.to_string())? = behavior;
    Ok(())
}

#[tauri::command]
pub fn set_desktop_tray_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_visible(visible)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn open_external_url(url: String) -> Result<(), String> {
    let parsed = reqwest::Url::parse(&url).map_err(|_| "链接无效".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("仅支持在浏览器中打开 HTTP 或 HTTPS 链接".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        let mut command = {
            let mut command = std::process::Command::new("open");
            command.arg("--");
            command
        };
        #[cfg(target_os = "windows")]
        let mut command = std::process::Command::new("explorer");
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let mut command = std::process::Command::new("xdg-open");
        let status = command
            .arg(parsed.as_str())
            .status()
            .map_err(|error| format!("打开浏览器失败：{error}"))?;
        if !status.success() {
            return Err("无法打开默认浏览器".to_string());
        }
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn complete_window_close(app: AppHandle, behavior: CloseBehavior) -> Result<(), String> {
    match behavior {
        CloseBehavior::Quit => app.exit(0),
        CloseBehavior::Tray => app
            .get_webview_window("main")
            .ok_or("找不到主窗口")?
            .hide()
            .map_err(|error| error.to_string())?,
        CloseBehavior::Ask => return Err("请选择退出应用或隐藏到菜单栏".into()),
    }
    refresh_desktop_playback(&app)
}

fn single_line(text: &str, max_chars: usize) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = text.chars();
    let title: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{title}…")
    } else {
        title
    }
}

#[tauri::command]
pub fn update_desktop_playback(
    app: AppHandle,
    state: State<'_, DesktopState>,
    payload: DesktopPlayback,
) -> Result<(), String> {
    *state.playback.lock().map_err(|error| error.to_string())? = Some(payload);
    refresh_desktop_playback(&app)
}

fn refresh_desktop_playback(app: &AppHandle) -> Result<(), String> {
    let Some(state) = app.try_state::<DesktopState>() else {
        return Ok(());
    };
    let payload = state
        .playback
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    let (Some(payload), Some(menu)) = (payload, app.try_state::<TrayMenu>()) else {
        return Ok(());
    };
    let update = || -> tauri::Result<()> {
        let has_track = payload.track.is_some();
        let track = payload.track.as_deref().unwrap_or("暂无播放");
        menu.track.set_text(single_line(track, 70))?;
        menu.toggle.set_text(if payload.is_playing {
            "暂停"
        } else {
            "播放"
        })?;
        menu.toggle.set_enabled(has_track)?;
        menu.previous.set_enabled(has_track)?;
        menu.next.set_enabled(has_track)?;
        menu.lyrics.set_checked(payload.menu_bar_lyrics)?;
        if let Some(tray) = app.tray_by_id(TRAY_ID) {
            let (visible, minimized) = match app.get_webview_window("main") {
                Some(window) => (window.is_visible()?, window.is_minimized()?),
                None => (false, false),
            };
            let lyric = payload.menu_bar_lyric(visible, minimized);
            #[cfg(target_os = "macos")]
            tray.set_title(Some(&lyric))?;
            let tooltip = if lyric.is_empty() {
                format!("One Player · {track}")
            } else {
                format!("One Player · {track}\n{}", payload.lyric.trim())
            };
            tray.set_tooltip(Some(tooltip))?;
        }
        Ok(())
    };
    update().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lyrics_stay_on_one_line_and_fit_the_menu_bar() {
        assert_eq!(single_line("  第一行\n 第二行\t ", 36), "第一行 第二行");
        assert_eq!(single_line("一二三四五", 4), "一二三四…");
        assert_eq!(single_line("🌙夜曲", 3), "🌙夜曲");
        assert_eq!(single_line("", 36), "");
    }

    #[test]
    fn close_behavior_defaults_to_asking_and_rejects_unknown_actions() {
        assert!(matches!(CloseBehavior::default(), CloseBehavior::Ask));
        assert!(matches!(
            serde_json::from_str::<CloseBehavior>("\"tray\"").unwrap(),
            CloseBehavior::Tray
        ));
        assert!(serde_json::from_str::<CloseBehavior>("\"destroy\"").is_err());
    }

    #[test]
    fn menu_bar_lyrics_follow_playback_and_player_page_visibility() {
        let mut playback = DesktopPlayback {
            track: Some("歌曲".into()),
            is_playing: true,
            lyric: "当前歌词".into(),
            menu_bar_lyrics: true,
            player_page_visible: false,
        };
        assert_eq!(playback.menu_bar_lyric(true, false), "当前歌词");
        playback.player_page_visible = true;
        assert_eq!(playback.menu_bar_lyric(true, false), "");
        assert_eq!(playback.menu_bar_lyric(true, true), "当前歌词");
        assert_eq!(playback.menu_bar_lyric(false, false), "当前歌词");
        assert_eq!(playback.menu_bar_lyric(true, false), "");
        playback.is_playing = false;
        assert_eq!(playback.menu_bar_lyric(true, true), "");
        assert_eq!(playback.menu_bar_lyric(false, false), "");
        playback.is_playing = true;
        playback.menu_bar_lyrics = false;
        assert_eq!(playback.menu_bar_lyric(false, false), "");
        playback.menu_bar_lyrics = true;
        playback.track = None;
        assert_eq!(playback.menu_bar_lyric(false, false), "");
    }
}
