// A local device-output correction, deliberately separate from artwork colours.
// Missing/disabled/mismatched profiles preserve the original input strings.
const bindingKeys = ["modelId", "productId", "firmwareVersion", "deviceKey"];
const ownKeysAre = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function validateOutputColorProfile(value) {
  if (value == null) return null;
  const fail = () => { throw new Error("输出颜色配置无效"); };
  if (!ownKeysAre(value, ["version", "enabled", "binding", "transfer", "gains"]) ||
      value.version !== 1 || typeof value.enabled !== "boolean" ||
      !["linear", "srgb"].includes(value.transfer) || !ownKeysAre(value.binding, bindingKeys) ||
      !ownKeysAre(value.gains, ["r", "g", "b"])) fail();
  const {binding, gains} = value;
  const products = {"air75-v3": [0x1028], kick75: [0x1026, 0x1027]};
  if (!Object.hasOwn(products, binding.modelId) || !products[binding.modelId].includes(binding.productId) ||
      typeof binding.firmwareVersion !== "string" || !/^\d{1,4}(?:\.\d{1,5}){3}$/.test(binding.firmwareVersion) ||
      typeof binding.deviceKey !== "string" || !/^native-device-v1:[a-f0-9]{64}$/.test(binding.deviceKey) ||
      [gains.r, gains.g, gains.b].some(gain => !Number.isFinite(gain) || gain < 0.01 || gain > 1)) fail();
  return {version: 1, enabled: value.enabled,
    binding: Object.fromEntries(bindingKeys.map(key => [key, binding[key]])),
    transfer: value.transfer, gains: {r: gains.r, g: gains.g, b: gains.b}};
}

export function deriveOutputColorProfileStatus(profile, binding) {
  const matches = Boolean(profile && binding && bindingKeys.every(key => profile.binding?.[key] === binding[key]));
  const active = matches && profile.enabled === true;
  return {active, matches, canBind: Boolean(binding),
    reason: !profile ? "unconfigured" : !binding ? "identityUnavailable" : !matches ? "bindingMismatch" :
      !profile.enabled ? "disabled" : "active",
    binding: binding ? {...binding} : null};
}

export function applyOutputColorProfile(colors, profile, binding) {
  if (!deriveOutputColorProfileStatus(profile, binding).active) return colors;
  const valid = validateOutputColorProfile(profile);
  return colors.map(color => {
    if (typeof color !== "string" || !/^#[a-f0-9]{6}$/i.test(color))
      throw new Error("输出颜色必须为有效的 RGB 颜色");
    return "#" + [valid.gains.r, valid.gains.g, valid.gains.b].map((gain, index) => {
      const value = parseInt(color.slice(index * 2 + 1, index * 2 + 3), 16) / 255;
      const pwm = valid.transfer === "srgb" ? value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4 : value;
      return Math.round(pwm * gain * 255).toString(16).padStart(2, "0");
    }).join("");
  });
}
