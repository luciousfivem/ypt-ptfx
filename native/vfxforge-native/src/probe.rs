//! Media probing via ffprobe.

use crate::error::{Error, Result};
use crate::sanitize::require_existing_file;
use crate::sniff::{sniff, Category, MediaKind, Sniffed};
use crate::tools::command;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct MediaInfo {
    pub kind: MediaKind,
    pub mime: &'static str,
    pub width: u32,
    pub height: u32,
    pub duration_sec: Option<f64>,
    pub fps: Option<f64>,
    pub frame_count: Option<u64>,
    pub has_alpha: bool,
    pub codec: Option<String>,
    pub bytes: u64,
}

#[derive(Debug, Deserialize)]
struct FfprobeOutput {
    #[serde(default)]
    streams: Vec<FfStream>,
    #[serde(default)]
    format: Option<FfFormat>,
}

#[derive(Debug, Deserialize)]
struct FfFormat {
    duration: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FfStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    pix_fmt: Option<String>,
    avg_frame_rate: Option<String>,
    r_frame_rate: Option<String>,
    nb_frames: Option<String>,
    duration: Option<String>,
    #[serde(default)]
    tags: std::collections::HashMap<String, String>,
}

/// "30000/1001" -> 29.97; "0/0" -> None
pub fn parse_rate(s: &str) -> Option<f64> {
    let (n, d) = match s.split_once('/') {
        Some((n, d)) => (n.trim().parse::<f64>().ok()?, d.trim().parse::<f64>().ok()?),
        None => (s.trim().parse::<f64>().ok()?, 1.0),
    };
    if d == 0.0 || !n.is_finite() || !d.is_finite() {
        return None;
    }
    let r = n / d;
    (r > 0.0 && r < 10_000.0).then_some(r)
}

fn pix_fmt_has_alpha(pix_fmt: &str) -> bool {
    // rgba, bgra, argb, abgr, yuva*, gbrap*, ya8, ya16, pal8 (may carry alpha), ...
    let p = pix_fmt.to_lowercase();
    p.contains("yuva")
        || p.contains("gbrap")
        || p.starts_with("ya")
        || p == "pal8"
        || p.ends_with('a') && (p.contains("rgb") || p.contains("bgr"))
        || p.starts_with('a') && (p.contains("rgb") || p.contains("bgr"))
        || p.contains("rgba")
        || p.contains("bgra")
}

pub fn parse_ffprobe_json(kind: Sniffed, json: &str, bytes: u64) -> Result<MediaInfo> {
    let parsed: FfprobeOutput = serde_json::from_str(json)
        .map_err(|e| Error::Data(format!("could not parse ffprobe output: {e}")))?;
    let video = parsed
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("video"))
        .ok_or_else(|| Error::NotMedia("the file contains no video stream".into()))?;
    let (w, h) = match (video.width, video.height) {
        (Some(w), Some(h)) if w > 0 && h > 0 => (w, h),
        _ => return Err(Error::NotMedia("video stream has no valid dimensions".into())),
    };
    let fps = video
        .avg_frame_rate
        .as_deref()
        .and_then(parse_rate)
        .or_else(|| video.r_frame_rate.as_deref().and_then(parse_rate));
    let duration = video
        .duration
        .as_deref()
        .and_then(|d| d.parse::<f64>().ok())
        .or_else(|| {
            parsed
                .format
                .as_ref()
                .and_then(|f| f.duration.as_deref())
                .and_then(|d| d.parse::<f64>().ok())
        })
        .filter(|d| d.is_finite() && *d >= 0.0);
    let frame_count = video
        .nb_frames
        .as_deref()
        .and_then(|n| n.parse::<u64>().ok())
        .or_else(|| match (duration, fps) {
            (Some(d), Some(f)) => Some((d * f).round() as u64),
            _ => None,
        });
    let alpha_tag = video
        .tags
        .iter()
        .any(|(k, v)| k.eq_ignore_ascii_case("alpha_mode") && v == "1");
    let has_alpha = alpha_tag || video.pix_fmt.as_deref().map(pix_fmt_has_alpha).unwrap_or(false);
    Ok(MediaInfo {
        kind: kind.kind,
        mime: kind.mime,
        width: w,
        height: h,
        duration_sec: duration,
        fps,
        frame_count,
        has_alpha,
        codec: video.codec_name.clone(),
        bytes,
    })
}

/// Reads up to 8 KiB from the start of the file for signature detection.
pub fn read_head(path: &Path) -> Result<Vec<u8>> {
    let mut f = std::fs::File::open(path).map_err(|e| Error::io(format!("opening {}", path.display()), e))?;
    let mut buf = vec![0u8; 8192];
    let n = f.read(&mut buf).map_err(|e| Error::io("reading file header", e))?;
    buf.truncate(n);
    Ok(buf)
}

/// Resolves the file, classifies it by content and returns the sniff result with the
/// canonical path. Fails for anything that is not a recognised image/video/model.
pub fn identify(path: &Path) -> Result<(PathBuf, Sniffed, u64)> {
    let canon = require_existing_file(path)?;
    let head = read_head(&canon)?;
    let sniffed = sniff(&head);
    if sniffed.category == Category::Unknown {
        return Err(Error::UnsupportedFormat(format!(
            "{} is not a recognised image, video or 3D model (checked the file signature, not the extension)",
            canon.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
        )));
    }
    let bytes = std::fs::metadata(&canon).map_err(|e| Error::io("reading file size", e))?.len();
    Ok((canon, sniffed, bytes))
}

/// Probes a video / animated image with ffprobe. The demuxer is forced from the sniffed
/// signature (see [`MediaKind::ffmpeg_demuxer`]) so a crafted file cannot redirect FFmpeg.
pub fn probe(ffprobe: &Path, path: &Path) -> Result<MediaInfo> {
    let (canon, sniffed, bytes) = identify(path)?;
    let demuxer = sniffed.kind.ffmpeg_demuxer().ok_or_else(|| {
        Error::UnsupportedFormat(format!(
            "{:?} files are not probed with FFmpeg (use the built-in image decoder)",
            sniffed.kind
        ))
    })?;
    let out = command(ffprobe)
        .args(["-v", "error", "-hide_banner", "-protocol_whitelist", "file", "-print_format", "json", "-show_format", "-show_streams", "-f"])
        .arg(demuxer)
        .arg("-i")
        .arg(format!("file:{}", canon.display()))
        .output()
        .map_err(|e| Error::io("running ffprobe", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail: String = stderr.trim().lines().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" | ");
        return Err(Error::NotMedia(if tail.is_empty() {
            "ffprobe could not read the file (it may be corrupt or truncated)".into()
        } else {
            tail
        }));
    }
    parse_ffprobe_json(sniffed, &String::from_utf8_lossy(&out.stdout), bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mp4() -> Sniffed {
        sniff(b"\x00\x00\x00\x20ftypisom\x00\x00\x02\x00")
    }

    #[test]
    fn parses_rates() {
        assert_eq!(parse_rate("16/1"), Some(16.0));
        assert!((parse_rate("30000/1001").unwrap() - 29.97).abs() < 0.01);
        assert_eq!(parse_rate("0/0"), None);
        assert_eq!(parse_rate("garbage"), None);
        assert_eq!(parse_rate("25"), Some(25.0));
        assert_eq!(parse_rate("-5/1"), None);
    }

    #[test]
    fn detects_alpha_pixel_formats() {
        for f in ["rgba", "bgra", "argb", "yuva420p", "yuva444p10le", "gbrap", "pal8", "ya8"] {
            assert!(pix_fmt_has_alpha(f), "{f}");
        }
        for f in ["yuv420p", "rgb24", "bgr24", "gray", "yuv444p", "nv12"] {
            assert!(!pix_fmt_has_alpha(f), "{f}");
        }
    }

    #[test]
    fn parses_typical_ffprobe_output() {
        let json = r#"{"streams":[{"codec_type":"video","codec_name":"h264","width":128,"height":96,"pix_fmt":"yuv420p","avg_frame_rate":"16/1","nb_frames":"32","duration":"2.000000"}],"format":{"duration":"2.000000"}}"#;
        let i = parse_ffprobe_json(mp4(), json, 1000).unwrap();
        assert_eq!((i.width, i.height, i.frame_count), (128, 96, Some(32)));
        assert_eq!(i.fps, Some(16.0));
        assert!(!i.has_alpha);
    }

    #[test]
    fn derives_frame_count_when_missing_and_handles_webm_alpha_tag() {
        let json = r#"{"streams":[{"codec_type":"video","codec_name":"vp9","width":64,"height":64,"pix_fmt":"yuv420p","avg_frame_rate":"30/1","tags":{"alpha_mode":"1"}}],"format":{"duration":"1.5"}}"#;
        let i = parse_ffprobe_json(mp4(), json, 1).unwrap();
        assert_eq!(i.frame_count, Some(45));
        assert!(i.has_alpha);
    }

    #[test]
    fn rejects_audio_only_and_garbage() {
        let audio = r#"{"streams":[{"codec_type":"audio","codec_name":"aac"}],"format":{}}"#;
        assert!(matches!(parse_ffprobe_json(mp4(), audio, 1), Err(Error::NotMedia(_))));
        assert!(matches!(parse_ffprobe_json(mp4(), "not json", 1), Err(Error::Data(_))));
        let nodims = r#"{"streams":[{"codec_type":"video","codec_name":"h264"}]}"#;
        assert!(matches!(parse_ffprobe_json(mp4(), nodims, 1), Err(Error::NotMedia(_))));
    }
}
