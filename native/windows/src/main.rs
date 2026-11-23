use nuphylab_core::{BridgeError, Result};
use serde_json::{json, Value};
use std::io::{self, Write};

use nuphylab_hid as probe;

fn send(value: Value) -> Result<()> {
    let mut out = io::stdout().lock();
    writeln!(out, "{value}")
        .and_then(|_| out.flush())
        .map_err(|_| BridgeError::new("PIPE_WRITE", "桥接回复通道已关闭"))
}
fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let lighting = lighting_mode(&args)?;
    let model_file = args
        .windows(2)
        .find(|arg| arg[0] == "--models")
        .map(|arg| &arg[1])
        .ok_or_else(|| BridgeError::new("INVALID_MODELS", "缺少 --models 设备配置"))?;
    let text = std::fs::read_to_string(model_file)
        .map_err(|_| BridgeError::new("INVALID_MODELS", "无法读取设备配置"))?;
    let models = nuphylab_core::models(&text)?;
    if lighting {
        return probe::runtime::run(&models, io::stdin(), io::stdout());
    }
    if args.iter().any(|arg| arg == "--enumerate") {
        send(json!({"ok":true,"result":probe::enumerate(&models)?}))?;
        return Ok(());
    }
    let mut status = disconnected();
    let mut reader = io::stdin().lock();
    let mut session = nuphylab_core::bridge::Session::default();
    let outcome = (|| -> Result<()> {
        while let Some(request) = nuphylab_core::json_line(&mut reader)? {
            let id = request.get("id").cloned().unwrap_or(Value::Null);
            let op = match session.accept(&request) {
                Ok(op) => op,
                Err(error) => {
                    send(json!({"id":id,"ok":false,"error":error}))?;
                    continue;
                }
            };
            let result = match op.as_str() {
                "hello" => Ok(session.hello(env!("CARGO_PKG_VERSION"))),
                "connect" => probe::connect(&models).inspect(|value| {
                    status = value.clone();
                }),
                "status" => {
                    if status["connected"] == true {
                        match probe::connect(&models) {
                            Ok(value) => {
                                status = value;
                                Ok(status.clone())
                            }
                            Err(error) => {
                                status = disconnected();
                                send(session.event("disconnected", json!({"needsRestore":false})))?;
                                Err(error)
                            }
                        }
                    } else {
                        Ok(status.clone())
                    }
                }
                "listDevices" => probe::enumerate(&models),
                "lightingSnapshot" => probe::lighting_snapshot(&models),
                "sleepSnapshot" => probe::sleep_snapshot(&models),
                "keymapSnapshot" => probe::keymap_snapshot(&models),
                "permissions" => Ok(
                    json!({"inputMonitoring":false,"accessibility":false,"canPostEvents":false,"promptsRequested":false,"platform":"win32"}),
                ),
                "bluetoothDevices" => Ok(json!({"devices":[],"count":0,"available":false})),
                "codexProcess" => Ok(json!({"running":false,"available":false})),
                "systemIdle" => Ok(json!({"available":false})),
                "restore" | "restoreKeys" | "restoreFunctionKey" => {
                    Ok(json!({"restored":true,"verified":true,"noMutation":true}))
                }
                "disconnect" => {
                    status = disconnected();
                    Ok(status.clone())
                }
                "quit" => Ok(json!({"quitting":true,"noMutation":true})),
                _ => Err(BridgeError::new(
                    "WINDOWS_PROBE_ONLY",
                    "Windows 预览版目前仅支持只读识别，尚未开放灯光和快捷控制",
                )),
            };
            match result {
                Ok(value) => send(json!({"id":id,"ok":true,"result":value}))?,
                Err(error) => send(json!({"id":id,"ok":false,"error":error}))?,
            }
            if op == "quit" {
                break;
            }
        }
        Ok(())
    })();
    send(session.event(
        "shutdownComplete",
        json!({"lightingRestored":true,"keysRestored":true,"noMutation":true}),
    ))?;
    outcome
}
fn lighting_mode(args: &[String]) -> Result<bool> {
    if !args.iter().any(|arg| arg == "--lighting") {
        return Ok(false);
    }
    let (mut index, mut models, mut lighting) = (1, false, false);
    let invalid = || {
        BridgeError::new(
            "INVALID_ARGUMENT",
            "灯光入口只接受一次 --lighting 与 --models 配置",
        )
    };
    while index < args.len() {
        match args[index].as_str() {
            "--lighting" if !lighting => lighting = true,
            "--models" if !models && args.get(index + 1).is_some_and(|v| !v.starts_with("--")) => {
                models = true;
                index += 1;
            }
            _ => return Err(invalid()),
        }
        index += 1;
    }
    if !models {
        return Err(invalid());
    }
    Ok(true)
}
fn disconnected() -> Value {
    json!({"connected":false,"identified":false,"armed":false,"readOnly":true,"recoveryPending":false,"needsRestore":false,"capabilities":{"perKey":false,"mainWholeZone":false,"functionKeyAdaptation":false}})
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{}: {}", error.code, error.message);
        std::process::exit(1);
    }
}
