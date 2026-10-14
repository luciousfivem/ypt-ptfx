//! VFXForge desktop shell.
//!
//! This crate is deliberately thin: every command validates its arguments, hands the work to
//! `vfxforge-native` (which has no GUI dependency and its own tests) on a blocking worker thread,
//! and returns either JSON or a `VFXW` container (see `vfxforge_native::wire`) for binary data.
//! The webview never receives a path it did not ask for and never supplies a command line.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, InvokeBody, Request, Response};
use tauri::{Manager, State};
use vfxforge_native::bridge::{bridge_status, BridgeConfig, BridgeStatus};
use vfxforge_native::extract::{extract_frames, ExtractRequest, Interpolation, Progress};
use vfxforge_native::fsx::{atomic_write, import_asset as store_asset};
use vfxforge_native::jobs::CancelToken;
use vfxforge_native::probe::{probe, MediaInfo};
use vfxforge_native::project::{clear_autosaves, load_project as load_project_dir, save_project as save_project_dir, write_autosave, LoadedProject};
use vfxforge_native::service::{self, ConvertArgs, FoundAutosave, ProjectSummary};
use vfxforge_native::sniff::Category;
use vfxforge_native::tools::ffmpeg_version;
use vfxforge_native::wire;
use vfxforge_native::{Error, MediaTools, Result};

/* ------------------------------------------------------------------- state */

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolPaths {
    pub ffmpeg: Option<PathBuf>,
    pub ffprobe: Option<PathBuf>,
    pub dotnet: Option<PathBuf>,
    pub dll: Option<PathBuf>,
}

struct Inner {
    projects_root: PathBuf,
    scratch: PathBuf,
    config_file: PathBuf,
    sidecar_dirs: Vec<PathBuf>,
    tools: Mutex<ToolPaths>,
    jobs: Mutex<HashMap<String, CancelToken>>,
}

#[derive(Clone)]
struct AppState(Arc<Inner>);

impl Inner {
    fn media_tools(&self) -> Result<MediaTools> {
        let p = self.tools.lock().expect("tools poisoned").clone();
        MediaTools::discover(p.ffmpeg.as_deref(), p.ffprobe.as_deref(), &self.sidecar_dirs)
    }

    fn bridge_cfg(&self) -> BridgeConfig {
        let p = self.tools.lock().expect("tools poisoned").clone();
        BridgeConfig { dotnet: p.dotnet, dll: p.dll }
    }

    fn register_job(&self, id: &str) -> Result<CancelToken> {
        if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b':')) {
            return Err(Error::InvalidParam("invalid job id".into()));
        }
        let t = CancelToken::new();
        self.jobs.lock().expect("jobs poisoned").insert(id.to_string(), t.clone());
        Ok(t)
    }

    fn finish_job(&self, id: &str) {
        self.jobs.lock().expect("jobs poisoned").remove(id);
    }

    fn save_tool_paths(&self) -> Result<()> {
        let p = self.tools.lock().expect("tools poisoned").clone();
        let json = serde_json::to_vec_pretty(&p).map_err(|e| Error::Data(e.to_string()))?;
        atomic_write(&self.config_file, &json)
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| Error::Data(format!("background task failed: {e}")))?
}

/* ------------------------------------------------------------------- tools */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolEntry {
    available: bool,
    path: Option<PathBuf>,
    version: Option<String>,
    detail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolStatus {
    ffmpeg: ToolEntry,
    ffprobe: ToolEntry,
    bridge: BridgeStatus,
    paths: ToolPaths,
}

fn tool_status_of(inner: &Inner) -> ToolStatus {
    let (ffmpeg, ffprobe) = match inner.media_tools() {
        Ok(t) => {
            let version = ffmpeg_version(&t.ffmpeg).ok().map(|v| v.raw);
            (
                ToolEntry { available: true, path: Some(t.ffmpeg), version, detail: "ready".into() },
                ToolEntry { available: true, path: Some(t.ffprobe), version: None, detail: "ready".into() },
            )
        }
        Err(e) => {
            let missing = |n: &str| ToolEntry { available: false, path: None, version: None, detail: format!("{n}: {e}") };
            (missing("ffmpeg"), missing("ffprobe"))
        }
    };
    ToolStatus { ffmpeg, ffprobe, bridge: bridge_status(&inner.bridge_cfg()), paths: inner.tools.lock().expect("tools poisoned").clone() }
}

#[tauri::command]
async fn tool_status(state: State<'_, AppState>) -> Result<ToolStatus> {
    let inner = state.0.clone();
    blocking(move || Ok(tool_status_of(&inner))).await
}

#[tauri::command]
async fn set_tool_paths(state: State<'_, AppState>, paths: ToolPaths) -> Result<ToolStatus> {
    let inner = state.0.clone();
    blocking(move || {
        for p in [&paths.ffmpeg, &paths.ffprobe, &paths.dotnet, &paths.dll].into_iter().flatten() {
            vfxforge_native::sanitize::reject_traversal(p)?;
            if !p.is_absolute() {
                return Err(Error::UnsafePath(format!("{} (tool paths must be absolute)", p.display())));
            }
        }
        *inner.tools.lock().expect("tools poisoned") = paths;
        inner.save_tool_paths()?;
        Ok(tool_status_of(&inner))
    })
    .await
}

/* ------------------------------------------------------------------ assets */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportResult {
    rel_path: String,
    sha256: String,
    bytes: u64,
    kind: vfxforge_native::sniff::MediaKind,
    category: Category,
    mime: &'static str,
    deduplicated: bool,
    /// Probed with ffprobe for video and images; `None` for models (and images when ffprobe is absent).
    info: Option<MediaInfo>,
}

#[tauri::command]
async fn import_asset(state: State<'_, AppState>, project_id: String, source: String) -> Result<ImportResult> {
    let inner = state.0.clone();
    blocking(move || {
        let dir = service::project_dir(&inner.projects_root, &project_id)?;
        let src = PathBuf::from(&source);
        // a video cannot be imported without ffprobe: say so before copying anything
        let (_, sniffed, _) = vfxforge_native::probe::identify(&src)?;
        let tools = inner.media_tools();
        if sniffed.kind.category() == Category::Video {
            tools.as_ref().map_err(|e| Error::ToolMissing { tool: "ffprobe".into(), hint: e.to_string() })?;
        }
        let stored = store_asset(&dir, &src)?;
        let info = match (&tools, stored.category) {
            (Ok(t), Category::Video | Category::Image) => probe(&t.ffprobe, &dir.join(&stored.rel_path)).ok(),
            _ => None,
        };
        Ok(ImportResult { rel_path: stored.rel_path, sha256: stored.sha256, bytes: stored.bytes, kind: stored.kind, category: stored.category, mime: stored.mime, deduplicated: stored.deduplicated, info })
    })
    .await
}

#[tauri::command]
async fn read_asset(state: State<'_, AppState>, project_id: String, rel_path: String) -> Result<Response> {
    let inner = state.0.clone();
    let bytes = blocking(move || service::read_asset(&service::project_dir(&inner.projects_root, &project_id)?, &rel_path)).await?;
    Ok(Response::new(bytes))
}

/// Bundle import: the body is a wire message `{ projectId, relPath }` + the asset bytes.
#[tauri::command]
async fn import_bundle_asset(state: State<'_, AppState>, request: Request<'_>) -> Result<()> {
    let InvokeBody::Raw(body) = request.body() else { return Err(Error::InvalidParam("expected a binary message".into())) };
    let body = body.clone();
    let inner = state.0.clone();
    blocking(move || {
        let (json, blobs) = wire::unpack(&body)?;
        let id = json.get("projectId").and_then(|v| v.as_str()).ok_or_else(|| Error::InvalidParam("projectId missing".into()))?;
        let rel = json.get("relPath").and_then(|v| v.as_str()).ok_or_else(|| Error::InvalidParam("relPath missing".into()))?;
        let bytes = blobs.first().ok_or_else(|| Error::InvalidParam("asset bytes missing".into()))?;
        service::write_bundle_asset(&service::project_dir(&inner.projects_root, id)?, rel, bytes)
    })
    .await
}

/* -------------------------------------------------------------- extraction */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtractArgs {
    asset_rel_path: String,
    start_sec: f64,
    end_sec: Option<f64>,
    fps: f64,
    frame_skip: u32,
    max_frames: u32,
    width: Option<u32>,
    height: Option<u32>,
    keep_aspect: bool,
    interpolation: Interpolation,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    done: u64,
    expected: Option<u64>,
}

/// Extracts frames with FFmpeg and returns `{ width, height, count }` + one PNG blob per frame.
#[tauri::command]
async fn extract_frames_cmd(state: State<'_, AppState>, job_id: String, project_id: String, args: ExtractArgs, on_progress: Channel<ProgressEvent>) -> Result<Response> {
    let inner = state.0.clone();
    let token = inner.register_job(&job_id)?;
    let inner2 = inner.clone();
    let result = blocking(move || {
        let dir = service::project_dir(&inner2.projects_root, &project_id)?;
        if !args.asset_rel_path.starts_with("assets/") {
            return Err(Error::UnsafePath(args.asset_rel_path.clone()));
        }
        let input = vfxforge_native::sanitize::resolve_within(&dir, &args.asset_rel_path)?;
        let tools = inner2.media_tools()?;
        let out_dir = inner2.scratch.join(format!("frames-{}-{}", std::process::id(), nanos()));
        let req = ExtractRequest {
            input,
            out_dir: out_dir.clone(),
            start_sec: args.start_sec,
            end_sec: args.end_sec,
            fps: args.fps,
            frame_skip: args.frame_skip,
            max_frames: args.max_frames,
            width: args.width,
            height: args.height,
            keep_aspect: args.keep_aspect,
            interpolation: args.interpolation,
        };
        let cb: Arc<dyn Fn(Progress) + Send + Sync> = Arc::new(move |p: Progress| {
            let _ = on_progress.send(ProgressEvent { done: p.frames_done, expected: p.frames_expected });
        });
        let outcome = extract_frames(&tools.ffmpeg, &tools.ffprobe, &req, &token, Some(cb)).and_then(|r| {
            let mut pngs = Vec::with_capacity(r.frames.len());
            for f in &r.frames {
                pngs.push(std::fs::read(f).map_err(|e| Error::io("reading an extracted frame", e))?);
            }
            let refs: Vec<&[u8]> = pngs.iter().map(Vec::as_slice).collect();
            wire::pack(&serde_json::json!({ "width": r.width, "height": r.height, "count": pngs.len(), "fps": r.fps }), &refs)
        });
        let _ = std::fs::remove_dir_all(&out_dir);
        outcome
    })
    .await;
    inner.finish_job(&job_id);
    Ok(Response::new(result?))
}

#[tauri::command]
fn cancel_job(state: State<'_, AppState>, job_id: String) -> bool {
    state.0.jobs.lock().expect("jobs poisoned").get(&job_id).map(|t| t.cancel()).is_some()
}

fn nanos() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
}

/* --------------------------------------------------------------- converter */

/// Request: wire message `{ xml, gen9, assetName, files: [name...] }` + one blob per file.
/// Reply: wire message `{ roundTripOk, mismatches, resourceVersion, codewalkerCore }` + the `.ypt`.
/// (Conversions take a second or two; they are not cancellable from the UI.)
#[tauri::command]
async fn convert_ypt(state: State<'_, AppState>, request: Request<'_>) -> Result<Response> {
    let InvokeBody::Raw(body) = request.body() else { return Err(Error::InvalidParam("expected a binary message".into())) };
    let body = body.clone();
    let inner = state.0.clone();
    let out = blocking(move || {
        let (json, blobs) = wire::unpack(&body)?;
        let names: Vec<String> = json
            .get("files")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|n| n.as_str().map(str::to_string)).collect())
            .ok_or_else(|| Error::InvalidParam("files missing".into()))?;
        if names.len() != blobs.len() {
            return Err(Error::InvalidParam("every texture needs its bytes".into()));
        }
        let args = ConvertArgs {
            xml: json.get("xml").and_then(|v| v.as_str()).ok_or_else(|| Error::InvalidParam("xml missing".into()))?.to_string(),
            gen9: json.get("gen9").and_then(|v| v.as_bool()).unwrap_or(false),
            asset_name: json.get("assetName").and_then(|v| v.as_str()).ok_or_else(|| Error::InvalidParam("assetName missing".into()))?.to_string(),
            files: names.into_iter().zip(blobs.into_iter().map(<[u8]>::to_vec)).collect(),
        };
        let (meta, ypt) = service::convert_ypt(&inner.bridge_cfg(), &inner.scratch, &args, &CancelToken::new())?;
        wire::pack(&serde_json::to_value(&meta).map_err(|e| Error::Data(e.to_string()))?, &[&ypt])
    })
    .await?;
    Ok(Response::new(out))
}

/* ---------------------------------------------------------------- projects */

#[tauri::command]
async fn list_projects(state: State<'_, AppState>) -> Result<Vec<ProjectSummary>> {
    let inner = state.0.clone();
    blocking(move || Ok(service::list_projects(&inner.projects_root))).await
}

#[tauri::command]
async fn save_project(state: State<'_, AppState>, project_id: String, json: String) -> Result<()> {
    let inner = state.0.clone();
    blocking(move || save_project_dir(&service::project_dir(&inner.projects_root, &project_id)?, &json)).await
}

#[tauri::command]
async fn load_project(state: State<'_, AppState>, project_id: String) -> Result<LoadedProject> {
    let inner = state.0.clone();
    blocking(move || load_project_dir(&service::project_dir(&inner.projects_root, &project_id)?)).await
}

#[tauri::command]
async fn delete_project(state: State<'_, AppState>, project_id: String) -> Result<()> {
    let inner = state.0.clone();
    blocking(move || service::delete_project(&inner.projects_root, &project_id)).await
}

#[tauri::command]
async fn autosave_project(state: State<'_, AppState>, project_id: String, json: String) -> Result<()> {
    let inner = state.0.clone();
    blocking(move || write_autosave(&service::project_dir(&inner.projects_root, &project_id)?, &json, 5).map(|_| ())).await
}

#[tauri::command]
async fn clear_autosave(state: State<'_, AppState>, project_id: String) -> Result<()> {
    let inner = state.0.clone();
    blocking(move || {
        clear_autosaves(&service::project_dir(&inner.projects_root, &project_id)?);
        Ok(())
    })
    .await
}

#[tauri::command]
async fn latest_autosave(state: State<'_, AppState>) -> Result<Option<FoundAutosave>> {
    let inner = state.0.clone();
    blocking(move || Ok(service::latest_autosave(&inner.projects_root))).await
}

/// The newest autosave of one project if it is newer than the saved document.
#[tauri::command]
async fn recovery_for(state: State<'_, AppState>, project_id: String) -> Result<Option<String>> {
    let inner = state.0.clone();
    blocking(move || {
        let dir = service::project_dir(&inner.projects_root, &project_id)?;
        Ok(vfxforge_native::project::recovery_candidate(&dir).and_then(|c| vfxforge_native::project::read_autosave(&dir, &c.path).ok()))
    })
    .await
}

/* --------------------------------------------------------------- user files */

/// Writes a file the user chose in a save dialog. Wire message `{ path }` + the bytes.
#[tauri::command]
async fn write_user_file(request: Request<'_>) -> Result<()> {
    let InvokeBody::Raw(body) = request.body() else { return Err(Error::InvalidParam("expected a binary message".into())) };
    let body = body.clone();
    blocking(move || {
        let (json, blobs) = wire::unpack(&body)?;
        let path = PathBuf::from(json.get("path").and_then(|v| v.as_str()).ok_or_else(|| Error::InvalidParam("path missing".into()))?);
        vfxforge_native::sanitize::reject_traversal(&path)?;
        if !path.is_absolute() || path.file_name().is_none() {
            return Err(Error::UnsafePath(format!("{} (expected an absolute file path)", path.display())));
        }
        match path.parent() {
            Some(p) if p.is_dir() => {}
            _ => return Err(Error::NotFound("the destination folder".into())),
        }
        atomic_write(&path, blobs.first().copied().unwrap_or(&[]))
    })
    .await
}

/* -------------------------------------------------------------------- run */

fn init_state(app: &tauri::App) -> std::result::Result<AppState, Box<dyn std::error::Error>> {
    let data = app.path().app_data_dir()?;
    let config = app.path().app_config_dir()?;
    std::fs::create_dir_all(&data)?;
    std::fs::create_dir_all(&config)?;
    let projects_root = data.join("projects");
    let scratch = data.join("scratch");
    std::fs::create_dir_all(&projects_root)?;
    // scratch holds only temporary frames/conversions; clear what a crashed session left behind
    let _ = std::fs::remove_dir_all(&scratch);
    std::fs::create_dir_all(&scratch)?;
    let config_file = config.join("tools.json");
    let tools: ToolPaths = std::fs::read(&config_file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let mut sidecar_dirs: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            sidecar_dirs.push(dir.to_path_buf());
            sidecar_dirs.push(dir.join("bin"));
        }
    }
    if let Ok(res) = app.path().resource_dir() {
        sidecar_dirs.push(res.join("bin"));
    }
    Ok(AppState(Arc::new(Inner { projects_root, scratch, config_file, sidecar_dirs, tools: Mutex::new(tools), jobs: Mutex::new(HashMap::new()) })))
}

/// Registers every command. Shared by `run()` and the IPC tests so both exercise the same table.
fn with_commands<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.invoke_handler(tauri::generate_handler![
            tool_status,
            set_tool_paths,
            import_asset,
            read_asset,
            import_bundle_asset,
            extract_frames_cmd,
            cancel_job,
            convert_ypt,
            list_projects,
            save_project,
            load_project,
            delete_project,
            autosave_project,
            clear_autosave,
            latest_autosave,
            recovery_for,
            write_user_file,
        ])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    with_commands(tauri::Builder::default().plugin(tauri_plugin_dialog::init()))
        .setup(|app| {
            let state = init_state(app)?;
            app.manage(state);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the VFXForge desktop shell");
}


/* ------------------------------------------------------------------- tests */

/// These tests drive the real command table through Tauri's own IPC dispatch (mock runtime), so
/// they catch what unit tests of the service layer cannot: argument names (camelCase), error
/// serialisation, raw binary bodies and channels.
#[cfg(test)]
mod ipc_tests {
    use super::*;
    use serde_json::{json, Value};
    use std::path::Path;
    use std::process::Command as Proc;
    use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::{WebviewWindow, WebviewWindowBuilder};

    struct Harness {
        _app: tauri::App<tauri::test::MockRuntime>,
        win: WebviewWindow<tauri::test::MockRuntime>,
        dir: tempfile::TempDir,
    }

    fn harness(tools: ToolPaths) -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let state = AppState(Arc::new(Inner {
            projects_root: root.join("projects"),
            scratch: root.join("scratch"),
            config_file: root.join("tools.json"),
            sidecar_dirs: vec![],
            tools: Mutex::new(tools),
            jobs: Mutex::new(HashMap::new()),
        }));
        std::fs::create_dir_all(&state.0.projects_root).unwrap();
        let app = with_commands(mock_builder()).manage(state).build(mock_context(noop_assets())).unwrap();
        let win = WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        Harness { _app: app, win, dir }
    }

    fn request(cmd: &str, body: InvokeBody) -> InvokeRequest {
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            // the webview's own origin: Windows/Android serve the app from http://tauri.localhost, anything else
            // would be treated as a remote page and rejected by the ACL
            url: if cfg!(windows) || cfg!(target_os = "android") { "http://tauri.localhost" } else { "tauri://localhost" }
                .parse()
                .unwrap(),
            body,
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        }
    }

    impl Harness {
        fn call(&self, cmd: &str, args: Value) -> std::result::Result<InvokeResponseBody, Value> {
            get_ipc_response(&self.win, request(cmd, InvokeBody::Json(args)))
        }
        fn json(&self, cmd: &str, args: Value) -> Value {
            match self.call(cmd, args).unwrap_or_else(|e| panic!("{cmd} failed: {e}")) {
                InvokeResponseBody::Json(s) => serde_json::from_str(&s).unwrap(),
                InvokeResponseBody::Raw(_) => panic!("{cmd} returned raw bytes"),
            }
        }
        fn err(&self, cmd: &str, args: Value) -> Value {
            self.call(cmd, args).expect_err(&format!("{cmd} should have been refused"))
        }
        fn raw_in(&self, cmd: &str, body: Vec<u8>) -> std::result::Result<InvokeResponseBody, Value> {
            get_ipc_response(&self.win, request(cmd, InvokeBody::Raw(body)))
        }
    }

    fn raw(r: InvokeResponseBody) -> Vec<u8> {
        match r {
            InvokeResponseBody::Raw(b) => b,
            InvokeResponseBody::Json(s) => panic!("expected raw bytes, got JSON {s}"),
        }
    }

    fn write_png(path: &Path) {
        let file = std::fs::File::create(path).unwrap();
        let mut enc = png::Encoder::new(std::io::BufWriter::new(file), 4, 4);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header().unwrap().write_image_data(&[200u8; 4 * 4 * 4]).unwrap();
    }

    fn ffmpeg_available() -> bool {
        Proc::new("ffmpeg").arg("-version").output().map(|o| o.status.success()).unwrap_or(false)
    }

    #[test]
    fn tool_status_has_the_shape_the_frontend_reads() {
        let h = harness(ToolPaths::default());
        let v = h.json("tool_status", json!({}));
        for k in ["ffmpeg", "ffprobe", "bridge", "paths"] {
            assert!(v.get(k).is_some(), "missing {k} in {v}");
        }
        assert_eq!(v["bridge"]["available"], false, "no bridge is configured in this test");
        assert!(v["bridge"]["detail"].as_str().unwrap().contains("YPT_BRIDGE"));
    }

    #[test]
    fn projects_round_trip_through_camel_case_arguments() {
        let h = harness(ToolPaths::default());
        let doc = r#"{"schemaVersion":1,"id":"proj_a1","name":"Via IPC","modifiedAt":"2026-05-01T00:00:00Z"}"#;
        h.json("save_project", json!({ "projectId": "proj_a1", "json": doc }));
        let loaded = h.json("load_project", json!({ "projectId": "proj_a1" }));
        assert_eq!(loaded["json"], doc);
        assert_eq!(loaded["recoveredFromBackup"], false);
        let list = h.json("list_projects", json!({}));
        assert_eq!(list[0]["name"], "Via IPC");
        assert_eq!(list[0]["modifiedAt"], "2026-05-01T00:00:00Z");

        // autosave + recovery
        let newer = doc.replace("Via IPC", "Edited, unsaved");
        std::thread::sleep(std::time::Duration::from_millis(30));
        h.json("autosave_project", json!({ "projectId": "proj_a1", "json": newer }));
        assert!(h.json("recovery_for", json!({ "projectId": "proj_a1" })).as_str().unwrap().contains("Edited, unsaved"));
        let latest = h.json("latest_autosave", json!({}));
        assert_eq!(latest["projectId"], "proj_a1");
        h.json("clear_autosave", json!({ "projectId": "proj_a1" }));
        assert!(h.json("recovery_for", json!({ "projectId": "proj_a1" })).is_null());

        h.json("delete_project", json!({ "projectId": "proj_a1" }));
        assert_eq!(h.json("list_projects", json!({})).as_array().unwrap().len(), 0);
    }

    #[test]
    fn hostile_arguments_are_refused_with_a_stable_error_code() {
        let h = harness(ToolPaths::default());
        for id in ["../escape", "a/b", "", "x y"] {
            let e = h.err("save_project", json!({ "projectId": id, "json": r#"{"schemaVersion":1}"# }));
            assert_eq!(e["code"], "invalid_param", "id {id:?} -> {e}");
        }
        let e = h.err("save_project", json!({ "projectId": "ok", "json": "not json" }));
        assert_eq!(e["code"], "data");
        let e = h.err("read_asset", json!({ "projectId": "ok", "relPath": "../../etc/passwd" }));
        assert_eq!(e["code"], "unsafe_path");
        assert_eq!(h.json("cancel_job", json!({ "jobId": "nope" })), json!(false));
        // a misspelt (snake_case) argument must not be silently accepted
        assert!(h.call("save_project", json!({ "project_id": "ok", "json": "{}" })).is_err());
    }

    #[test]
    fn imports_by_content_and_serves_the_stored_bytes_back() {
        let h = harness(ToolPaths::default());
        let src = h.dir.path().join("sprite.dat"); // misleading extension on purpose
        write_png(&src);
        let r = h.json("import_asset", json!({ "projectId": "proj_i", "source": src.to_string_lossy() }));
        assert_eq!(r["category"], "image");
        assert_eq!(r["mime"], "image/png");
        let rel = r["relPath"].as_str().unwrap().to_string();
        assert!(rel.starts_with("assets/") && rel.ends_with(".png"), "{rel}");
        assert_eq!(r["sha256"].as_str().unwrap().len(), 64);
        assert_eq!(r["deduplicated"], false);
        let again = h.json("import_asset", json!({ "projectId": "proj_i", "source": src.to_string_lossy() }));
        assert_eq!(again["deduplicated"], true);

        let bytes = raw(h.call("read_asset", json!({ "projectId": "proj_i", "relPath": rel })).unwrap());
        assert_eq!(bytes, std::fs::read(&src).unwrap());

        let text = h.dir.path().join("evil.png");
        std::fs::write(&text, b"just text pretending to be an image").unwrap();
        let e = h.err("import_asset", json!({ "projectId": "proj_i", "source": text.to_string_lossy() }));
        assert!(matches!(e["code"].as_str(), Some("not_media") | Some("unsupported_format")), "{e}");
        let e = h.err("import_asset", json!({ "projectId": "proj_i", "source": "relative/path.png" }));
        assert_eq!(e["code"], "unsafe_path");
    }

    #[test]
    fn user_files_are_written_atomically_to_absolute_paths_only() {
        let h = harness(ToolPaths::default());
        let out = h.dir.path().join("saved.bin");
        let msg = wire::pack(&json!({ "path": out.to_string_lossy() }), &[&[1u8, 2, 3][..]]).unwrap();
        h.raw_in("write_user_file", msg).unwrap();
        assert_eq!(std::fs::read(&out).unwrap(), [1, 2, 3]);
        // relative, and absolute-with-a-missing-parent (absolute on every OS, unlike a bare "/x/y")
        let missing_parent = h.dir.path().join("no-such-folder").join("x.bin").to_string_lossy().into_owned();
        for bad in ["relative.bin", missing_parent.as_str()] {
            let msg = wire::pack(&json!({ "path": bad }), &[&[1u8][..]]).unwrap();
            assert!(h.raw_in("write_user_file", msg).is_err(), "{bad}");
        }
        assert!(h.raw_in("write_user_file", b"garbage".to_vec()).is_err());
    }

    #[test]
    fn bundle_assets_are_verified_before_they_are_stored() {
        let h = harness(ToolPaths::default());
        let tmp = h.dir.path().join("a.png");
        write_png(&tmp);
        let bytes = std::fs::read(&tmp).unwrap();
        let sha = vfxforge_native::fsx::sha256_hex(&bytes);
        let ok = wire::pack(&json!({ "projectId": "proj_b", "relPath": format!("assets/{sha}.png") }), &[&bytes[..]]).unwrap();
        h.raw_in("import_bundle_asset", ok).unwrap();
        assert!(h.dir.path().join("projects/proj_b/assets").join(format!("{sha}.png")).is_file());
        let wrong = wire::pack(&json!({ "projectId": "proj_b", "relPath": format!("assets/{}.png", "0".repeat(64)) }), &[&bytes[..]]).unwrap();
        assert!(h.raw_in("import_bundle_asset", wrong).is_err());
    }

    #[test]
    fn conversion_without_a_bridge_is_a_clear_error() {
        let h = harness(ToolPaths::default());
        let msg = wire::pack(&json!({ "xml": "<x/>", "gen9": false, "assetName": "fx", "files": [] }), &[]).unwrap();
        let e = h.raw_in("convert_ypt", msg).expect_err("no bridge configured");
        assert_eq!(e["code"], "tool_missing");
        assert!(e["message"].as_str().unwrap().contains("YPT_BRIDGE"));
        // mismatched file/blob counts are refused before any process starts
        let msg = wire::pack(&json!({ "xml": "<x/>", "gen9": false, "assetName": "fx", "files": ["a.dds"] }), &[]).unwrap();
        assert_eq!(h.raw_in("convert_ypt", msg).unwrap_err()["code"], "invalid_param");
    }

    fn bridge_dll() -> Option<PathBuf> {
        let dll = std::env::var_os("VFXFORGE_BRIDGE_DLL")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tools/ypt-bridge/out/vfxforge-ypt-bridge.dll"));
        dll.is_file().then_some(dll)
    }

    #[test]
    fn conversion_through_ipc_returns_a_verified_binary() {
        let Some(dll) = bridge_dll() else {
            eprintln!("SKIPPED: converter bridge not built");
            return;
        };
        let h = harness(ToolPaths { dll: Some(dll), ..Default::default() });
        if h.json("tool_status", json!({}))["bridge"]["available"] != true {
            eprintln!("SKIPPED: dotnet/bridge not usable");
            return;
        }
        let fx = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../native/vfxforge-native/tests/fixtures");
        let xml = std::fs::read_to_string(fx.join("tiny_fx.ypt.xml")).unwrap();
        let dds = std::fs::read(fx.join("tinyfx.dds")).unwrap();
        let msg = wire::pack(&json!({ "xml": xml, "gen9": false, "assetName": "tiny_fx", "files": ["tinyfx.dds"] }), &[&dds[..]]).unwrap();
        let reply = raw(h.raw_in("convert_ypt", msg).unwrap());
        let (meta, blobs) = wire::unpack(&reply).unwrap();
        assert_eq!(meta["roundTripOk"], true, "{meta}");
        assert_eq!(&blobs[0][..4], b"RSC7");
        assert!(meta["resourceVersion"].as_i64().unwrap() > 0);
    }

    #[test]
    fn extraction_through_ipc_returns_one_png_per_frame_and_honours_the_channel() {
        if !ffmpeg_available() {
            eprintln!("SKIPPED: ffmpeg not installed");
            return;
        }
        let h = harness(ToolPaths::default());
        let video = h.dir.path().join("clip.mp4");
        let ok = Proc::new("ffmpeg")
            .args(["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=64x48:r=8:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p"])
            .arg(&video)
            .status()
            .unwrap()
            .success();
        assert!(ok, "could not generate the fixture video");
        let imported = h.json("import_asset", json!({ "projectId": "proj_v", "source": video.to_string_lossy() }));
        assert_eq!(imported["category"], "video");
        assert_eq!(imported["info"]["width"], 64, "ffprobe data must reach the frontend: {imported}");
        let rel = imported["relPath"].clone();
        let args = json!({
            "assetRelPath": rel, "startSec": 0.0, "endSec": null, "fps": 8.0, "frameSkip": 0,
            "maxFrames": 4, "width": 32, "height": null, "keepAspect": true, "interpolation": "none"
        });
        let reply = raw(h.call("extract_frames_cmd", json!({ "jobId": "job-1", "projectId": "proj_v", "args": args, "onProgress": "__CHANNEL__:1" })).unwrap());
        let (meta, frames) = wire::unpack(&reply).unwrap();
        assert_eq!(meta["count"], 4);
        assert_eq!(frames.len(), 4);
        assert_eq!(meta["width"], 32);
        assert!(frames.iter().all(|f| f.starts_with(&[0x89, b'P', b'N', b'G'])), "every frame is a PNG");
        // the scratch folder must not keep frames around
        let leftovers = std::fs::read_dir(h.dir.path().join("scratch")).map(|d| d.count()).unwrap_or(0);
        assert_eq!(leftovers, 0);
        // an asset path outside assets/ is refused
        let bad = json!({ "assetRelPath": "../../../etc/passwd", "startSec": 0.0, "endSec": null, "fps": 8.0, "frameSkip": 0, "maxFrames": 4, "width": null, "height": null, "keepAspect": true, "interpolation": "none" });
        let e = h.err("extract_frames_cmd", json!({ "jobId": "job-2", "projectId": "proj_v", "args": bad, "onProgress": "__CHANNEL__:2" }));
        assert_eq!(e["code"], "unsafe_path");
        // invalid parameters are rejected by the native validator
        let mut insane = args.clone();
        insane["fps"] = json!(9999.0);
        let e = h.err("extract_frames_cmd", json!({ "jobId": "job-3", "projectId": "proj_v", "args": insane, "onProgress": "__CHANNEL__:3" }));
        assert_eq!(e["code"], "invalid_param");
    }

    #[test]
    fn tool_paths_must_be_absolute_and_are_persisted() {
        let h = harness(ToolPaths::default());
        let e = h.err("set_tool_paths", json!({ "paths": { "ffmpeg": "ffmpeg", "ffprobe": null, "dotnet": null, "dll": null } }));
        assert_eq!(e["code"], "unsafe_path");
        // absolute on every OS (a bare "/a/b" has no drive letter on Windows and would be rejected as relative)
        let traversal = h.dir.path().join("a").join("..").join("b").join("ffmpeg").to_string_lossy().into_owned();
        let e = h.err("set_tool_paths", json!({ "paths": { "ffmpeg": traversal, "ffprobe": null, "dotnet": null, "dll": null } }));
        assert_eq!(e["code"], "unsafe_path");
        // an absolute path that does not exist is accepted as configuration but reported as unavailable
        let missing = h.dir.path().join("nonexistent").join("ffmpeg").to_string_lossy().into_owned();
        let v = h.json("set_tool_paths", json!({ "paths": { "ffmpeg": missing, "ffprobe": null, "dotnet": null, "dll": null } }));
        assert_eq!(v["ffmpeg"]["available"], false);
        assert!(h.dir.path().join("tools.json").is_file());
    }
}
