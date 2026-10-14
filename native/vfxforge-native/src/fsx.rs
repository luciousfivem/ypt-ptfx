//! Crash-safe file operations and content-addressed asset import.

use crate::error::{Error, IoContext, Result};
use crate::probe::identify;
use crate::sniff::{Category, MediaKind};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_sibling(path: &Path) -> PathBuf {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    let n = TMP_COUNTER.fetch_add(1, Ordering::SeqCst);
    path.with_file_name(format!(".{name}.{}.{n}.tmp", std::process::id()))
}

/// Writes `bytes` to `path` so that readers see either the complete old file or the
/// complete new file, never a partial one: write to a sibling temp file, fsync, rename.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ctx("creating the destination folder")?;
    }
    let tmp = temp_sibling(path);
    let write = || -> std::io::Result<()> {
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        Ok(())
    };
    if let Err(e) = write() {
        let _ = std::fs::remove_file(&tmp);
        return Err(Error::io(format!("writing {}", path.display()), e));
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(Error::io(format!("replacing {}", path.display()), e));
    }
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        if let Ok(d) = std::fs::File::open(parent) {
            let _ = d.sync_all();
        }
    }
    Ok(())
}

pub fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

pub fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    hex(h.finalize().as_slice())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAsset {
    /// Path relative to the project folder, always `assets/<sha256>.<ext>`.
    pub rel_path: String,
    pub sha256: String,
    pub bytes: u64,
    pub kind: MediaKind,
    pub category: Category,
    pub mime: &'static str,
    /// True when an identical asset was already in the store.
    pub deduplicated: bool,
}

/// Copies `src` into `<project_dir>/assets/<sha256>.<ext>`.
///
/// * The original file is only ever read, never modified.
/// * The extension comes from the detected CONTENT, not from the user's file name.
/// * Identical content is stored once.
pub fn import_asset(project_dir: &Path, src: &Path) -> Result<StoredAsset> {
    let (canon, sniffed, _) = identify(src)?;
    let assets = project_dir.join("assets");
    std::fs::create_dir_all(&assets).ctx("creating the assets folder")?;

    let tmp = assets.join(format!(".import-{}-{}.tmp", std::process::id(), TMP_COUNTER.fetch_add(1, Ordering::SeqCst)));
    let result = (|| -> Result<(String, u64)> {
        let mut input = std::fs::File::open(&canon).ctx("opening the source file")?;
        let mut out = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp).ctx("creating a temporary copy")?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 1 << 20];
        let mut total = 0u64;
        loop {
            let n = input.read(&mut buf).ctx("reading the source file")?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            out.write_all(&buf[..n]).ctx("writing the asset copy")?;
            total += n as u64;
        }
        out.sync_all().ctx("flushing the asset copy")?;
        Ok((hex(hasher.finalize().as_slice()), total))
    })();
    let (sha, bytes) = match result {
        Ok(v) => v,
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
    };
    let ext = sniffed.kind.extensions().first().copied().unwrap_or("bin");
    let file_name = format!("{sha}.{ext}");
    let dest = assets.join(&file_name);
    let deduplicated = dest.exists();
    if deduplicated {
        let _ = std::fs::remove_file(&tmp);
    } else if let Err(e) = std::fs::rename(&tmp, &dest) {
        let _ = std::fs::remove_file(&tmp);
        return Err(Error::io("moving the asset into the project", e));
    }
    Ok(StoredAsset {
        rel_path: format!("assets/{file_name}"),
        sha256: sha,
        bytes,
        kind: sniffed.kind,
        category: sniffed.category,
        mime: sniffed.mime,
        deduplicated,
    })
}

/// Reads a whole file but refuses anything larger than `limit` bytes.
pub fn read_limited(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let meta = std::fs::metadata(path).map_err(|_| Error::NotFound(path.display().to_string()))?;
    if meta.len() > limit {
        return Err(Error::InvalidParam(format!(
            "{} is {} bytes, larger than the {limit}-byte limit",
            path.display(),
            meta.len()
        )));
    }
    std::fs::read(path).ctx(&format!("reading {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_known_vector() {
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }

    #[test]
    fn atomic_write_replaces_and_leaves_no_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("sub").join("project.json");
        atomic_write(&p, b"one").unwrap();
        atomic_write(&p, b"two-longer").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"two-longer");
        let leftovers: Vec<_> = std::fs::read_dir(p.parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn failed_write_does_not_clobber_the_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("keep.json");
        atomic_write(&p, b"precious").unwrap();
        // destination whose parent is a regular file -> cannot create temp sibling
        let bad = p.join("child.json");
        assert!(atomic_write(&bad, b"x").is_err());
        assert_eq!(std::fs::read(&p).unwrap(), b"precious");
    }

    #[test]
    fn read_limited_enforces_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("big.bin");
        std::fs::write(&p, vec![0u8; 100]).unwrap();
        assert!(read_limited(&p, 100).is_ok());
        assert!(matches!(read_limited(&p, 99), Err(Error::InvalidParam(_))));
        assert!(matches!(read_limited(&dir.path().join("none"), 10), Err(Error::NotFound(_))));
    }

    #[test]
    fn import_is_content_addressed_deduplicated_and_non_destructive() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("proj");
        // a PNG signature + junk is enough for sniffing; name it with a LYING extension
        let src = dir.path().join("liar.mp4");
        let mut data = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        data.extend_from_slice(&[7u8; 64]);
        std::fs::write(&src, &data).unwrap();
        let a = import_asset(&project, &src).unwrap();
        assert!(a.rel_path.starts_with("assets/") && a.rel_path.ends_with(".png"), "{}", a.rel_path);
        assert_eq!(a.sha256, sha256_hex(&data));
        assert!(!a.deduplicated);
        assert_eq!(std::fs::read(&src).unwrap(), data, "original must be untouched");
        let b = import_asset(&project, &src).unwrap();
        assert!(b.deduplicated);
        assert_eq!(a.rel_path, b.rel_path);
        assert_eq!(std::fs::read(project.join(&a.rel_path)).unwrap(), data);
        let temps = std::fs::read_dir(project.join("assets")).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".tmp")).count();
        assert_eq!(temps, 0);
    }

    #[test]
    fn import_rejects_unrecognised_content() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("notes.png");
        std::fs::write(&src, b"just some text, not an image").unwrap();
        assert!(matches!(import_asset(&dir.path().join("p"), &src), Err(Error::UnsupportedFormat(_))));
    }
}
