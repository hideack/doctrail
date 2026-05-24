use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Emitter, Manager};
use url::Url;

struct PendingOpenFiles(Mutex<Vec<String>>);

#[derive(Serialize, Clone)]
struct FileNode {
    name: String,
    path: String,
    is_directory: bool,
    children: Vec<FileNode>,
}

#[derive(Serialize)]
struct PendingPaths {
    files: Vec<String>,
    directory: Option<String>,
}

#[tauri::command]
fn take_pending_open_files(state: tauri::State<'_, PendingOpenFiles>) -> Vec<String> {
    let mut files = state.0.lock().expect("pending open files lock poisoned");
    std::mem::take(&mut *files)
}

#[tauri::command]
fn take_pending_open_paths(state: tauri::State<'_, PendingOpenFiles>) -> PendingPaths {
    let mut all = state.0.lock().expect("pending open files lock poisoned");
    let paths = std::mem::take(&mut *all);

    let mut directory: Option<String> = None;
    let mut files: Vec<String> = Vec::new();

    for path in paths {
        let p = Path::new(&path);
        if p.is_dir() && directory.is_none() {
            directory = Some(path);
        } else if is_markdown_path(&path) {
            files.push(path);
        }
    }

    PendingPaths { files, directory }
}

#[tauri::command]
fn scan_directory(path: String) -> Result<Vec<FileNode>, String> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("{path} is not a directory"));
    }
    Ok(scan_dir_recursive(dir))
}

fn scan_dir_recursive(dir: &Path) -> Vec<FileNode> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return vec![],
    };

    let mut nodes: Vec<FileNode> = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if name.starts_with('.') {
            continue;
        }

        if path.is_dir() {
            let children = scan_dir_recursive(&path);
            if !children.is_empty() {
                nodes.push(FileNode {
                    name,
                    path: path.to_string_lossy().to_string(),
                    is_directory: true,
                    children,
                });
            }
        } else if is_markdown_path(&path.to_string_lossy()) {
            nodes.push(FileNode {
                name,
                path: path.to_string_lossy().to_string(),
                is_directory: false,
                children: vec![],
            });
        }
    }

    nodes.sort_by(|a, b| match (a.is_directory, b.is_directory) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    nodes
}

fn is_markdown_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".mdown") || lower.ends_with(".mkd")
}

fn file_urls_to_paths(urls: Vec<Url>) -> Vec<String> {
    urls.into_iter()
        .filter_map(|url| url.to_file_path().ok())
        .filter_map(|path| path.to_str().map(ToOwned::to_owned))
        .filter(|path| {
            let p = Path::new(path);
            p.is_dir() || is_markdown_path(path)
        })
        .collect()
}

fn cli_open_paths() -> Vec<String> {
    std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .filter(|path| path.is_dir() || (path.is_file() && is_markdown_path(&path.to_string_lossy())))
        .filter_map(|path| path.to_str().map(ToOwned::to_owned))
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(PendingOpenFiles(Mutex::new(Vec::new())))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            take_pending_open_files,
            take_pending_open_paths,
            scan_directory
        ])
        .setup(|app| {
            let cli_paths = cli_open_paths();
            if !cli_paths.is_empty() {
                let state = app.state::<PendingOpenFiles>();
                state
                    .0
                    .lock()
                    .expect("pending open files lock poisoned")
                    .extend(cli_paths);
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
