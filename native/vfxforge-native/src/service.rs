//! The desktop shell's service layer: everything a Tauri command does, minus Tauri.
//!
//! Projects live under one root: `<root>/<project id>/{project.json, assets/, autosave/}`. Ids are
//! validated, every path handed in by the UI is resolved *inside* the project folder, and nothing
//! in here ever takes a command line or a file name from the UI without checking it first.

use crate::bridge::{run_bridge, BridgeCommand, BridgeConfig};
use crate::error::{Error, IoContext, Result};
use crate::fsx::{atomic_write, read_limited, sha256_hex};
use crate::jobs::CancelToken;
use crate::project::{recovery_candidate, read_autosave, PROJECT_FILE};
use crate::sanitize::resolve_within;
use crate::sniff::{sniff, Category};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const MAX_ASSET_READ: u64 = 768 * 1024 * 1024;
const MAX_XML_BYTES: usize = 64 * 1024 * 1024;
const MAX_DDS_FILES: usize = 64;

/// `[A-Za-z0-9_-]{1,64}`: the shape of ids the UI generates (`proj_<hex>`), nothing path-like.
pub fn valid_project_id(id: &str) -> Result<&str> {
    if !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        Ok(id)
    } else {
        Err(Error::InvalidParam("invalid project id".into()))
    }
}

pub fn project_dir(root: &Path, id: &str) -> Result<PathBuf> {
    Ok(root.join(valid_project_id(id)?))
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub modified_at: String,
}

/// Saved projects, newest first. Folders without a readable project document are skipped.
pub fn list_projects(root: &Path) -> Vec<ProjectSummary> {
    let mut out: Vec<ProjectSummary> = std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let id = e.file_name().to_string_lossy().into_owned();
            valid_project_id(&id).ok()?;
            let bytes = read_limited(&e.path().join(PROJECT_FILE), 64 * 1024 * 1024).ok()?;
            let v: Value = serde_json::from_slice(&bytes).ok()?;
            Some(ProjectSummary {
                id: v.get("id").and_then(Value::as_str).filter(|s| *s == id).unwrap_or(&id).to_string(),
                name: v.get("name").and_then(Value::as_str).unwrap_or("Untitled").to_string(),
                modified_at: v.get("modifiedAt").and_then(Value::as_str).unwrap_or("").to_string(),
            })
        })
        .collect();
    out.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    out
}

pub fn delete_project(root: &Path, id: &str) -> Result<()> {
    let dir = project_dir(root, id)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).ctx("deleting the project folder")?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundAutosave {
    pub project_id: String,
    pub json: String,
    pub modified_ms: u64,
}

/// The newest autosave that is newer than its project's saved document, across all projects.
pub fn latest_autosave(root: &Path) -> Option<FoundAutosave> {
    std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let id = e.file_name().to_string_lossy().into_owned();
            valid_project_id(&id).ok()?;
            let dir = e.path();
            let cand = recovery_candidate(&dir)?;
            let json = read_autosave(&dir, &cand.path).ok()?;
            Some(FoundAutosave { project_id: id, json, modified_ms: cand.modified_ms })
        })
        .max_by_key(|a| a.modified_ms)
}

/// Reads an imported asset by its project-relative path (`assets/<sha>.<ext>`).
pub fn read_asset(project_dir: &Path, rel: &str) -> Result<Vec<u8>> {
    if !rel.starts_with("assets/") {
        return Err(Error::UnsafePath(rel.to_string()));
    }
    let p = resolve_within(project_dir, rel)?;
    read_limited(&p, MAX_ASSET_READ)
}

/// Stores an asset that arrives inside a project bundle. The bytes must be recognised media and
/// must hash to the id in the file name, so a tampered or mislabelled bundle is refused.
pub fn write_bundle_asset(project_dir: &Path, rel: &str, bytes: &[u8]) -> Result<()> {
    let name = rel.strip_prefix("assets/").ok_or_else(|| Error::UnsafePath(rel.to_string()))?;
    let (stem, ext) = name.rsplit_once('.').ok_or_else(|| Error::UnsafePath(rel.to_string()))?;
    if stem.len() != 64 || !stem.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) || !ext.bytes().all(|b| b.is_ascii_alphanumeric()) || ext.len() > 5 {
        return Err(Error::UnsafePath(rel.to_string()));
    }
    let sniffed = sniff(&bytes[..bytes.len().min(8192)]);
    if sniffed.category == Category::Unknown {
        return Err(Error::NotMedia(rel.to_string()));
    }
    if sha256_hex(bytes) != stem {
        return Err(Error::Data(format!("{rel} does not match its recorded checksum")));
    }
    std::fs::create_dir_all(project_dir.join("assets")).ctx("creating the assets folder")?;
    let dest = resolve_within(project_dir, rel)?;
    if !dest.exists() {
        atomic_write(&dest, bytes)?;
    }
    Ok(())
}

/* ----------------------------------------------------------------- converter */

#[derive(Debug)]
pub struct ConvertArgs {
    pub xml: String,
    pub gen9: bool,
    pub asset_name: String,
    /// `(file name, bytes)`, e.g. `("flames.dds", ...)`.
    pub files: Vec<(String, Vec<u8>)>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertedMeta {
    pub round_trip_ok: bool,
    pub mismatches: Vec<String>,
    pub resource_version: i64,
    pub codewalker_core: Option<String>,
}

fn ident_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && b.len() <= 48 && b[0].is_ascii_lowercase() && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_')
}

/// XML + DDS files -> verified binary `.ypt`, through the external converter bridge.
pub fn convert_ypt(cfg: &BridgeConfig, scratch_root: &Path, args: &ConvertArgs, cancel: &CancelToken) -> Result<(ConvertedMeta, Vec<u8>)> {
    if !ident_ok(&args.asset_name) {
        return Err(Error::InvalidParam("asset name must be a lowercase identifier".into()));
    }
    if args.xml.len() > MAX_XML_BYTES {
        return Err(Error::InvalidParam("the .ypt.xml is larger than 64 MiB".into()));
    }
    if args.files.len() > MAX_DDS_FILES {
        return Err(Error::InvalidParam("too many texture files".into()));
    }
    for (name, _) in &args.files {
        match name.strip_suffix(".dds") {
            Some(stem) if ident_ok(stem) => {}
            _ => return Err(Error::UnsafePath(format!("texture file name {name:?}"))),
        }
    }
    std::fs::create_dir_all(scratch_root).ctx("creating the scratch folder")?;
    let dir = scratch_root.join(format!("convert-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)));
    std::fs::create_dir_all(&dir).ctx("creating the conversion folder")?;
    let result = (|| {
        let xml_path = dir.join(format!("{}.ypt.xml", args.asset_name));
        let out_path = dir.join(format!("{}.ypt", args.asset_name));
        std::fs::write(&xml_path, args.xml.as_bytes()).ctx("writing the .ypt.xml")?;
        for (name, bytes) in &args.files {
            std::fs::write(dir.join(name), bytes).ctx("writing a texture file")?;
        }
        let reply = run_bridge(cfg, &BridgeCommand::XmlToYpt { input: xml_path, output: out_path.clone(), gen9: args.gen9 }, cancel, Duration::from_secs(300))?;
        let rt = reply.get("roundTrip");
        let ok = rt.and_then(|r| r.get("ok")).and_then(Value::as_bool).unwrap_or(false);
        let mismatches: Vec<String> = rt
            .and_then(|r| r.get("mismatches"))
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|m| m.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        let resource_version = reply.get("resourceVersion").and_then(Value::as_i64).unwrap_or(0);
        let codewalker_core = run_bridge(cfg, &BridgeCommand::Version, cancel, Duration::from_secs(30))
            .ok()
            .and_then(|v| v.get("codewalkerCore").and_then(Value::as_str).map(str::to_string));
        let ypt = read_limited(&out_path, 512 * 1024 * 1024)?;
        Ok((ConvertedMeta { round_trip_ok: ok, mismatches, resource_version, codewalker_core }, ypt))
    })();
    let _ = std::fs::remove_dir_all(&dir);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_ids_cannot_escape_the_root() {
        for bad in ["", "..", "a/b", "a\\b", "../x", "x y", "é", &"a".repeat(65)] {
            assert!(valid_project_id(bad).is_err(), "{bad:?}");
            assert!(project_dir(Path::new("/tmp/root"), bad).is_err());
        }
        assert_eq!(project_dir(Path::new("/r"), "proj_ab12-3").unwrap(), PathBuf::from("/r/proj_ab12-3"));
    }

    #[test]
    fn lists_projects_newest_first_and_skips_junk() {
        let root = tempfile::tempdir().unwrap();
        let mk = |id: &str, name: &str, at: &str| {
            let d = root.path().join(id);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join(PROJECT_FILE), format!(r#"{{"schemaVersion":1,"id":"{id}","name":"{name}","modifiedAt":"{at}"}}"#)).unwrap();
        };
        mk("proj_a", "Old", "2026-01-01T00:00:00Z");
        mk("proj_b", "New", "2026-03-01T00:00:00Z");
        std::fs::create_dir_all(root.path().join("proj_empty")).unwrap();
        std::fs::create_dir_all(root.path().join("not a valid id")).unwrap();
        let list = list_projects(root.path());
        assert_eq!(list.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["New", "Old"]);
    }

    #[test]
    fn reads_assets_only_from_inside_the_assets_folder() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("assets")).unwrap();
        std::fs::write(dir.path().join("assets/x.bin"), b"hi").unwrap();
        std::fs::write(dir.path().join("secret.txt"), b"no").unwrap();
        assert_eq!(read_asset(dir.path(), "assets/x.bin").unwrap(), b"hi");
        for bad in ["secret.txt", "assets/../secret.txt", "/etc/passwd", "assets//..//secret.txt", "C:\\x"] {
            assert!(read_asset(dir.path(), bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn bundle_assets_must_be_media_and_match_their_hash() {
        let dir = tempfile::tempdir().unwrap();
        // a minimal PNG signature + IHDR is enough for content sniffing
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
        png.extend_from_slice(&[0; 40]);
        let sha = sha256_hex(&png);
        write_bundle_asset(dir.path(), &format!("assets/{sha}.png"), &png).unwrap();
        assert!(dir.path().join(format!("assets/{sha}.png")).is_file());
        // wrong hash
        let other = "0".repeat(64);
        assert!(matches!(write_bundle_asset(dir.path(), &format!("assets/{other}.png"), &png), Err(Error::Data(_))));
        // not media, even with a matching hash
        let junk = b"hello world, definitely not media".to_vec();
        let jsha = sha256_hex(&junk);
        assert!(matches!(write_bundle_asset(dir.path(), &format!("assets/{jsha}.png"), &junk), Err(Error::NotMedia(_))));
        // path games
        for bad in ["../x.png", "assets/../x.png", "assets/short.png", &format!("assets/{}.png/../../x", sha), &format!("assets/{}.p/ng", sha)] {
            assert!(write_bundle_asset(dir.path(), bad, &png).is_err(), "{bad}");
        }
    }

    #[test]
    fn conversion_inputs_are_validated_before_anything_is_written() {
        let scratch = tempfile::tempdir().unwrap();
        let cfg = BridgeConfig::default();
        let cancel = CancelToken::new();
        let base = || ConvertArgs { xml: "<x/>".into(), gen9: false, asset_name: "fx".into(), files: vec![] };
        let mut a = base();
        a.asset_name = "../evil".into();
        assert!(matches!(convert_ypt(&cfg, scratch.path(), &a, &cancel), Err(Error::InvalidParam(_))));
        let mut a = base();
        a.files = vec![("../../x.dds".into(), vec![1])];
        assert!(matches!(convert_ypt(&cfg, scratch.path(), &a, &cancel), Err(Error::UnsafePath(_))));
        let mut a = base();
        a.files = vec![("evil.exe".into(), vec![1])];
        assert!(matches!(convert_ypt(&cfg, scratch.path(), &a, &cancel), Err(Error::UnsafePath(_))));
        // valid input but no bridge configured: a clear tool-missing error and no leftovers
        let a = base();
        assert!(matches!(convert_ypt(&cfg, scratch.path(), &a, &cancel), Err(Error::ToolMissing { .. })));
        let leftovers: Vec<_> = std::fs::read_dir(scratch.path()).unwrap().collect();
        assert!(leftovers.is_empty(), "scratch folder must be cleaned up");
    }
}
