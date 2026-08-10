use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_store::StoreExt;
use uuid::Uuid;

const SETTINGS_STORE: &str = "nova-settings.json";
const SETTINGS_KEY: &str = "settings";

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

struct SidecarState {
  child: Option<Child>,
  stdin: Option<ChildStdin>,
  pending: HashMap<String, PendingRequest>,
}

impl Default for SidecarState {
  fn default() -> Self {
    Self { child: None, stdin: None, pending: HashMap::new() }
  }
}

pub struct AppState {
  sidecar: Mutex<SidecarState>,
}

fn app_root() -> PathBuf {
  let mut dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
  dir.pop();
  dir
}

fn sidecar_script_path(app: &AppHandle) -> Result<PathBuf, String> {
  let mut candidates: Vec<PathBuf> = Vec::new();

  if let Ok(resource) = app.path().resource_dir() {
    candidates.push(resource.join("binaries").join("nova-sidecar"));
    candidates.push(resource.join("binaries").join("nova-sidecar.exe"));
    candidates.push(resource.join("nova-sidecar.exe"));
    candidates.push(resource.join("nova-sidecar"));
  }

  if let Ok(exe) = std::env::current_exe() {
    if let Some(dir) = exe.parent() {
      candidates.push(dir.join("binaries").join("nova-sidecar.exe"));
      candidates.push(dir.join("binaries").join("nova-sidecar"));
      candidates.push(dir.join("nova-sidecar.exe"));
      candidates.push(dir.join("nova-sidecar"));
    }
  }

  for path in &candidates {
    if path.exists() {
      return Ok(path.clone());
    }
  }

  let dir = app_root();
  let js = dir.join("sidecar").join("dist").join("index.js");
  if js.exists() {
    return Ok(js);
  }
  let ts = dir.join("sidecar").join("src").join("index.ts");
  if ts.exists() {
    return Ok(ts);
  }
  Err("Nova sidecar not found. Place nova-sidecar.exe next to Nova.exe (or under binaries/).".into())
}

fn spawn_sidecar_process(script: &PathBuf) -> Result<(Child, ChildStdin), String> {
  let name = script.file_name().and_then(|s| s.to_str()).unwrap_or("");
  let mut command = if name.starts_with("nova-sidecar") {
    Command::new(script)
  } else if script.extension().and_then(|s| s.to_str()) == Some("ts") {
    let local_tsx = app_root().join("node_modules").join(".bin").join(if cfg!(windows) { "tsx.cmd" } else { "tsx" });
    let mut cmd = if local_tsx.exists() { Command::new(local_tsx) } else { Command::new("tsx") };
    cmd.arg(script);
    cmd
  } else {
    let mut cmd = Command::new("node");
    cmd.arg(script);
    cmd
  };

  if let Ok(path) = std::env::var("PATH") {
    command.env("PATH", path);
  }

  let mut child = command
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
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
      let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
      let channel = value.get("channel").and_then(|v| v.as_str()).unwrap_or("");
      if channel == "event" {
        let mut event = value.clone();
        if let Some(obj) = event.as_object_mut() {
          obj.remove("channel");
        }
        let _ = app.emit("sidecar-event", event);
      } else if channel == "response" {
        let id = value.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let ok = value.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
        let result = if ok {
          Ok(value.get("result").cloned().unwrap_or(Value::Null))
        } else {
          Err(value.get("error").and_then(|v| v.as_str()).unwrap_or("Sidecar request failed").to_string())
        };
        let mut guard = state.sidecar.lock().expect("sidecar lock");
        if let Some(pending) = guard.pending.remove(&id) {
          let _ = pending.tx.send(result);
        }
      }
    }
  });
}

fn pump_stderr(stderr: impl std::io::Read + Send + 'static) {
  thread::spawn(move || {
    let reader = BufReader::new(stderr);
    for line in reader.lines().flatten() {
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
        Ok(None) => return Ok(()),
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
  pump_stdout(app, state.inner().clone(), stdout);
  pump_stderr(stderr);
  thread::sleep(Duration::from_millis(50));
  Ok(())
}

#[tauri::command]
async fn sidecar_request(state: State<'_, Arc<AppState>>, request: Value) -> Result<Value, String> {
  let id = request.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()).unwrap_or_else(|| Uuid::new_v4().to_string());
  let mut payload = request;
  if let Some(obj) = payload.as_object_mut() {
    obj.insert("id".into(), json!(id));
  }

  let (tx, rx) = std::sync::mpsc::channel();
  {
    let mut guard = state.sidecar.lock().map_err(|e| e.to_string())?;
    let stdin = guard.stdin.as_mut().ok_or("Sidecar is not running. Call sidecar_start first.")?;
    writeln!(stdin, "{}", payload).map_err(|e| format!("Failed writing to sidecar: {e}"))?;
    stdin.flush().map_err(|e| format!("Failed flushing sidecar stdin: {e}"))?;
    guard.pending.insert(id.clone(), PendingRequest { tx });
  }

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

#[tauri::command]
fn load_settings(app: AppHandle) -> Result<Option<NovaSettings>, String> {
  let store = app.store(SETTINGS_STORE).map_err(|e| e.to_string())?;
  let Some(value) = store.get(SETTINGS_KEY) else { return Ok(None) };
  serde_json::from_value(value).map(Some).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: NovaSettings) -> Result<(), String> {
  let store = app.store(SETTINGS_STORE).map_err(|e| e.to_string())?;
  store.set(SETTINGS_KEY, serde_json::to_value(settings).map_err(|e| e.to_string())?);
  store.save().map_err(|e| e.to_string())?;
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let state = Arc::new(AppState { sidecar: Mutex::new(SidecarState::default()) });
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_store::Builder::default().build())
    .manage(state)
    .invoke_handler(tauri::generate_handler![sidecar_start, sidecar_request, load_settings, save_settings])
    .run(tauri::generate_context!())
    .expect("error while running Nova");
}
