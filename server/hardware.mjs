import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import {randomUUID} from 'node:crypto';
// A retained record belonging to an earlier USB handle is history, not proof
// that this handle has settings to restore. Native code alone classifies it.
export function hasUnownedFunctionKeyHistory(state) {
  return state?.unownedFunctionKeyHistory === true && state.functionKeyRecoveryPending === true &&
    state.unsafeWritesNeeded !== true && state.historicalRecoveryLost !== true &&
    state.keyRecovery?.ownsCurrentHandle !== true;
}
export function hardwareErrorMessage(code, detail) {
  const messages = {
    LIGHTING_DISABLED: "请先在键盘上按 Fn＋↑ 开启灯光，再点击播放。",
    STATE_VERIFY_FAILED: "键盘未确认灯光设置，请点击重新连接后重试。",
    COLOR_VERIFY_FAILED: "灯光输出校验未通过，播放已停止。",
    ROUTE_MISMATCH: "键盘连接被其他软件改变，请关闭其他灯效软件后重新连接。",
    RESTORE_REQUIRED: "灯光控制已停止，原有灯效尚未恢复。请重新连接键盘后点击「恢复原有灯效」。",
    RECOVERY_REQUIRED: "上次灯光尚未恢复，请重新连接键盘后重试。",
    PRESET_RECOVERY_CONFLICT: "键盘原灯效的预设参数暂时无法安全恢复，原始备份已保留。请提供诊断日志以便处理。",
  };
  const message = messages[code];
  if (!message) return detail;
  if (code === "LIGHTING_DISABLED") return message;
  return message + (detail.includes("Original lighting was restored and verified.") ? "已恢复原有灯效。" : "");
}
export class Hardware extends EventEmitter {
  constructor(binary, backup) {
    super();
    this.binary = binary;
    this.backup = backup;
    this.requests = new Map();
    this.serial = 0;
    this.tail = Promise.resolve();
    this.state = {
      connected: false,
      armed: false,
      firmware: null,
      ledCount: 0,
      error: null,
      errorCode: null,
    };
    this.child = null;
    this.sessionId = randomUUID();
    this.connectionGeneration = 0;
    this.identityPresent = false;
    this.transportEpoch = 0;
    this.connecting = null;
  }
  start() {
    if (this.child) return;
    this.restoreFailure = null;
    this.keyRestoreFailure = null;
    this.shutdownResult = null;
    this.diagnostics = "";
    const child = spawn(this.binary, ["--backup", this.backup], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    createInterface({ input: child.stdout }).on("line", (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.event) {
        if (msg.event === "disconnected") {
          this.transportEpoch++;
          this.identityPresent = false;
          this.state = {
            ...this.state,
            connected: false,
            armed: false,
            recoveryPending: msg.needsRestore ?? this.state.recoveryPending ?? false,
            needsRestore: msg.needsRestore ?? this.state.needsRestore ?? false,
            error: null,
            errorCode: "DEVICE_NOT_FOUND",
            firmware: null,
            firmwareVersion: null,
            identified: false,
            firmwareDetectionAvailable: false,
            capabilities: null,
            readOnly: false,
            protocolReady: false,
            ledCount: 0,
          };
        }
        if (msg.event === "restoreFailed") {
          this.restoreFailure = msg.error;
          this.state.error = msg.error;
        }
        if (msg.event === "keyRestoreFailed") this.keyRestoreFailure = msg.error;
        if (msg.event === "shutdownComplete") this.shutdownResult = msg;
        this.emit(msg.event, msg);
        return;
      }
      const req = this.requests.get(msg.id);
      if (!req) return;
      this.requests.delete(msg.id);
      clearTimeout(req.timer);
      if (req.epoch !== null && req.epoch !== this.transportEpoch) {
        req.reject(Object.assign(new Error('键盘连接正在恢复，请稍候。'), {code:'SESSION_CHANGED'}));
        return;
      }
      if (msg.ok) req.resolve(msg.result);
      else {
        const detail = typeof msg.error === "string" ? msg.error : (msg.error?.message ?? "键盘请求失败");
        const error = new Error(hardwareErrorMessage(msg.error?.code, detail));
        error.protocolDetail = detail;
        if (typeof msg.error?.code === "string") error.code = msg.error.code;
        req.reject(error);
      }
    });
    child.stderr.on("data", (data) => {
      const detail = data.toString();
      this.diagnostics = (this.diagnostics + detail).slice(-4096);
      this.emit("diagnostic", detail);
    });
    child.on("error", (e) => {
      if (this.child !== child) return;
      this.child = null;
      this.failed(e);
    });
    // 'close' runs after stdout/stderr drain; 'exit' can precede the final
    // restore result and used to discard the only useful failure diagnostic.
    child.on("close", () => {
      if (this.child !== child) return;
      this.child = null;
      this.failed(new Error("键盘控制进程已退出"));
      this.emit("disconnect");
    });
  }
  failed(error) {
    this.transportEpoch++;
    this.identityPresent = false;
    this.state = {
      ...this.state,
      connected: false,
      armed: false,
      identified: false,
      firmwareDetectionAvailable: false,
      firmware: null,
      firmwareVersion: null,
      capabilities: null,
      error: error.message,
    };
    for (const req of this.requests.values()) {
      clearTimeout(req.timer);
      req.reject(error);
    }
    this.requests.clear();
  }
  request(op, args = {}) {
    const deviceOperation = ['connect','status','arm','paint','restore','disconnect','readColors','nativeLighting','readKeymap',
      'prepareFunctionKey','previewFunctionKeyRecovery','confirmFunctionKeyRecovery','side'].includes(op) ||
      (['adaptKeys','keyMappingStatus'].includes(op) && args.transport !== 'bluetooth');
    const epoch = deviceOperation ? this.transportEpoch : null;
    const run = async () => {
      if (epoch !== null && epoch !== this.transportEpoch)
        throw Object.assign(new Error('键盘连接正在恢复，请稍候。'), {code:'SESSION_CHANGED'});
      if (!this.child) this.start();
      return new Promise((resolve, reject) => {
        const id = ++this.serial;
        const timer = setTimeout(() => {
          this.requests.delete(id);
          reject(new Error("键盘响应超时，请重新连接"));
        }, 12000);
        this.requests.set(id, { resolve, reject, timer, epoch });
        this.child.stdin.write(
          JSON.stringify({ id, op, ...args }) + "\n",
          (e) => {
            if (e) {
              clearTimeout(timer);
              this.requests.delete(id);
              reject(e);
            }
          },
        );
      });
    };
    const promise = this.tail.then(run, run).then(result => {
      // One stdout chunk can contain a successful reply followed immediately
      // by a removal event. Resolving the reply only schedules an await
      // continuation; the later event must still invalidate that result before
      // connect/status/arm/restore can commit it back into the current state.
      if (epoch !== null && epoch !== this.transportEpoch)
        throw Object.assign(new Error('键盘连接正在恢复，请稍候。'), {code:'SESSION_CHANGED'});
      return result;
    });
    this.tail = promise.catch(() => {});
    return promise;
  }
  connect() {
    if (this.connecting) return this.connecting;
    this.connecting = this.connectOnce().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async connectOnce() {
    let identified = false;
    try {
      let result = await this.request("connect");
      this.updateState(result);
      identified = true;
      if (result.recoveryPending && !result.armed && result.readOnly !== true) {
        await this.restore();
        result = {
          ...result,
          ...(await this.request("status")),
        };
      }
      this.updateState({
        ...result,
        connected: true,
        error: result.error ?? null,
        errorCode: result.errorCode ?? null,
      });
      return this.state;
    } catch (e) {
      // A restore failure does not invalidate a successful USB identification.
      // Keep the device available for recovery instead of reconnecting in a loop.
      this.state = {
        ...this.state,
        ...(!identified ? { connected: false, identified: false, firmwareDetectionAvailable: false, firmware: null, firmwareVersion: null, firmwareBytes: null, ledCount: 0, capabilities: null } : {}),
        armed: false,
        error: ['DEVICE_NOT_FOUND','SESSION_CHANGED','DISCONNECTED'].includes(e.code) ? null : e.message,
        errorCode: e.code ?? "CONNECT_FAILED",
      };
      throw e;
    }
  }
  async status() {
    const result = await this.request("status");
    const pendingError = result.recoveryPending && this.state.errorCode && this.state.errorCode !== "DEVICE_NOT_FOUND";
    const reportedError = typeof result.errorCode === 'string' || typeof result.error === 'string' && result.error.length > 0;
    this.updateState({ ...result, ...(!reportedError ? pendingError ? { error: this.state.error, errorCode: this.state.errorCode } : result.recoveryPending === false ? { errorCode: null } : {} : {}) });
    return this.state;
  }
  updateState(result) {
    const present = result.connected === true || result.identified === true;
    if (present && !this.identityPresent) {
      this.connectionGeneration++;
      this.identityPresent = true;
    } else if (result.connected === false && result.identified !== true) this.identityPresent = false;
    const bytes = Array.isArray(result.firmware) ? result.firmware : this.state.firmwareBytes;
    const version = result.firmwareVersion ?? (bytes?.length === 8 && bytes[3] === 0xaa ? `${bytes[2]}.${bytes[1]}.${bytes[0]}.${bytes[4] + bytes[5] * 256}` : this.state.firmware);
    this.state = {
      ...this.state,
      ...result,
      ...(typeof result.recoveryPending === "boolean" ? { needsRestore: result.recoveryPending } : {}),
      firmware: result.connected === false && result.firmwareDetectionAvailable !== true ? null : version,
      firmwareBytes: bytes,
      connectionSessionId: `${this.sessionId}:${this.connectionGeneration}`,
      ...(result.connected === false && result.identified !== true ? {identified:false,firmwareDetectionAvailable:false,firmwareVersion:null} : {}),
    };
  }
  async arm() {
    if (!this.state.connected) throw new Error("请先连接键盘");
    if (this.state.readOnly === true) throw new Error(this.state.error || '当前固件未通过兼容检查，请先通过官方 NuPhyIO 更新固件。');
    if (this.state.armed) return;
    // A reconnect may identify USB successfully before recovery completes, or
    // the user may change Mac/Win while it remains connected. Retry recovery
    // for the current profile before opening a new lighting session.
    await this.status();
    if (this.state.armed) return;
    if (this.state.recoveryPending || this.state.needsRestore) await this.restore();
    const result = await this.request("arm");
    this.updateState({ ...result, armed: true, error: null, errorCode: null });
  }
  async paint(colors) {
    await this.request("paint", { colors });
  }
  async restore() {
    if (this.state.readOnly === true && !this.state.recoveryPending && !this.state.needsRestore && !this.state.unsafeWritesNeeded)
      return {restored:true,verified:true,readOnly:true};
    if (!this.state.connected && !this.state.recoveryPending && !this.state.needsRestore) return;
    try {
      const result = await this.request("restore");
      if (result.verified !== true) throw new Error("键盘灯效恢复尚未通过校验");
      this.restoreFailure = null;
      this.updateState({ ...result, armed: false, needsRestore: false, recoveryPending: false, error: null, errorCode: null });
      if (!this.state.connected) await this.status();
      return result;
    } catch (error) {
      this.state = { ...this.state, armed: false, error: error.message, errorCode: error.code ?? "RESTORE_REQUIRED" };
      throw error;
    }
  }
  async disconnect() {
    this.transportEpoch++;
    const result = await this.request("disconnect");
    const pending = result.recoveryPending === true ||
      (result.functionKeyRecoveryPending === true && !hasUnownedFunctionKeyHistory(result)) ||
      result.unsafeWritesNeeded === true || result.historicalRecoveryLost === true || result.keyRestoreErrors?.length > 0;
    this.updateState({ ...result, connected: false, identified:false, firmwareDetectionAvailable:false, armed: false,
      error: pending ? "键盘已断开，原设置备份已保留，下次连接时自动恢复。" : null,
      errorCode: pending ? "RESTORE_DEFERRED" : null });
    if (!pending) this.restoreFailure = this.keyRestoreFailure = null;
    return this.state;
  }
  async close() {
    let failure;
    try {
      await this.tail;
      if (this.child) {
        try { await this.request("restoreKeys"); }
        catch (e) { failure = e; }
      }
      if (this.state.connected) await this.restore();
    } catch (e) {
      // The helper verifies its durable journal before accepting a deferred
      // quit with no USB device. Real restore/verification failures still fail.
      if (this.state.connected || !["DEVICE_NOT_FOUND", "NOT_CONNECTED", "DISCONNECTED"].includes(e.code)) failure = e;
    } finally {
      if (this.child) {
        const child = this.child;
        const exited = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            child.kill("SIGTERM");
            reject(new Error("恢复进程尚未退出，磁盘备份仍保留"));
          }, 25000);
          child.once("close", (code, signal) => {
            clearTimeout(timeout);
            if (code === 0 && !this.restoreFailure && !this.keyRestoreFailure) resolve();
            else
              reject(
                new Error(
                  this.restoreFailure ?? this.keyRestoreFailure ??
                    `键盘控制进程退出异常（code=${code}, signal=${signal ?? "none"}）${this.diagnostics ? ": " + this.diagnostics.trim() : ""}`,
                ),
              );
          });
        });
        exited.catch(() => {});
        try {
          await this.request("quit");
        } catch {}
        child.stdin.end();
        await exited;
      }
    }
    if (failure) throw failure;
  }
}
