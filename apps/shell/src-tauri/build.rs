fn main() {
    // The app's own commands, so a capability can allow them: the page is served from the local server (a remote
    // origin to Tauri), and remote content reaches an app command only through a capability that names it.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["open_page"])))
        .expect("tauri build");
}
