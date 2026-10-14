//! Locating and invoking external tools (FFmpeg, ffprobe, dotnet).
//!
//! Search order: explicit configured path -> sidecar directories (next to the app
//! executable) -> PATH. We never go through a shell.

use crate::error::{Error, Result};
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
const EXE_SUFFIX: &str = ".exe";
#[cfg(not(windows))]
const EXE_SUFFIX: &str = "";

fn candidate_names(name: &str) -> Vec<String> {
    if EXE_SUFFIX.is_empty() || name.ends_with(EXE_SUFFIX) {
        vec![name.to_string()]
    } else {
        vec![format!("{name}{EXE_SUFFIX}"), name.to_string()]
    }
}

fn is_executable_file(p: &Path) -> bool {
    match std::fs::metadata(p) {
        Ok(m) if m.is_file() => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                m.permissions().mode() & 0o111 != 0
            }
            #[cfg(not(unix))]
            {
                true
            }
        }
        _ => false,
    }
}

/// Finds `name` using the configured path, then `extra_dirs`, then `PATH`.
pub fn locate(name: &str, configured: Option<&Path>, extra_dirs: &[PathBuf]) -> Result<PathBuf> {
    if let Some(p) = configured {
        if is_executable_file(p) {
            return Ok(p.to_path_buf());
        }
        return Err(Error::ToolMissing {
            tool: name.to_string(),
            hint: format!(
                "The configured path '{}' does not exist or is not executable. Fix it in Settings > Tools.",
                p.display()
            ),
        });
    }
    let mut dirs: Vec<PathBuf> = extra_dirs.to_vec();
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    for dir in dirs {
        for cand in candidate_names(name) {
            let full = dir.join(&cand);
            if is_executable_file(&full) {
                return Ok(full);
            }
        }
    }
    Err(Error::ToolMissing {
        tool: name.to_string(),
        hint: format!(
            "Install FFmpeg (https://ffmpeg.org/download.html) and either add it to PATH, place '{name}' next to the VFXForge executable, or set its path in Settings > Tools. Image import and procedural animation still work without it; video import needs it."
        ),
    })
}

/// Builds a `Command` that never opens a console window on Windows and never inherits stdin.
pub fn command(program: &Path) -> Command {
    let mut c = Command::new(program);
    c.stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolVersion {
    pub raw: String,
    /// (major, minor) when it could be parsed; `None` for git/nightly builds.
    pub numeric: Option<(u32, u32)>,
}

impl ToolVersion {
    /// True for FFmpeg builds that understand `-fps_mode` (5.1+). Unknown/nightly builds are
    /// assumed modern.
    pub fn supports_fps_mode(&self) -> bool {
        match self.numeric {
            Some((maj, min)) => maj > 5 || (maj == 5 && min >= 1),
            None => true,
        }
    }
}

pub fn parse_ffmpeg_version(first_line: &str) -> ToolVersion {
    // "ffmpeg version 6.1.1-3ubuntu5 Copyright ..." / "ffmpeg version n7.0 ..." / "ffmpeg version N-1234-gabc"
    let after = first_line.split("version").nth(1).unwrap_or("").trim();
    let token = after.split_whitespace().next().unwrap_or("");
    let t = token.trim_start_matches(['n', 'N']);
    let mut parts = t.split(['.', '-']);
    let numeric = match (
        parts.next().and_then(|p| p.parse::<u32>().ok()),
        parts.next().and_then(|p| p.parse::<u32>().ok()),
    ) {
        (Some(a), Some(b)) if a < 100 => Some((a, b)),
        (Some(a), None) if a < 100 => Some((a, 0)),
        _ => None,
    };
    ToolVersion {
        raw: first_line.trim().to_string(),
        numeric,
    }
}

pub fn ffmpeg_version(ffmpeg: &Path) -> Result<ToolVersion> {
    let out = command(ffmpeg)
        .arg("-version")
        .output()
        .map_err(|e| Error::io("running ffmpeg -version", e))?;
    if !out.status.success() {
        return Err(Error::ToolFailed {
            tool: "ffmpeg".into(),
            code: out.status.code(),
            detail: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        });
    }
    let text = String::from_utf8_lossy(&out.stdout);
    Ok(parse_ffmpeg_version(text.lines().next().unwrap_or("")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_versions() {
        let v = parse_ffmpeg_version("ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023");
        assert_eq!(v.numeric, Some((6, 1)));
        assert!(v.supports_fps_mode());
        assert_eq!(parse_ffmpeg_version("ffmpeg version n7.0 Copyright").numeric, Some((7, 0)));
        assert!(!parse_ffmpeg_version("ffmpeg version 4.4.2 Copyright").supports_fps_mode());
        assert!(!parse_ffmpeg_version("ffmpeg version 5.0.1 Copyright").supports_fps_mode());
        assert!(parse_ffmpeg_version("ffmpeg version 5.1 Copyright").supports_fps_mode());
        // nightly: unknown -> assumed modern
        let nightly = parse_ffmpeg_version("ffmpeg version N-117000-gabcdef123 Copyright");
        assert_eq!(nightly.numeric, None);
        assert!(nightly.supports_fps_mode());
    }

    #[test]
    fn missing_tool_has_actionable_message() {
        let err = locate("definitely-not-a-real-tool-xyz", None, &[]).unwrap_err();
        assert!(matches!(err, Error::ToolMissing { .. }));
        assert!(err.to_string().contains("Install FFmpeg"));
        let bad = locate("ffmpeg", Some(Path::new("/nonexistent/ffmpeg")), &[]).unwrap_err();
        assert!(bad.to_string().contains("Settings > Tools"));
    }

    #[test]
    fn finds_tools_on_path() {
        // `sh` exists on every unix CI image; on Windows `cmd` does.
        #[cfg(unix)]
        assert!(locate("sh", None, &[]).is_ok());
        #[cfg(windows)]
        assert!(locate("cmd", None, &[]).is_ok());
    }
}
