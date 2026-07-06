use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{Emitter, State};

struct TerminalState {
    writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
}

#[tauri::command]
fn read_config() -> Result<String, String> {
    let config_path = "/home/bakdoolot/.config/liquid-terminal/config.json";
    if Path::new(config_path).exists() {
        fs::read_to_string(config_path).map_err(|e| e.to_string())
    } else {
        Err("Config file does not exist".into())
    }
}

#[tauri::command]
fn write_to_pty(data: String, state: State<'_, TerminalState>) -> Result<(), String> {
    let mut writer_guard = state.writer.lock().map_err(|e| e.to_string())?;

    if let Some(writer) = writer_guard.as_mut() {
        writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("PTY writer is not ready".into())
    }
}

#[tauri::command]
fn resize_pty(rows: u16, cols: u16, state: State<'_, TerminalState>) -> Result<(), String> {
    let master_guard = state.master.lock().map_err(|e| e.to_string())?;

    if let Some(master) = master_guard.as_ref() {
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let writer_arc = Arc::new(Mutex::new(None));
    let writer_for_state = writer_arc.clone();
    let master_arc = Arc::new(Mutex::new(None));
    let master_for_state = master_arc.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(TerminalState {
            writer: writer_for_state,
            master: master_for_state,
        })
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let writer_clone = writer_arc.clone();
            let master_clone = master_arc.clone();

            thread::spawn(move || {
                let pty_system = native_pty_system();
                let pair = match pty_system.openpty(PtySize {
                    rows: 24,
                    cols: 80,
                    pixel_width: 0,
                    pixel_height: 0,
                }) {
                    Ok(pair) => pair,
                    Err(err) => {
                        let _ = app_handle
                            .emit("pty-data", format!("Не удалось открыть PTY: {err}\r\n"));
                        return;
                    }
                };

                let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
                let mut cmd = CommandBuilder::new(shell);
                cmd.env("TERM", "xterm-256color");
                cmd.env("COLORTERM", "truecolor");

                let mut child = match pair.slave.spawn_command(cmd) {
                    Ok(child) => child,
                    Err(err) => {
                        let _ = app_handle
                            .emit("pty-data", format!("Не удалось запустить shell: {err}\r\n"));
                        return;
                    }
                };

                drop(pair.slave);

                let mut reader = match pair.master.try_clone_reader() {
                    Ok(reader) => reader,
                    Err(err) => {
                        let _ = app_handle
                            .emit("pty-data", format!("Не удалось читать PTY: {err}\r\n"));
                        return;
                    }
                };

                match pair.master.take_writer() {
                    Ok(writer) => {
                        *writer_clone.lock().unwrap() = Some(writer);
                    }
                    Err(err) => {
                        let _ = app_handle
                            .emit("pty-data", format!("Не удалось писать в PTY: {err}\r\n"));
                        return;
                    }
                }

                *master_clone.lock().unwrap() = Some(pair.master);

                let app_handle_for_exit = app_handle.clone();
                thread::spawn(move || {
                    if let Ok(status) = child.wait() {
                        let _ = app_handle_for_exit.emit(
                            "pty-data",
                            format!("\r\n[process exited with code {}]\r\n", status.exit_code()),
                        );
                    }
                });

                let mut buffer = [0; 4096];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(n) => {
                            let output_str = String::from_utf8_lossy(&buffer[..n]).to_string();
                            let _ = app_handle.emit("pty-data", output_str);
                        }
                        Err(_) => break,
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_config,
            write_to_pty,
            resize_pty
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
