use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_store::StoreExt;
use uuid::Uuid;

const SETTINGS_STORE: &str = "nova-settings.json";
const SETTINGS_KEY: &str = "settings";
/// Where the window was last working, kept apart from settings on purpose: settings are the
/// user's configuration and are worth backing up or copying between machines, while this is
/// per-machine state about paths that may not exist anywhere else.
const WORKSPACE_KEY: &str = "workspace";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NovaSettings {
    pub provider: String,
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub e2b_api_key: Option<String>,
    #[serde(default)]
    pub relay_secret: Option<String>,
    #[serde(default)]
    pub budget: Option<f64>,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub fx_rwf_per_usd: Option<f64>,
    #[serde(default)]
    pub model_input_per_million: Option<f64>,
    #[serde(default)]
    pub model_output_per_million: Option<f64>,
}

struct PendingRequest {
    tx: std::sync::mpsc::Sender<Result<Value, String>>,
}

#[derive(Default)]
struct SidecarState {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    pending: HashMap<String, PendingRequest>,
}

pub struct AppState {
    sidecar: Mutex<SidecarState>,
}

fn app_root() -> PathBuf {
    let mut dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    dir.pop(); // apps/nova-desktop
    dir
}

/// The sidecar Tauri bundles, named as it lands on disk. `.exe` on Windows, bare elsewhere.
fn sidecar_file_name() -> String {
    format!("nova-sidecar{}", std::env::consts::EXE_SUFFIX)
}

/// Locates the compiled sidecar executable.
///
/// There is exactly one artifact now, in development and in an installed app alike. It used to
/// fall back to `node sidecar/dist/index.js` — a path inside the *development tree* — which had
/// three consequences: an installed app pointed at a directory that does not exist on the user's
/// machine, the end user needed Node, and, worst of all, running `tauri dev` locally never
/// exercised the binary a release actually ships. The packaging path could only break silently.
///
/// The candidates are ordered by how a real installation looks first, so the dev tree is consulted
/// only when neither bundle layout is present.
fn sidecar_script_path(app: &AppHandle) -> Result<PathBuf, String> {
    let name = sidecar_file_name();

    // Installed: Tauri places an external binary beside the app executable. The portable folder
    // (release/windows ships Nova.exe + binaries/nova-sidecar.exe together) puts it one level down,
    // so both are checked before anything else.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for dir in [dir.to_path_buf(), dir.join("binaries")] {
                let candidate = dir.join(&name);
                if candidate.exists() {
                    return Ok(candidate);
                }
            }
        }
    }

    // Some bundle layouts stage resources separately. NSIS installs put the external binary at the
    // resource-dir *root* rather than under `binaries/`, which is what left v0.1.0 unable to find
    // its own sidecar at startup — so both are checked.
    if let Ok(resource) = app.path().resource_dir() {
        for dir in [resource.clone(), resource.join("binaries")] {
            let candidate = dir.join(&name);
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }

    // Development: the triple-named artifact `npm run sidecar:binary` produces. The triple comes
    // from Tauri's own build script, so it cannot drift from the name the bundler will look for.
    let dev = app_root().join("src-tauri").join("binaries").join(format!(
        "nova-sidecar-{}{}",
        env!("TAURI_ENV_TARGET_TRIPLE"),
        std::env::consts::EXE_SUFFIX
    ));
    if dev.exists() {
        return Ok(dev);
    }

    Err(format!(
        "Nova sidecar not found (looked for {} beside the app and {} in the source tree). \
     From apps/nova-desktop run: npm run sidecar:binary",
        name,
        dev.display()
    ))
}

fn spawn_sidecar_process(script: &PathBuf) -> Result<(Child, ChildStdin), String> {
    // One shape of invocation, because there is one kind of artifact: a self-contained executable.
    let mut command = Command::new(script);

    // Keep PATH useful for finding `node` when launched from a desktop session.
    if let Ok(path) = std::env::var("PATH") {
        command.env("PATH", path);
    }

    let child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        // Spawn the sidecar without a console window (CREATE_NO_WINDOW).
        let _ = child.creation_flags(0x08000000);
    }
    let mut child = child
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {e}"))?;

    let stdin = child.stdin.take().ok_or("Sidecar stdin unavailable")?;
    Ok((child, stdin))
}

fn pump_stdout(app: AppHandle, state: Arc<AppState>, stdout: impl std::io::Read + Send + 'static) {
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let channel = value.get("channel").and_then(|v| v.as_str()).unwrap_or("");
            if channel == "event" {
                let mut event = value.clone();
                if let Some(obj) = event.as_object_mut() {
                    obj.remove("channel");
                }
                let _ = app.emit("sidecar-event", event);
                continue;
            }
            if channel == "response" {
                let id = value
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let ok = value.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
                let result = if ok {
                    Ok(value.get("result").cloned().unwrap_or(Value::Null))
                } else {
                    Err(value
                        .get("error")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Sidecar request failed")
                        .to_string())
                };
                let mut guard = state.sidecar.lock().expect("sidecar lock");
                if let Some(pending) = guard.pending.remove(&id) {
                    let _ = pending.tx.send(result);
                }
            }
        }

        // Falling out of that loop means stdout closed, which means the sidecar process is gone —
        // crashed, killed, or exited. Every request still waiting on a reply would otherwise sit on
        // its ten-minute timeout with the window looking simply frozen, so they are failed here with
        // something the UI can actually say out loud. Clearing `child`/`stdin` is what lets the next
        // `sidecar_start` spawn a replacement rather than believing one is still running.
        {
            let mut guard = state.sidecar.lock().expect("sidecar lock");
            guard.child = None;
            guard.stdin = None;
            for (_, pending) in guard.pending.drain() {
                let _ = pending.tx.send(Err(SIDECAR_STOPPED.to_string()));
            }
        }
        let _ = app.emit("sidecar-exited", ());
    });
}

/// Shown when the engine process dies. Phrased for the person reading it, not for a log.
const SIDECAR_STOPPED: &str = "Nova's engine stopped unexpectedly. Your saved sessions are safe; restart the engine, then resume the one you need.";

fn pump_stderr(stderr: impl std::io::Read + Send + 'static) {
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            eprintln!("[nova-sidecar] {line}");
        }
    });
}

#[tauri::command]
fn sidecar_start(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    {
        let mut guard = state.sidecar.lock().map_err(|e| e.to_string())?;
        if let Some(child) = guard.child.as_mut() {
            match child.try_wait() {
                Ok(None) => return Ok(()), // still running
                Ok(Some(_)) | Err(_) => {
                    guard.child = None;
                    guard.stdin = None;
                    guard.pending.clear();
                }
            }
        }
    }

    let script = sidecar_script_path(&app)?;
    let (mut child, stdin) = spawn_sidecar_process(&script)?;
    let stdout = child.stdout.take().ok_or("Sidecar stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("Sidecar stderr unavailable")?;

    {
        let mut guard = state.sidecar.lock().map_err(|e| e.to_string())?;
        guard.child = Some(child);
        guard.stdin = Some(stdin);
    }

    pump_stdout(app.clone(), state.inner().clone(), stdout);
    pump_stderr(stderr);
    thread::sleep(Duration::from_millis(50));
    Ok(())
}

#[tauri::command]
async fn sidecar_request(state: State<'_, Arc<AppState>>, request: Value) -> Result<Value, String> {
    let id = request
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let mut payload = request;
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("id".into(), json!(id));
    }

    let (tx, rx) = std::sync::mpsc::channel();
    {
        let mut guard = state.sidecar.lock().map_err(|e| e.to_string())?;
        let stdin = guard
            .stdin
            .as_mut()
            .ok_or("Sidecar is not running. Call sidecar_start first.")?;
        writeln!(stdin, "{}", payload).map_err(|e| format!("Failed writing to sidecar: {e}"))?;
        stdin
            .flush()
            .map_err(|e| format!("Failed flushing sidecar stdin: {e}"))?;
        guard.pending.insert(id.clone(), PendingRequest { tx });
    }

    // Wait off the async runtime so the UI thread stays responsive.
    let result = tokio::task::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(600)))
        .await
        .map_err(|e| format!("Sidecar wait failed: {e}"))?;

    match result {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(err)) => Err(err),
        Err(_) => {
            let mut guard = state.sidecar.lock().map_err(|e| e.to_string())?;
            guard.pending.remove(&id);
            Err("Sidecar request timed out".into())
        }
    }
}

/// The desktop's own memory of where it was: the project last opened, the mode it was in, and the
/// projects before that. Without it every launch started blank — no project, no session list, and
/// no route back to a past conversation except re-finding the folder by hand.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceState {
    #[serde(default)]
    pub last_root: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub sandbox: Option<bool>,
    /// Most recent first. Bounded by the caller so this file cannot grow without limit.
    #[serde(default)]
    pub recent_roots: Vec<String>,
}

#[tauri::command]
fn load_workspace(app: AppHandle) -> Result<Option<WorkspaceState>, String> {
    let store = app.store(SETTINGS_STORE).map_err(|e| e.to_string())?;
    let Some(value) = store.get(WORKSPACE_KEY) else {
        return Ok(None);
    };
    // A malformed or outdated blob reads as "no memory" rather than as a failure: this is a
    // convenience, and refusing to start the app over it would be a poor trade.
    Ok(serde_json::from_value(value).ok())
}

#[tauri::command]
fn save_workspace(app: AppHandle, workspace: WorkspaceState) -> Result<(), String> {
    let store = app.store(SETTINGS_STORE).map_err(|e| e.to_string())?;
    store.set(
        WORKSPACE_KEY,
        serde_json::to_value(workspace).map_err(|e| e.to_string())?,
    );
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn load_settings(app: AppHandle) -> Result<Option<NovaSettings>, String> {
    let store = app.store(SETTINGS_STORE).map_err(|e| e.to_string())?;
    let Some(value) = store.get(SETTINGS_KEY) else {
        return Ok(None);
    };
    serde_json::from_value(value)
        .map(Some)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: NovaSettings) -> Result<(), String> {
    let store = app.store(SETTINGS_STORE).map_err(|e| e.to_string())?;
    store.set(
        SETTINGS_KEY,
        serde_json::to_value(settings).map_err(|e| e.to_string())?,
    );
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = Arc::new(AppState {
        sidecar: Mutex::new(SidecarState::default()),
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            sidecar_start,
            sidecar_request,
            load_settings,
            save_settings,
            load_workspace,
            save_workspace
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nova");
}
