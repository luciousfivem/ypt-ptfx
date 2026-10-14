//! Command-line front-end to the native services. Used by the TypeScript integration
//! tests and handy for debugging. Replies are single-line JSON on stdout; errors are
//! `{"error":{"code","message"}}` with a non-zero exit status.

use serde_json::json;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use vfxforge_native::bridge::{bridge_status, BridgeConfig};
use vfxforge_native::extract::{extract_frames, ExtractRequest};
use vfxforge_native::jobs::CancelToken;
use vfxforge_native::{fsx, probe, project, Error, MediaTools, Result};

fn arg_value(args: &[String], flag: &str) -> Option<PathBuf> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).map(PathBuf::from)
}

fn run(args: Vec<String>) -> Result<serde_json::Value> {
    let cmd = args.get(1).map(String::as_str).unwrap_or("help");
    let tools = || MediaTools::discover(arg_value(&args, "--ffmpeg").as_deref(), arg_value(&args, "--ffprobe").as_deref(), &[]);
    let positional = |n: usize| -> Result<PathBuf> {
        args.iter()
            .skip(2)
            .filter(|a| !a.starts_with("--"))
            .nth(n)
            .map(PathBuf::from)
            .ok_or_else(|| Error::InvalidParam(format!("missing argument #{}", n + 1)))
    };
    match cmd {
        "sniff" => {
            let (path, s, bytes) = probe::identify(&positional(0)?)?;
            Ok(json!({ "path": path, "kind": s.kind, "category": s.category, "mime": s.mime, "bytes": bytes }))
        }
        "probe" => {
            let t = tools()?;
            Ok(serde_json::to_value(probe::probe(&t.ffprobe, &positional(0)?)?).unwrap())
        }
        "extract" => {
            let t = tools()?;
            let mut body = String::new();
            std::io::Read::read_to_string(&mut std::io::stdin(), &mut body).map_err(|e| Error::io("reading the request from stdin", e))?;
            let req: ExtractRequest = serde_json::from_str(&body).map_err(|e| Error::InvalidParam(format!("bad extract request: {e}")))?;
            let result = extract_frames(
                &t.ffmpeg,
                &t.ffprobe,
                &req,
                &CancelToken::new(),
                Some(Arc::new(|p| eprintln!("progress {}", serde_json::to_string(&p).unwrap_or_default()))),
            )?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "import" => {
            let stored = fsx::import_asset(&positional(0)?, &positional(1)?)?;
            Ok(serde_json::to_value(stored).unwrap())
        }
        "project-load" => Ok(serde_json::to_value(project::load_project(&positional(0)?)?).unwrap()),
        "bridge-status" => {
            let cfg = BridgeConfig { dotnet: arg_value(&args, "--dotnet"), dll: arg_value(&args, "--dll") };
            Ok(serde_json::to_value(bridge_status(&cfg)).unwrap())
        }
        _ => Ok(json!({ "commands": ["sniff <file>", "probe <file>", "extract (JSON on stdin)", "import <projectDir> <file>", "project-load <dir>", "bridge-status [--dll X] [--dotnet Y]"] })),
    }
}

fn main() -> ExitCode {
    match run(std::env::args().collect()) {
        Ok(v) => {
            println!("{v}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            println!("{}", json!({ "error": e }));
            ExitCode::from(1)
        }
    }
}
