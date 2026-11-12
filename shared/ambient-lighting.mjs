import {isKeyboardModel} from './keyboard-models.mjs';

export const DEFAULT_AMBIENT_LIGHTING = Object.freeze({enabled:false, learn:true, brightRoom:'off', profiles:{}});
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const validLux = v => Number.isFinite(v) && v >= 0 && v <= 200000;
export function validateAmbientLighting(input, previous = DEFAULT_AMBIENT_LIGHTING) {
  if (!plain(input)) throw new Error('Invalid automatic lighting settings.');
  const result = {...DEFAULT_AMBIENT_LIGHTING, ...previous};
  for (const [key, value] of Object.entries(input)) {
    if (['enabled','learn'].includes(key)) {
      if (typeof value !== 'boolean') throw new Error('Invalid automatic lighting switch.');
    } else if (key === 'brightRoom') {
      if (!['off','dim'].includes(value)) throw new Error('Invalid bright-room lighting choice.');
    } else if (key === 'profiles') {
      if (!plain(value) || Object.keys(value).length > 8) throw new Error('Invalid lighting preferences.');
      for (const [model, points] of Object.entries(value)) {
        if (!isKeyboardModel(model) || !Array.isArray(points) || points.length > 12 || points.some(p =>
          !plain(p) || Object.keys(p).some(k => !['lux','brightness'].includes(k)) || !validLux(p.lux) ||
          !Number.isFinite(p.brightness) || p.brightness < 0 || p.brightness > 100)) throw new Error('Invalid lighting preference.');
      }
    } else throw new Error('Unknown automatic lighting setting.');
    result[key] = structuredClone(value);
  }
  return result;
}

// Preferences are sparse local anchors, not a history of ambient readings.
// Each model has its own curve; artwork RGB and the manual dimmer remain intact.
export function learnAmbientPreference(settings, model, lux, brightness) {
  if (!settings.enabled || !settings.learn || !isKeyboardModel(model) || !validLux(lux) || brightness <= 0) return settings;
  const x = Math.log1p(lux);
  const existing = settings.profiles[model] ?? [];
  const points = existing.filter(p => Math.abs(Math.log1p(p.lux) - x) > 0.3);
  points.push({lux:Math.round(lux * 10) / 10, brightness:clamp(brightness, 0, 100)});
  // Bound the preference footprint without storing timestamps or raw samples.
  if (points.length > 12) points.shift();
  return {...settings, profiles:{...settings.profiles, [model]:points}};
}

export function ambientTarget(lux, base, settings, model) {
  const floor = settings.brightRoom === 'dim' ? Math.min(8, base) : 0;
  const defaults = [[0,base],[10,base*.9],[80,base*.65],[250,base*.3],[800,floor],[200000,floor]];
  const learned = settings.profiles[model] ?? [];
  // A local preference replaces nearby defaults, leaving other environments
  // on their own curve. Above daylight threshold the explicit Off/Dim choice wins.
  const points = defaults.filter(([lx]) => lx >= 800 || !learned.some(p => Math.abs(Math.log1p(p.lux) - Math.log1p(lx)) < .7))
    .concat(learned.filter(p => p.lux < 800).map(p => [p.lux,p.brightness])).sort((a,b) => a[0]-b[0]);
  const x = Math.log1p(lux);
  if (lux <= points[0][0]) return points[0][1];
  for (let i=1; i<points.length; i++) {
    if (lux > points[i][0]) continue;
    const [a, av]=points[i-1], [b, bv]=points[i];
    const t=(x-Math.log1p(a))/(Math.log1p(b)-Math.log1p(a));
    return clamp(av+(bv-av)*t,0,100);
  }
  return floor;
}

export class AmbientLighting {
  constructor({now = () => performance.now(), wallNow = Date.now} = {}) {
    this.now=now; this.wallNow=wallNow; this.sequence=-1; this.reset();
  }
  reset() { this.samples=[]; this.lux=null; this.receivedAt=null; this.sensorStatus='waiting'; this.sampledAt=null; this.lastStep=null; this.value=null; this.target=null; }
  receive(report) {
    if (!plain(report) || !Number.isSafeInteger(report.sequence) || report.sequence < 0 ||
        !['ready','unavailable','lidClosed','sleeping'].includes(report.status) ||
        !Number.isFinite(report.sampledAt) || report.sampledAt > this.wallNow()+1000 ||
        this.wallNow()-report.sampledAt > 5000 || (report.status === 'ready' && !validLux(report.lux)))
      throw new Error('Invalid ambient-light sample.');
    if (report.sequence <= this.sequence) return false;
    if (this.receivedAt !== null && this.now()-this.receivedAt > 6000) { this.samples=[]; this.lux=null; }
    this.sequence=report.sequence; this.sampledAt=report.sampledAt;
    this.receivedAt=this.now(); this.sensorStatus=report.status;
    if (report.status !== 'ready') { this.samples=[]; this.lux=null; return true; }
    this.samples.push(Math.log1p(report.lux)); this.samples=this.samples.slice(-3);
    const sorted=[...this.samples].sort((a,b)=>a-b), median=sorted[Math.floor(sorted.length/2)];
    this.lux=this.lux===null ? Math.expm1(median) : Math.expm1(Math.log1p(this.lux)*.55+median*.45);
    return true;
  }
  status(settings, device, base) {
    if (!settings.enabled) return 'disabled';
    if (base === 0) return 'manualOff';
    if (!device.connected) return 'noKeyboard';
    if (device.readOnly === true || device.capabilities?.perKey !== true) return 'unsupportedKeyboard';
    if (!device.armed) return 'idle';
    if (this.receivedAt === null) return 'waiting';
    if (this.now()-this.receivedAt > 6000) return 'unavailable';
    if (this.sensorStatus !== 'ready') return this.sensorStatus;
    return this.samples.length >= 3 ? 'active' : 'waiting';
  }
  brightness(base, settings, device) {
    const now=this.now(), status=this.status(settings,device,base);
    let desired=status==='active' ? ambientTarget(this.lux,base,settings,device.modelId) : base;
    // Manual off and disabling automation apply immediately. Other transitions
    // are bounded to 25 percentage points/second, including sensor fallback.
    if (this.value===null || !settings.enabled || base===0 || !device.armed) { this.value=base; this.target=base; this.lastStep=now; return base; }
    if (this.target===null || Math.abs(desired-this.target)>=2 || desired===0 || desired===base && status!=='active') this.target=desired;
    const dt=clamp((now-(this.lastStep??now))/1000,0,.25); this.lastStep=now;
    this.value += clamp(this.target-this.value,-25*dt,25*dt);
    if (Math.abs(this.target-this.value)<.05) this.value=this.target;
    return Math.round(this.value*100)/100;
  }
  manualBrightness(value) { this.value=this.target=value; this.lastStep=this.now(); }
  preference(settings,device,base,value) {
    if (this.status(settings,device,base)!=='active' || this.lux>=800) return settings;
    return learnAmbientPreference(settings,device.modelId,this.lux,value);
  }
  snapshot(base,settings,device) {
    const status=this.status(settings,device,base);
    return {status, lux:this.lux===null||!['active','waiting'].includes(status)?null:Math.round(this.lux),
      effectiveBrightness:Math.round(this.value??base), targetBrightness:Math.round(this.target??base),
      learnedPoints:(settings.profiles[device.modelId]??[]).length};
  }
}
