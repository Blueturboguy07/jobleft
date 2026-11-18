fn main() {
    // Test builds point the updater at a test feed (src/updates.rs, option_env!).
    println!("cargo:rerun-if-env-changed=PUBLIK_UPDATE_ENDPOINT");
    tauri_build::build()
}
