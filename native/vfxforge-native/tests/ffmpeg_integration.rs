//! Integration tests against the REAL ffmpeg/ffprobe on this machine.
//!
//! The fixture video is lossless (libx264rgb, crf 0) and every frame is a flat colour whose
//! red channel equals `frame_index * 8` — so after extraction we can verify exact content
//! and exact ordering, not just "some PNGs appeared".

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use vfxforge_native::extract::{extract_frames, ExtractRequest, Interpolation};
use vfxforge_native::jobs::CancelToken;
use vfxforge_native::probe::probe;
use vfxforge_native::{Error, MediaTools};

fn tools() -> MediaTools {
    MediaTools::discover(None, None, &[]).expect("ffmpeg and ffprobe must be installed to run these tests")
}

/// 64x48 video, `frames` frames at `fps`, red channel = index*8, green = 255 - index*8.
fn make_video(dir: &Path, name: &str, frames: u32, fps: u32, codec_args: &[&str]) -> PathBuf {
    let out = dir.join(name);
    let dur = f64::from(frames) / f64::from(fps);
    let status = Command::new(tools().ffmpeg)
        .args(["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i"])
        .arg(format!("color=c=black:s=64x48:r={fps}:d={dur}"))
        .args(["-vf", "format=rgb24,geq=r='N*8':g='255-N*8':b=0"])
        .args(codec_args)
        .arg(&out)
        .status()
        .expect("spawn ffmpeg");
    assert!(status.success(), "fixture generation failed for {name}");
    out
}

fn lossless_mp4(dir: &Path, frames: u32, fps: u32) -> PathBuf {
    make_video(dir, "fixture.mp4", frames, fps, &["-c:v", "libx264rgb", "-crf", "0", "-pix_fmt", "rgb24"])
}

fn req(input: &Path, out: &Path) -> ExtractRequest {
    ExtractRequest {
        input: input.to_path_buf(),
        out_dir: out.to_path_buf(),
        start_sec: 0.0,
        end_sec: None,
        fps: 16.0,
        frame_skip: 0,
        max_frames: 64,
        width: None,
        height: None,
        keep_aspect: true,
        interpolation: Interpolation::None,
    }
}

fn extract(r: &ExtractRequest) -> vfxforge_native::Result<vfxforge_native::extract::ExtractResult> {
    let t = tools();
    extract_frames(&t.ffmpeg, &t.ffprobe, r, &CancelToken::new(), None)
}

fn first_pixel(png_path: &Path) -> [u8; 4] {
    let decoder = png::Decoder::new(std::io::BufReader::new(std::fs::File::open(png_path).unwrap()));
    let mut reader = decoder.read_info().unwrap();
    let mut buf = vec![0; reader.output_buffer_size().unwrap()];
    let info = reader.next_frame(&mut buf).unwrap();
    assert_eq!(info.color_type, png::ColorType::Rgba, "extracted frames must be RGBA");
    [buf[0], buf[1], buf[2], buf[3]]
}

#[test]
fn probe_reports_real_stream_properties() {
    let dir = tempfile::tempdir().unwrap();
    let video = lossless_mp4(dir.path(), 32, 16);
    let info = probe(&tools().ffprobe, &video).unwrap();
    assert_eq!((info.width, info.height), (64, 48));
    assert_eq!(info.fps, Some(16.0));
    assert_eq!(info.frame_count, Some(32));
    assert!((info.duration_sec.unwrap() - 2.0).abs() < 0.05);
    assert!(!info.has_alpha);
    assert_eq!(info.kind, vfxforge_native::sniff::MediaKind::Mp4);
    assert_eq!(info.mime, "video/mp4");
}

#[test]
fn extracts_every_frame_in_exact_order_with_exact_content() {
    let dir = tempfile::tempdir().unwrap();
    let video = lossless_mp4(dir.path(), 16, 16);
    let res = extract(&req(&video, &dir.path().join("frames"))).unwrap();
    assert_eq!(res.frames.len(), 16);
    assert_eq!((res.width, res.height), (64, 48));
    for (i, f) in res.frames.iter().enumerate() {
        assert_eq!(f.file_name().unwrap().to_string_lossy(), format!("frame_{i:05}.png"));
        let px = first_pixel(f);
        assert_eq!(px, [(i as u8) * 8, 255 - (i as u8) * 8, 0, 255], "frame {i}");
    }
}

#[test]
fn time_window_and_frame_cap() {
    let dir = tempfile::tempdir().unwrap();
    let video = lossless_mp4(dir.path(), 32, 16); // 2 s
    let mut r = req(&video, &dir.path().join("w"));
    r.start_sec = 0.5;
    r.end_sec = Some(1.5); // 1 s window => 16 frames starting at source frame 8
    let res = extract(&r).unwrap();
    assert_eq!(res.frames.len(), 16);
    assert_eq!(first_pixel(&res.frames[0])[0], 8 * 8, "window must start at source frame 8");

    let mut capped = req(&video, &dir.path().join("cap"));
    capped.max_frames = 5;
    assert_eq!(extract(&capped).unwrap().frames.len(), 5);
}

#[test]
fn output_fps_and_frame_skip() {
    let dir = tempfile::tempdir().unwrap();
    let video = lossless_mp4(dir.path(), 32, 16); // 2 s @16
    let mut half = req(&video, &dir.path().join("half"));
    half.fps = 8.0;
    let res = extract(&half).unwrap();
    assert_eq!(res.frames.len(), 16, "2 s at 8 fps");
    // every second source frame
    assert_eq!(first_pixel(&res.frames[1])[0], 2 * 8);

    let mut skip = req(&video, &dir.path().join("skip"));
    skip.frame_skip = 3; // keep every 4th of the 16fps frames
    let res = extract(&skip).unwrap();
    assert_eq!(res.frames.len(), 8);
    assert_eq!(first_pixel(&res.frames[1])[0], 4 * 8);
    assert_eq!(first_pixel(&res.frames[2])[0], 8 * 8);
}

#[test]
fn resolution_and_aspect_handling() {
    let dir = tempfile::tempdir().unwrap();
    let video = lossless_mp4(dir.path(), 4, 16);
    let mut r = req(&video, &dir.path().join("a"));
    r.width = Some(32);
    let res = extract(&r).unwrap();
    assert_eq!((res.width, res.height), (32, 24), "width only keeps the aspect ratio");

    let mut boxed = req(&video, &dir.path().join("b"));
    boxed.width = Some(100);
    boxed.height = Some(100);
    let res = extract(&boxed).unwrap();
    assert!(res.width <= 100 && res.height <= 100);
    assert_eq!(res.width, 100, "64x48 scaled to fit a 100x100 box => 100x75");
    assert_eq!(res.height, 75);

    let mut stretch = req(&video, &dir.path().join("c"));
    stretch.width = Some(50);
    stretch.height = Some(50);
    stretch.keep_aspect = false;
    let res = extract(&stretch).unwrap();
    assert_eq!((res.width, res.height), (50, 50));
}

#[test]
fn blend_interpolation_upsamples_frame_count() {
    let dir = tempfile::tempdir().unwrap();
    let video = lossless_mp4(dir.path(), 8, 8); // 1 s @8
    let mut r = req(&video, &dir.path().join("i"));
    r.fps = 16.0;
    r.interpolation = Interpolation::Blend;
    let res = extract(&r).unwrap();
    assert!(res.frames.len() >= 15 && res.frames.len() <= 17, "got {}", res.frames.len());
}

#[test]
fn progress_events_are_reported() {
    let dir = tempfile::tempdir().unwrap();
    let video = lossless_mp4(dir.path(), 32, 16);
    let max = Arc::new(AtomicU64::new(0));
    let m2 = max.clone();
    let t = tools();
    let mut r = req(&video, &dir.path().join("p"));
    r.fps = 16.0;
    extract_frames(&t.ffmpeg, &t.ffprobe, &r, &CancelToken::new(), Some(Arc::new(move |p| {
        m2.fetch_max(p.frames_done, Ordering::SeqCst);
        assert_eq!(p.frames_expected, Some(32));
    })))
    .unwrap();
    assert_eq!(max.load(Ordering::SeqCst), 32);
}

#[test]
fn cancelling_stops_ffmpeg_quickly_and_removes_partial_output() {
    let dir = tempfile::tempdir().unwrap();
    // long & heavy enough that it cannot finish in 300 ms: 20 s of 640x480 @ 30 fps, lossless
    let long = dir.path().join("long.mkv");
    let status = Command::new(tools().ffmpeg)
        .args(["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x480:r=30:d=20", "-c:v", "ffv1"])
        .arg(&long)
        .status()
        .unwrap();
    assert!(status.success());
    let out = dir.path().join("cancelled");
    let token = CancelToken::new();
    let t2 = token.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(250));
        t2.cancel();
    });
    let t = tools();
    let mut r = req(&long, &out);
    r.fps = 30.0;
    r.max_frames = 600;
    let started = Instant::now();
    let err = extract_frames(&t.ffmpeg, &t.ffprobe, &r, &token, None).unwrap_err();
    assert!(matches!(err, Error::Cancelled), "{err:?}");
    assert!(started.elapsed() < Duration::from_secs(10), "cancel took {:?}", started.elapsed());
    let leftovers = std::fs::read_dir(&out).map(|d| d.count()).unwrap_or(0);
    assert_eq!(leftovers, 0, "partial frames must be cleaned up");
}

#[test]
fn corrupt_and_hostile_inputs_fail_with_specific_errors() {
    let dir = tempfile::tempdir().unwrap();
    let good = lossless_mp4(dir.path(), 16, 16);

    // truncated mp4: header is valid, data is missing
    let bytes = std::fs::read(&good).unwrap();
    let truncated = dir.path().join("truncated.mp4");
    std::fs::write(&truncated, &bytes[..bytes.len().min(400)]).unwrap();
    assert!(extract(&req(&truncated, &dir.path().join("t"))).is_err());

    // not media at all, with a lying extension
    let fake = dir.path().join("fake.mp4");
    std::fs::write(&fake, b"this is just text").unwrap();
    assert!(matches!(extract(&req(&fake, &dir.path().join("f"))), Err(Error::UnsupportedFormat(_))));

    // an HLS playlist / ffconcat script pointing at local files must NEVER reach FFmpeg
    let secret = dir.path().join("secret.txt");
    std::fs::write(&secret, "TOP SECRET").unwrap();
    for (name, body) in [
        ("evil.m3u8", format!("#EXTM3U\n#EXTINF:1,\nfile://{}\n", secret.display())),
        ("evil.ffconcat", format!("ffconcat version 1.0\nfile '{}'\n", secret.display())),
    ] {
        let p = dir.path().join(name);
        std::fs::write(&p, body).unwrap();
        let err = extract(&req(&p, &dir.path().join(format!("e-{name}")))).unwrap_err();
        assert!(matches!(err, Error::UnsupportedFormat(_)), "{name}: {err:?}");
    }

    // missing file / relative path
    assert!(matches!(extract(&req(&dir.path().join("nope.mp4"), &dir.path().join("m"))), Err(Error::NotFound(_))));
    assert!(matches!(extract(&req(Path::new("relative.mp4"), &dir.path().join("r"))), Err(Error::UnsafePath(_))));

    // start time beyond the end of the media
    let mut r = req(&good, &dir.path().join("late"));
    r.start_sec = 60.0;
    assert!(matches!(extract(&r), Err(Error::InvalidParam(_))));
}

#[test]
fn missing_ffmpeg_reports_the_tool_and_the_fix() {
    let err = MediaTools::discover(Some(Path::new("/no/such/ffmpeg")), None, &[]).unwrap_err();
    assert!(matches!(err, Error::ToolMissing { .. }));
    assert!(err.to_string().contains("Settings > Tools"));
}

#[test]
fn gif_and_webm_inputs_extract_through_their_forced_demuxers() {
    let dir = tempfile::tempdir().unwrap();
    let gif = make_video(dir.path(), "a.gif", 8, 8, &[]);
    let info = probe(&tools().ffprobe, &gif).unwrap();
    assert_eq!(info.kind, vfxforge_native::sniff::MediaKind::Gif);
    assert_eq!(extract(&{
        let mut r = req(&gif, &dir.path().join("gif"));
        r.fps = 8.0;
        r
    })
    .unwrap()
    .frames
    .len(), 8);

    let webm = make_video(dir.path(), "a.webm", 8, 8, &["-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", "-b:v", "1M"]);
    let info = probe(&tools().ffprobe, &webm).unwrap();
    assert_eq!(info.kind, vfxforge_native::sniff::MediaKind::Webm);
    let mut r = req(&webm, &dir.path().join("webm"));
    r.fps = 8.0;
    assert_eq!(extract(&r).unwrap().frames.len(), 8);
}

#[test]
fn concurrent_extractions_do_not_interfere() {
    let dir = tempfile::tempdir().unwrap();
    let video = lossless_mp4(dir.path(), 16, 16);
    let results = Arc::new(Mutex::new(Vec::new()));
    let handles: Vec<_> = (0..3)
        .map(|i| {
            let video = video.clone();
            let out = dir.path().join(format!("c{i}"));
            let results = results.clone();
            std::thread::spawn(move || {
                let n = extract(&req(&video, &out)).unwrap().frames.len();
                results.lock().unwrap().push(n);
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
    assert_eq!(*results.lock().unwrap(), vec![16, 16, 16]);
}
