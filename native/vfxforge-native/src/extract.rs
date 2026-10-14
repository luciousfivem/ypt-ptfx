//! Frame extraction from video / animated images via FFmpeg.
//!
//! Security model: the FFmpeg command line is assembled ONLY from validated numbers and
//! enums. The one user-controlled string that reaches argv is the input path, which is
//! canonicalised, must be an existing regular file whose *content* sniffs as a supported
//! container, is prefixed with `file:` and read through a forced, allow-listed demuxer.
//! No shell is involved.

use crate::error::{Error, Result};
use crate::jobs::CancelToken;
use crate::probe::{identify, probe, MediaInfo};
use crate::process::{run, LineCallback};
use crate::tools::{command, ffmpeg_version, ToolVersion};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

pub const MAX_FRAMES: u32 = 1024;
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Interpolation {
    /// Plain frame dropping/duplication (`fps` filter).
    None,
    /// Cross-fades neighbouring frames (`framerate` filter). Cheap, can look ghosted.
    Blend,
    /// Motion-compensated interpolation (`minterpolate`). Slow, can introduce artefacts.
    Motion,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractRequest {
    pub input: PathBuf,
    pub out_dir: PathBuf,
    #[serde(default)]
    pub start_sec: f64,
    pub end_sec: Option<f64>,
    pub fps: f64,
    #[serde(default)]
    pub frame_skip: u32,
    pub max_frames: u32,
    pub width: Option<u32>,
    pub height: Option<u32>,
    #[serde(default = "yes")]
    pub keep_aspect: bool,
    #[serde(default = "no_interp")]
    pub interpolation: Interpolation,
}

fn yes() -> bool {
    true
}
fn no_interp() -> Interpolation {
    Interpolation::None
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractResult {
    pub dir: PathBuf,
    pub frames: Vec<PathBuf>,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub frames_done: u64,
    pub frames_expected: Option<u64>,
}

pub fn validate(req: &ExtractRequest) -> Result<()> {
    let bad = |m: &str| Err(Error::InvalidParam(m.to_string()));
    if !req.fps.is_finite() || !(0.1..=120.0).contains(&req.fps) {
        return bad("fps must be between 0.1 and 120");
    }
    if !req.start_sec.is_finite() || req.start_sec < 0.0 {
        return bad("start time must be a non-negative number");
    }
    if let Some(end) = req.end_sec {
        if !end.is_finite() || end <= req.start_sec {
            return bad("end time must be greater than the start time");
        }
    }
    if req.frame_skip > 64 {
        return bad("frame skip must be at most 64");
    }
    if req.max_frames == 0 || req.max_frames > MAX_FRAMES {
        return Err(Error::InvalidParam(format!("max frames must be between 1 and {MAX_FRAMES}")));
    }
    for (name, v) in [("width", req.width), ("height", req.height)] {
        if let Some(v) = v {
            if v == 0 || v > 8192 {
                return Err(Error::InvalidParam(format!("{name} must be between 1 and 8192")));
            }
        }
    }
    if !req.out_dir.is_absolute() {
        return bad("output directory must be an absolute path");
    }
    crate::sanitize::reject_traversal(&req.out_dir)?;
    Ok(())
}

/// Number formatting that can never produce `NaN`, `inf`, exponents or locale commas.
fn num(v: f64) -> String {
    let s = format!("{v:.6}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s.is_empty() { "0".to_string() } else { s.to_string() }
}

/// Builds the `-vf` filter chain. Pure function so it is unit-testable.
pub fn build_filter(req: &ExtractRequest) -> String {
    let mut f: Vec<String> = Vec::new();
    let fps = num(req.fps);
    f.push(match req.interpolation {
        Interpolation::None => format!("fps=fps={fps}"),
        Interpolation::Blend => format!("framerate=fps={fps}"),
        Interpolation::Motion => format!("minterpolate=fps={fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1"),
    });
    if req.frame_skip > 0 {
        // keep every (skip+1)-th frame; the comma inside the expression must be escaped
        f.push(format!("select=not(mod(n\\,{}))", req.frame_skip + 1));
    }
    match (req.width, req.height) {
        (Some(w), Some(h)) if req.keep_aspect => {
            f.push(format!("scale=w={w}:h={h}:force_original_aspect_ratio=decrease:flags=lanczos"))
        }
        (Some(w), Some(h)) => f.push(format!("scale=w={w}:h={h}:flags=lanczos")),
        (Some(w), None) => f.push(format!("scale=w={w}:h={}:flags=lanczos", if req.keep_aspect { "-1" } else { "ih" })),
        (None, Some(h)) => f.push(format!("scale=w={}:h={h}:flags=lanczos", if req.keep_aspect { "-1" } else { "iw" })),
        (None, None) => {}
    }
    f.push("format=rgba".to_string());
    f.join(",")
}

/// Builds the full FFmpeg argument vector (excluding the program itself).
pub fn build_args(
    req: &ExtractRequest,
    input: &Path,
    demuxer: &str,
    decode_vp_alpha: Option<&str>,
    version: &ToolVersion,
) -> Vec<OsString> {
    let mut a: Vec<OsString> = Vec::new();
    let mut push = |s: &str| a.push(OsString::from(s));
    for s in ["-hide_banner", "-nostdin", "-v", "error", "-nostats", "-progress", "pipe:1", "-protocol_whitelist", "file"] {
        push(s);
    }
    if let Some(dec) = decode_vp_alpha {
        push("-c:v");
        push(dec);
    }
    if req.start_sec > 0.0 {
        push("-ss");
        push(&num(req.start_sec));
    }
    if let Some(end) = req.end_sec {
        push("-t");
        push(&num(end - req.start_sec));
    }
    push("-f");
    push(demuxer);
    push("-i");
    let mut input_arg = OsString::from("file:");
    input_arg.push(input.as_os_str());
    a.push(input_arg);
    for s in ["-an", "-sn", "-dn", "-vf"] {
        a.push(OsString::from(s));
    }
    a.push(OsString::from(build_filter(req)));
    a.push(OsString::from("-frames:v"));
    a.push(OsString::from(req.max_frames.to_string()));
    if version.supports_fps_mode() {
        a.push(OsString::from("-fps_mode"));
        a.push(OsString::from("passthrough"));
    } else {
        a.push(OsString::from("-vsync"));
        a.push(OsString::from("0"));
    }
    for s in ["-compression_level", "3", "-start_number", "0", "-y"] {
        a.push(OsString::from(s));
    }
    let mut out = OsString::from(req.out_dir.as_os_str());
    out.push(std::path::MAIN_SEPARATOR_STR);
    out.push("frame_%05d.png");
    a.push(out);
    a
}

fn is_frame_file(name: &str) -> bool {
    name.len() == 15
        && name.starts_with("frame_")
        && name.ends_with(".png")
        && name[6..11].bytes().all(|b| b.is_ascii_digit())
}

/// Deletes frames produced by a previous run (only files matching our own naming scheme).
pub fn clear_frames(dir: &Path) {
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            if is_frame_file(&e.file_name().to_string_lossy()) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

fn png_dimensions(path: &Path) -> Result<(u32, u32)> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|e| Error::io("opening extracted frame", e))?;
    let mut h = [0u8; 24];
    f.read_exact(&mut h).map_err(|e| Error::io("reading extracted frame header", e))?;
    if h[..8] != [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A] {
        return Err(Error::Data("FFmpeg produced a file that is not a PNG".into()));
    }
    Ok((u32::from_be_bytes([h[16], h[17], h[18], h[19]]), u32::from_be_bytes([h[20], h[21], h[22], h[23]])))
}

fn list_frames(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut frames: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| Error::io("listing extracted frames", e))?
        .flatten()
        .filter(|e| is_frame_file(&e.file_name().to_string_lossy()))
        .map(|e| e.path())
        .collect();
    frames.sort();
    Ok(frames)
}

/// Extracts frames to `req.out_dir/frame_00000.png ...`. Blocks until done; call from a
/// worker thread. Reports progress through `on_progress` and honours `cancel`.
pub fn extract_frames(
    ffmpeg: &Path,
    ffprobe: &Path,
    req: &ExtractRequest,
    cancel: &CancelToken,
    on_progress: Option<Arc<dyn Fn(Progress) + Send + Sync>>,
) -> Result<ExtractResult> {
    validate(req)?;
    let (canon, sniffed, _) = identify(&req.input)?;
    let demuxer = sniffed.kind.ffmpeg_demuxer().ok_or_else(|| {
        Error::UnsupportedFormat(format!("{:?} files cannot be decoded by FFmpeg here", sniffed.kind))
    })?;
    let info: MediaInfo = probe(ffprobe, &canon)?;
    if let Some(d) = info.duration_sec {
        if req.start_sec >= d && d > 0.0 {
            return Err(Error::InvalidParam(format!(
                "start time {:.2}s is beyond the end of the media ({d:.2}s)",
                req.start_sec
            )));
        }
    }
    let version = ffmpeg_version(ffmpeg)?;

    std::fs::create_dir_all(&req.out_dir).map_err(|e| Error::io("creating the frame folder", e))?;
    clear_frames(&req.out_dir);

    // VP8/VP9 alpha lives in side data that only libvpx decodes
    let vp_decoder = if info.has_alpha {
        match info.codec.as_deref() {
            Some("vp9") => Some("libvpx-vp9"),
            Some("vp8") => Some("libvpx"),
            _ => None,
        }
    } else {
        None
    };

    let span = match (req.end_sec, info.duration_sec) {
        (Some(e), _) => Some(e - req.start_sec),
        (None, Some(d)) => Some((d - req.start_sec).max(0.0)),
        _ => None,
    };
    let expected = span.map(|s| {
        (((s * req.fps) / f64::from(req.frame_skip + 1)).ceil() as u64).min(u64::from(req.max_frames))
    });

    let args = build_args(req, &canon, demuxer, vp_decoder, &version);
    let mut cmd = command(ffmpeg);
    cmd.args(&args);

    let cb: Option<LineCallback> = on_progress.map(|p| {
        let f: LineCallback = Arc::new(move |line: &str| {
            if let Some(n) = line.strip_prefix("frame=") {
                if let Ok(done) = n.trim().parse::<u64>() {
                    p(Progress { frames_done: done, frames_expected: expected });
                }
            }
        });
        f
    });

    let result = run(cmd, "ffmpeg", cancel, DEFAULT_TIMEOUT, cb);
    let out = match result {
        Ok(o) => o,
        Err(e) => {
            clear_frames(&req.out_dir);
            return Err(e);
        }
    };
    let frames = list_frames(&req.out_dir)?;
    if !out.success || frames.is_empty() {
        let detail = if out.stderr_tail.is_empty() {
            "no frames were produced (the file may be corrupt, or the time range is empty)".to_string()
        } else {
            out.stderr_tail
        };
        clear_frames(&req.out_dir);
        return Err(Error::ToolFailed { tool: "ffmpeg".into(), code: out.code, detail });
    }
    let (width, height) = png_dimensions(&frames[0])?;
    Ok(ExtractResult { dir: req.out_dir.clone(), frames, width, height, fps: req.fps })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> ExtractRequest {
        ExtractRequest {
            input: PathBuf::from("/tmp/in.mp4"),
            out_dir: PathBuf::from("/tmp/out"),
            start_sec: 0.0,
            end_sec: None,
            fps: 16.0,
            frame_skip: 0,
            max_frames: 16,
            width: None,
            height: None,
            keep_aspect: true,
            interpolation: Interpolation::None,
        }
    }

    fn modern() -> ToolVersion {
        crate::tools::parse_ffmpeg_version("ffmpeg version 6.1.1")
    }

    #[test]
    fn filter_chain_variants() {
        assert_eq!(build_filter(&req()), "fps=fps=16,format=rgba");
        let mut r = req();
        r.fps = 29.97;
        r.frame_skip = 2;
        r.width = Some(256);
        r.height = Some(256);
        assert_eq!(
            build_filter(&r),
            "fps=fps=29.97,select=not(mod(n\\,3)),scale=w=256:h=256:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba"
        );
        r.keep_aspect = false;
        assert!(build_filter(&r).contains("scale=w=256:h=256:flags=lanczos"));
        r.height = None;
        assert!(build_filter(&r).contains("scale=w=256:h=ih"));
        r.keep_aspect = true;
        assert!(build_filter(&r).contains("scale=w=256:h=-1"));
        r.interpolation = Interpolation::Blend;
        assert!(build_filter(&r).starts_with("framerate=fps=29.97"));
        r.interpolation = Interpolation::Motion;
        assert!(build_filter(&r).starts_with("minterpolate=fps=29.97:mi_mode=mci"));
    }

    #[test]
    fn args_contain_only_expected_tokens_and_safe_input() {
        let mut r = req();
        r.start_sec = 1.5;
        r.end_sec = Some(3.0);
        let hostile = Path::new("/tmp/evil name; rm -rf -- $(x) \"q\".mp4");
        let args: Vec<String> = build_args(&r, hostile, "mov,mp4,m4a,3gp,3g2,mj2", None, &modern())
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        // input is passed verbatim as ONE argv element behind `file:` (no shell, no splitting)
        let i = args.iter().position(|a| a == "-i").unwrap();
        assert_eq!(args[i + 1], "file:/tmp/evil name; rm -rf -- $(x) \"q\".mp4");
        // forced demuxer immediately before -i
        assert_eq!(args[i - 2], "-f");
        assert_eq!(args[i - 1], "mov,mp4,m4a,3gp,3g2,mj2");
        assert!(args.windows(2).any(|w| w == ["-protocol_whitelist", "file"]));
        assert!(args.windows(2).any(|w| w == ["-ss", "1.5"]));
        assert!(args.windows(2).any(|w| w == ["-t", "1.5"]));
        assert!(args.windows(2).any(|w| w == ["-fps_mode", "passthrough"]));
        assert!(args.last().unwrap().ends_with("frame_%05d.png"));
        // old ffmpeg falls back to -vsync 0
        let old = crate::tools::parse_ffmpeg_version("ffmpeg version 4.4.2");
        let old_args: Vec<String> = build_args(&r, Path::new("/x.mp4"), "avi", None, &old)
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(old_args.windows(2).any(|w| w == ["-vsync", "0"]));
        assert!(!old_args.contains(&"-fps_mode".to_string()));
        // alpha decoder is inserted before the input
        let vp: Vec<String> = build_args(&r, Path::new("/x.webm"), "matroska,webm", Some("libvpx-vp9"), &modern())
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let ci = vp.iter().position(|a| a == "-c:v").unwrap();
        assert!(ci < vp.iter().position(|a| a == "-i").unwrap());
    }

    #[test]
    fn numbers_never_leak_nan_or_exponents() {
        assert_eq!(num(16.0), "16");
        assert_eq!(num(0.1), "0.1");
        assert_eq!(num(1e-9), "0");
        assert_eq!(num(1234567.5), "1234567.5");
    }

    #[test]
    fn validation_rejects_bad_parameters() {
        let mut r = req();
        assert!(validate(&r).is_ok());
        for mutate in [
            (|r: &mut ExtractRequest| r.fps = 0.0) as fn(&mut ExtractRequest),
            |r| r.fps = f64::NAN,
            |r| r.fps = 500.0,
            |r| r.start_sec = -1.0,
            |r| r.start_sec = f64::INFINITY,
            |r| r.end_sec = Some(0.0),
            |r| r.frame_skip = 65,
            |r| r.max_frames = 0,
            |r| r.max_frames = MAX_FRAMES + 1,
            |r| r.width = Some(0),
            |r| r.height = Some(9000),
            |r| r.out_dir = PathBuf::from("relative/out"),
            |r| r.out_dir = PathBuf::from("/tmp/../etc"),
        ] {
            r = req();
            mutate(&mut r);
            assert!(validate(&r).is_err(), "{r:?}");
        }
    }

    #[test]
    fn frame_file_pattern() {
        assert!(is_frame_file("frame_00000.png"));
        assert!(is_frame_file("frame_00123.png"));
        assert!(!is_frame_file("frame_0001.png"));
        assert!(!is_frame_file("frame_abcde.png"));
        assert!(!is_frame_file("other.png"));
        assert!(!is_frame_file("frame_00000.png.bak"));
    }
}
