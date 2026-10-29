// Connection failures are recoverable states, not permanent incompatibility.
// Re-probe with backoff; never repeat a lighting/keymap write here.
export class ConnectionRecovery {
  constructor({now = () => performance.now()} = {}) {
    this.now = now;
    this.attempts = 0;
    this.nextAttempt = 0;
    this.inFlight = false;
  }
  needed(device) {
    return !device.connected || (device.readOnly === true && device.errorCode !== 'UNSUPPORTED_FIRMWARE');
  }
  due(device, allowed) {
    return allowed && this.needed(device) && !this.inFlight && this.now() >= this.nextAttempt;
  }
  begin() { this.inFlight = true; this.attempts++; }
  finish(device) {
    this.inFlight = false;
    if (device.connected && device.readOnly !== true) {
      this.attempts = 0; this.nextAttempt = 0;
    } else this.nextAttempt = this.now() + Math.min(15000, 1000 * 2 ** Math.min(this.attempts - 1, 4));
  }
  reset() { this.attempts = 0; this.nextAttempt = 0; this.inFlight = false; }
  disconnected() { this.reset(); this.nextAttempt = this.now() + 400; }
  snapshot(device, allowed) {
    if (device.connected && device.readOnly !== true) return {status: 'ready', attempts: 0};
    if (!allowed) return {status: 'paused', attempts: this.attempts};
    if (device.errorCode === 'UNSUPPORTED_FIRMWARE') return {status: 'updateRequired', attempts: this.attempts};
    if (device.errorCode === 'DEVICE_NOT_FOUND' || !device.errorCode && !device.connected)
      return {status: 'waiting', attempts: this.attempts};
    return {status: this.attempts < 3 || this.inFlight ? 'reconnecting' : 'attention', attempts: this.attempts};
  }
}
