import {getKeyboardProfile,isKeyboardModel} from '../shared/keyboard-models.mjs';
import {AIR_CONNECTION_WAKE_DURATION_MS, renderConnectionWake} from '../shared/air-connection-wake.mjs';

export function supportsAirConnectionWake(device) {
  const profile=isKeyboardModel(device?.modelId)?getKeyboardProfile(device.modelId):null;
  return !!profile && device?.connected === true && device.identified === true &&
    device.transport === 'USB' && device.vendorId === 0x19f5 && profile.productIds.includes(device.productId) &&
    device.ledCount === profile.keyCount+profile.sideCount && device.keyLedCount === profile.keyCount &&
    device.protocolReady === true && device.readOnly === false &&
    typeof device.connectionSessionId === 'string' && device.connectionSessionId.length > 0 &&
    device.capabilities?.perKey === true && device.capabilities.readProbeVerified === true &&
    device.capabilities.connectionWake === true &&
    device.historicalRecoveryLost !== true;
}

// Physical absence grants one opportunity. A new helper/connectionSessionId or
// a retry alone does not: those can change while the cable remains connected.
export class AirConnectionWake {
  constructor({now = () => performance.now()} = {}) {
    this.now = now;
    this.available = true;
    this.current = null;
    this.last = {status:'idle', reason:null, elapsedMs:0, sessionId:null};
  }
  get active() { return this.current !== null; }
  absent() {
    this.cancel('disconnected');
    this.available = true;
  }
  begin(device, epoch, context = {}) {
    if (!this.available || device?.connected !== true || device.identified !== true) return null;
    // Consume before any arm/paint, including an incompatible model or probe.
    // Recovery, a cancelled animation or a rejected write must not replay it.
    this.available = false;
    if (!supportsAirConnectionWake(device)) return null;
    const ticket = {modelId:device.modelId,sessionId:device.connectionSessionId, epoch, profile:device.lightingProfile??0, started:null, context};
    this.current = ticket;
    this.last = {modelId:device.modelId,status:'starting', reason:null, elapsedMs:0, sessionId:ticket.sessionId};
    return ticket;
  }
  matches(ticket, device, epoch) {
    return this.current === ticket && supportsAirConnectionWake(device) &&
      ticket.modelId === device.modelId && ticket.sessionId === device.connectionSessionId && ticket.epoch === epoch && ticket.profile===(device.lightingProfile??0);
  }
  start(ticket, device, epoch) {
    if (!this.matches(ticket, device, epoch) || device.armed !== true) {
      this.cancel('sessionChanged');
      return false;
    }
    ticket.started = this.now();
    this.last.status = 'playing';
    return true;
  }
  elapsed() {
    return this.current?.started === null || !this.current ? 0 :
      Math.max(0, Math.min(AIR_CONNECTION_WAKE_DURATION_MS, this.now() - this.current.started));
  }
  frame(device, epoch) {
    const ticket = this.current;
    if (!ticket) return null;
    if (!this.matches(ticket, device, epoch) || device.armed !== true) {
      this.cancel('sessionChanged');
      return null;
    }
    return renderConnectionWake(ticket.modelId,ticket.started === null ? 0 : this.elapsed());
  }
  handoff() {
    const ticket = this.current;
    if (!ticket) return null;
    this.last = {modelId:ticket.modelId,status:'finishing', reason:null, elapsedMs:AIR_CONNECTION_WAKE_DURATION_MS, sessionId:ticket.sessionId};
    this.current = null;
    return ticket.context;
  }
  complete() {
    if (this.last.status === 'finishing') this.last.status = 'completed';
  }
  cancel(reason = 'cancelled') {
    if (!this.current) {
      if (this.last.status !== 'finishing') return false;
      this.last = {...this.last, status:'cancelled', reason};
      return true;
    }
    this.last = {...this.last, status:'cancelled', reason, elapsedMs:this.elapsed()};
    this.current = null;
    return true;
  }
  snapshot() {
    return {...this.last, active:this.active, elapsedMs:this.active ? this.elapsed() : this.last.elapsedMs,
      durationMs:AIR_CONNECTION_WAKE_DURATION_MS, modelId:this.last.modelId ?? 'air75-v3', brightness:100};
  }
}
