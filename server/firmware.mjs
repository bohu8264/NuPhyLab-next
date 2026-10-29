export const FIRMWARE_URL = "https://drive.nuphy.io/?lang=zh-CN";
export const FIRMWARE_API = "https://drive.nuphy.io/prod-api/api/nuphyIo/getLastFirmwareVersionsByType?businessId=1930212869851615233&type=1";
// Hardware-tested version is distinct from protocol support and online latest.
export const VERIFIED_FIRMWARE = "1.0.23.6";
// Official model catalog: /prod-api/api/nuphyIo/keyBoardList. Kick75 IO
// identifies 19f5:1026 with keyBoardId 1930094363885735938 (checked 2026-10-29).
export const FIRMWARE_MODELS = Object.freeze({
  "air75-v3": Object.freeze({ businessId: "1930212869851615233", modelName: "AIR75 V3", verifiedVersion: VERIFIED_FIRMWARE, minimumVersion: "1.0.16.6" }),
  "kick75": Object.freeze({ businessId: "1930094363885735938", modelName: "Kick75", verifiedVersion: "4.0.18.6", minimumVersion: "4.0.18.6" }),
});
const modelConfig = modelId => Object.hasOwn(FIRMWARE_MODELS, modelId) ? FIRMWARE_MODELS[modelId] : null;
export const firmwareAPI = (modelId = "air75-v3") => {
  const model = modelConfig(modelId);
  return model ? `https://drive.nuphy.io/prod-api/api/nuphyIo/getLastFirmwareVersionsByType?businessId=${model.businessId}&type=1` : null;
};
const FRESH_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;

export function versionParts(value) {
  if (typeof value !== "string" || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,5}$/.test(value)) return null;
  const parts = value.split(".").map(Number);
  return parts.some((n, i) => n > (i === 3 ? 65535 : 255)) ? null : parts;
}
export function compareVersions(a, b) {
  const left = versionParts(a), right = versionParts(b);
  if (!left || !right) return null;
  for (let i = 0; i < 4; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}
export function parseFirmwareManifest(value, modelId = "air75-v3") {
  const entry = value?.data, model = modelConfig(modelId);
  if (!model || value?.code !== 200 || !entry || entry.businessId !== model.businessId ||
      String(entry.type) !== "1" || entry.environment !== "prod" ||
      String(entry.status) !== "0" || !versionParts(entry.versionNumber))
    throw new Error("官方固件信息暂时无法确认");
  return { version: entry.versionNumber, releasedAt: entry.firstListTime || null };
}
export class FirmwareChecker {
  constructor({ fetchImpl = fetch, now = Date.now } = {}) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.modelId = "air75-v3";
    this.entries = new Map();
  }
  entry(modelId = this.modelId) {
    if (!this.entries.has(modelId)) this.entries.set(modelId, {
      latest: null, checkedAt: null, error: null, pending: null,
      retryAt: 0, abort: null, request: null,
    });
    return this.entries.get(modelId);
  }
  setModel(modelId) {
    const next = Object.hasOwn(FIRMWARE_MODELS, modelId) ? modelId : null;
    if (next === this.modelId) return;
    const previous = this.entry();
    // Invalidate before abort: an ignored abort or a queued old response must
    // never populate the new model, or clear a newer request after switching back.
    previous.request = null;
    previous.abort?.abort();
    previous.abort = null;
    previous.pending = null;
    this.modelId = next;
  }
  refresh(force = false) {
    const modelId = this.modelId, api = firmwareAPI(modelId), entry = this.entry();
    if (!api) {
      entry.error = "官方固件信息暂时无法确认";
      return Promise.resolve();
    }
    if (entry.pending) return entry.pending;
    if (!force && this.now() < entry.retryAt) return Promise.resolve();
    const abort = new AbortController(), request = {};
    entry.abort = abort;
    entry.request = request;
    const timer = setTimeout(() => abort.abort(), 8000);
    entry.pending = Promise.resolve().then(async () => {
      try {
        if (entry.request !== request) return;
        const response = await this.fetchImpl(api, {
          signal: abort.signal, redirect: "error", headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error("官方服务暂时不可用");
        // Bound response size; never download firmware binaries or follow supplied URLs.
        const reader = response.body.getReader();
        let bytes = 0, chunks = [];
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.length;
            if (bytes > 128 * 1024) throw new Error("固件信息超出预期大小");
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); }
        const latest = parseFirmwareManifest(JSON.parse(Buffer.concat(chunks).toString("utf8")), modelId);
        if (entry.request !== request) return;
        entry.latest = latest;
        entry.checkedAt = this.now();
        entry.error = null;
        entry.retryAt = this.now() + FRESH_MS;
      } catch {
        if (entry.request !== request) return;
        entry.error = "暂时无法检查官方最新固件，请稍后重试。";
        entry.retryAt = this.now() + RETRY_MS;
      } finally {
        clearTimeout(timer);
        if (entry.request === request) {
          entry.abort = null;
          entry.pending = null;
          entry.request = null;
        }
      }
    });
    return entry.pending;
  }
  snapshot(device) {
    // The caller may deliver the newly identified device before setModel runs.
    // Read only that model's cache, even during this transition.
    const identifiedOnly = device.identified === true || device.firmwareDetectionAvailable === true;
    // Explicit identification from a failed lighting handshake must carry its
    // own model; do not attribute an unknown USB device to the previous model.
    const modelId = device.modelId ?? (identifiedOnly ? null : this.modelId);
    const model = modelConfig(modelId), entry = this.entry(modelId);
    const current = versionParts(device.firmware) ? device.firmware
      : versionParts(device.firmwareVersion) ? device.firmwareVersion : null;
    // Reading USB/firmware identity can succeed before the LED protocol is
    // validated. A legacy LED-count reply must not hide the way to upgrade.
    // These explicit flags are cleared by Hardware on physical disconnect.
    const canDetectFirmware = device.connected === true ||
      (device.identified === true && device.firmwareDetectionAvailable === true);
    const stale = entry.checkedAt !== null && (Boolean(entry.error) || this.now() - entry.checkedAt >= FRESH_MS);
    const comparison = compareVersions(current, entry.latest?.version);
    const hasChecked = entry.checkedAt !== null;
    const latestConfirmed = Boolean(model && hasChecked && entry.latest && !entry.error && !stale);
    const minimumRequired = model?.minimumVersion ?? null;
    // An old keyboard can lack the required protocol even when the official
    // service is unreachable. Numeric version evidence can recommend an upgrade
    // offline, but it must never grant per-key or function-key capabilities.
    const updateRequired = Boolean(canDetectFirmware && model && compareVersions(current, minimumRequired) === -1);
    const updateAvailable = Boolean(canDetectFirmware && latestConfirmed && comparison === -1);
    const perKeyReady = Boolean(device.connected && model && current && !updateRequired && device.capabilities?.perKey === true);
    const functionKeysReady = Boolean(device.connected && model && current && !updateRequired && device.capabilities?.functionKeyAdaptation === true);
    const status = !canDetectFirmware ? "disconnected"
      : !model ? "unavailable"
      : entry.pending && !entry.latest ? "checking"
      : entry.error || stale ? "unavailable"
      : !entry.latest ? "checking"
      : comparison === null ? "unknown"
      : comparison < 0 ? "updateAvailable"
      : comparison > 0 ? "newer" : "current";
    return { status, modelId, modelName: model?.modelName ?? null, current, latest: entry.latest?.version ?? null,
      checkedAt: entry.checkedAt, hasChecked, latestConfirmed, checking: Boolean(entry.pending), stale,
      minimumRequired, updateRequired, updateAvailable,
      upgradeRecommended: updateRequired || updateAvailable,
      firmwareDetectionAvailable: Boolean(canDetectFirmware && model && current),
      error: entry.error, updateUrl: FIRMWARE_URL,
      compatible: perKeyReady, perKeyReady, functionKeysReady,
      protocol: device.capabilities?.protocol ?? null,
      stateBytes: device.capabilities?.stateBytes ?? null,
      verifiedVersion: model?.verifiedVersion ?? null };
  }
  close() {
    for (const entry of this.entries.values()) {
      entry.request = null;
      entry.abort?.abort();
      entry.abort = null;
      entry.pending = null;
    }
  }
}
