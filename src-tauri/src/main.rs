// 흥행판 (Tauri 시험판 v개발.000003)
// 넉넉한 취향이 클로드와 함께 만들었어요.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::{fs, path::PathBuf, time::Duration};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const DIR_NAME: &str = "흥행판_스냅샷";
const CRACK_URL: &str = "https://crack.wrtn.ai/";
const API_PREFIX: &str = "https://crack-api.wrtn.ai/";

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir().map(|h| h.join("Documents")))
        .map_err(|e| format!("문서 폴더를 찾지 못했어요: {e}"))?;
    let dir = base.join(DIR_NAME);
    fs::create_dir_all(&dir).map_err(|e| format!("저장 폴더를 만들지 못했어요: {e}"))?;
    Ok(dir)
}

/// 파일 이름으로 쓸 수 없는 값(경로 이동 등)을 막는다.
fn check_name(name: &str) -> Result<(), String> {
    let bad = name.is_empty()
        || name.len() > 200
        || name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
        || name.contains("..");
    if bad {
        Err(format!("사용할 수 없는 파일 이름이에요: {name}"))
    } else {
        Ok(())
    }
}

#[derive(Serialize)]
struct FileItem {
    name: String,
    text: String,
}

/// 저장 폴더 바로 아래의 .json 파일을 모두 읽어 돌려준다 (하위 폴더는 제외).
#[tauri::command]
fn list_snapshots(app: AppHandle) -> Result<Vec<FileItem>, String> {
    let dir = data_dir(&app)?;
    let mut out = Vec::new();
    let rd = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in rd.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.to_lowercase().ends_with(".json") {
            continue;
        }
        if let Ok(text) = fs::read_to_string(&path) {
            out.push(FileItem { name, text });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// 스냅샷 파일을 저장 폴더에 쓴다. overwrite=false 이고 이미 있으면 건너뛴다.
#[tauri::command]
fn save_snapshot(app: AppHandle, name: String, text: String, overwrite: bool) -> Result<bool, String> {
    check_name(&name)?;
    let path = data_dir(&app)?.join(&name);
    if path.exists() && !overwrite {
        return Ok(false);
    }
    fs::write(&path, text).map_err(|e| format!("저장하지 못했어요: {e}"))?;
    Ok(true)
}

/// 전체 기록 내보내기 파일을 '내보내기' 하위 폴더에 쓰고 경로를 돌려준다.
#[tauri::command]
fn save_export(app: AppHandle, name: String, text: String) -> Result<String, String> {
    check_name(&name)?;
    let dir = data_dir(&app)?.join("내보내기");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&name);
    fs::write(&path, text).map_err(|e| format!("저장하지 못했어요: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// 파일을 지우지 않고 '삭제됨' / '가져옴' 하위 폴더로 옮긴다.
#[tauri::command]
fn move_aside(app: AppHandle, name: String, sub: String) -> Result<(), String> {
    check_name(&name)?;
    if sub != "삭제됨" && sub != "가져옴" {
        return Err("허용되지 않은 폴더예요".into());
    }
    let dir = data_dir(&app)?;
    let from = dir.join(&name);
    if !from.is_file() {
        return Ok(());
    }
    let to_dir = dir.join(&sub);
    fs::create_dir_all(&to_dir).map_err(|e| e.to_string())?;
    let mut to = to_dir.join(&name);
    let mut n = 1;
    while to.exists() {
        to = to_dir.join(format!("{n}_{name}"));
        n += 1;
    }
    fs::rename(&from, &to).map_err(|e| format!("옮기지 못했어요: {e}"))
}

#[tauri::command]
fn data_dir_path(app: AppHandle) -> Result<String, String> {
    Ok(data_dir(&app)?.to_string_lossy().to_string())
}

#[tauri::command]
fn open_folder(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = data_dir(&app)?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// 크랙 작품 링크만 기본 브라우저로 연다.
#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if !url.starts_with(CRACK_URL) {
        return Err("크랙 주소만 열 수 있어요".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct HttpRes {
    status: u16,
    body: String,
}

/// 크랙 API GET 요청 (브라우저의 CORS 제한을 피하려고 앱 뒤쪽에서 호출).
#[tauri::command]
async fn http_get(url: String, token: String) -> Result<HttpRes, String> {
    if !url.starts_with(API_PREFIX) {
        return Err("크랙 API 주소만 호출할 수 있어요".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client
        .get(&url)
        .header("Platform", "web")
        .header("wrtn-locale", "ko-KR");
    if !token.is_empty() {
        req = req.header("Authorization", format!("Bearer {token}"));
    }
    let res = req.send().await.map_err(|e| format!("네트워크 오류: {e}"))?;
    let status = res.status().as_u16();
    let body = res.text().await.map_err(|e| e.to_string())?;
    Ok(HttpRes { status, body })
}

/// 크랙 로그인 창을 연다 (이미 있으면 앞으로 가져온다). 로그인은 크랙 페이지에서 직접 한다.
#[tauri::command]
async fn crack_login(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("crack") {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    let url: Url = Url::parse(CRACK_URL).map_err(|e| e.to_string())?;
    WebviewWindowBuilder::new(&app, "crack", WebviewUrl::External(url))
        .title("크랙 로그인 — 로그인 후 이 창을 닫고 '스냅샷 받기'를 누르세요")
        .inner_size(1000.0, 800.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 로그인 창의 쿠키에서 access_token 을 읽어 돌려준다. 없으면 빈 문자열.
#[tauri::command]
async fn crack_token(app: AppHandle) -> Result<String, String> {
    let url: Url = Url::parse(CRACK_URL).map_err(|e| e.to_string())?;
    let (win, created) = match app.get_webview_window("crack") {
        Some(w) => (w, false),
        None => (
            WebviewWindowBuilder::new(&app, "crack", WebviewUrl::External(url.clone()))
                .title("크랙")
                .visible(false)
                .build()
                .map_err(|e| e.to_string())?,
            true,
        ),
    };
    if created {
        tokio_sleep(600).await;
    }
    let cookies = win.cookies_for_url(url).map_err(|e| e.to_string())?;
    let token = cookies
        .iter()
        .find(|c| c.name() == "access_token")
        .map(|c| c.value().to_string())
        .unwrap_or_default();
    if created {
        let _ = win.close();
    }
    Ok(token)
}

async fn tokio_sleep(ms: u64) {
    tauri::async_runtime::spawn_blocking(move || std::thread::sleep(Duration::from_millis(ms)))
        .await
        .ok();
}

/// 자체 검사용 (환경변수 HEUNG_SELFTEST_OUT 이 있을 때만 동작)
#[tauri::command]
fn selftest_enabled() -> bool {
    std::env::var("HEUNG_SELFTEST_OUT").is_ok()
}

#[tauri::command]
fn selftest_log(text: String) {
    use std::io::Write;
    if let Ok(p) = std::env::var("HEUNG_SELFTEST_OUT") {
        if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(format!("{p}.log")) {
            let _ = writeln!(f, "{text}");
        }
    }
}

#[tauri::command]
fn selftest_report(text: String) {
    if let Ok(p) = std::env::var("HEUNG_SELFTEST_OUT") {
        let _ = fs::write(p, text);
        std::process::exit(0);
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_snapshots,
            save_snapshot,
            save_export,
            move_aside,
            data_dir_path,
            open_folder,
            open_url,
            http_get,
            crack_login,
            crack_token,
            selftest_enabled,
            selftest_log,
            selftest_report
        ])
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("흥행판 · v개발.000003")
                .inner_size(1600.0, 900.0)
                .min_inner_size(900.0, 600.0)
                .disable_drag_drop_handler()
                .initialization_script(include_str!("bridge.js"))
                .build()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                if window.label() == "main" {
                    window.app_handle().exit(0);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("흥행판을 시작하지 못했어요");
}
