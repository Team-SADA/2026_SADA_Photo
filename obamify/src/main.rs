#![warn(clippy::all, rust_2018_idioms)]
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")] // hide console window on Windows in release

use serde::Deserialize;
use std::path::PathBuf;

#[derive(Deserialize, Debug)]
struct PendingJob {
    source: String,
    target: String,
    user_id: Option<String>,
    status: String,
}

// When compiling natively:
#[cfg(not(target_arch = "wasm32"))]
fn main() -> eframe::Result {
    env_logger::init(); // Log to stderr

    // 명령줄 인자 확인
    let args: Vec<String> = std::env::args().collect();
    let is_auto = args.contains(&"--auto".to_string());

    if is_auto {
        println!("[obamify-cli] 🚀 Starting in Single-Job Autonomous Mode...");
        const FLASK_URL: &str = "http://localhost:5000";
        
        // Flask 서버에 작업이 등록될 때까지 잠시 대기 (최대 5번 시도)
        let mut job_found = false;
        for _ in 0..5 {
            match reqwest::blocking::get(format!("{}/api/pending_job", FLASK_URL)) {
                Ok(resp) if resp.status() == 200 => {
                    if let Ok(text) = resp.text() {
                        if let Ok(job) = serde_json::from_str::<PendingJob>(&text) {
                            println!("[obamify-cli] Found a pending job! Source: {}, Target: {}, User: {:?}", job.source, job.target, job.user_id);
                            
                            let temp_dir = std::env::temp_dir();
                            let source_path = temp_dir.join(&job.source);
                            let target_path = temp_dir.join(&job.target);

                            if download_file(&format!("{}/source/{}", FLASK_URL, job.source), &source_path).is_ok() &&
                               download_file(&format!("{}/source/{}", FLASK_URL, job.target), &target_path).is_ok() {
                                
                                println!("[obamify-cli] Downloaded images. Starting conversion...");
                                
                                unsafe {
                                    std::env::set_var("OBAMIFY_AUTO_SOURCE", source_path.to_str().unwrap());
                                    std::env::set_var("OBAMIFY_AUTO_TARGET", target_path.to_str().unwrap());
                                    if let Some(uid) = &job.user_id {
                                        std::env::set_var("OBAMIFY_AUTO_USER_ID", uid);
                                    }
                                }
                                
                                let native_options = eframe::NativeOptions {
                                    viewport: egui::ViewportBuilder::default()
                                        .with_inner_size([1024.0, 1024.0]),
                                    ..Default::default()
                                };

                                let _ = eframe::run_native(
                                    "obamify-auto",
                                    native_options,
                                    Box::new(|cc| Ok(Box::new(obamify::ObamifyApp::new(cc)))),
                                );
                                job_found = true;
                                break;
                            }
                        }
                    }
                }
                _ => {}
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }

        if !job_found {
            eprintln!("[obamify-cli] ❌ No pending job found after retries. Exiting.");
            std::process::exit(1);
        }
        std::process::exit(0);
    } else {
        // 기존 일반 GUI 수동 실행 모드
        let native_options = eframe::NativeOptions {
            viewport: egui::ViewportBuilder::default()
                .with_inner_size([1024.0, 1024.0])
                .with_min_inner_size([400.0, 400.0])
                .with_icon(
                    eframe::icon_data::from_png_bytes(&include_bytes!("../assets/icon128.png")[..])
                        .expect("Failed to load icon"),
                ),
            ..Default::default()
        };
        eframe::run_native(
            "obamify",
            native_options,
            Box::new(|cc| Ok(Box::new(obamify::ObamifyApp::new(cc)))),
        )
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn download_file(url: &str, dest: &PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    let mut resp = reqwest::blocking::get(url)?;
    let mut file = std::fs::File::create(dest)?;
    std::io::copy(&mut resp, &mut file)?;
    Ok(())
}

// When compiling to web using trunk:
#[cfg(target_arch = "wasm32")]
fn start_app() {
    use eframe::wasm_bindgen::JsCast as _;
    std::panic::set_hook(Box::new(console_error_panic_hook::hook));

    eframe::WebLogger::init(log::LevelFilter::Warn).ok();

    let web_options = eframe::WebOptions {
        wgpu_options: egui_wgpu::WgpuConfiguration {
            wgpu_setup: egui_wgpu::WgpuSetup::CreateNew(egui_wgpu::WgpuSetupCreateNew {
                instance_descriptor: egui_wgpu::wgpu::InstanceDescriptor {
                    backends: egui_wgpu::wgpu::Backends::GL,
                    ..Default::default()
                },
                power_preference: egui_wgpu::wgpu::PowerPreference::HighPerformance,
                device_descriptor: std::sync::Arc::new(|_adapter| {
                    let mut limits = egui_wgpu::wgpu::Limits::downlevel_webgl2_defaults();
                    limits.max_texture_dimension_2d = 4096;
                    egui_wgpu::wgpu::DeviceDescriptor {
                        label: Some("egui_device"),
                        required_features: egui_wgpu::wgpu::Features::default(),
                        required_limits: limits,
                        memory_hints: egui_wgpu::wgpu::MemoryHints::default(),
                        trace: Default::default(),
                    }
                }),
                native_adapter_selector: None,
            }),
            ..Default::default()
        },
        ..Default::default()
    };

    wasm_bindgen_futures::spawn_local(async {
        let document = web_sys::window()
            .expect("No window")
            .document()
            .expect("No document");

        let canvas = document
            .get_element_by_id("the_canvas_id")
            .expect("Failed to find the_canvas_id")
            .dyn_into::<web_sys::HtmlCanvasElement>()
            .expect("the_canvas_id was not a HtmlCanvasElement");

        let start_result = eframe::WebRunner::new()
            .start(
                canvas,
                web_options,
                Box::new(|cc| Ok(Box::new(obamify::ObamifyApp::new(cc)))),
            )
            .await;

        if let Some(loading_text) = document.get_element_by_id("loading_text") {
            match start_result {
                Ok(_) => {
                    loading_text.remove();
                }
                Err(e) => {
                    use web_sys::js_sys::JsString;

                    loading_text.set_inner_html(&format!(
                        "<div> Please enable hardware acceleration in your browser :) </div> <div class=\"error\"> Error: {} </div>",
                        std::convert::Into::<JsString>::into(e.clone())
                    ));
                    panic!("Failed to start eframe: {e:?}");
                }
            }
        }
    });
}

#[cfg(target_arch = "wasm32")]
pub fn main() {
    use wasm_bindgen::JsCast as _;
    console_error_panic_hook::set_once();

    if web_sys::window().is_some() {
        start_app();
        return;
    }

    if web_sys::js_sys::global()
        .dyn_ref::<web_sys::DedicatedWorkerGlobalScope>()
        .is_some()
    {
        obamify::worker_entry();
        return;
    }

    web_sys::console::warn_1(
        &"Unknown global (not Window / not DedicatedWorkerGlobalScope)".into(),
    );
}
