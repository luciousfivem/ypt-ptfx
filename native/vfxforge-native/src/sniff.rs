//! File-signature (magic number) detection. File extensions are never trusted: a `.png`
//! that is really an MP4 (or a playlist that FFmpeg would happily follow) is classified by
//! content.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Png,
    Apng,
    Jpeg,
    Gif,
    Webp,
    Mp4,
    Mov,
    Webm,
    Mkv,
    Avi,
    Glb,
    Gltf,
    Obj,
    Fbx,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Image,
    Video,
    Model,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
pub struct Sniffed {
    pub kind: MediaKind,
    pub category: Category,
    pub mime: &'static str,
}

impl MediaKind {
    pub fn category(self) -> Category {
        use MediaKind::*;
        match self {
            Png | Apng | Jpeg | Gif | Webp => Category::Image,
            Mp4 | Mov | Webm | Mkv | Avi => Category::Video,
            Glb | Gltf | Obj | Fbx => Category::Model,
            Unknown => Category::Unknown,
        }
    }

    pub fn mime(self) -> &'static str {
        use MediaKind::*;
        match self {
            Png => "image/png",
            Apng => "image/apng",
            Jpeg => "image/jpeg",
            Gif => "image/gif",
            Webp => "image/webp",
            Mp4 => "video/mp4",
            Mov => "video/quicktime",
            Webm => "video/webm",
            Mkv => "video/x-matroska",
            Avi => "video/x-msvideo",
            Glb => "model/gltf-binary",
            Gltf => "model/gltf+json",
            Obj => "model/obj",
            Fbx => "application/octet-stream",
            Unknown => "application/octet-stream",
        }
    }

    /// The ONLY FFmpeg demuxer allowed for this kind. Forcing it with `-f` means a
    /// malicious file cannot make FFmpeg switch to a playlist/concat/URL-following demuxer.
    /// `None` = this kind must not be sent to FFmpeg.
    pub fn ffmpeg_demuxer(self) -> Option<&'static str> {
        use MediaKind::*;
        match self {
            Mp4 | Mov => Some("mov,mp4,m4a,3gp,3g2,mj2"),
            Webm | Mkv => Some("matroska,webm"),
            Avi => Some("avi"),
            Gif => Some("gif"),
            Apng => Some("apng"),
            // FFmpeg 6.x has no animated-WebP demuxer (only `webp_pipe`, stills). WebP is
            // decoded by the frontend (WebCodecs ImageDecoder) instead.
            _ => None,
        }
    }

    /// Extensions that are plausible for this kind (lowercase, no dot).
    pub fn extensions(self) -> &'static [&'static str] {
        use MediaKind::*;
        match self {
            Png | Apng => &["png", "apng"],
            Jpeg => &["jpg", "jpeg"],
            Gif => &["gif"],
            Webp => &["webp"],
            Mp4 => &["mp4", "m4v"],
            Mov => &["mov"],
            Webm => &["webm"],
            Mkv => &["mkv"],
            Avi => &["avi"],
            Glb => &["glb"],
            Gltf => &["gltf"],
            Obj => &["obj"],
            Fbx => &["fbx"],
            Unknown => &[],
        }
    }
}

fn is_png_animated(b: &[u8]) -> bool {
    // walk chunks until IDAT; an `acTL` chunk before it means APNG
    let mut i = 8usize;
    while i + 8 <= b.len() {
        let len = u32::from_be_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]) as usize;
        let ty = &b[i + 4..i + 8];
        if ty == b"acTL" {
            return true;
        }
        if ty == b"IDAT" || ty == b"IEND" {
            return false;
        }
        i = match i.checked_add(12 + len) {
            Some(n) => n,
            None => return false,
        };
    }
    false
}

/// Classifies `head` (the first few KiB of a file; 4096+ bytes recommended).
pub fn sniff(head: &[u8]) -> Sniffed {
    let kind = detect(head);
    Sniffed {
        kind,
        category: kind.category(),
        mime: kind.mime(),
    }
}

fn detect(b: &[u8]) -> MediaKind {
    if b.len() >= 8 && b[..8] == [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A] {
        return if is_png_animated(b) {
            MediaKind::Apng
        } else {
            MediaKind::Png
        };
    }
    if b.len() >= 3 && b[..3] == [0xFF, 0xD8, 0xFF] {
        return MediaKind::Jpeg;
    }
    if b.len() >= 6 && (&b[..6] == b"GIF87a" || &b[..6] == b"GIF89a") {
        return MediaKind::Gif;
    }
    if b.len() >= 12 && &b[..4] == b"RIFF" {
        match &b[8..12] {
            b"WEBP" => return MediaKind::Webp,
            b"AVI " => return MediaKind::Avi,
            _ => {}
        }
    }
    if b.len() >= 12 && &b[4..8] == b"ftyp" {
        return if &b[8..12] == b"qt  " {
            MediaKind::Mov
        } else {
            MediaKind::Mp4
        };
    }
    if b.len() >= 4 && b[..4] == [0x1A, 0x45, 0xDF, 0xA3] {
        let window = &b[..b.len().min(64)];
        return if window.windows(4).any(|w| w == b"webm") {
            MediaKind::Webm
        } else {
            MediaKind::Mkv
        };
    }
    if b.len() >= 4 && &b[..4] == b"glTF" {
        return MediaKind::Glb;
    }
    if b.len() >= 20 && &b[..20] == b"Kaydara FBX Binary  " {
        return MediaKind::Fbx;
    }
    // Text formats: only trust them when the head is valid UTF-8 text.
    if let Ok(text) = std::str::from_utf8(&b[..b.len().min(4096)]).or_else(|e| {
        // a multi-byte char may be cut at the 4096 boundary; accept the valid prefix
        std::str::from_utf8(&b[..e.valid_up_to()])
    }) {
        let trimmed = text.trim_start();
        if trimmed.starts_with('{') && text.contains("\"asset\"") && text.contains("\"version\"") {
            return MediaKind::Gltf;
        }
        let looks_obj = text.lines().take(200).any(|l| {
            let l = l.trim_start();
            l.starts_with("v ") || l.starts_with("vn ") || l.starts_with("vt ") || l.starts_with("f ")
        });
        if looks_obj && !text.contains('\0') {
            return MediaKind::Obj;
        }
    }
    MediaKind::Unknown
}

/// True when the file extension is consistent with the detected content.
pub fn extension_matches(kind: MediaKind, ext: &str) -> bool {
    let e = ext.trim_start_matches('.').to_lowercase();
    kind.extensions().contains(&e.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_head(animated: bool) -> Vec<u8> {
        let mut v = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        // IHDR (13 bytes of data)
        v.extend_from_slice(&13u32.to_be_bytes());
        v.extend_from_slice(b"IHDR");
        v.extend_from_slice(&[0u8; 13]);
        v.extend_from_slice(&[0u8; 4]);
        if animated {
            v.extend_from_slice(&8u32.to_be_bytes());
            v.extend_from_slice(b"acTL");
            v.extend_from_slice(&[0u8; 8]);
            v.extend_from_slice(&[0u8; 4]);
        }
        v.extend_from_slice(&0u32.to_be_bytes());
        v.extend_from_slice(b"IDAT");
        v
    }

    #[test]
    fn detects_images() {
        assert_eq!(sniff(&png_head(false)).kind, MediaKind::Png);
        assert_eq!(sniff(&png_head(true)).kind, MediaKind::Apng);
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0]).kind, MediaKind::Jpeg);
        assert_eq!(sniff(b"GIF89a....").kind, MediaKind::Gif);
        assert_eq!(sniff(b"RIFF\x00\x00\x00\x00WEBPVP8 ").kind, MediaKind::Webp);
    }

    #[test]
    fn detects_video() {
        assert_eq!(sniff(b"\x00\x00\x00\x20ftypisom\x00\x00\x02\x00").kind, MediaKind::Mp4);
        assert_eq!(sniff(b"\x00\x00\x00\x14ftypqt  \x00\x00\x00\x00").kind, MediaKind::Mov);
        assert_eq!(sniff(b"RIFF\x00\x00\x00\x00AVI LIST").kind, MediaKind::Avi);
        let mut webm = vec![0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42, 0x82, 0x84];
        webm.extend_from_slice(b"webm");
        assert_eq!(sniff(&webm).kind, MediaKind::Webm);
        assert_eq!(sniff(&[0x1A, 0x45, 0xDF, 0xA3, 0, 0, 0, 0]).kind, MediaKind::Mkv);
    }

    #[test]
    fn detects_models() {
        assert_eq!(sniff(b"glTF\x02\x00\x00\x00").kind, MediaKind::Glb);
        assert_eq!(sniff(b"Kaydara FBX Binary  \x00\x1a\x00").kind, MediaKind::Fbx);
        assert_eq!(sniff(br#"{"asset":{"version":"2.0"},"scenes":[]}"#).kind, MediaKind::Gltf);
        assert_eq!(sniff(b"# comment\nv 0 0 0\nv 1 0 0\nf 1 2 3\n").kind, MediaKind::Obj);
    }

    #[test]
    fn rejects_playlists_and_garbage() {
        // an HLS playlist / ffconcat script must NEVER be classified as media
        assert_eq!(sniff(b"#EXTM3U\n#EXT-X-VERSION:3\nfile:///etc/passwd\n").kind, MediaKind::Unknown);
        assert_eq!(sniff(b"ffconcat version 1.0\nfile '/etc/passwd'\n").kind, MediaKind::Unknown);
        assert_eq!(sniff(&[1, 2, 3, 4, 5]).kind, MediaKind::Unknown);
        assert_eq!(sniff(&[]).kind, MediaKind::Unknown);
    }

    #[test]
    fn extension_mismatch_is_detectable() {
        assert!(extension_matches(MediaKind::Png, ".PNG"));
        assert!(!extension_matches(MediaKind::Mp4, "png"));
        assert_eq!(MediaKind::Mp4.ffmpeg_demuxer(), Some("mov,mp4,m4a,3gp,3g2,mj2"));
        assert_eq!(MediaKind::Unknown.ffmpeg_demuxer(), None);
    }
}
