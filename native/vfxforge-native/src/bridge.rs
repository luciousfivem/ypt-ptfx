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
}

fn resolve(cfg: &BridgeConfig) -> Result<(PathBuf, PathBuf)> {
    let dll = cfg.dll.as_ref().ok_or_else(|| Error::ToolMissing {
        tool: "vfxforge-ypt-bridge".into(),
        hint: "The CodeWalker converter bridge is not configured. Build tools/ypt-bridge against your CodeWalker checkout (see docs/YPT_BRIDGE.md) and set its path in Settings > Tools. Without it VFXForge can still export validated .ypt.xml + DDS for CodeWalker, but not a binary .ypt.".into(),
    })?;
    if !dll.is_file() || dll.extension().map(|e| e.to_ascii_lowercase()) != Some("dll".into()) {
        return Err(Error::ToolMissing {
            tool: "vfxforge-ypt-bridge".into(),
            hint: format!("'{}' is not a built vfxforge-ypt-bridge.dll.", dll.display()),
        });
    }
    let dotnet = locate("dotnet", cfg.dotnet.as_deref(), &[])?;
    Ok((dotnet, dll.clone()))
}

fn parse_reply(stdout: &str) -> Result<Value> {
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
        Err(Error::ToolFailed { tool: format!("ypt-bridge ({code})"), code: None, detail: msg.to_string() })
    }
}

pub fn build_bridge_args(cmd: &BridgeCommand) -> Result<Vec<std::ffi::OsString>> {
    use std::ffi::OsString as S;
    fn abs_file(p: &Path) -> Result<PathBuf> {
        require_existing_file(p)
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
    })
}

pub fn run_bridge(cfg: &BridgeConfig, cmd: &BridgeCommand, cancel: &CancelToken, timeout: Duration) -> Result<Value> {
    let (dotnet, dll) = resolve(cfg)?;
    let args = build_bridge_args(cmd)?;
    let mut c = command(&dotnet);
    c.arg(&dll).args(&args);
    let out = run(c, "dotnet", cancel, timeout, None)?;
    if !out.success && out.stdout.trim().is_empty() {
        return Err(Error::ToolFailed { tool: "dotnet".into(), code: out.code, detail: out.stderr_tail });
    }
    parse_reply(&out.stdout)
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
        assert!(matches!(resolve(&cfg), Err(Error::ToolMissing { .. })));
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
