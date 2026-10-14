fn main() {
    // Windows (MSVC) only. `cargo test` links a separate test executable that does not get the application
    // manifest tauri-build embeds into the real app, so it cannot load the Common Controls v6 DLL that the
    // dialog plugin's imports need and Windows kills it at launch (STATUS_ENTRYPOINT_NOT_FOUND, 0xc0000139)
    // before a single test runs. Declaring the dependency for test targets only leaves the shipped binary's
    // link step untouched.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os == "windows" && target_env == "msvc" {
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-tests=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' \
             version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
    }
    tauri_build::build()
}
