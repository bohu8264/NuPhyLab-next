//! Development-only peer for Node/Rust protocol tests. No HID dependency.
use nuphylab_core::{
    controller::{self, Backend},
    output::{Connection, Transport},
    BridgeError, Result,
};
use serde::{Deserialize, Serialize};
use std::{fs, io, path::PathBuf, time::Duration};
// The shared fault board contains knobs used by the core's protocol tests.
#[allow(dead_code)]
#[path = "../test-support/lighting_board.rs"]
mod board;

struct Simulator {
    board: board::Board,
    token: String,
    directory: PathBuf,
    index: u64,
    fault: String,
    painted: bool,
    original: Vec<u8>,
    original_rgb: Vec<u8>,
    original_sleep: [u8; 4],
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiskBoard {
    model_id: String,
    serial: String,
    profile: u8,
    firmware: Vec<u8>,
    state: Vec<u8>,
    palette: Vec<u8>,
    sleep: [u8; 4],
    original_state: Vec<u8>,
    original_rgb: Vec<u8>,
    original_sleep: [u8; 4],
}
impl Simulator {
    fn persist(&self) -> Result<()> {
        let value = DiskBoard {
            model_id: self.board.model.id.clone(),
            serial: self.board.connection.serial.clone().unwrap_or_default(),
            profile: self.board.profile,
            firmware: self.board.firmware.clone(),
            state: self.board.state.clone(),
            palette: self.board.palette.clone(),
            sleep: self.board.sleep,
            original_state: self.original.clone(),
            original_rgb: self.original_rgb.clone(),
            original_sleep: self.original_sleep,
        };
        fs::write(
            self.directory.join("simulator-hardware.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .map_err(|_| BridgeError::new("SIMULATOR_STATE", "无法保存模拟板状态"))
    }
}
impl Transport for Simulator {
    fn connection(&self) -> Connection {
        let mut value = self.board.connection();
        value.token = self.token.clone();
        value
    }
    fn pause(&mut self, delay: Duration) -> Result<()> {
        self.board.pause(delay)
    }
    fn exchange(&mut self, frame: &[u8; 64], timeout: Duration) -> Result<Vec<u8>> {
        if self.fault == "restore" && self.painted && frame[1] == 0xd6 {
            return Err(BridgeError::new(
                "SIMULATED_RESTORE_FAILURE",
                "模拟灯光恢复失败",
            ));
        }
        if self.fault == "cold-sleep" && self.painted && frame[1] == 0xf5 {
            return Err(BridgeError::new(
                "SIMULATED_SLEEP_FAILURE",
                "模拟休眠恢复失败",
            ));
        }
        let result = self.board.exchange(frame, timeout);
        self.painted |= frame[1] == 0xd8;
        self.persist()?;
        result
    }
}
impl Drop for Simulator {
    fn drop(&mut self) {
        let file = self.directory.join(format!(
            "simulator-audit-{}-{}.json",
            std::process::id(),
            self.index
        ));
        let report = serde_json::json!({"simulated":true,"originalState":self.original,"state":self.board.state,
            "originalRgb":self.original_rgb,"rgb":self.board.rgb(),"originalSleep":self.original_sleep,"sleep":self.board.sleep,
            "commands":self.board.calls.iter().map(|f| f[1]).collect::<Vec<_>>()});
        if let Err(error) = fs::write(file, report.to_string()) {
            eprintln!("SIMULATOR_AUDIT: {error}");
        }
    }
}
fn run() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    let arg = |name: &str| args.windows(2).find(|v| v[0] == name).map(|v| v[1].clone());
    let directory = PathBuf::from(
        arg("--directory")
            .ok_or_else(|| BridgeError::new("SIMULATOR_ARGUMENT", "缺少模拟临时目录"))?,
    );
    let id = arg("--model").unwrap_or_else(|| "air75-v3".into());
    let model = board::fixture()
        .models
        .into_iter()
        .find(|m| m.id == id)
        .ok_or_else(|| BridgeError::new("SIMULATOR_ARGUMENT", "未知模拟型号"))?;
    let fault = arg("--fault").unwrap_or_default();
    let firmware = arg("--firmware").unwrap_or_else(|| model.qualified_firmware.clone());
    nuphylab_core::lighting_policy::qualified(&model, &firmware)?;
    let version: Vec<u16> = firmware.split('.').map(|v| v.parse().unwrap()).collect();
    if !["", "paint", "restore", "cold-sleep"].contains(&fault.as_str()) {
        return Err(BridgeError::new("SIMULATOR_ARGUMENT", "未知模拟故障"));
    }
    let mut index = 0;
    controller::run(
        || {
            index += 1;
            let mut board = board::Board::new(&model);
            board.firmware = vec![
                version[2] as u8,
                version[1] as u8,
                version[0] as u8,
                170,
                version[3] as u8,
                (version[3] >> 8) as u8,
                0,
                0,
            ];
            if model.id == "air75-v3" {
                board.state[6..9].copy_from_slice(
                    &nuphylab_core::lighting_policy::main_color_readback_for(
                        &model,
                        &firmware,
                        [31, 47, 63],
                    )?,
                );
            }
            let disk = directory.join("simulator-hardware.json");
            let saved: Option<DiskBoard> = if disk.exists() {
                let bytes = fs::read(&disk)
                    .map_err(|_| BridgeError::new("SIMULATOR_STATE", "无法读取模拟板状态"))?;
                if bytes.len() > 65536 {
                    return Err(BridgeError::new("SIMULATOR_STATE", "模拟板状态过大"));
                }
                Some(
                    serde_json::from_slice(&bytes)
                        .map_err(|_| BridgeError::new("SIMULATOR_STATE", "模拟板状态损坏"))?,
                )
            } else {
                None
            };
            let (original, original_rgb, original_sleep) = if let Some(saved) = saved {
                if saved.model_id != model.id
                    || saved.state.len() != board.state.len()
                    || saved.palette.len() != board.palette.len()
                {
                    return Err(BridgeError::new("SIMULATOR_STATE", "模拟板型号不符"));
                }
                board.state = saved.state;
                board.palette = saved.palette;
                board.sleep = saved.sleep;
                board.connection.serial = Some(saved.serial);
                board.profile = saved.profile;
                board.firmware = saved.firmware;
                (
                    saved.original_state,
                    saved.original_rgb,
                    saved.original_sleep,
                )
            } else {
                (board.state.clone(), board.rgb(), board.sleep)
            };
            if fault == "paint" {
                board.fail_command = Some(0xd8);
            }
            let simulator = Simulator {
                painted: board.state != original || board.sleep != original_sleep,
                original,
                original_rgb,
                original_sleep,
                board,
                token: format!("simulated-{}-{index}", std::process::id()),
                directory: directory.clone(),
                index,
                fault: fault.clone(),
            };
            Ok((model.clone(), simulator))
        },
        &directory,
        io::stdin(),
        io::stdout(),
        Backend::Simulated,
    )
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{}: {}", error.code, error.message);
        std::process::exit(1);
    }
}
