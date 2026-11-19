//! Signed self-update (tauri-plugin-updater). Copied from the publik template (GSpot, src-tauri/src/updates.rs) and
//! changed for jobleft only where the comments say so; follow the checklist in docs/updates.md.
//!
//! What it does
//! - Checks the feed 10 s after launch, then once a day while the app runs. The day is measured on the wall clock,
//!   so a Mac that slept through the day checks soon after it wakes. `PUBLIK_NO_AUTO_UPDATE=1` turns the automatic
//!   checks off (CI, managed machines).
//! - "Check for Updates…" in the menu bar menu runs the same check by hand.
//! - Every package is checked against the public key in tauri.conf.json before it is used, and its signature must
//!   name the version the feed announces (`requireSignedVersion`).
//! - macOS: the new .app is downloaded and verified in the background. Then the app asks, and "Install and Restart"
//!   puts it in place, stops the local service and restarts. (jobleft: the bundle is NOT swapped in the background,
//!   because the local service reads its server and UI files from the bundle while it runs; see
//!   INSTALL_IN_BACKGROUND.) When this user cannot replace the app (installed by another user), macOS asks for an
//!   admin password after the yes.
//!   Windows: the installer is downloaded and verified in the background. Then the app asks, and "Restart and
//!   Install" stops the local service (node.exe must not hold its files) and runs the installer in passive mode (a
//!   progress bar, no questions): it closes the app, updates it and opens it again. Nothing restarts without a yes.
//! - A background check that fails writes to stderr only. A manual check shows the error.
//!
//! Build-time override: `PUBLIK_UPDATE_ENDPOINT` (one URL or a comma-separated list, read with `option_env!`)
//! replaces the endpoints in tauri.conf.json, so a test build can use a test feed.
//!
//! Test hook: `PUBLIK_UPDATE_SELF_TEST=version|check|install|prompt|restart` starts the app with no window and no
//! prompt, runs the same check/download/verify/install code, writes one JSON line to stdout and appends it to the
//! file named by `PUBLIK_UPDATE_SELF_TEST_OUT`, then exits.
//! Exit codes: 0 = done (installed, up to date, or version), 2 = the update failed or was refused.
//! `prompt` runs the background check as it is and leaves the restart question open (the test looks at it and closes
//! the app). `restart` (jobleft) takes the "yes" answer of that question without showing it: install, stop the local
//! service, restart into the new version.

use serde_json::{json, Value};
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

// ---- Per app ----------------------------------------------------------------------------------------------------
const APP_NAME: &str = "jobleft";
const FIRST_CHECK_AFTER: Duration = Duration::from_secs(10);
const CHECK_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
/// How often the background loop looks at the wall clock.
const TICK: Duration = Duration::from_secs(30 * 60);
/// macOS: swap the bundle in place as soon as the update is verified (the template does), or only after the yes.
/// jobleft: only after the yes. The local service (node) reads its server and UI files from the bundle while it
/// runs, so a swapped bundle would serve the new UI and load new modules into the old service until a restart.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const INSTALL_IN_BACKGROUND: bool = false;
// ------------------------------------------------------------------------------------------------------------------

const NO_AUTO_ENV: &str = "PUBLIK_NO_AUTO_UPDATE";
const SELF_TEST_ENV: &str = "PUBLIK_UPDATE_SELF_TEST";
const SELF_TEST_OUT_ENV: &str = "PUBLIK_UPDATE_SELF_TEST_OUT";
/// Set at build time only. A running app never reads its endpoint from the environment.
const ENDPOINT_OVERRIDE: Option<&str> = option_env!("PUBLIK_UPDATE_ENDPOINT");

/// An update that is downloaded and verified.
struct Ready {
    version: String,
    update: Update,
    /// The verified package while it is not installed yet: always on Windows (the installer runs on "Restart and
    /// Install"), and on macOS unless it was swapped in place in the background (INSTALL_IN_BACKGROUND).
    /// None: installed in the background, a restart is all that is left.
    package: Option<Vec<u8>>,
}

static READY: Mutex<Option<Ready>> = Mutex::new(None);
static BUSY: AtomicBool = AtomicBool::new(false);
static ASKING: AtomicBool = AtomicBool::new(false);

type Hook = Box<dyn Fn(&AppHandle) + Send + Sync + 'static>;
/// The app's own step before the new version takes over (jobleft: stop the local service). See `on_before_restart`.
static BEFORE_RESTART: OnceLock<Hook> = OnceLock::new();

enum Found {
    UpToDate(String),
    Ready(String),
}

/// The plugins the updater needs. Call on the Builder before `.setup`.
pub fn plugins<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.plugin(tauri_plugin_updater::Builder::new().build()).plugin(tauri_plugin_dialog::init())
}

/// The app's step right before the new version takes over: on macOS after the new bundle is in place and before the
/// restart, on Windows right before the installer starts (after the package is verified and unpacked). Call it once,
/// before `start`. jobleft stops its local service here.
pub fn on_before_restart(f: impl Fn(&AppHandle) + Send + Sync + 'static) {
    let _ = BEFORE_RESTART.set(Box::new(f));
}

fn before_restart(app: &AppHandle) {
    if let Some(f) = BEFORE_RESTART.get() {
        f(app);
    }
}

/// Start the automatic checks: 10 s after launch, then once a day. Call from `setup`.
pub fn start(app: &AppHandle) {
    if std::env::var(NO_AUTO_ENV).is_ok_and(|v| !v.is_empty() && v != "0") {
        eprintln!("updates: automatic checks are off ({NO_AUTO_ENV})");
        return;
    }
    let app = app.clone();
    // jobleft: a thread with std sleeps (the shell has no direct tokio dependency); the check itself runs on the
    // async runtime.
    std::thread::spawn(move || {
        schedule(SystemTime::now, std::thread::sleep, || {
            tauri::async_runtime::block_on(check(app.clone(), false));
            true
        });
    });
}

/// True when the automatic check is due: there was none yet, a day has passed on the wall clock since the last one,
/// or the clock moved back (that gives an error here, and it counts as due).
fn due(last: Option<SystemTime>, now: SystemTime) -> bool {
    last.map_or(true, |t| now.duration_since(t).map_or(true, |e| e >= CHECK_EVERY))
}

/// The automatic checks: the first one FIRST_CHECK_AFTER after launch, then one whenever `due` says so, looked at
/// every TICK. The clock, the sleep and the check are arguments so that the unit tests below can run days of it on a
/// fake clock. In the app `run_check` always answers true and the loop never ends; false ends it (tests only).
fn schedule(now: impl Fn() -> SystemTime, sleep: impl Fn(Duration), mut run_check: impl FnMut() -> bool) {
    sleep(FIRST_CHECK_AFTER);
    let mut last: Option<SystemTime> = None;
    loop {
        if due(last, now()) {
            last = Some(now());
            if !run_check() {
                return;
            }
        }
        sleep(TICK);
    }
}

/// "Check for Updates…": the same check, with its result shown.
pub fn check_now(app: &AppHandle) {
    // An update that is already downloaded (the person chose "Later") is offered again at once.
    let ready = READY.lock().unwrap().as_ref().map(|r| r.version.clone());
    if let Some(version) = ready {
        ask_to_restart(app, &version);
        return;
    }
    tauri::async_runtime::spawn(check(app.clone(), true));
}

async fn check(app: AppHandle, manual: bool) {
    if BUSY.swap(true, Ordering::SeqCst) {
        if manual {
            tell(&app, &format!("{APP_NAME} is already checking for updates."), false);
        }
        return;
    }
    let found = fetch(&app).await;
    BUSY.store(false, Ordering::SeqCst);
    match found {
        Ok(Found::Ready(version)) => {
            eprintln!("updates: {APP_NAME} {version} is ready");
            ask_to_restart(&app, &version);
        }
        Ok(Found::UpToDate(current)) => {
            eprintln!("updates: {current} is the latest version");
            if manual {
                tell(&app, &format!("{APP_NAME} {current} is the latest version."), false);
            }
        }
        Err(e) => {
            eprintln!("updates: the check failed: {e}");
            if manual {
                tell(&app, &format!("{APP_NAME} could not check for updates.\n\n{e}"), true);
            }
        }
    }
}

/// The updater, with the build-time endpoint override applied.
fn updater(app: &AppHandle) -> Result<Updater, String> {
    let mut builder = app.updater_builder();
    if let Some(list) = ENDPOINT_OVERRIDE.map(str::trim).filter(|s| !s.is_empty()) {
        let urls = list
            .split(',')
            .map(|u| tauri::Url::parse(u.trim()).map_err(|e| format!("PUBLIK_UPDATE_ENDPOINT {u}: {e}")))
            .collect::<Result<Vec<_>, _>>()?;
        builder = builder.endpoints(urls).map_err(|e| e.to_string())?;
    }
    // Windows: the plugin runs this right before it starts the installer and exits (std::process::exit). It replaces
    // the plugin's own hook, so the plugin's cleanup is called here too. No effect on other systems.
    let handle = app.clone();
    builder = builder.on_before_exit(move || {
        before_restart(&handle);
        handle.cleanup_before_exit();
    });
    builder.build().map_err(|e| e.to_string())
}

/// Check, download and verify; on macOS also install when INSTALL_IN_BACKGROUND and this user can replace the app.
/// The one code path behind the automatic check, the menu item and the self-test.
async fn fetch(app: &AppHandle) -> Result<Found, String> {
    let Some(update) = updater(app)?.check().await.map_err(|e| e.to_string())? else {
        return Ok(Found::UpToDate(app.package_info().version.to_string()));
    };
    let version = update.version.clone();
    if READY.lock().unwrap().as_ref().is_some_and(|r| r.version == version) {
        return Ok(Found::Ready(version));
    }
    // `download` verifies the signature (and the signed version) before it returns the bytes.
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    let package = if INSTALL_IN_BACKGROUND && can_replace_in_place() {
        // Verifies again, then swaps the new bundle in place. The running app is not touched.
        update.install(&bytes).map_err(|e| e.to_string())?;
        None
    } else {
        Some(bytes)
    };
    #[cfg(not(target_os = "macos"))]
    let package = Some(bytes);
    *READY.lock().unwrap() = Some(Ready { version: version.clone(), update, package });
    Ok(Found::Ready(version))
}

/// macOS: true when this user can swap the app bundle without an admin password (write access to the bundle and to
/// its folder). Otherwise the plugin asks for one, which must not happen in a background check.
#[cfg(target_os = "macos")]
fn can_replace_in_place() -> bool {
    use std::os::raw::{c_char, c_int};
    use std::os::unix::ffi::OsStrExt;
    extern "C" {
        fn access(path: *const c_char, mode: c_int) -> c_int;
    }
    const W_OK: c_int = 2;
    let writable = |p: &std::path::Path| {
        std::ffi::CString::new(p.as_os_str().as_bytes()).is_ok_and(|c| unsafe { access(c.as_ptr(), W_OK) } == 0)
    };
    // .../jobleft.app/Contents/MacOS/<binary>
    let Ok(exe) = std::env::current_exe() else { return false };
    match exe.ancestors().nth(3) {
        Some(bundle) if bundle.extension().is_some_and(|e| e == "app") => writable(bundle) && bundle.parent().is_some_and(writable),
        _ => false,
    }
}

fn pending_install() -> bool {
    READY.lock().unwrap().as_ref().is_some_and(|r| r.package.is_some())
}

fn ask_to_restart(app: &AppHandle, version: &str) {
    if ASKING.swap(true, Ordering::SeqCst) {
        return;
    }
    let (message, yes) = if cfg!(windows) {
        (format!("{APP_NAME} {version} is ready. {APP_NAME} closes, installs it and opens again."), "Restart and Install")
    } else if pending_install() {
        #[cfg(target_os = "macos")]
        let asks_password = !can_replace_in_place();
        #[cfg(not(target_os = "macos"))]
        let asks_password = false;
        if asks_password {
            (format!("{APP_NAME} {version} is ready. {APP_NAME} installs it and restarts. macOS may ask for an administrator password."), "Install and Restart")
        } else {
            (format!("{APP_NAME} {version} is ready. {APP_NAME} installs it and restarts."), "Install and Restart")
        }
    } else {
        (format!("{APP_NAME} {version} is installed. Restart {APP_NAME} to use it."), "Restart")
    };
    let handle = app.clone();
    app.dialog()
        .message(message)
        .title(format!("{APP_NAME} update"))
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(yes.into(), "Later".into()))
        .show(move |restart| {
            ASKING.store(false, Ordering::SeqCst);
            if restart {
                if let Err(e) = restart_into_update(&handle) {
                    eprintln!("updates: {e}");
                    tell(&handle, &format!("{APP_NAME} could not install the update.\n\n{e}"), true);
                }
            }
        });
}

/// Installs a package that is not installed yet, then restarts into the new version. Call it from a thread that is
/// not the main thread (the dialog's callback is one): the restart then runs the app's exit events first.
/// Windows: the installer closes and reopens the app, so this does not return on success.
fn restart_into_update(app: &AppHandle) -> Result<(), String> {
    if pending_install() {
        install_pending(app)?;
    }
    // macOS: the new bundle is in place. The app's step (jobleft: stop the local service) runs before the restart, so
    // the new copy finds the data folder free. (Windows ran it in the updater's on_before_exit and did not get here.)
    before_restart(app);
    app.restart();
}

/// Installs the downloaded package. Windows: runs the installer on the main thread (so the tray icon is removed
/// first); the process then exits, so this returns only on an error.
fn install_pending(app: &AppHandle) -> Result<(), String> {
    let Some(Ready { update, package: Some(bytes), .. }) = READY.lock().unwrap().take() else {
        return Err("no update is ready".into());
    };
    #[cfg(windows)]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(update.install(&bytes).map_err(|e| e.to_string()));
        })
        .map_err(|e| e.to_string())?;
        rx.recv().map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        update.install(&bytes).map_err(|e| e.to_string())
    }
}

fn tell(app: &AppHandle, message: &str, error: bool) {
    app.dialog()
        .message(message)
        .title(format!("{APP_NAME} update"))
        .kind(if error { MessageDialogKind::Error } else { MessageDialogKind::Info })
        .show(|_| {});
}

/// The self-test mode, when `PUBLIK_UPDATE_SELF_TEST` is set.
pub fn self_test_mode() -> Option<String> {
    std::env::var(SELF_TEST_ENV).ok().filter(|m| !m.is_empty())
}

/// Runs the self-test instead of the app: no window and no prompt (except in `prompt` mode), one JSON report, then
/// exit.
pub fn run_self_test(app: &AppHandle, mode: String) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut report = json!({
            "self_test": mode,
            "version": app.package_info().version.to_string(),
            "pid": std::process::id(),
            "exe": std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default(),
            "endpoint_override": ENDPOINT_OVERRIDE.is_some(),
        });
        #[cfg(target_os = "macos")]
        {
            report["in_place"] = can_replace_in_place().into();
        }
        let code = match mode.as_str() {
            "version" => {
                report["result"] = "version".into();
                0
            }
            "check" => match updater(&app) {
                Err(e) => fail(&mut report, e),
                Ok(u) => match u.check().await {
                    Ok(Some(update)) => {
                        report["result"] = "available".into();
                        report["new_version"] = update.version.into();
                        0
                    }
                    Ok(None) => {
                        report["result"] = "none".into();
                        0
                    }
                    Err(e) => fail(&mut report, e.to_string()),
                },
            },
            "prompt" => match fetch(&app).await {
                Ok(Found::Ready(version)) => {
                    report["result"] = "asking".into();
                    report["new_version"] = version.clone().into();
                    report["install_waits_for_yes"] = pending_install().into();
                    emit(&report);
                    ask_to_restart(&app, &version);
                    return;
                }
                Ok(Found::UpToDate(_)) => {
                    report["result"] = "none".into();
                    0
                }
                Err(e) => fail(&mut report, e),
            },
            "restart" => match fetch(&app).await {
                Ok(Found::Ready(version)) => {
                    // The "yes" answer, as the dialog's callback gives it: on a thread of its own.
                    report["result"] = "restarting".into();
                    report["new_version"] = version.into();
                    emit(&report);
                    let handle = app.clone();
                    std::thread::spawn(move || {
                        // The new copy gets this process's environment from the restart. Without these two
                        // variables it starts as users get it, not as a second run of this test (the output file
                        // stays set, for the error line below).
                        std::env::remove_var(SELF_TEST_ENV);
                        std::env::remove_var("PUBLIK_UPDATE_SELF_TEST_SIDECAR");
                        if let Err(e) = restart_into_update(&handle) {
                            let mut r = json!({ "self_test": "restart", "pid": std::process::id() });
                            let code = fail(&mut r, e);
                            emit(&r);
                            handle.exit(code);
                        }
                    });
                    return;
                }
                Ok(Found::UpToDate(_)) => {
                    report["result"] = "none".into();
                    0
                }
                Err(e) => fail(&mut report, e),
            },
            "install" => match fetch(&app).await {
                Ok(Found::UpToDate(_)) => {
                    report["result"] = "none".into();
                    0
                }
                Ok(Found::Ready(version)) => {
                    report["new_version"] = version.into();
                    install_without_prompt(&app, &mut report)
                }
                Err(e) => fail(&mut report, e),
            },
            other => fail(&mut report, format!("unknown mode {other:?} (version, check, install, prompt, restart)")),
        };
        emit(&report);
        app.exit(code);
    });
}

/// The "yes" branch of the prompt, without the prompt and without the restart.
fn install_without_prompt(app: &AppHandle, report: &mut Value) -> i32 {
    if pending_install() {
        if cfg!(windows) {
            // Written first: on success the installer takes over and this process exits.
            report["result"] = "installing".into();
            emit(report);
        }
        if let Err(e) = install_pending(app) {
            return fail(report, e);
        }
    }
    report["result"] = "installed".into();
    0
}

fn fail(report: &mut Value, error: String) -> i32 {
    report["result"] = "error".into();
    report["error"] = error.into();
    2
}

fn emit(report: &Value) {
    let line = report.to_string();
    let _ = writeln!(std::io::stdout(), "{line}");
    if let Some(path) = std::env::var_os(SELF_TEST_OUT_ENV) {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, "{line}");
        }
    }
}

/// The daily check on a fake clock: the clock moves only when the schedule sleeps, so days run in microseconds.
#[cfg(test)]
mod schedule_tests {
    use super::{due, schedule, CHECK_EVERY, FIRST_CHECK_AFTER, TICK};
    use std::cell::{Cell, RefCell};
    use std::time::{Duration, SystemTime};

    fn start() -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000)
    }

    /// Runs the schedule until `checks` checks have run; returns when each ran (from launch) and every sleep asked.
    fn run_fake(checks: usize) -> (Vec<Duration>, Vec<Duration>) {
        let t0 = start();
        let now = Cell::new(t0);
        let sleeps = RefCell::new(Vec::new());
        let fired = RefCell::new(Vec::new());
        schedule(
            || now.get(),
            |d| {
                sleeps.borrow_mut().push(d);
                now.set(now.get() + d);
            },
            || {
                fired.borrow_mut().push(now.get().duration_since(t0).unwrap());
                fired.borrow().len() < checks
            },
        );
        (fired.into_inner(), sleeps.into_inner())
    }

    #[test]
    fn the_first_check_runs_10_seconds_after_launch() {
        let (fired, sleeps) = run_fake(1);
        assert_eq!(FIRST_CHECK_AFTER, Duration::from_secs(10));
        assert_eq!(fired, vec![FIRST_CHECK_AFTER]);
        assert_eq!(sleeps, vec![FIRST_CHECK_AFTER]);
    }

    #[test]
    fn then_one_check_a_day_and_none_in_between() {
        assert_eq!(CHECK_EVERY, Duration::from_secs(24 * 60 * 60));
        let (fired, sleeps) = run_fake(4);
        assert_eq!(fired.len(), 4);
        // The loop looks every TICK; a check is due at the first look a full day after the last one.
        let ticks_per_day = (CHECK_EVERY.as_secs() + TICK.as_secs() - 1) / TICK.as_secs();
        let step = TICK * ticks_per_day as u32;
        assert!(step >= CHECK_EVERY && step < CHECK_EVERY + TICK);
        for (i, at) in fired.iter().enumerate() {
            assert_eq!(*at, FIRST_CHECK_AFTER + step * i as u32, "check {i}");
        }
        // Between two checks the thread only sleeps TICK at a time: one look per TICK, no busy loop.
        assert!(sleeps[1..].iter().all(|d| *d == TICK));
        assert_eq!(sleeps.len(), 1 + 3 * ticks_per_day as usize);
    }

    #[test]
    fn the_day_is_counted_on_the_wall_clock() {
        let t = start();
        assert!(due(None, t), "the first check is due at once");
        assert!(!due(Some(t), t + CHECK_EVERY - Duration::from_secs(1)), "not due a second before the day is over");
        assert!(due(Some(t), t + CHECK_EVERY), "due when the day is over");
        // A Mac that slept through the day: due at the first look after it wakes.
        assert!(due(Some(t), t + CHECK_EVERY * 3));
        // A clock that moved back counts as due.
        assert!(due(Some(t), t - Duration::from_secs(60)));
    }

    #[test]
    fn a_wall_clock_jump_brings_the_next_check_to_the_next_look() {
        // The clock jumps a day ahead during the first sleep after the first check (the Mac slept): the next look
        // runs the check, it does not wait for 48 more ticks.
        let t0 = start();
        let now = Cell::new(t0);
        let jumped = Cell::new(false);
        let fired = RefCell::new(Vec::new());
        schedule(
            || now.get(),
            |d| {
                let extra = if d == TICK && !jumped.get() {
                    jumped.set(true);
                    CHECK_EVERY
                } else {
                    Duration::ZERO
                };
                now.set(now.get() + d + extra);
            },
            || {
                fired.borrow_mut().push(now.get().duration_since(t0).unwrap());
                fired.borrow().len() < 2
            },
        );
        assert_eq!(fired.into_inner(), vec![FIRST_CHECK_AFTER, FIRST_CHECK_AFTER + TICK + CHECK_EVERY]);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    /// The shipped config: the real feed over https, the key, the strict checks. Test builds change these with
    /// `--config` and PUBLIK_UPDATE_ENDPOINT, never in tauri.conf.json.
    #[test]
    fn the_shipped_config_points_at_the_publik_feed_with_strict_checks() {
        let conf: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let updater = &conf["plugins"]["updater"];
        let endpoints = updater["endpoints"].as_array().unwrap();
        assert_eq!(endpoints.len(), 1);
        assert_eq!(endpoints[0], "https://publikhq.com/api/updates/jobleft/latest.json");
        assert_eq!(updater["requireSignedVersion"], true);
        assert_eq!(updater["windows"]["installMode"], "passive");
        assert!(updater.get("dangerousInsecureTransportProtocol").is_none());
        assert!(updater.get("allowDowngrades").is_none());
        assert_eq!(conf["bundle"]["createUpdaterArtifacts"], true);
        // base64 of "untrusted comment: minisign public key:", as `tauri signer generate` writes it.
        assert!(updater["pubkey"].as_str().unwrap().starts_with("dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6"));
    }
}
