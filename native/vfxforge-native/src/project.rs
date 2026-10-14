//! Project folder persistence: atomic saves with a rolling backup, autosave snapshots and
//! crash-recovery detection.
//!
//! Layout:
//! ```text
//! MyEffect.vfxforge/
//!   project.json        current document
//!   project.json.bak    previous good document
//!   assets/<sha>.<ext>  immutable, content-addressed imports
//!   autosave/autosave-<unix-ms>.json
//! ```

use crate::error::{Error, IoContext, Result};
use crate::fsx::{atomic_write, read_limited};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub const PROJECT_FILE: &str = "project.json";
pub const BACKUP_FILE: &str = "project.json.bak";
pub const AUTOSAVE_DIR: &str = "autosave";
const MAX_PROJECT_BYTES: u64 = 64 * 1024 * 1024;

fn validate_document(json: &str) -> Result<()> {
    if json.len() as u64 > MAX_PROJECT_BYTES {
        return Err(Error::InvalidParam("project document is larger than 64 MiB".into()));
    }
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| Error::Data(format!("project JSON is not valid: {e}")))?;
    match v.get("schemaVersion") {
        Some(serde_json::Value::Number(_)) => Ok(()),
        _ => Err(Error::Data("project JSON has no numeric schemaVersion".into())),
    }
}

/// Saves the document atomically, keeping the previous good version as `project.json.bak`
/// and discarding now-obsolete autosaves.
pub fn save_project(dir: &Path, json: &str) -> Result<()> {
    validate_document(json)?;
    std::fs::create_dir_all(dir.join("assets")).ctx("creating the project folder")?;
    let current = dir.join(PROJECT_FILE);
    if current.exists() {
        // only promote the existing file to .bak if it still parses (never overwrite a good
        // backup with a corrupt file)
        if let Ok(prev) = read_limited(&current, MAX_PROJECT_BYTES) {
            if validate_document(&String::from_utf8_lossy(&prev)).is_ok() {
                atomic_write(&dir.join(BACKUP_FILE), &prev)?;
            }
        }
    }
    atomic_write(&current, json.as_bytes())?;
    clear_autosaves(dir);
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedProject {
    pub json: String,
    /// True when `project.json` was missing/corrupt and the backup was used instead.
    pub recovered_from_backup: bool,
}

pub fn load_project(dir: &Path) -> Result<LoadedProject> {
    let primary = dir.join(PROJECT_FILE);
    let try_read = |p: &Path| -> Result<String> {
        let bytes = read_limited(p, MAX_PROJECT_BYTES)?;
        let s = String::from_utf8(bytes).map_err(|_| Error::Data(format!("{} is not valid UTF-8", p.display())))?;
        validate_document(&s)?;
        Ok(s)
    };
    match try_read(&primary) {
        Ok(json) => Ok(LoadedProject { json, recovered_from_backup: false }),
        Err(primary_err) => match try_read(&dir.join(BACKUP_FILE)) {
            Ok(json) => Ok(LoadedProject { json, recovered_from_backup: true }),
            Err(_) => Err(primary_err),
        },
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutosaveInfo {
    pub path: PathBuf,
    pub modified_ms: u64,
}

fn mtime_ms(p: &Path) -> u64 {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn list_autosaves(dir: &Path) -> Vec<AutosaveInfo> {
    let mut v: Vec<AutosaveInfo> = std::fs::read_dir(dir.join(AUTOSAVE_DIR))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| {
            let n = e.file_name().to_string_lossy().into_owned();
            n.starts_with("autosave-") && n.ends_with(".json")
        })
        .map(|e| AutosaveInfo { modified_ms: mtime_ms(&e.path()), path: e.path() })
        .collect();
    v.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms).then_with(|| b.path.cmp(&a.path)));
    v
}

/// Writes a recoverable snapshot and prunes all but the newest `keep`.
pub fn write_autosave(dir: &Path, json: &str, keep: usize) -> Result<PathBuf> {
    validate_document(json)?;
    let ms = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let mut path = dir.join(AUTOSAVE_DIR).join(format!("autosave-{ms}.json"));
    let mut n = 1;
    while path.exists() {
        path = dir.join(AUTOSAVE_DIR).join(format!("autosave-{ms}-{n}.json"));
        n += 1;
    }
    atomic_write(&path, json.as_bytes())?;
    for old in list_autosaves(dir).into_iter().skip(keep.max(1)) {
        let _ = std::fs::remove_file(old.path);
    }
    Ok(path)
}

/// An autosave that is newer than the saved project means the last session did not end with
/// a save (crash / power loss / forced quit).
pub fn recovery_candidate(dir: &Path) -> Option<AutosaveInfo> {
    let saved = mtime_ms(&dir.join(PROJECT_FILE));
    list_autosaves(dir).into_iter().next().filter(|a| a.modified_ms > saved)
}

pub fn read_autosave(dir: &Path, path: &Path) -> Result<String> {
    // only files inside <dir>/autosave may be read through this API
    let base = dir.join(AUTOSAVE_DIR).canonicalize().map_err(|_| Error::NotFound("autosave folder".into()))?;
    let canon = path.canonicalize().map_err(|_| Error::NotFound(path.display().to_string()))?;
    if !canon.starts_with(&base) {
        return Err(Error::UnsafePath(path.display().to_string()));
    }
    let s = String::from_utf8(read_limited(&canon, MAX_PROJECT_BYTES)?).map_err(|_| Error::Data("autosave is not UTF-8".into()))?;
    validate_document(&s)?;
    Ok(s)
}

pub fn clear_autosaves(dir: &Path) {
    for a in list_autosaves(dir) {
        let _ = std::fs::remove_file(a.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    const DOC1: &str = r#"{"schemaVersion":1,"name":"one"}"#;
    const DOC2: &str = r#"{"schemaVersion":1,"name":"two"}"#;

    #[test]
    fn save_then_load_roundtrips_and_keeps_a_backup() {
        let dir = tempfile::tempdir().unwrap();
        save_project(dir.path(), DOC1).unwrap();
        save_project(dir.path(), DOC2).unwrap();
        let loaded = load_project(dir.path()).unwrap();
        assert_eq!(loaded.json, DOC2);
        assert!(!loaded.recovered_from_backup);
        assert_eq!(std::fs::read_to_string(dir.path().join(BACKUP_FILE)).unwrap(), DOC1);
        assert!(dir.path().join("assets").is_dir());
    }

    #[test]
    fn corrupt_primary_falls_back_to_backup() {
        let dir = tempfile::tempdir().unwrap();
        save_project(dir.path(), DOC1).unwrap();
        save_project(dir.path(), DOC2).unwrap();
        std::fs::write(dir.path().join(PROJECT_FILE), b"{\"schemaVersion\":1,\"name\":\"tr").unwrap(); // torn write
        let loaded = load_project(dir.path()).unwrap();
        assert_eq!(loaded.json, DOC1);
        assert!(loaded.recovered_from_backup);
    }

    #[test]
    fn corrupt_file_never_overwrites_a_good_backup() {
        let dir = tempfile::tempdir().unwrap();
        save_project(dir.path(), DOC1).unwrap();
        save_project(dir.path(), DOC2).unwrap();
        std::fs::write(dir.path().join(PROJECT_FILE), b"garbage").unwrap();
        save_project(dir.path(), DOC1).unwrap(); // saving over a corrupt primary
        assert_eq!(std::fs::read_to_string(dir.path().join(BACKUP_FILE)).unwrap(), DOC1);
    }

    #[test]
    fn invalid_documents_are_rejected_before_touching_disk() {
        let dir = tempfile::tempdir().unwrap();
        assert!(save_project(dir.path(), "not json").is_err());
        assert!(save_project(dir.path(), r#"{"name":"no version"}"#).is_err());
        assert!(!dir.path().join(PROJECT_FILE).exists());
        assert!(load_project(dir.path()).is_err());
    }

    #[test]
    fn autosave_rotation_and_recovery_detection() {
        let dir = tempfile::tempdir().unwrap();
        save_project(dir.path(), DOC1).unwrap();
        assert!(recovery_candidate(dir.path()).is_none());
        std::thread::sleep(Duration::from_millis(20));
        for i in 0..5 {
            write_autosave(dir.path(), &format!(r#"{{"schemaVersion":1,"name":"auto{i}"}}"#), 3).unwrap();
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(list_autosaves(dir.path()).len(), 3);
        let cand = recovery_candidate(dir.path()).expect("autosave newer than the save");
        assert!(read_autosave(dir.path(), &cand.path).unwrap().contains("auto4"));
        save_project(dir.path(), DOC2).unwrap(); // an explicit save clears the snapshots
        assert!(recovery_candidate(dir.path()).is_none());
        assert!(list_autosaves(dir.path()).is_empty());
    }

    #[test]
    fn read_autosave_refuses_paths_outside_the_autosave_folder() {
        let dir = tempfile::tempdir().unwrap();
        save_project(dir.path(), DOC1).unwrap();
        write_autosave(dir.path(), DOC2, 3).unwrap();
        let outside = dir.path().join(PROJECT_FILE);
        assert!(matches!(read_autosave(dir.path(), &outside), Err(Error::UnsafePath(_))));
    }
}
