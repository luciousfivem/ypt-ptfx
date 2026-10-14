//! Launcher for the optional CodeWalker-based converter (`tools/ypt-bridge`).
//!
//! The converter is a SEPARATE process that the user builds locally against their own
//! CodeWalker checkout (CodeWalker is GPL; VFXForge neither vendors nor links it). This
//! module only starts that process with a fixed, validated command set and parses its
//! one-line JSON reply. Nothing user-supplied is ever interpreted as a command.

use crate::error::{Error, Result};
use crate::jobs::CancelToken;
use crate::process::run;
use crate::sanitize::require_existing_file;
use crate::tools::{command, locate};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeConfig {
    /// Path to the `dotnet` executable (auto-detected from PATH when absent).
    pub dotnet: Option<PathBuf>,
    /// Path to the built `vfxforge-ypt-bridge.dll`.
    pub dll: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    pub available: bool,
    pub detail: String,
    pub version: Option<String>,
    pub codewalker_core: Option<String>,
}

#[derive(Debug, Clone)]
pub enum BridgeCommand {
    Version,
    /// `.ypt.xml` (with DDS files beside it) -> binary `.ypt`
    XmlToYpt { input: PathBuf, output: PathBuf, gen9: bool },
    /// binary `.ypt` -> `.ypt.xml` (+ DDS files next to the output)
    YptToXml { input: PathBuf, output: PathBuf },
    /// GTA V drawable `.ydr` -> binary glTF `.glb` (highest LOD that has geometry; geometry only, no textures)
    YdrToGlb { input: PathBuf, output: PathBuf },
}

/// Added to every "the bridge cannot be used" error of the drawable import, which is the one flow that has a
/// way around the bridge: any model format three.js reads imports without it.
const YDR_WITHOUT_BRIDGE: &str = "Exporting the model as .glb works without it.";

/// `ydr`: the caller is a drawable import, so the hints say what to do about the bridge for THAT (and that
/// a `.glb` needs no bridge) instead of talking about binary `.ypt` export.
fn resolve(cfg: &BridgeConfig, ydr: bool) -> Result<(PathBuf, PathBuf)> {
    let dll = cfg.dll.as_ref().ok_or_else(|| Error::ToolMissing {
        tool: "vfxforge-ypt-bridge".into(),
        hint: if ydr {
            format!("The CodeWalker converter bridge is not configured, and importing a .ydr needs it (it converts the drawable to a .glb). Build tools/ypt-bridge against your CodeWalker checkout (see docs/YPT_BRIDGE.md) and set its path in Settings > Tools. {YDR_WITHOUT_BRIDGE}")
        } else {
            "The CodeWalker converter bridge is not configured. Build tools/ypt-bridge against your CodeWalker checkout (see docs/YPT_BRIDGE.md) and set its path in Settings > Tools. Without it VFXForge can still export validated .ypt.xml + DDS for CodeWalker, but not a binary .ypt.".into()
        },
    })?;
    if !dll.is_file() || dll.extension().map(|e| e.to_ascii_lowercase()) != Some("dll".into()) {
        return Err(Error::ToolMissing {
            tool: "vfxforge-ypt-bridge".into(),
            hint: if ydr {
                format!("'{}' is not a built vfxforge-ypt-bridge.dll. Fix the path in Settings > Tools (build steps: docs/YPT_BRIDGE.md). {YDR_WITHOUT_BRIDGE}", dll.display())
            } else {
                format!("'{}' is not a built vfxforge-ypt-bridge.dll.", dll.display())
            },
        });
    }
    let dotnet = locate("dotnet", cfg.dotnet.as_deref(), &[]).map_err(|e| match e {
        Error::ToolMissing { tool, hint } if ydr => Error::ToolMissing { tool, hint: format!("{hint} Importing a .ydr needs the converter bridge, which runs on .NET. {YDR_WITHOUT_BRIDGE}") },
        other => other,
    })?;
    Ok((dotnet, dll.clone()))
}

/// Checks that the bridge could be started for a drawable import (configured, built, `dotnet` found) without
/// starting it, so the caller can refuse before it copies anything.
pub fn ensure_ready_for_ydr(cfg: &BridgeConfig) -> Result<()> {
    resolve(cfg, true).map(|_| ())
}

/// How a failure the bridge reported for `ydr2glb` reads to the user. `code` and `message` are the reply's own
/// `code` and `error`; the bridge's messages already say what is wrong with the file, so this only adds what
/// the app knows: that nothing was imported, and what an outdated bridge needs.
pub fn ydr_failure_error(code: &str, message: &str) -> Error {
    let tool = format!("ypt-bridge ({code})");
    let detail = match code {
        // the bridge predates ydr2glb: its dispatcher rejects the command name
        "unknown_command" => "this converter bridge is too old to convert .ydr drawables (it does not know the ydr2glb command). Rebuild tools/ypt-bridge from this version of VFXForge (see docs/YPT_BRIDGE.md) and select the new vfxforge-ypt-bridge.dll in Settings > Tools. Exporting the model as .glb works without the bridge.".to_string(),
        _ => format!("{} Nothing was imported.", message.trim()),
    };
    Error::ToolFailed { tool, code: None, detail }
}

/// The bridge exited unsuccessfully without writing its JSON reply: it crashed (for example a stack overflow inside
/// CodeWalker's reader on a malformed file), was killed, or `dotnet` itself failed to start it. `code` is the exit code
/// (None when the process was terminated by a signal) and `stderr` its error output.
pub fn no_reply_error(ydr: bool, code: Option<i32>, stderr: &str) -> Error {
    let killed = if code.is_none() { " It was terminated without an exit code." } else { "" };
    let first = stderr.lines().map(str::trim).find(|l| !l.is_empty()).map(|l| l.chars().take(200).collect::<String>());
    if ydr {
        let output = first.map(|l| format!(" Converter output: {l}")).unwrap_or_default();
        return Error::ToolFailed {
            tool: "ypt-bridge".into(),
            code,
            detail: format!("the converter stopped without answering while reading this file; the file is probably corrupt or deliberately malformed.{killed} Nothing was imported.{output}"),
        };
    }
    let detail = if stderr.trim().is_empty() { format!("it wrote no error output.{killed}") } else { format!("{}{killed}", stderr.trim_end()) };
    Error::ToolFailed { tool: "dotnet".into(), code, detail }
}

fn generic_failure_error(code: &str, message: &str) -> Error {
    Error::ToolFailed { tool: format!("ypt-bridge ({code})"), code: None, detail: message.to_string() }
}

fn parse_reply(stdout: &str) -> Result<Value> {
    parse_reply_with(stdout, generic_failure_error)
}

/// `on_failure(code, message)` words a `{"ok":false,...}` reply; everything else about the reply is common.
fn parse_reply_with(stdout: &str, on_failure: impl FnOnce(&str, &str) -> Error) -> Result<Value> {
    let line = stdout
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with('{'))
        .ok_or_else(|| Error::Data("the converter bridge produced no JSON reply".into()))?;
    let v: Value = serde_json::from_str(line).map_err(|e| Error::Data(format!("bridge reply is not valid JSON: {e}")))?;
    if v.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(v)
    } else {
        let msg = v.get("error").and_then(Value::as_str).unwrap_or("unknown error");
        let code = v.get("code").and_then(Value::as_str).unwrap_or("bridge_error");
        Err(on_failure(code, msg))
    }
}

pub fn build_bridge_args(cmd: &BridgeCommand) -> Result<Vec<std::ffi::OsString>> {
    use std::ffi::OsString as S;
    fn abs_file(p: &Path) -> Result<PathBuf> {
        require_existing_file(p)
    }
    fn abs_file_named(p: &Path, ext: &str) -> Result<PathBuf> {
        let canon = require_existing_file(p)?;
        let name = canon.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
        if !name.ends_with(ext) {
            return Err(Error::InvalidParam(format!("input file name must end with {ext}")));
        }
        Ok(canon)
    }
    fn out_path(p: &Path, ext: &str) -> Result<PathBuf> {
        if !p.is_absolute() {
            return Err(Error::UnsafePath(format!("{} (expected an absolute path)", p.display())));
        }
        crate::sanitize::reject_traversal(p)?;
        let name = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
        if !name.ends_with(ext) {
            return Err(Error::InvalidParam(format!("output file name must end with {ext}")));
        }
        match p.parent() {
            Some(parent) if parent.is_dir() => Ok(p.to_path_buf()),
            _ => Err(Error::NotFound("output folder".into())),
        }
    }
    Ok(match cmd {
        BridgeCommand::Version => vec![S::from("version")],
        BridgeCommand::XmlToYpt { input, output, gen9 } => vec![
            S::from("xml2ypt"),
            S::from("--in"),
            abs_file(input)?.into_os_string(),
            S::from("--out"),
            out_path(output, ".ypt")?.into_os_string(),
            S::from("--gen"),
            S::from(if *gen9 { "gen9" } else { "legacy" }),
        ],
        BridgeCommand::YptToXml { input, output } => vec![
            S::from("ypt2xml"),
            S::from("--in"),
            abs_file(input)?.into_os_string(),
            S::from("--out"),
            out_path(output, ".xml")?.into_os_string(),
        ],
        BridgeCommand::YdrToGlb { input, output } => vec![
            S::from("ydr2glb"),
            S::from("--in"),
            abs_file_named(input, ".ydr")?.into_os_string(),
            S::from("--out"),
            out_path(output, ".glb")?.into_os_string(),
        ],
    })
}

pub fn run_bridge(cfg: &BridgeConfig, cmd: &BridgeCommand, cancel: &CancelToken, timeout: Duration) -> Result<Value> {
    let ydr = matches!(cmd, BridgeCommand::YdrToGlb { .. });
    let (dotnet, dll) = resolve(cfg, ydr)?;
    let args = build_bridge_args(cmd)?;
    let mut c = command(&dotnet);
    c.arg(&dll).args(&args);
    let out = run(c, "dotnet", cancel, timeout, None)?;
    if !out.success && out.stdout.trim().is_empty() {
        return Err(no_reply_error(ydr, out.code, &out.stderr_tail));
    }
    if ydr {
        parse_reply_with(&out.stdout, ydr_failure_error)
    } else {
        parse_reply(&out.stdout)
    }
}

pub fn bridge_status(cfg: &BridgeConfig) -> BridgeStatus {
    match run_bridge(cfg, &BridgeCommand::Version, &CancelToken::new(), Duration::from_secs(30)) {
        Ok(v) => BridgeStatus {
            available: true,
            detail: "Converter bridge is ready.".into(),
            version: v.get("version").and_then(Value::as_str).map(str::to_string),
            codewalker_core: v.get("codewalkerCore").and_then(Value::as_str).map(str::to_string),
        },
        Err(e) => BridgeStatus { available: false, detail: e.to_string(), version: None, codewalker_core: None },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unconfigured_bridge_explains_what_to_do() {
        let err = run_bridge(&BridgeConfig::default(), &BridgeCommand::Version, &CancelToken::new(), Duration::from_secs(1)).unwrap_err();
        let msg = err.to_string();
        assert!(matches!(err, Error::ToolMissing { .. }));
        assert!(msg.contains("docs/YPT_BRIDGE.md"), "{msg}");
        assert!(msg.contains(".ypt.xml"), "{msg}");
        let st = bridge_status(&BridgeConfig::default());
        assert!(!st.available);
    }

    #[test]
    fn rejects_dll_paths_that_are_not_a_dll() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("evil.sh");
        std::fs::write(&f, "#!/bin/sh\n").unwrap();
        let cfg = BridgeConfig { dotnet: None, dll: Some(f) };
        assert!(matches!(resolve(&cfg, false), Err(Error::ToolMissing { .. })));
    }

    #[test]
    fn builds_a_fixed_argument_shape() {
        let dir = tempfile::tempdir().unwrap();
        let xml = dir.path().join("fx.ypt.xml");
        std::fs::write(&xml, "<x/>").unwrap();
        let out = dir.path().join("fx.ypt");
        let args: Vec<String> = build_bridge_args(&BridgeCommand::XmlToYpt { input: xml.clone(), output: out.clone(), gen9: false })
            .unwrap()
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args[0], "xml2ypt");
        assert_eq!(args[1], "--in");
        assert_eq!(args[3], "--out");
        assert_eq!(args[5], "--gen");
        assert_eq!(args[6], "legacy");
        // wrong extension / relative / missing parent are rejected
        assert!(build_bridge_args(&BridgeCommand::XmlToYpt { input: xml.clone(), output: dir.path().join("fx.exe"), gen9: true }).is_err());
        assert!(build_bridge_args(&BridgeCommand::XmlToYpt { input: xml.clone(), output: PathBuf::from("fx.ypt"), gen9: true }).is_err());
        assert!(build_bridge_args(&BridgeCommand::XmlToYpt { input: xml, output: dir.path().join("no/such/fx.ypt"), gen9: true }).is_err());
        assert!(build_bridge_args(&BridgeCommand::YptToXml { input: dir.path().join("missing.ypt"), output: dir.path().join("o.xml") }).is_err());
    }

    fn arg_strings(cmd: &BridgeCommand) -> Result<Vec<String>> {
        build_bridge_args(cmd).map(|a| a.iter().map(|x| x.to_string_lossy().into_owned()).collect())
    }

    #[test]
    fn ydr_arguments_have_the_fixed_shape() {
        let dir = tempfile::tempdir().unwrap();
        let ydr = dir.path().join("w_ar_k2light.ydr");
        std::fs::write(&ydr, b"RSC7").unwrap();
        let glb = dir.path().join("w_ar_k2light.glb");
        let args = arg_strings(&BridgeCommand::YdrToGlb { input: ydr.clone(), output: glb.clone() }).unwrap();
        assert_eq!(args.len(), 5);
        assert_eq!(&args[..2], ["ydr2glb", "--in"]);
        assert_eq!(args[3], "--out");
        // both are absolute and name the files we asked for (the input is canonicalised, the output is as given)
        assert!(Path::new(&args[2]).is_absolute() && args[2].ends_with("w_ar_k2light.ydr"), "{args:?}");
        assert_eq!(Path::new(&args[4]), glb.as_path());
        // an upper-case extension is still a .ydr / .glb
        let loud = dir.path().join("LOUD.YDR");
        std::fs::write(&loud, b"RSC7").unwrap();
        assert!(arg_strings(&BridgeCommand::YdrToGlb { input: loud, output: dir.path().join("LOUD.GLB") }).is_ok());
    }

    #[test]
    fn ydr_arguments_refuse_bad_extensions_paths_and_missing_files() {
        let dir = tempfile::tempdir().unwrap();
        let ydr = dir.path().join("a.ydr");
        std::fs::write(&ydr, b"RSC7").unwrap();
        let png = dir.path().join("a.png");
        std::fs::write(&png, b"x").unwrap();
        let glb = dir.path().join("a.glb");
        let job = |input: PathBuf, output: PathBuf| arg_strings(&BridgeCommand::YdrToGlb { input, output });
        // wrong extensions on either side
        assert!(matches!(job(png, glb.clone()), Err(Error::InvalidParam(_))));
        assert!(matches!(job(ydr.clone(), dir.path().join("a.png")), Err(Error::InvalidParam(_))));
        assert!(matches!(job(ydr.clone(), dir.path().join("a.glb.exe")), Err(Error::InvalidParam(_))));
        // relative paths
        assert!(matches!(job(PathBuf::from("a.ydr"), glb.clone()), Err(Error::UnsafePath(_))));
        assert!(matches!(job(ydr.clone(), PathBuf::from("a.glb")), Err(Error::UnsafePath(_))));
        // missing input, a folder as input
        assert!(matches!(job(dir.path().join("missing.ydr"), glb.clone()), Err(Error::NotFound(_))));
        let folder = dir.path().join("dir.ydr");
        std::fs::create_dir(&folder).unwrap();
        assert!(matches!(job(folder, glb.clone()), Err(Error::InvalidParam(_))));
        // traversal in the output, missing output folder
        let sneaky = dir.path().join("sub").join("..").join("a.glb");
        assert!(matches!(job(ydr.clone(), sneaky), Err(Error::UnsafePath(_))));
        assert!(matches!(job(ydr, dir.path().join("no").join("such").join("a.glb")), Err(Error::NotFound(_))));
    }

    #[test]
    fn an_old_bridge_is_told_to_be_rebuilt() {
        // the old dispatcher answered exactly this to a command it did not know
        let reply = r#"{"ok":false,"code":"unknown_command","error":"Unknown command 'ydr2glb'. Commands: version, xml2ypt, ypt2xml, xml-normalize."}"#;
        let e = parse_reply_with(reply, ydr_failure_error).unwrap_err();
        let msg = e.to_string();
        assert_eq!(e.code(), "tool_failed");
        assert!(msg.contains("too old") && msg.contains("tools/ypt-bridge") && msg.contains("Settings > Tools") && msg.contains("YPT_BRIDGE.md"), "{msg}");
        assert!(msg.contains("works without the bridge"), "{msg}");
        assert!(!msg.contains("exit code"), "{msg}");
        // the other commands keep the generic wording
        let generic = parse_reply(reply).unwrap_err().to_string();
        assert!(generic.contains("Unknown command 'ydr2glb'") && !generic.contains("too old"), "{generic}");
    }

    #[test]
    fn every_failure_code_the_converter_documents_reaches_the_user_with_its_message() {
        for (code, message) in [
            ("not_ydr", "The file does not start with an RSC7 resource header; it is not a GTA V resource file (.ydr)."),
            ("unsupported_version", "RSC7 resource version 68 is not a drawable version this converter can read (drawables are 165 legacy or 159/154 gen9)."),
            ("parse_failed", "CodeWalker could not read this file as a drawable: Unexpected end of stream"),
            ("no_geometry", "The drawable has no renderable geometry in any LOD."),
            ("too_large", "The file is 300 MiB; the limit is 256 MiB."),
            ("convert_error", "The conversion did not finish within 90 s."),
            ("bad_argument", "Input file name must end with .ydr."),
            ("not_found", "File not found: /x/y.ydr"),
            ("something_new", "a code this launcher has never heard of"),
        ] {
            let line = format!("{{\"ok\":false,\"code\":\"{code}\",\"error\":\"{message}\"}}");
            let e = parse_reply_with(&line, ydr_failure_error).unwrap_err();
            let text = e.to_string();
            assert!(matches!(e, Error::ToolFailed { code: None, .. }), "{code}");
            assert!(text.contains(message), "{code}: {text}");
            assert!(text.contains(&format!("ypt-bridge ({code})")), "{code}: {text}");
            assert!(text.ends_with("Nothing was imported."), "{code}: {text}");
        }
        // a failure reply without a code or message is still a failure with some words
        let e = parse_reply_with(r#"{"ok":false}"#, ydr_failure_error).unwrap_err().to_string();
        assert!(e.contains("bridge_error") && e.contains("unknown error"), "{e}");
        // and a reply that is not JSON at all is not mistaken for success
        assert!(parse_reply_with("Unhandled exception. System.IO.FileNotFoundException", ydr_failure_error).is_err());
        assert!(parse_reply_with("{\"ok\":false,", ydr_failure_error).is_err());
    }

    #[test]
    fn the_drawable_flow_explains_how_to_get_a_model_in_without_the_bridge() {
        let e = ensure_ready_for_ydr(&BridgeConfig::default()).unwrap_err();
        let msg = e.to_string();
        assert!(matches!(e, Error::ToolMissing { .. }));
        assert_eq!(e.code(), "tool_missing");
        for needle in ["Settings > Tools", "docs/YPT_BRIDGE.md", "Exporting the model as .glb works without it"] {
            assert!(msg.contains(needle), "{needle} missing from: {msg}");
        }
        assert!(!msg.contains(".ypt.xml"), "the YPT wording leaked into the drawable flow: {msg}");
        // run_bridge reaches the same error for the actual command, before touching any file
        let cmd = BridgeCommand::YdrToGlb { input: PathBuf::from("/nope/a.ydr"), output: PathBuf::from("/nope/a.glb") };
        let e = run_bridge(&BridgeConfig::default(), &cmd, &CancelToken::new(), Duration::from_secs(1)).unwrap_err();
        assert_eq!(e.to_string(), msg);

        // a configured path that is not a dll gets the same advice
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("evil.sh");
        std::fs::write(&f, "#!/bin/sh\n").unwrap();
        let bad = ensure_ready_for_ydr(&BridgeConfig { dotnet: None, dll: Some(f) }).unwrap_err().to_string();
        assert!(bad.contains("is not a built vfxforge-ypt-bridge.dll") && bad.contains("Settings > Tools") && bad.contains("works without it"), "{bad}");

        // a dll that exists but no dotnet to run it
        let dll = dir.path().join("vfxforge-ypt-bridge.dll");
        std::fs::write(&dll, b"x").unwrap();
        let cfg = BridgeConfig { dotnet: Some(dir.path().join("no-dotnet-here")), dll: Some(dll) };
        let no_dotnet = ensure_ready_for_ydr(&cfg).unwrap_err().to_string();
        assert!(no_dotnet.contains("Settings > Tools") && no_dotnet.contains("works without it") && !no_dotnet.contains("FFmpeg"), "{no_dotnet}");
        // while the existing YPT wording is untouched
        let ypt = run_bridge(&BridgeConfig::default(), &BridgeCommand::Version, &CancelToken::new(), Duration::from_secs(1)).unwrap_err().to_string();
        assert!(ypt.contains(".ypt.xml") && !ypt.contains("works without it"), "{ypt}");
    }

    #[test]
    fn a_bridge_that_dies_without_a_reply_is_explained() {
        // a stack overflow inside CodeWalker's reader: .NET prints this and aborts (exit code 134 on Linux)
        let crash = no_reply_error(true, Some(134), "\nStack overflow.\n   at CodeWalker.GameFiles.SkeletonBoneTag.Read(...)\n");
        let msg = crash.to_string();
        assert_eq!(crash.code(), "tool_failed");
        assert!(msg.starts_with("ypt-bridge failed (exit code 134): the converter stopped without answering"), "{msg}");
        assert!(msg.contains("corrupt or deliberately malformed") && msg.contains("Nothing was imported."), "{msg}");
        assert!(msg.ends_with("Converter output: Stack overflow."), "{msg}");
        // killed by a signal (no exit code) and silent: still says what happened
        let killed = no_reply_error(true, None, "").to_string();
        assert!(killed.contains("terminated without an exit code") && !killed.contains("exit code None") && !killed.contains("Converter output"), "{killed}");
        // the other commands keep the dotnet wording, but never end in an empty message
        let silent = no_reply_error(false, None, "  ").to_string();
        assert_eq!(silent, "dotnet failed: it wrote no error output. It was terminated without an exit code.");
        let loud = no_reply_error(false, Some(1), "Unhandled exception.\n").to_string();
        assert_eq!(loud, "dotnet failed (exit code 1): Unhandled exception.");
    }

    #[test]
    fn parses_replies() {
        assert!(parse_reply("noise\n{\"ok\":true,\"version\":\"1\"}\n").is_ok());
        let e = parse_reply("{\"ok\":false,\"code\":\"missing_texture\",\"error\":\"Texture file not found: a.dds\"}").unwrap_err();
        assert!(e.to_string().contains("Texture file not found"));
        assert!(e.to_string().contains("missing_texture"));
        assert!(parse_reply("no json here").is_err());
        assert!(parse_reply("{broken").is_err());
    }
}
