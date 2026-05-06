use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{Emitter, Manager};
use url::Url;

struct PendingOpenFiles(Mutex<Vec<String>>);

#[tauri::command]
fn take_pending_open_files(state: tauri::State<'_, PendingOpenFiles>) -> Vec<String> {
    let mut files = state.0.lock().expect("pending open files lock poisoned");
    std::mem::take(&mut *files)
}

fn is_markdown_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".mdown") || lower.ends_with(".mkd")
}

fn file_urls_to_paths(urls: Vec<Url>) -> Vec<String> {
    urls.into_iter()
        .filter_map(|url| url.to_file_path().ok())
        .filter_map(|path| path.to_str().map(ToOwned::to_owned))
        .filter(|path| is_markdown_path(path))
        .collect()
}

fn cli_markdown_paths() -> Vec<String> {
    std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .filter_map(|path| path.to_str().map(ToOwned::to_owned))
        .filter(|path| is_markdown_path(path))
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(PendingOpenFiles(Mutex::new(Vec::new())))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![take_pending_open_files])
        .setup(|app| {
            let cli_files = cli_markdown_paths();
            if !cli_files.is_empty() {
                let state = app.state::<PendingOpenFiles>();
                state
                    .0
                    .lock()
                    .expect("pending open files lock poisoned")
                    .extend(cli_files);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building DocTrail");

    app.run(|app_handle, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = event {
            let paths = file_urls_to_paths(urls);
            if paths.is_empty() {
                return;
            }

            let state = app_handle.state::<PendingOpenFiles>();
            state
                .0
                .lock()
                .expect("pending open files lock poisoned")
                .extend(paths.clone());
            let _ = app_handle.emit("open-files", paths);
        }
    });
}
