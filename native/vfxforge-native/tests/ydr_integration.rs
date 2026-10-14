//! `service::import_ydr` against the REAL CodeWalker bridge (`tools/ypt-bridge`), plus the parts of the
//! drawable import that need no bridge at all.
//!
//! Tests that run the converter are skipped (loudly) unless `VFXFORGE_BRIDGE_DLL` points at a built
//! `vfxforge-ypt-bridge.dll` (or the default `tools/ypt-bridge/out` build exists) and `dotnet` can run it, so a plain
//! `cargo test` works everywhere. Everything else here (validation, refusal of other content, the no-bridge message)
//! always runs.
//!
//! The `.ydr` fixtures are the bridge's own synthetic drawables (`tools/ypt-bridge/fixtures`, written by CodeWalker
//! from XML authored for this repository). No real GTA V drawable was available when these tests were written.

use serde_json::Value;
use std::path::{Path, PathBuf};
use vfxforge_native::bridge::{bridge_status, BridgeCommand, BridgeConfig};
use vfxforge_native::fsx::{import_asset, sha256_hex};
use vfxforge_native::jobs::CancelToken;
use vfxforge_native::probe::identify;
use vfxforge_native::service::{self, convert_ypt, explain_unrecognised, import_ydr, read_asset, ConvertArgs};
use vfxforge_native::sniff::{Category, MediaKind};
use vfxforge_native::Error;

fn dll_from_env(var: &str, default: Option<PathBuf>) -> Option<PathBuf> {
    std::env::var_os(var).map(PathBuf::from).or(default)
}

fn bridge_cfg() -> Option<BridgeConfig> {
    let default = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tools/ypt-bridge/out/vfxforge-ypt-bridge.dll");
    let dll = dll_from_env("VFXFORGE_BRIDGE_DLL", Some(default))?;
    if !dll.is_file() {
        eprintln!("SKIPPED: bridge not built at {}", dll.display());
        return None;
    }
    let cfg = BridgeConfig { dotnet: None, dll: Some(dll) };
    let st = bridge_status(&cfg);
    if !st.available {
        eprintln!("SKIPPED: bridge not usable: {}", st.detail);
        return None;
    }
    Some(cfg)
}

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
}

/// One test's private world: a project folder, the app's scratch root, and a place for source files.
struct World {
    dir: tempfile::TempDir,
}

impl World {
    fn new() -> Self {
        World { dir: tempfile::tempdir().unwrap() }
    }
    fn project(&self) -> PathBuf {
        self.dir.path().join("proj")
    }
    fn scratch(&self) -> PathBuf {
        self.dir.path().join("scratch")
    }
    /// Copies a fixture to `<tmp>/<as_name>` (so the file name is what the test says it is).
    fn source(&self, fixture: &str, as_name: &str) -> PathBuf {
        let p = self.dir.path().join(as_name);
        std::fs::write(&p, std::fs::read(fixture_path(fixture)).expect("fixture")).unwrap();
        p
    }
    fn put(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let p = self.dir.path().join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }
    fn import(&self, cfg: &BridgeConfig, src: &Path) -> vfxforge_native::Result<service::YdrImport> {
        import_ydr(cfg, &self.scratch(), &self.project(), src, &CancelToken::new())
    }
    fn assert_scratch_clean(&self) {
        let left = std::fs::read_dir(self.scratch()).map(|d| d.count()).unwrap_or(0);
        assert_eq!(left, 0, "the scratch folder must be empty");
    }
    fn stored_files(&self) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(self.project().join("assets")).map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
        v.sort();
        v
    }
}

/// The glTF JSON of a GLB, after checking the container (magic, version, declared length).
fn glb_json(bytes: &[u8]) -> Value {
    assert_eq!(&bytes[..4], b"glTF", "GLB magic");
    assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()), 2, "GLB container version");
    assert_eq!(u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize, bytes.len(), "declared GLB length");
    let json_len = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
    assert_eq!(&bytes[16..20], b"JSON", "first chunk is the JSON chunk");
    serde_json::from_slice(&bytes[20..20 + json_len]).expect("glTF JSON")
}

/// (meshes, primitives, vertices, triangles) counted from the glTF itself, not from the bridge's reply.
fn glb_counts(gltf: &Value) -> (usize, usize, u64, u64) {
    let accessors = gltf["accessors"].as_array().unwrap();
    let count = |i: &Value| accessors[i.as_u64().unwrap() as usize]["count"].as_u64().unwrap();
    let meshes = gltf["meshes"].as_array().unwrap();
    let (mut prims, mut verts, mut tris) = (0, 0, 0);
    for m in meshes {
        for p in m["primitives"].as_array().unwrap() {
            prims += 1;
            verts += count(&p["attributes"]["POSITION"]);
            tris += count(&p["indices"]) / 3;
        }
    }
    (meshes.len(), prims, verts, tris)
}

#[test]
fn imports_a_drawable_as_an_ordinary_glb_asset() {
    let Some(cfg) = bridge_cfg() else { return };
    let w = World::new();
    let src = w.source("cube_pnct.ydr", "w_ar_k2light.ydr");
    let before = std::fs::read(&src).unwrap();
    let done = w.import(&cfg, &src).expect("import");

    // an ordinary model asset, content-addressed
    let a = &done.asset;
    assert_eq!((a.kind, a.category, a.mime), (MediaKind::Glb, Category::Model, "model/gltf-binary"));
    assert_eq!(a.rel_path, format!("assets/{}.glb", a.sha256));
    assert!(!a.deduplicated);
    let stored = read_asset(&w.project(), &a.rel_path).unwrap();
    assert_eq!(sha256_hex(&stored), a.sha256);
    assert_eq!(stored.len() as u64, a.bytes);
    assert_eq!(identify(&w.project().join(&a.rel_path)).unwrap().1.kind, MediaKind::Glb);
    assert_eq!(w.stored_files(), [format!("{}.glb", a.sha256)], "the GLB is the only thing in the store");

    // the stored bytes are the converter's GLB, and its content matches what the summary claims
    let gltf = glb_json(&stored);
    assert_eq!(glb_counts(&gltf), (1, 1, 24, 12));
    assert_eq!(gltf["asset"]["version"], "2.0");
    let extras = &gltf["asset"]["extras"]["vfxforge"];
    assert_eq!(extras["source"], "ydr");
    assert_eq!((extras["vertices"].as_u64(), extras["triangles"].as_u64()), (Some(24), Some(12)));
    let c = &done.conversion;
    assert_eq!((c.lod.as_str(), c.models, c.geometries, c.vertices, c.triangles), ("high", 1, 1, 24, 12));
    assert!(c.warnings.is_empty(), "{:?}", c.warnings);
    assert_eq!(done.bridge_reply["gen"], "legacy");
    assert_eq!(done.bridge_reply["resourceVersion"], 165);
    assert_eq!(done.bridge_reply["bounds"]["min"], serde_json::json!([-0.5, 0.125, -1.75]));
    assert!(done.bridge_reply.get("output").is_none());

    // the .ydr itself was only read; nothing is left in the scratch folder
    assert_eq!(std::fs::read(&src).unwrap(), before);
    w.assert_scratch_clean();
}

#[test]
fn imports_the_highest_lod_and_passes_the_converters_notes_on() {
    let Some(cfg) = bridge_cfg() else { return };
    let w = World::new();
    let done = w.import(&cfg, &w.source("multi_lod.ydr", "multi.ydr")).expect("import");
    let c = &done.conversion;
    assert_eq!((c.lod.as_str(), c.models, c.geometries, c.vertices, c.triangles), ("high", 2, 3, 44, 22));
    assert_eq!(c.warnings.len(), 1, "{:?}", c.warnings);
    assert!(c.warnings[0].contains("no normals"), "{:?}", c.warnings);
    assert_eq!(done.bridge_reply["lodsAvailable"], serde_json::json!(["high", "med"]));
    assert_eq!(done.bridge_reply["windingFlippedGeometries"], 1);
    let stored = read_asset(&w.project(), &done.asset.rel_path).unwrap();
    assert_eq!(glb_counts(&glb_json(&stored)), (2, 3, 44, 22));
    w.assert_scratch_clean();
}

#[test]
fn a_gen9_resource_converts_to_the_same_mesh() {
    let Some(cfg) = bridge_cfg() else { return };
    let w = World::new();
    let legacy = w.import(&cfg, &w.source("cube_pnct.ydr", "legacy.ydr")).unwrap();
    let gen9 = w.import(&cfg, &w.source("cube_pnct_gen9.ydr", "gen9.ydr")).unwrap();
    assert_eq!(gen9.bridge_reply["gen"], "gen9");
    assert_eq!(gen9.bridge_reply["resourceVersion"], 159);
    assert_eq!(gen9.conversion, legacy.conversion);
    // same mesh, different provenance record in the asset extras: two distinct assets
    assert_ne!(gen9.asset.sha256, legacy.asset.sha256);
    w.assert_scratch_clean();
}

#[test]
fn the_same_drawable_is_stored_once_whatever_it_is_called_or_where_it_lives() {
    let Some(cfg) = bridge_cfg() else { return };
    let w = World::new();
    let first = w.import(&cfg, &w.source("cube_pnct.ydr", "one.ydr")).unwrap();
    std::fs::create_dir(w.dir.path().join("elsewhere")).unwrap();
    let second = w.import(&cfg, &w.source("cube_pnct.ydr", "elsewhere/a_different_name.YDR")).unwrap();
    assert!(!first.asset.deduplicated);
    assert!(second.asset.deduplicated, "converting is deterministic, so the same drawable must map to the same asset");
    assert_eq!(first.asset.rel_path, second.asset.rel_path);
    assert_eq!(first.asset.sha256, second.asset.sha256);
    assert_eq!(w.stored_files().len(), 1);
    // a different drawable is a different asset
    let other = w.import(&cfg, &w.source("multi_lod.ydr", "other.ydr")).unwrap();
    assert!(!other.asset.deduplicated);
    assert_ne!(other.asset.rel_path, first.asset.rel_path);
    assert_eq!(w.stored_files().len(), 2);
    w.assert_scratch_clean();
}

#[test]
fn concurrent_imports_do_not_share_a_scratch_folder() {
    let Some(cfg) = bridge_cfg() else { return };
    let w = World::new();
    let srcs = [w.source("cube_pnct.ydr", "a.ydr"), w.source("multi_lod.ydr", "b.ydr"), w.source("cube_pnct_gen9.ydr", "c.ydr"), w.source("multi_lod.ydr", "d.ydr")];
    let results: Vec<_> = std::thread::scope(|s| {
        let handles: Vec<_> = srcs.iter().map(|src| s.spawn(|| w.import(&cfg, src))).collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let vertices: Vec<u64> = results.iter().map(|r| r.as_ref().expect("import").conversion.vertices).collect();
    assert_eq!(vertices, [24, 44, 24, 44], "each import got its own drawable's result");
    assert_eq!(w.stored_files().len(), 3, "a, b/d (identical) and c");
    w.assert_scratch_clean();
}

#[test]
fn resource_files_that_are_not_drawables_are_refused_by_the_converter_and_leave_nothing_behind() {
    let Some(cfg) = bridge_cfg() else { return };
    let w = World::new();

    // a binary particle effect (version 68) renamed to .ydr: right container, wrong resource
    let fx = |name: &str| std::fs::read(fixture_path(name)).unwrap();
    let (_, ypt) = convert_ypt(
        &cfg,
        &w.dir.path().join("ypt-scratch"),
        &ConvertArgs { xml: String::from_utf8(fx("tiny_fx.ypt.xml")).unwrap(), gen9: false, asset_name: "tiny_fx".into(), files: vec![("tinyfx.dds".into(), fx("tinyfx.dds"))] },
        &CancelToken::new(),
    )
    .expect("make a binary YPT with the bridge");
    assert_eq!(&ypt[..4], b"RSC7");
    let e = w.import(&cfg, &w.put("particles.ydr", &ypt)).unwrap_err();
    let msg = e.to_string();
    assert_eq!(e.code(), "tool_failed", "{msg}");
    assert!(msg.contains("unsupported_version") && msg.contains("68") && msg.contains("Nothing was imported"), "{msg}");

    // a real drawable's resource header (so the sizes and version are plausible) followed by a payload that is not a deflate stream
    let real = std::fs::read(fixture_path("cube_pnct.ydr")).unwrap();
    let mut forged = real[..16].to_vec();
    forged.extend((0..4096u32).map(|i| (i.wrapping_mul(2654435761) >> 13) as u8));
    let e = w.import(&cfg, &w.put("forged.ydr", &forged)).unwrap_err();
    let msg = e.to_string();
    assert_eq!(e.code(), "tool_failed", "{msg}");
    assert!(msg.contains("parse_failed") && msg.contains("not a valid deflate stream"), "{msg}");

    // half of a real drawable
    let multi = std::fs::read(fixture_path("multi_lod.ydr")).unwrap();
    let e = w.import(&cfg, &w.put("truncated.ydr", &multi[..multi.len() / 2])).unwrap_err();
    assert!(e.to_string().contains("parse_failed") && e.to_string().contains("truncated"), "{e}");

    // the converter was started for all three and cleaned up after itself; nothing reached the store
    w.assert_scratch_clean();
    assert!(w.stored_files().is_empty());
}

#[test]
fn files_that_are_not_resources_never_reach_the_converter() {
    // no bridge is configured at all: these fail on the file, not on the missing tool
    let w = World::new();
    let cfg = BridgeConfig::default();
    for (name, bytes) in [("text.ydr", &b"definitely not a drawable"[..]), ("empty.ydr", b""), ("rsc.ydr", b"RSC"), ("glb.ydr", b"glTF\x02\x00\x00\x00\x0c\x00\x00\x00")] {
        let e = w.import(&cfg, &w.put(name, bytes)).unwrap_err();
        assert!(matches!(e, Error::UnsupportedFormat(_)), "{name}: {e}");
        assert!(e.to_string().contains("not a GTA V resource file"), "{name}: {e}");
    }
    assert!(!w.scratch().exists() && !w.project().exists());
}

#[test]
fn a_real_drawable_with_another_name_never_takes_the_drawable_path() {
    let w = World::new();
    let project = w.project();
    for name in ["model.png", "model.glb", "model.gltf", "model.obj", "model.fbx", "model.dat", "model.ydr.bak", "model.yft", "model"] {
        let src = w.source("cube_pnct.ydr", name);
        // the importer sniffs content, and a resource file is not media, whatever it is called
        let e = import_asset(&project, &src).unwrap_err();
        assert!(matches!(e, Error::UnsupportedFormat(_)), "{name}: {e}");
        let msg = explain_unrecognised(&src, e).to_string();
        assert!(msg.contains("RSC7") && msg.contains("not imported as a drawable") && msg.contains(name), "{name}: {msg}");
        // and asking for the drawable converter by hand is refused too
        assert!(matches!(w.import(&BridgeConfig::default(), &src), Err(Error::InvalidParam(_))), "{name}");
        assert!(!service::is_ydr_path(&src));
    }
    assert!(w.stored_files().is_empty());
    assert!(!w.scratch().exists());
}

#[test]
fn without_a_bridge_the_error_says_what_to_do() {
    let w = World::new();
    let src = w.source("cube_pnct.ydr", "w_ar_k2light.ydr");
    let e = w.import(&BridgeConfig::default(), &src).unwrap_err();
    assert!(matches!(e, Error::ToolMissing { .. }), "{e}");
    assert_eq!(e.code(), "tool_missing");
    let msg = e.to_string();
    for needle in ["Settings > Tools", "docs/YPT_BRIDGE.md", "Exporting the model as .glb works without it"] {
        assert!(msg.contains(needle), "{needle:?} missing from: {msg}");
    }
    assert!(!w.scratch().exists() && w.stored_files().is_empty(), "nothing is copied or stored when the converter cannot run");
}

#[test]
fn a_bridge_built_before_ydr2glb_existed_is_told_to_be_rebuilt() {
    // VFXFORGE_OLD_BRIDGE_DLL: a bridge built from a revision without the ydr2glb command (0.1.x)
    let Some(dll) = dll_from_env("VFXFORGE_OLD_BRIDGE_DLL", None).filter(|p| p.is_file()) else {
        eprintln!("SKIPPED: set VFXFORGE_OLD_BRIDGE_DLL to a bridge built before ydr2glb");
        return;
    };
    let cfg = BridgeConfig { dotnet: None, dll: Some(dll) };
    if !bridge_status(&cfg).available {
        eprintln!("SKIPPED: old bridge not usable");
        return;
    }
    let w = World::new();
    let e = w.import(&cfg, &w.source("cube_pnct.ydr", "w.ydr")).unwrap_err();
    let msg = e.to_string();
    assert_eq!(e.code(), "tool_failed");
    assert!(msg.contains("too old") && msg.contains("Rebuild tools/ypt-bridge") && msg.contains("Settings > Tools"), "{msg}");
    // the old bridge still does what it did
    let (_, ypt) = convert_ypt(
        &cfg,
        &w.dir.path().join("ypt-scratch"),
        &ConvertArgs { xml: std::fs::read_to_string(fixture_path("tiny_fx.ypt.xml")).unwrap(), gen9: false, asset_name: "tiny_fx".into(), files: vec![("tinyfx.dds".into(), std::fs::read(fixture_path("tinyfx.dds")).unwrap())] },
        &CancelToken::new(),
    )
    .unwrap();
    assert_eq!(&ypt[..4], b"RSC7");
    w.assert_scratch_clean();
}

#[test]
fn the_other_commands_are_unaffected_by_the_new_one() {
    let Some(cfg) = bridge_cfg() else { return };
    let v = vfxforge_native::bridge::run_bridge(&cfg, &BridgeCommand::Version, &CancelToken::new(), std::time::Duration::from_secs(30)).unwrap();
    assert_eq!(v["ok"], true);
    assert!(v["version"].as_str().is_some_and(|s| !s.is_empty()));
}
