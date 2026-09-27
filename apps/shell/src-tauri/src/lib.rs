//! jobleft desktop shell (Tauri v2, macOS first). Contract: docs/INTERFACES.md section 5.2.
//!
//! - Launch: a new launch token, then the Node server as a sidecar (`node` beside this executable, the server tree
//!   under Resources/server) with `JOBLEFT_HOME`, `JOBLEFT_LAUNCH_TOKEN`, `JOBLEFT_PARENT_PID`, `JOBLEFT_UI_DIR`.
//! - Ready: wait for `run/server.json` and `GET /api/v1/health` (up to 15 s), then open the one window at
//!   `http://127.0.0.1:<port>/#token=<token>`. Before that, no window at all: no blank page, no "starting" page.
//! - Closing the window hides it; the app stays in the menu bar with Open, Check for jobs now, Pause/Continue
//!   checks, the time of the last check, and Quit. A second launch focuses the window (single instance).
//! - Notifications: `GET /api/v1/notifications` every minute; each one shown goes through Notification Center
//!   (`osascript`) and is acked.
//! - Quit (menu bar or Cmd-Q): SIGTERM to the server, wait up to 5 s, then exit. If the shell dies, the server sees
//!   the parent pid gone and exits by itself.
//!
//! Test hooks (env, never set by the app itself): `JOBLEFT_HOME` (data folder), `JOBLEFT_SHELL_NODE` and
//! `JOBLEFT_SHELL_SERVER` (a node binary and a server tree outside the bundle), `JOBLEFT_SHELL_PROBE` (a JavaScript
//! file to run in the window once it has loaded; whatever it puts in `document.title` after the prefix `PROBE:` is
//! written to `run/probe.json`).

use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const READY_TIMEOUT: Duration = Duration::from_secs(15);
/// Set by the SIGTERM handler (Unix); a thread turns it into the same clean quit as the menu bar item.
static TERM: AtomicBool = AtomicBool::new(false);
#[cfg(unix)]
extern "C" fn on_term(_sig: libc::c_int) {
    TERM.store(true, Ordering::SeqCst);
}
const QUIT_WAIT: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_secs(60);

struct Shell {
    home: PathBuf,
    token: String,
    port: Mutex<Option<u16>>,
    child: Mutex<Option<Child>>,
    quitting: Mutex<bool>,
}

/// The data folder: `JOBLEFT_HOME`, else `~/Library/Application Support/jobleft` on macOS, `%APPDATA%\jobleft` on
/// Windows (docs/INTERFACES.md section 2).
fn data_home() -> PathBuf {
    if let Ok(h) = std::env::var("JOBLEFT_HOME") {
        if !h.trim().is_empty() {
            return PathBuf::from(h);
        }
    }
    #[cfg(windows)]
    {
        if let Ok(a) = std::env::var("APPDATA") {
            if !a.trim().is_empty() {
                return PathBuf::from(a).join("jobleft");
            }
        }
        let up = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into());
        return PathBuf::from(up).join("AppData").join("Roaming").join("jobleft");
    }
    #[cfg(not(windows))]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        PathBuf::from(home).join("Library/Application Support/jobleft")
    }
}

/// 32 random bytes as hex, from the operating system's random source.
fn new_token() -> String {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).expect("the operating system's random source");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// One small HTTP/1.1 request to the local server (no library: the server is on loopback and answers small JSON).
fn http(port: u16, method: &str, path: &str, token: &str, body: Option<&str>) -> Option<(u16, String)> {
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse().ok()?;
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(10))).ok()?;
    s.set_write_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nx-jobleft-token: {token}\r\nAccept: application/json\r\nConnection: close\r\n");
    if let Some(b) = body {
        req.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", b.len()));
    }
    req.push_str("\r\n");
    if let Some(b) = body {
        req.push_str(b);
    }
    s.write_all(req.as_bytes()).ok()?;
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).ok()?;
    let text = String::from_utf8_lossy(&raw).to_string();
    let status: u16 = text.split(' ').nth(1)?.parse().ok()?;
    let body = text.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
    Some((status, body))
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

/// Where the sidecar's pieces are: `node` beside the executable and the server tree in Resources, unless a test
/// points at copies outside the bundle.
fn sidecar_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf, Option<PathBuf>), String> {
    let node = match std::env::var("JOBLEFT_SHELL_NODE") {
        Ok(p) if !p.is_empty() => PathBuf::from(p),
        _ => {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let dir = exe.parent().ok_or("no executable folder")?;
            if cfg!(windows) { dir.join("node.exe") } else { dir.join("node") }
        }
    };
    let res = app.path().resource_dir().map_err(|e| e.to_string())?;
    let server = match std::env::var("JOBLEFT_SHELL_SERVER") {
        Ok(p) if !p.is_empty() => PathBuf::from(p),
        _ => {
            let a = res.join("server");
            if a.join("src/main.js").exists() { a } else { res.join("resources/server") }
        }
    };
    let ui = [res.join("ui"), res.join("resources/ui")].into_iter().find(|p| p.join("index.html").exists());
    Ok((node, server, ui))
}

/// The public app token in Resources, if the build carries one (a `pat_jobleft_...` line; anything else is ignored).
fn publik_app_token(app: &AppHandle) -> Option<String> {
    let res = app.path().resource_dir().ok()?;
    let text = [res.join("publik-app-token.txt"), res.join("resources/publik-app-token.txt")].into_iter().find_map(|p| fs::read_to_string(p).ok())?;
    let tok = text.trim().to_string();
    if tok.starts_with("pat_jobleft_") && tok.len() < 120 { Some(tok) } else { None }
}

/// A path Node can take on Windows: without the `\\?\` verbatim prefix (`std::env::current_exe` and Tauri's resource
/// folder carry it there, and Node then fails to resolve its main script). Other systems: unchanged.
fn plain(p: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let s = p.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    p.to_path_buf()
}

fn spawn_server(app: &AppHandle, home: &Path, token: &str) -> Result<Child, String> {
    let (node, server, ui) = sidecar_paths(app)?;
    let (node, server, ui, home) = (plain(&node), plain(&server), ui.map(|u| plain(&u)), plain(home));
    let home = home.as_path();
    if !node.exists() {
        return Err(format!("the node runtime is missing at {}", node.display()));
    }
    let main = server.join("src/main.js");
    if !main.exists() {
        return Err(format!("the server is missing at {}", main.display()));
    }
    fs::create_dir_all(home.join("logs")).map_err(|e| e.to_string())?;
    let log = fs::OpenOptions::new().create(true).append(true).open(home.join("logs/sidecar.log")).map_err(|e| e.to_string())?;
    let log2 = log.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(&node);
    cmd.arg(&main)
        .env("JOBLEFT_HOME", home)
        .env("JOBLEFT_LAUNCH_TOKEN", token)
        .env("JOBLEFT_PARENT_PID", std::process::id().to_string())
        .env("JOBLEFT_QUIET", "1")
        .env_remove("JOBLEFT_PORT")
        .current_dir(&server)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log2));
    if let Some(ui) = ui {
        cmd.env("JOBLEFT_UI_DIR", ui);
    }
    // The public publik app token a packaged build ships with (CONTRACT section 7): Resources/publik-app-token.txt,
    // put there by scripts/pack.ts from a local file that git never sees. Only a packaged build may talk to the live
    // publik API; dev runs and tests use loopback stand-ins.
    if let Some(tok) = publik_app_token(app) {
        cmd.env("JOBLEFT_PUBLIK_APP_TOKEN", tok).env("JOBLEFT_PUBLIK_ALLOW_LIVE", "1");
    }
    cmd.spawn().map_err(|e| format!("could not start node: {e}"))
}

/// Waits for `run/server.json` and a healthy `GET /api/v1/health`. Returns the port.
fn wait_ready(home: &Path, token: &str, child: &mut Child) -> Result<u16, String> {
    let start = Instant::now();
    let run = home.join("run/server.json");
    while start.elapsed() < READY_TIMEOUT {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("the local service stopped at once (exit {status}); see logs/sidecar.log"));
        }
        if let Some(j) = read_json(&run) {
            if let Some(port) = j.get("port").and_then(|p| p.as_u64()) {
                let port = port as u16;
                if let Some((200, body)) = http(port, "GET", "/api/v1/health", token, None) {
                    if body.contains("\"jobleft\"") {
                        return Ok(port);
                    }
                }
            }
        }
        thread::sleep(Duration::from_millis(150));
    }
    Err("the local service did not answer within 15 seconds; see logs/sidecar.log".into())
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn open_window(app: &AppHandle, port: u16, token: &str) -> tauri::Result<()> {
    let url = format!("http://127.0.0.1:{port}/#token={token}").parse().expect("url");
    let w = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("jobleft")
        .inner_size(1280.0, 820.0)
        .min_inner_size(1024.0, 640.0)
        .build()?;
    let handle = app.clone();
    w.on_window_event(move |e| {
        if let WindowEvent::CloseRequested { api, .. } = e {
            // The window closes; jobleft stays in the menu bar and keeps checking for jobs.
            api.prevent_close();
            if let Some(w) = handle.get_webview_window("main") {
                let _ = w.hide();
            }
        }
    });
    Ok(())
}

fn error_window(app: &AppHandle, reason: &str) {
    eprintln!("jobleft: {reason}");
    let _ = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("jobleft")
        .inner_size(640.0, 360.0)
        .build();
}

/// Asks the server to stop (POST /api/v1/shutdown, the launch token proves it is the shell), on Unix also sends
/// SIGTERM, waits up to 5 s for a clean exit, and only then kills the process.
fn stop_server(shell: &Shell) {
    let mut guard = shell.child.lock().unwrap();
    if let Some(mut child) = guard.take() {
        if let Some(port) = *shell.port.lock().unwrap() {
            let _ = http(port, "POST", "/api/v1/shutdown", &shell.token, Some("{}"));
        }
        #[cfg(unix)]
        {
            let pid = child.id() as i32;
            unsafe {
                libc::kill(pid, libc::SIGTERM);
            }
        }
        let start = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if start.elapsed() < QUIT_WAIT => thread::sleep(Duration::from_millis(100)),
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
            }
        }
    }
    let _ = fs::remove_file(shell.home.join("run/shell.json"));
}

fn quit(app: &AppHandle) {
    let shell = app.state::<Shell>();
    {
        let mut q = shell.quitting.lock().unwrap();
        if *q {
            return;
        }
        *q = true;
    }
    stop_server(&shell);
    app.exit(0);
}

#[cfg(not(windows))]
fn notify(_app: &AppHandle, title: &str, body: &str) {
    let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!("display notification \"{}\" with title \"{}\"", esc(body), esc(title));
    let _ = Command::new("/usr/bin/osascript").arg("-e").arg(script).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
}
#[cfg(windows)]
fn notify(app: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

fn last_check_text(port: u16, token: &str) -> String {
    let status = http(port, "GET", "/api/v1/crawl/status", token, None).and_then(|(s, b)| if s == 200 { serde_json::from_str::<Value>(&b).ok() } else { None });
    let finished = status.as_ref().and_then(|j| j.pointer("/lastRun/finishedAt")).and_then(|v| v.as_str()).map(|s| s.to_string());
    let running = status.as_ref().and_then(|j| j.get("running")).and_then(|v| v.as_bool()).unwrap_or(false);
    match (running, finished) {
        (true, _) => "Checking for jobs now…".into(),
        (false, Some(t)) => format!("Last check: {}", t.replace('T', " ").chars().take(16).collect::<String>()),
        (false, None) => "Last check: none yet".into(),
    }
}

fn paused(port: u16, token: &str) -> bool {
    http(port, "GET", "/api/v1/settings", token, None)
        .and_then(|(s, b)| if s == 200 { serde_json::from_str::<Value>(&b).ok() } else { None })
        .and_then(|j| j.pointer("/crawl/paused").and_then(|v| v.as_bool()))
        .unwrap_or(false)
}

fn set_paused(port: u16, token: &str, value: bool) {
    if let Some((200, b)) = http(port, "GET", "/api/v1/settings", token, None) {
        if let Ok(mut j) = serde_json::from_str::<Value>(&b) {
            if let Some(c) = j.get_mut("crawl").and_then(|c| c.as_object_mut()) {
                c.insert("paused".into(), Value::Bool(value));
            }
            let _ = http(port, "PUT", "/api/v1/settings", token, Some(&j.to_string()));
        }
    }
}

/// Decodes %XX escapes (the probe report travels in the URL fragment).
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() + 1 && i + 2 <= b.len() - 1 + 1 {
            if let (Some(h), Some(l)) = (hex(b.get(i + 1).copied()), hex(b.get(i + 2).copied())) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}
fn hex(c: Option<u8>) -> Option<u8> {
    match c? {
        c @ b'0'..=b'9' => Some(c - b'0'),
        c @ b'a'..=b'f' => Some(c - b'a' + 10),
        c @ b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// Runs the JavaScript a test asked for, then copies what it leaves in the URL fragment (`#probe=...`) into
/// `run/probe.json`. WKWebView does not mirror document.title, but the webview's URL is readable from here.
fn run_probe(app: &AppHandle, home: PathBuf, script_path: String) {
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(4));
        let Ok(js) = fs::read_to_string(&script_path) else { return };
        let Some(w) = app.get_webview_window("main") else { return };
        let _ = w.eval(&js);
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(30) {
            thread::sleep(Duration::from_millis(250));
            if let Ok(u) = w.url() {
                if let Some(rest) = u.fragment().and_then(|f| f.strip_prefix("probe=")) {
                    let _ = fs::write(home.join("run/probe.json"), percent_decode(rest));
                    return;
                }
            }
        }
    });
}

pub fn run() {
    let home = data_home();
    let token = new_token();
    #[cfg(unix)]
    unsafe {
        libc::signal(libc::SIGTERM, on_term as *const () as usize);
        libc::signal(libc::SIGINT, on_term as *const () as usize);
    }
    let builder = tauri::Builder::default();
    #[cfg(windows)]
    let builder = builder.plugin(tauri_plugin_notification::init());
    builder
        // Links with target=_blank and window.open go to the default browser (the plugin's JS shim patches both).
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch: bring the one window forward and do nothing else.
            show_main(app);
        }))
        .manage(Shell { home: home.clone(), token: token.clone(), port: Mutex::new(None), child: Mutex::new(None), quitting: Mutex::new(false) })
        .setup(move |app| {
            let handle = app.handle().clone();
            let shell = handle.state::<Shell>();
            fs::create_dir_all(shell.home.join("run")).ok();

            // 1. The server sidecar, then the window only once the server answers.
            let mut child = match spawn_server(&handle, &shell.home, &shell.token) {
                Ok(c) => c,
                Err(e) => {
                    error_window(&handle, &e);
                    return Ok(());
                }
            };
            let port = match wait_ready(&shell.home, &shell.token, &mut child) {
                Ok(p) => p,
                Err(e) => {
                    let _ = child.kill();
                    error_window(&handle, &e);
                    return Ok(());
                }
            };
            *shell.child.lock().unwrap() = Some(child);
            *shell.port.lock().unwrap() = Some(port);
            open_window(&handle, port, &shell.token)?;
            let _ = fs::write(
                shell.home.join("run/shell.json"),
                json!({ "pid": std::process::id(), "port": port, "windowShown": true, "at": chrono_now() }).to_string(),
            );
            if let Ok(p) = std::env::var("JOBLEFT_SHELL_PROBE") {
                if !p.is_empty() {
                    run_probe(&handle, shell.home.clone(), p);
                }
            }

            // 2. The menu bar item.
            let open = MenuItem::with_id(app, "open", "Open jobleft", true, None::<&str>)?;
            let check = MenuItem::with_id(app, "check", "Check for jobs now", true, None::<&str>)?;
            let pause = MenuItem::with_id(app, "pause", if paused(port, &shell.token) { "Continue checks" } else { "Pause checks" }, true, None::<&str>)?;
            let last = MenuItem::with_id(app, "last", &last_check_text(port, &shell.token), false, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit jobleft", true, Some("CmdOrCtrl+Q"))?;
            let menu = Menu::with_items(app, &[&open, &check, &pause, &last, &PredefinedMenuItem::separator(app)?, &quit_item])?;
            let mut tray = TrayIconBuilder::with_id("jobleft")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .tooltip("jobleft")
                .on_menu_event(|app, ev| match ev.id().as_ref() {
                    "open" => show_main(app),
                    "check" => {
                        let s = app.state::<Shell>();
                        let port = *s.port.lock().unwrap();
                        if let Some(port) = port {
                            let _ = http(port, "POST", "/api/v1/crawl/run", &s.token, Some("{}"));
                        }
                    }
                    "pause" => {
                        let s = app.state::<Shell>();
                        let port = *s.port.lock().unwrap();
                        if let Some(port) = port {
                            let now = paused(port, &s.token);
                            set_paused(port, &s.token, !now);
                        }
                    }
                    "quit" => quit(app),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            }
            tray.build(app)?;

            // SIGTERM or Ctrl-C (a `kill`, a logout, a test) quits the same way the menu bar item does.
            let handle3 = handle.clone();
            thread::spawn(move || loop {
                thread::sleep(Duration::from_millis(100));
                if TERM.load(Ordering::SeqCst) {
                    quit(&handle3);
                    return;
                }
            });

            // 3. Every minute: the last-check line, the pause label, and notifications to show.
            let token2 = shell.token.clone();
            let handle2 = handle.clone();
            thread::spawn(move || loop {
                thread::sleep(POLL);
                let _ = last.set_text(last_check_text(port, &token2));
                let _ = pause.set_text(if paused(port, &token2) { "Continue checks" } else { "Pause checks" });
                if let Some((200, body)) = http(port, "GET", "/api/v1/notifications", &token2, None) {
                    if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(&body) {
                        for n in items {
                            let id = n.get("id").and_then(|v| v.as_str()).unwrap_or("");
                            let title = n.get("title").and_then(|v| v.as_str()).unwrap_or("jobleft");
                            let text = n.get("body").and_then(|v| v.as_str()).unwrap_or("");
                            if id.is_empty() {
                                continue;
                            }
                            notify(&handle2, title, text);
                            let _ = http(port, "POST", &format!("/api/v1/notifications/{id}/ack"), &token2, Some("{}"));
                        }
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("jobleft could not start")
        .run(|app, event| match event {
            // A dock icon click (macOS only: the event does not exist on Windows).
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => show_main(app),
            RunEvent::ExitRequested { .. } => {
                let shell = app.state::<Shell>();
                if !*shell.quitting.lock().unwrap() {
                    stop_server(&shell);
                }
            }
            RunEvent::Exit => {
                let shell = app.state::<Shell>();
                stop_server(&shell);
            }
            _ => {}
        });
}

/// ISO-8601 UTC time without a date library.
fn chrono_now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let days = secs / 86400;
    let (h, m, s) = ((secs % 86400) / 3600, (secs % 3600) / 60, secs % 60);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days as i64 + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}
