//! Filename and path hygiene. Mirrors `packages/core/src/safety.ts` so both sides of
//! the app agree on what is acceptable.

use crate::error::{Error, Result};
use std::path::{Component, Path, PathBuf};

const WINDOWS_RESERVED: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Makes `input` safe to use as ONE path component on Windows, macOS and Linux.
/// Never returns an empty string, "." or "..".
pub fn sanitize_filename(input: &str) -> String {
    let mut s: String = input
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if (c as u32) < 0x20 || c as u32 == 0x7f => '_',
            c => c,
        })
        .collect();
    s = s.trim().to_string();
    s = s.trim_end_matches(['.', ' ']).to_string();
    s = s.trim_start_matches('.').to_string();
    if s.chars().count() > 100 {
        s = s.chars().take(100).collect::<String>();
        s = s.trim_end_matches(['.', ' ']).to_string();
    }
    if s.is_empty() {
        return "untitled".to_string();
    }
    let stem = s.split('.').next().unwrap_or("").to_lowercase();
    if WINDOWS_RESERVED.contains(&stem.as_str()) {
        s = format!("_{s}");
    }
    s
}

/// True when `p` is a canonical relative path that cannot escape its base directory.
pub fn is_safe_relative(p: &str) -> bool {
    if p.is_empty() || p.contains('\0') {
        return false;
    }
    if p.starts_with('/') || p.starts_with('\\') {
        return false;
    }
    let bytes = p.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return false;
    }
    p.split(['/', '\\'])
        .all(|seg| !seg.is_empty() && seg != "." && seg != "..")
}

/// Joins `rel` onto `base` and guarantees the result stays inside `base`, including
/// when existing path components are symlinks that point elsewhere.
pub fn resolve_within(base: &Path, rel: &str) -> Result<PathBuf> {
    if !is_safe_relative(rel) {
        return Err(Error::UnsafePath(rel.to_string()));
    }
    let joined = rel.split(['/', '\\']).fold(base.to_path_buf(), |acc, seg| acc.join(seg));
    // Walk up to the deepest existing ancestor and canonicalise it; it must live under base.
    let canon_base = base
        .canonicalize()
        .map_err(|e| Error::io(format!("resolving {}", base.display()), e))?;
    let mut probe = joined.as_path();
    loop {
        if probe.exists() {
            let canon = probe
                .canonicalize()
                .map_err(|e| Error::io(format!("resolving {}", probe.display()), e))?;
            if !canon.starts_with(&canon_base) {
                return Err(Error::UnsafePath(format!(
                    "{rel} resolves outside the project folder"
                )));
            }
            break;
        }
        match probe.parent() {
            Some(parent) => probe = parent,
            None => break,
        }
    }
    Ok(joined)
}

/// Windows' `canonicalize` returns "verbatim" paths (`\\?\C:\dir\file`, `\\?\UNC\server\share\file`).
/// Many tools — FFmpeg's `file:` protocol among them — do not understand that prefix, so it is removed
/// again when it is purely cosmetic. Pure string logic, so it is unit-tested on every platform.
pub fn strip_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = path.strip_prefix(r"\\?\") {
        let b = rest.as_bytes();
        if b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\' {
            return rest.to_string();
        }
    }
    path.to_string()
}

fn simplify_canonical(p: PathBuf) -> PathBuf {
    if cfg!(windows) {
        if let Some(s) = p.to_str() {
            return PathBuf::from(strip_verbatim_prefix(s));
        }
    }
    p
}

/// Requires an absolute, existing, regular file (after following symlinks) and returns its
/// canonical path. Used for every user-selected input before it is handed to a subprocess.
pub fn require_existing_file(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err(Error::UnsafePath(format!(
            "{} (expected an absolute path)",
            path.display()
        )));
    }
    let canon = simplify_canonical(
        path.canonicalize()
            .map_err(|_| Error::NotFound(path.display().to_string()))?,
    );
    let meta = std::fs::metadata(&canon).map_err(|e| Error::io("reading file metadata", e))?;
    if !meta.is_file() {
        return Err(Error::InvalidParam(format!(
            "{} is not a regular file",
            canon.display()
        )));
    }
    Ok(canon)
}

/// Requires an absolute, existing directory and returns its canonical path (no cosmetic Windows
/// verbatim prefix, so it can be handed to a subprocess).
pub fn require_existing_dir(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err(Error::UnsafePath(format!(
            "{} (expected an absolute path)",
            path.display()
        )));
    }
    let canon = simplify_canonical(
        path.canonicalize()
            .map_err(|_| Error::NotFound(path.display().to_string()))?,
    );
    if !canon.is_dir() {
        return Err(Error::InvalidParam(format!(
            "{} is not a folder",
            canon.display()
        )));
    }
    Ok(canon)
}

/// Rejects `..` components outright for paths that arrive as raw strings from the UI.
pub fn reject_traversal(path: &Path) -> Result<()> {
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(Error::UnsafePath(path.display().to_string()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbatim_windows_prefixes_are_removed_only_when_cosmetic() {
        assert_eq!(strip_verbatim_prefix(r"\\?\C:\Users\me\clip.mp4"), r"C:\Users\me\clip.mp4");
        assert_eq!(strip_verbatim_prefix(r"\\?\UNC\server\share\clip.mp4"), r"\\server\share\clip.mp4");
        // not a drive path: leave it alone (it may genuinely need the verbatim form)
        assert_eq!(strip_verbatim_prefix(r"\\?\GLOBALROOT\x"), r"\\?\GLOBALROOT\x");
        assert_eq!(strip_verbatim_prefix(r"\\?\C:"), r"\\?\C:");
        assert_eq!(strip_verbatim_prefix("/home/me/clip.mp4"), "/home/me/clip.mp4");
        assert_eq!(strip_verbatim_prefix(r"C:\plain\path"), r"C:\plain\path");
    }

    #[test]
    fn filenames_are_sanitised() {
        assert_eq!(sanitize_filename("a<b>c:d\"e|f?g*h"), "a_b_c_d_e_f_g_h");
        assert_eq!(sanitize_filename("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(sanitize_filename("CON"), "_CON");
        assert_eq!(sanitize_filename("nul.txt"), "_nul.txt");
        assert_eq!(sanitize_filename("   "), "untitled");
        assert_eq!(sanitize_filename("..."), "untitled");
        assert_eq!(sanitize_filename("name. . "), "name");
        assert_eq!(sanitize_filename("bad\0name\n.png"), "bad_name_.png");
        assert!(sanitize_filename(&"x".repeat(300)).chars().count() <= 100);
    }

    #[test]
    fn relative_path_validation() {
        for bad in [
            "../x", "a/../../x", "/abs", "C:\\win", "\\\\server\\share", "a\\..\\b", "", "a//b",
            "./x", "a\0b",
        ] {
            assert!(!is_safe_relative(bad), "{bad:?} should be rejected");
        }
        for good in ["assets/a.png", "a.b/c-d_e.ext"] {
            assert!(is_safe_relative(good), "{good:?} should be accepted");
        }
    }

    #[test]
    fn resolve_within_blocks_escape_and_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("proj");
        std::fs::create_dir_all(base.join("assets")).unwrap();
        assert!(resolve_within(&base, "assets/new.png").is_ok());
        assert!(matches!(
            resolve_within(&base, "../outside"),
            Err(Error::UnsafePath(_))
        ));
        #[cfg(unix)]
        {
            let outside = dir.path().join("outside");
            std::fs::create_dir_all(&outside).unwrap();
            std::os::unix::fs::symlink(&outside, base.join("evil")).unwrap();
            assert!(matches!(
                resolve_within(&base, "evil/file.png"),
                Err(Error::UnsafePath(_))
            ));
        }
    }

    #[test]
    fn existing_file_requirements() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.bin");
        std::fs::write(&f, b"x").unwrap();
        assert!(require_existing_file(&f).is_ok());
        assert!(matches!(
            require_existing_file(Path::new("relative.bin")),
            Err(Error::UnsafePath(_))
        ));
        assert!(matches!(
            require_existing_file(&dir.path().join("missing")),
            Err(Error::NotFound(_))
        ));
        assert!(matches!(
            require_existing_file(dir.path()),
            Err(Error::InvalidParam(_))
        ));
    }

    #[test]
    fn existing_folder_requirements() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.bin");
        std::fs::write(&f, b"x").unwrap();
        let canon = require_existing_dir(dir.path()).unwrap();
        assert!(canon.is_absolute() && canon.is_dir());
        assert!(matches!(
            require_existing_dir(Path::new("relative")),
            Err(Error::UnsafePath(_))
        ));
        assert!(matches!(
            require_existing_dir(&dir.path().join("missing")),
            Err(Error::NotFound(_))
        ));
        assert!(matches!(require_existing_dir(&f), Err(Error::InvalidParam(_))));
    }

    #[test]
    fn traversal_components_are_rejected() {
        assert!(reject_traversal(Path::new("/a/../b")).is_err());
        assert!(reject_traversal(Path::new("/a/b")).is_ok());
    }
}
