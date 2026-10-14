//! The desktop shell's service layer: everything a Tauri command does, minus Tauri.
//!
//! Projects live under one root: `<root>/<project id>/{project.json, assets/, autosave/}`. Ids are
//! validated, every path handed in by the UI is resolved *inside* the project folder, and nothing
//! in here ever takes a command line or a file name from the UI without checking it first.

use crate::bridge::{ensure_ready_for_ydr, run_bridge, BridgeCommand, BridgeConfig};
use crate::error::{Error, IoContext, Result};
use crate::fsx::{atomic_write, import_asset, read_limited, sha256_hex, StoredAsset};
use crate::jobs::CancelToken;
use crate::probe::read_head;
use crate::project::{recovery_candidate, read_autosave, PROJECT_FILE};
use crate::sanitize::{require_existing_dir, require_existing_file, resolve_within};
use crate::sniff::{rsc7_version, sniff, Category, MediaKind};
use serde::Serialize;
use serde_json::Value;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

pub const MAX_ASSET_READ: u64 = 768 * 1024 * 1024;
const MAX_XML_BYTES: usize = 64 * 1024 * 1024;
const MAX_DDS_FILES: usize = 64;
/// The same caps the bridge enforces on its side (input .ydr, produced .glb), checked here too so a
/// misbehaving or substituted bridge cannot make us copy or store something huge.
pub const MAX_YDR_BYTES: u64 = 256 * 1024 * 1024;
const MAX_GLB_BYTES: u64 = 256 * 1024 * 1024;
/// A drawable converts in well under a second; the bridge has its own 90 s watchdog, this one also covers a hung `dotnet`.
const YDR_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_YDR_WARNINGS: usize = 50;
const MAX_YDR_WARNING_CHARS: usize = 500;

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

/* ------------------------------------------------------------ drawable (.ydr) import */

/// What the converter did to a drawable, in the shape the UI shows. All counts are the converter's own,
/// read from its reply; nothing here is estimated.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct YdrConversion {
    /// The level of detail that was converted: `high`, `med`, `low` or `vlow`.
    pub lod: String,
    pub models: u64,
    pub geometries: u64,
    pub vertices: u64,
    pub triangles: u64,
    /// The converter's own notes (skipped geometry, winding decisions, bone placement, ...), bounded in count and length.
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct YdrImport {
    /// The stored GLB (`assets/<sha256>.glb`); a drawable that converts to the same bytes is stored once.
    pub asset: StoredAsset,
    pub conversion: YdrConversion,
    /// The bridge's whole success reply (name, gen, resourceVersion, bounds, shaders, ...), minus the scratch path.
    pub bridge_reply: Value,
}

/// True when the file name selects the drawable converter. Only the NAME decides that; the content must then
/// agree (see [`import_ydr`]).
pub fn is_ydr_path(path: &Path) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case("ydr"))
}

fn display_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string())
}

/// Makes the error for a file that is not recognised media a precise one when it is a GTA V resource: an
/// RSC7 file that was not named `.ydr` is never run through the drawable converter, and the user is told so
/// instead of being told "unrecognised".
pub fn explain_unrecognised(src: &Path, err: Error) -> Error {
    if !matches!(err, Error::UnsupportedFormat(_)) {
        return err;
    }
    match read_head(src) {
        Ok(head) if rsc7_version(&head).is_some() => Error::UnsupportedFormat(format!(
            "{} is a GTA V resource file (RSC7) but its name does not end in .ydr, so it was not imported as a drawable. Only .ydr drawables can be converted to a model; textures (.ytd), drawable dictionaries (.ydd), fragments (.yft) and other resources are not supported.",
            display_name(src)
        )),
        _ => err,
    }
}

static SCRATCH_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A private folder under the app's scratch root that is removed when it goes out of scope, on success, on
/// every error path, on cancellation and on a panic.
struct ScratchDir(PathBuf);

impl ScratchDir {
    fn create(root: &Path, prefix: &str) -> Result<Self> {
        if !root.is_absolute() {
            // checked first: a relative root would otherwise be created inside whatever the working directory is
            return Err(Error::UnsafePath(format!("{} (expected an absolute scratch folder)", root.display())));
        }
        std::fs::create_dir_all(root).ctx("creating the scratch folder")?;
        // canonical and without a Windows verbatim prefix: this path goes to a subprocess
        let root = require_existing_dir(root)?;
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = root.join(format!("{prefix}-{}-{nanos}-{}", std::process::id(), SCRATCH_COUNTER.fetch_add(1, Ordering::SeqCst)));
        // create_dir, not create_dir_all: a name collision must fail rather than share a folder with another import
        std::fs::create_dir(&dir).ctx("creating the conversion folder")?;
        Ok(Self(dir))
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        // a just-killed process on Windows can hold its files for a few milliseconds
        for attempt in 0..5 {
            if std::fs::remove_dir_all(&self.0).is_ok() || !self.0.exists() {
                return;
            }
            if attempt < 4 {
                std::thread::sleep(Duration::from_millis(40));
            }
        }
    }
}

/// `glTF`, container version 2, and a declared length equal to the file's: what the bridge always writes.
fn glb_header_matches(head: &[u8], file_len: u64) -> bool {
    head.len() >= 12
        && &head[..4] == b"glTF"
        && u32::from_le_bytes([head[4], head[5], head[6], head[7]]) == 2
        && u64::from(u32::from_le_bytes([head[8], head[9], head[10], head[11]])) == file_len
}

fn count_field(reply: &Value, key: &str) -> Result<u64> {
    reply.get(key).and_then(Value::as_u64).ok_or_else(|| Error::Data(format!("the converter bridge's reply has no valid '{key}'; rebuild tools/ypt-bridge from this version of VFXForge")))
}

/// Reads the summary out of the bridge's success reply. Required fields are required: a reply that lacks them
/// is not turned into zeros.
fn conversion_from_reply(reply: &Value) -> Result<YdrConversion> {
    let lod = match reply.get("lod").and_then(Value::as_str) {
        Some(l @ ("high" | "med" | "low" | "vlow")) => l.to_string(),
        _ => return Err(Error::Data("the converter bridge's reply has no valid 'lod'; rebuild tools/ypt-bridge from this version of VFXForge".into())),
    };
    let all: Vec<&str> = reply.get("warnings").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let mut warnings: Vec<String> = all
        .iter()
        .take(MAX_YDR_WARNINGS)
        .map(|w| {
            let w = w.trim();
            match w.char_indices().nth(MAX_YDR_WARNING_CHARS) {
                Some((cut, _)) => format!("{}...", &w[..cut]),
                None => w.to_string(),
            }
        })
        .collect();
    if all.len() > MAX_YDR_WARNINGS {
        warnings.push(format!("... and {} more notes from the converter", all.len() - MAX_YDR_WARNINGS));
    }
    Ok(YdrConversion {
        lod,
        models: count_field(reply, "models")?,
        geometries: count_field(reply, "geometries")?,
        vertices: count_field(reply, "vertices")?,
        triangles: count_field(reply, "triangles")?,
        warnings,
    })
}

/// Validates a `.ydr` (name AND content), converts it to a GLB with the bridge in a private scratch folder and
/// stores the GLB like any other model asset.
///
/// * The file must be named `.ydr`, be a regular file of at most [`MAX_YDR_BYTES`] and start with the RSC7
///   resource header. Nothing else is ever sent to the converter, and a bad file is refused before the bridge is
///   even looked for.
/// * The bridge only ever sees a private copy (`<scratch>/ydr-.../source.ydr`) of exactly the bytes that were
///   validated, and writes its output next to it. The scratch folder is removed on every path out of here.
/// * The produced file is size-checked, its GLB container header verified, and it goes through
///   [`import_asset`], so the content-sniffing store again requires it to be a GLB. Identical drawables
///   deduplicate. The original `.ydr` is never modified or stored.
pub fn import_ydr(cfg: &BridgeConfig, scratch_root: &Path, project_dir: &Path, src: &Path, cancel: &CancelToken) -> Result<YdrImport> {
    if !is_ydr_path(src) {
        return Err(Error::InvalidParam(format!("{} does not end in .ydr, so it is not imported as a drawable", display_name(src))));
    }
    let name = display_name(src);
    let canon = require_existing_file(src)?;
    let mut file = std::fs::File::open(&canon).ctx("opening the .ydr")?;
    let len = file.metadata().ctx("reading the .ydr size")?.len();
    if len > MAX_YDR_BYTES {
        return Err(Error::InvalidParam(format!("{name} is {} MiB, larger than the {} MiB limit for a .ydr", len / (1024 * 1024), MAX_YDR_BYTES / (1024 * 1024))));
    }
    let mut head = Vec::with_capacity(8192);
    (&mut file).take(8192).read_to_end(&mut head).ctx("reading the .ydr header")?;
    if rsc7_version(&head).is_none() {
        return Err(Error::UnsupportedFormat(format!("{name} is not a GTA V resource file (it does not start with an RSC7 header), so it cannot be a drawable")));
    }
    // refuse before copying a possibly large file when the converter cannot run anyway
    ensure_ready_for_ydr(cfg)?;

    let scratch = ScratchDir::create(scratch_root, "ydr")?;
    let input = scratch.0.join("source.ydr");
    let output = scratch.0.join("model.glb");
    {
        file.seek(SeekFrom::Start(0)).ctx("rewinding the .ydr")?;
        let mut copy = std::fs::OpenOptions::new().write(true).create_new(true).open(&input).ctx("copying the .ydr into the scratch folder")?;
        let copied = std::io::copy(&mut (&mut file).take(MAX_YDR_BYTES + 1), &mut copy).ctx("copying the .ydr into the scratch folder")?;
        if copied > MAX_YDR_BYTES {
            return Err(Error::InvalidParam(format!("{name} grew past the {} MiB limit for a .ydr while it was being read", MAX_YDR_BYTES / (1024 * 1024))));
        }
        copy.sync_all().ctx("copying the .ydr into the scratch folder")?;
    }
    drop(file);

    let mut reply = run_bridge(cfg, &BridgeCommand::YdrToGlb { input, output: output.clone() }, cancel, YDR_TIMEOUT)?;
    let conversion = conversion_from_reply(&reply)?;
    if let Some(o) = reply.as_object_mut() {
        o.remove("output");
    }

    let produced = std::fs::metadata(&output).map_err(|_| Error::Data("the converter reported success but wrote no .glb file".into()))?;
    if !produced.is_file() || produced.len() > MAX_GLB_BYTES {
        return Err(Error::InvalidParam(format!("the converter's output is not a .glb of at most {} MiB", MAX_GLB_BYTES / (1024 * 1024))));
    }
    let produced_head = read_head(&output)?;
    if sniff(&produced_head).kind != MediaKind::Glb || !glb_header_matches(&produced_head, produced.len()) {
        return Err(Error::Data("the converter reported success but its output is not a valid .glb".into()));
    }
    let asset = import_asset(project_dir, &output)?;
    Ok(YdrImport { asset, conversion, bridge_reply: reply })
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

    /* ------------------------------------------------------------ drawable (.ydr) import */

    /// A header that passes the RSC7 check followed by filler; enough for everything that happens before the bridge.
    fn rsc7_bytes(version: u32) -> Vec<u8> {
        let mut v = b"RSC7".to_vec();
        v.extend_from_slice(&version.to_le_bytes());
        v.extend_from_slice(&[0xA5; 64]);
        v
    }

    fn entries(dir: &Path) -> usize {
        std::fs::read_dir(dir).map(|d| d.count()).unwrap_or(0)
    }

    /// Smallest container that satisfies the header checks: `glTF`, version 2, one JSON chunk.
    fn tiny_glb() -> Vec<u8> {
        let mut json = br#"{"asset":{"version":"2.0"}}"#.to_vec();
        json.resize(json.len().next_multiple_of(4), b' ');
        let total = 12 + 8 + json.len();
        let mut v = b"glTF".to_vec();
        v.extend_from_slice(&2u32.to_le_bytes());
        v.extend_from_slice(&(total as u32).to_le_bytes());
        v.extend_from_slice(&(json.len() as u32).to_le_bytes());
        v.extend_from_slice(b"JSON");
        v.extend_from_slice(&json);
        v
    }

    #[test]
    fn only_the_name_selects_the_drawable_converter_and_case_does_not_matter() {
        for yes in ["a.ydr", "A.YDR", "w_ar_k2light.Ydr", "/x/y/z.ydr", "weird name (1).ydr"] {
            assert!(is_ydr_path(Path::new(yes)), "{yes}");
        }
        for no in ["a.png", "a.ydr.bak", "a.ydd", "ydr", ".ydr", "a.ydrx", "a.glb", ""] {
            assert!(!is_ydr_path(Path::new(no)), "{no}");
        }
    }

    #[test]
    fn a_bad_drawable_is_refused_before_the_bridge_is_looked_for() {
        // no bridge is configured: every one of these must fail on the FILE, with its own message, and leave nothing behind
        let dir = tempfile::tempdir().unwrap();
        let scratch = dir.path().join("scratch");
        let project = dir.path().join("proj");
        let cfg = BridgeConfig::default();
        let go = |p: &Path| import_ydr(&cfg, &scratch, &project, p, &CancelToken::new()).unwrap_err();
        let put = |name: &str, bytes: &[u8]| {
            let p = dir.path().join(name);
            std::fs::write(&p, bytes).unwrap();
            p
        };

        assert!(matches!(go(&put("model.png", &rsc7_bytes(165))), Error::InvalidParam(_)));
        assert!(matches!(go(Path::new("relative/model.ydr")), Error::UnsafePath(_)));
        assert!(matches!(go(&dir.path().join("missing.ydr")), Error::NotFound(_)));
        let folder = dir.path().join("folder.ydr");
        std::fs::create_dir(&folder).unwrap();
        assert!(matches!(go(&folder), Error::InvalidParam(_)));
        for (name, bytes) in [
            ("empty.ydr", &b""[..]),
            ("text.ydr", b"this is a text file, not a drawable"),
            ("gltf.ydr", br#"{"asset":{"version":"2.0"}}"#),
            ("glb.ydr", b"glTF\x02\x00\x00\x00\x0c\x00\x00\x00"),
            ("short.ydr", b"RSC7\xa5\x00"),
            ("lower.ydr", b"rsc7\xa5\x00\x00\x00 and more"),
            ("offset.ydr", b"\x00RSC7\xa5\x00\x00\x00 and more"),
        ] {
            let e = go(&put(name, bytes));
            assert!(matches!(e, Error::UnsupportedFormat(_)), "{name}: {e}");
            let msg = e.to_string();
            assert!(msg.contains("not a GTA V resource file") && msg.contains(name), "{name}: {msg}");
        }
        assert!(!scratch.exists(), "nothing may be created before the file is accepted");
        assert!(!project.exists());

        // an acceptable file reaches the bridge check, which is where the user learns what to do
        let e = go(&put("good.ydr", &rsc7_bytes(165)));
        assert!(matches!(e, Error::ToolMissing { .. }), "{e}");
        let msg = e.to_string();
        assert!(msg.contains("Settings > Tools") && msg.contains("YPT_BRIDGE.md") && msg.contains("Exporting the model as .glb works without it"), "{msg}");
        assert!(!scratch.exists(), "an unusable bridge must be reported before the file is copied");
        assert!(!project.exists());
    }

    #[test]
    fn a_drawable_over_the_size_cap_is_refused_without_reading_it() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("huge.ydr");
        let mut f = std::fs::File::create(&p).unwrap();
        std::io::Write::write_all(&mut f, &rsc7_bytes(165)).unwrap();
        f.set_len(MAX_YDR_BYTES + 1).unwrap(); // sparse: no real data
        drop(f);
        let e = import_ydr(&BridgeConfig::default(), &dir.path().join("s"), &dir.path().join("p"), &p, &CancelToken::new()).unwrap_err();
        assert!(matches!(e, Error::InvalidParam(_)), "{e}");
        assert!(e.to_string().contains("256 MiB"), "{e}");
        // at the cap it is accepted by the size check (and then stopped by the missing bridge)
        let f = std::fs::OpenOptions::new().write(true).open(&p).unwrap();
        f.set_len(MAX_YDR_BYTES).unwrap();
        drop(f);
        let e = import_ydr(&BridgeConfig::default(), &dir.path().join("s"), &dir.path().join("p"), &p, &CancelToken::new()).unwrap_err();
        assert!(matches!(e, Error::ToolMissing { .. }), "{e}");
    }

    #[test]
    fn a_resource_file_with_another_name_is_explained_not_imported() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("w_ar_k2light.ydd");
        std::fs::write(&src, rsc7_bytes(165)).unwrap();
        let unrecognised = || Error::UnsupportedFormat("w_ar_k2light.ydd is not a recognised image, video or 3D model".into());
        let e = explain_unrecognised(&src, unrecognised());
        assert!(matches!(e, Error::UnsupportedFormat(_)));
        let msg = e.to_string();
        assert!(msg.contains("w_ar_k2light.ydd") && msg.contains("RSC7") && msg.contains("not imported as a drawable") && msg.contains(".ydr"), "{msg}");
        // other content keeps the generic wording, and other errors pass through untouched
        let text = dir.path().join("notes.png");
        std::fs::write(&text, b"just text").unwrap();
        assert_eq!(explain_unrecognised(&text, unrecognised()).to_string(), unrecognised().to_string());
        assert!(matches!(explain_unrecognised(&src, Error::NotFound("x".into())), Error::NotFound(_)));
        assert!(matches!(explain_unrecognised(&dir.path().join("gone.bin"), unrecognised()), Error::UnsupportedFormat(_)));
    }

    #[test]
    fn a_raw_resource_file_can_never_be_stored_as_an_asset() {
        // fsx::import_asset (the importer) and write_bundle_asset (the project-bundle path) both sniff content
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("proj");
        let bytes = rsc7_bytes(165);
        for name in ["w.ydr", "w.glb", "w.png", "w.dat"] {
            let src = dir.path().join(name);
            std::fs::write(&src, &bytes).unwrap();
            assert!(matches!(import_asset(&project, &src), Err(Error::UnsupportedFormat(_))), "{name}");
        }
        let sha = sha256_hex(&bytes);
        for ext in ["ydr", "glb", "png"] {
            let rel = format!("assets/{sha}.{ext}");
            assert!(matches!(write_bundle_asset(&project, &rel, &bytes), Err(Error::NotMedia(_))), "{rel}");
            assert!(!project.join(&rel).exists());
        }
        assert_eq!(entries(&project.join("assets")), 0, "no file, not even a temporary one, may be left in the store");
    }

    #[test]
    fn glb_headers_are_checked_against_the_file_length() {
        let glb = tiny_glb();
        assert!(glb_header_matches(&glb, glb.len() as u64));
        assert!(!glb_header_matches(&glb, glb.len() as u64 + 4), "trailing bytes the container does not declare");
        assert!(!glb_header_matches(&glb, glb.len() as u64 - 4));
        let mut v1 = glb.clone();
        v1[4] = 1;
        assert!(!glb_header_matches(&v1, glb.len() as u64));
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        png.extend_from_slice(&[0; 8]);
        assert!(!glb_header_matches(&png, png.len() as u64));
        assert!(!glb_header_matches(&glb[..11], 11));
        assert!(!glb_header_matches(&[], 0));
    }

    #[test]
    fn the_summary_is_read_from_the_reply_and_never_invented() {
        let reply = serde_json::json!({
            "ok": true, "lod": "med", "models": 2, "geometries": 3, "vertices": 44, "triangles": 22,
            "warnings": ["  first  ", "second"], "windingFlippedGeometries": 1
        });
        let c = conversion_from_reply(&reply).unwrap();
        assert_eq!(c, YdrConversion { lod: "med".into(), models: 2, geometries: 3, vertices: 44, triangles: 22, warnings: vec!["first".into(), "second".into()] });
        // warnings are optional; a missing list is an empty one
        let mut no_warnings = reply.clone();
        no_warnings.as_object_mut().unwrap().remove("warnings");
        assert!(conversion_from_reply(&no_warnings).unwrap().warnings.is_empty());
        // every count and the lod are required and must have the right type
        for key in ["lod", "models", "geometries", "vertices", "triangles"] {
            let mut r = reply.clone();
            r.as_object_mut().unwrap().remove(key);
            let e = conversion_from_reply(&r).unwrap_err();
            assert!(matches!(e, Error::Data(_)) && e.to_string().contains(key), "{key}: {e}");
        }
        for (key, bad) in [("models", serde_json::json!("2")), ("vertices", serde_json::json!(-1)), ("triangles", serde_json::json!(1.5)), ("lod", serde_json::json!("ultra")), ("lod", serde_json::json!(3))] {
            let mut r = reply.clone();
            r[key] = bad.clone();
            assert!(conversion_from_reply(&r).is_err(), "{key} = {bad}");
        }
    }

    #[test]
    fn warnings_from_the_bridge_are_bounded_in_number_and_length() {
        let long = "é".repeat(MAX_YDR_WARNING_CHARS + 10); // multi-byte on purpose: the cut must land on a char boundary
        let many: Vec<String> = (0..MAX_YDR_WARNINGS + 7).map(|i| if i == 0 { long.clone() } else { format!("note {i}") }).collect();
        let reply = serde_json::json!({ "lod": "high", "models": 1, "geometries": 1, "vertices": 3, "triangles": 1, "warnings": many });
        let c = conversion_from_reply(&reply).unwrap();
        assert_eq!(c.warnings.len(), MAX_YDR_WARNINGS + 1);
        assert_eq!(c.warnings[0].chars().count(), MAX_YDR_WARNING_CHARS + 3);
        assert!(c.warnings[0].ends_with("..."));
        assert_eq!(c.warnings[1], "note 1");
        assert_eq!(c.warnings.last().unwrap(), "... and 7 more notes from the converter");
        // exactly at the limits nothing is cut
        let exact: Vec<String> = (0..MAX_YDR_WARNINGS).map(|_| "x".repeat(MAX_YDR_WARNING_CHARS)).collect();
        let reply = serde_json::json!({ "lod": "high", "models": 1, "geometries": 1, "vertices": 3, "triangles": 1, "warnings": exact });
        let c = conversion_from_reply(&reply).unwrap();
        assert_eq!(c.warnings.len(), MAX_YDR_WARNINGS);
        assert!(c.warnings.iter().all(|w| w.chars().count() == MAX_YDR_WARNING_CHARS));
    }

    #[test]
    fn scratch_folders_are_unique_private_and_removed_on_drop() {
        let root = tempfile::tempdir().unwrap();
        let a = ScratchDir::create(root.path(), "ydr").unwrap();
        let b = ScratchDir::create(root.path(), "ydr").unwrap();
        assert_ne!(a.0, b.0);
        // compare with the same normalisation the code applies (on Windows canonicalize() adds a \\?\ prefix that
        // require_existing_dir strips, and Path::starts_with compares prefix components exactly)
        assert!(a.0.starts_with(crate::sanitize::require_existing_dir(root.path()).unwrap()) && a.0.is_dir());
        std::fs::write(a.0.join("source.ydr"), b"x").unwrap();
        std::fs::create_dir(a.0.join("nested")).unwrap();
        let (pa, pb) = (a.0.clone(), b.0.clone());
        drop(a);
        assert!(!pa.exists() && pb.exists(), "dropping one must not touch the other");
        drop(b);
        assert_eq!(entries(root.path()), 0);
        // a root that cannot be a folder is an error, not a panic
        let file = root.path().join("file");
        std::fs::write(&file, b"x").unwrap();
        assert!(ScratchDir::create(&file.join("sub"), "ydr").is_err());
        let relative = Path::new("vfxforge-relative-scratch-must-not-appear");
        assert!(matches!(ScratchDir::create(relative, "ydr"), Err(Error::UnsafePath(_))));
        assert!(!relative.exists(), "a rejected relative root must not be created in the working directory");
    }

    /// The tests below run the REAL `run_bridge` / `import_ydr` code against a stand-in converter: `/bin/sh` is
    /// configured as `dotnet` and the "dll" is a shell script, so the argument vector, the reply handling and the
    /// clean-up are exercised everywhere there is a POSIX shell, without .NET. The real converter is covered by
    /// `tests/ydr_integration.rs`.
    #[cfg(unix)]
    mod stand_in_converter {
        use super::*;

        const OK_REPLY: &str = r#"{"ok":true,"output":"/gone/model.glb","bytes":1,"name":"fake","gen":"legacy","resourceVersion":165,"lod":"high","lodsAvailable":["high"],"models":2,"geometries":3,"vertices":44,"triangles":22,"windingFlippedGeometries":1,"hasSkeleton":false,"boneTransformsApplied":false,"warnings":["first note","second note"]}"#;

        struct Rig {
            dir: tempfile::TempDir,
        }

        impl Rig {
            fn new() -> Self {
                let rig = Rig { dir: tempfile::tempdir().unwrap() };
                std::fs::create_dir(rig.rec()).unwrap();
                std::fs::write(rig.dir.path().join("tiny.glb"), tiny_glb()).unwrap();
                rig
            }
            fn scratch(&self) -> PathBuf {
                self.dir.path().join("scratch")
            }
            fn project(&self) -> PathBuf {
                self.dir.path().join("proj")
            }
            fn rec(&self) -> PathBuf {
                self.dir.path().join("rec")
            }
            fn glb(&self) -> PathBuf {
                self.dir.path().join("tiny.glb")
            }
            fn source(&self, bytes: &[u8]) -> PathBuf {
                let p = self.dir.path().join("w_ar_k2light.ydr");
                std::fs::write(&p, bytes).unwrap();
                p
            }
            fn bridge(&self, script: &str) -> BridgeConfig {
                let dll = self.dir.path().join("vfxforge-ypt-bridge.dll");
                std::fs::write(&dll, script).unwrap();
                BridgeConfig { dotnet: Some(PathBuf::from("/bin/sh")), dll: Some(dll) }
            }
            fn run(&self, script: &str, src: &Path) -> Result<YdrImport> {
                import_ydr(&self.bridge(script), &self.scratch(), &self.project(), src, &CancelToken::new())
            }
            fn no_leftovers(&self) {
                assert_eq!(entries(&self.scratch()), 0, "the scratch folder must be empty");
                assert_eq!(entries(&self.project().join("assets")), 0, "nothing may have been stored");
            }
        }

        #[test]
        fn success_stores_the_glb_and_hands_the_bridge_a_private_copy() {
            let rig = Rig::new();
            let ydr = rsc7_bytes(165);
            let src = rig.source(&ydr);
            let script = format!(
                "printf '%s\\n' \"$@\" > '{rec}/args.txt'\ncp \"$3\" '{rec}/input.copy'\ncp '{glb}' \"$5\"\nprintf 'diagnostics on stdout before the reply\\n'\nprintf '%s\\n' '{OK_REPLY}'\n",
                rec = rig.rec().display(),
                glb = rig.glb().display()
            );
            let done = rig.run(&script, &src).unwrap();

            // the stored asset is the GLB the converter wrote, by content
            let glb = tiny_glb();
            assert_eq!(done.asset.kind, MediaKind::Glb);
            assert_eq!(done.asset.category, Category::Model);
            assert_eq!(done.asset.mime, "model/gltf-binary");
            assert_eq!(done.asset.sha256, sha256_hex(&glb));
            assert_eq!(done.asset.rel_path, format!("assets/{}.glb", sha256_hex(&glb)));
            assert!(!done.asset.deduplicated);
            assert_eq!(std::fs::read(rig.project().join(&done.asset.rel_path)).unwrap(), glb);
            // the summary comes from the reply
            assert_eq!(done.conversion, YdrConversion { lod: "high".into(), models: 2, geometries: 3, vertices: 44, triangles: 22, warnings: vec!["first note".into(), "second note".into()] });
            assert_eq!(done.bridge_reply["name"], "fake");
            assert_eq!(done.bridge_reply["windingFlippedGeometries"], 1);
            assert!(done.bridge_reply.get("output").is_none(), "the scratch path must not outlive the scratch folder");

            // exactly what the converter was started with
            let args = std::fs::read_to_string(rig.rec().join("args.txt")).unwrap();
            let args: Vec<&str> = args.lines().collect();
            assert_eq!(args.len(), 5, "{args:?}");
            assert_eq!((args[0], args[1], args[3]), ("ydr2glb", "--in", "--out"));
            let scratch = rig.scratch().canonicalize().unwrap();
            assert!(Path::new(args[2]).starts_with(&scratch) && args[2].ends_with("/source.ydr"), "{args:?}");
            assert!(Path::new(args[4]).starts_with(&scratch) && args[4].ends_with("/model.glb"), "{args:?}");
            assert_ne!(Path::new(args[2]), src.as_path(), "the user's file is never handed to the converter");
            assert_eq!(std::fs::read(rig.rec().join("input.copy")).unwrap(), ydr, "the converter read a byte-identical copy");

            // everything temporary is gone, the original is untouched, nothing but the GLB was stored
            assert_eq!(entries(&rig.scratch()), 0);
            assert_eq!(std::fs::read(&src).unwrap(), ydr);
            assert_eq!(entries(&rig.project().join("assets")), 1);

            // the same converter output again is the same asset
            let again = rig.run(&script, &src).unwrap();
            assert!(again.asset.deduplicated);
            assert_eq!(again.asset.rel_path, done.asset.rel_path);
            assert_eq!(entries(&rig.project().join("assets")), 1);
            assert_eq!(entries(&rig.scratch()), 0);
        }

        #[test]
        fn an_outdated_bridge_says_to_rebuild_it() {
            let rig = Rig::new();
            let src = rig.source(&rsc7_bytes(165));
            let old = "printf '%s\\n' '{\"ok\":false,\"code\":\"unknown_command\",\"error\":\"Unknown command '\"'\"'ydr2glb'\"'\"'. Commands: version, xml2ypt, ypt2xml, xml-normalize.\"}'\nexit 1\n";
            let e = rig.run(old, &src).unwrap_err();
            assert_eq!(e.code(), "tool_failed");
            let msg = e.to_string();
            assert!(msg.contains("too old") && msg.contains("Rebuild tools/ypt-bridge") && msg.contains("Settings > Tools"), "{msg}");
            rig.no_leftovers();
        }

        #[test]
        fn failures_the_bridge_reports_are_surfaced_with_its_message_and_leave_nothing_behind() {
            let rig = Rig::new();
            let src = rig.source(&rsc7_bytes(165));
            let fail = |code: &str, msg: &str| format!("cp '{}' \"$5\"\nprintf '%s\\n' '{{\"ok\":false,\"code\":\"{code}\",\"error\":\"{msg}\"}}'\nexit 1\n", rig.glb().display());
            for (code, msg) in [("unsupported_version", "RSC7 resource version 68 is not a drawable version"), ("parse_failed", "CodeWalker could not read this file as a drawable"), ("no_geometry", "The drawable has no renderable geometry"), ("too_large", "The file is 300 MiB")] {
                let e = rig.run(&fail(code, msg), &src).unwrap_err();
                let text = e.to_string();
                assert_eq!(e.code(), "tool_failed", "{code}");
                assert!(text.contains(msg) && text.contains(code) && text.ends_with("Nothing was imported."), "{code}: {text}");
                rig.no_leftovers(); // even though the stand-in left a finished GLB in the scratch folder
            }
        }

        #[test]
        fn a_crashing_converter_is_reported_with_its_exit_code_and_stderr() {
            let rig = Rig::new();
            let src = rig.source(&rsc7_bytes(165));
            let e = rig.run("echo 'Unhandled exception. System.BadImageFormatException' >&2\nexit 134\n", &src).unwrap_err();
            let msg = e.to_string();
            assert!(matches!(e, Error::ToolFailed { code: Some(134), .. }), "{msg}");
            assert!(msg.contains("exit code 134") && msg.contains("BadImageFormatException"), "{msg}");
            assert!(msg.contains("stopped without answering") && msg.contains("Nothing was imported."), "{msg}");
            rig.no_leftovers();
            // killed by a signal: no exit code, no output, and the message still says what happened
            let e = rig.run("kill -9 $$\n", &src).unwrap_err();
            let msg = e.to_string();
            assert!(matches!(e, Error::ToolFailed { code: None, .. }), "{msg}");
            assert!(msg.contains("terminated without an exit code") && msg.contains("Nothing was imported."), "{msg}");
            rig.no_leftovers();
            // garbage on stdout is not a reply either
            let e = rig.run("echo 'segmentation fault'\nexit 0\n", &src).unwrap_err();
            assert!(matches!(e, Error::Data(_)), "{e}");
            rig.no_leftovers();
        }

        #[test]
        fn a_reply_that_does_not_match_the_output_is_not_trusted() {
            let rig = Rig::new();
            let src = rig.source(&rsc7_bytes(165));
            let reply = format!("printf '%s\\n' '{OK_REPLY}'\n");

            // success claimed, no file written
            let e = rig.run(&reply, &src).unwrap_err();
            assert!(e.to_string().contains("wrote no .glb"), "{e}");
            rig.no_leftovers();

            // success claimed, a PNG written (the store would accept a PNG as media: the GLB check must not)
            let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
            png.extend_from_slice(&[7; 40]);
            std::fs::write(rig.dir.path().join("x.png"), &png).unwrap();
            let e = rig.run(&format!("cp '{}' \"$5\"\n{reply}", rig.dir.path().join("x.png").display()), &src).unwrap_err();
            assert!(matches!(e, Error::Data(_)) && e.to_string().contains("not a valid .glb"), "{e}");
            rig.no_leftovers();

            // a GLB whose header disagrees with the file length (truncated or padded)
            let mut padded = tiny_glb();
            padded.extend_from_slice(&[0; 8]);
            std::fs::write(rig.dir.path().join("padded.glb"), &padded).unwrap();
            let e = rig.run(&format!("cp '{}' \"$5\"\n{reply}", rig.dir.path().join("padded.glb").display()), &src).unwrap_err();
            assert!(e.to_string().contains("not a valid .glb"), "{e}");
            rig.no_leftovers();

            // an output over the size cap is never stored (sparse, so cheap to make)
            let e = rig.run(&format!("dd if=/dev/null of=\"$5\" bs=1 seek={} count=0 2>/dev/null\n{reply}", MAX_GLB_BYTES + 1), &src).unwrap_err();
            assert!(matches!(e, Error::InvalidParam(_)) && e.to_string().contains("256 MiB"), "{e}");
            rig.no_leftovers();

            // a reply without the counts is refused even though the file is fine
            let thin = format!("cp '{}' \"$5\"\nprintf '%s\\n' '{{\"ok\":true,\"lod\":\"high\",\"models\":1}}'\n", rig.glb().display());
            let e = rig.run(&thin, &src).unwrap_err();
            assert!(matches!(e, Error::Data(_)) && e.to_string().contains("geometries"), "{e}");
            rig.no_leftovers();
        }

        #[test]
        fn cancelling_stops_the_converter_and_cleans_up() {
            let rig = Rig::new();
            let src = rig.source(&rsc7_bytes(165));
            let cancel = CancelToken::new();
            cancel.cancel();
            let started = std::time::Instant::now();
            let e = import_ydr(&rig.bridge("sleep 30\n"), &rig.scratch(), &rig.project(), &src, &cancel).unwrap_err();
            assert!(matches!(e, Error::Cancelled), "{e}");
            assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
            rig.no_leftovers();
        }
    }
}
