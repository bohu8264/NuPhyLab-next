export type OutputColorBinding = {
  modelId: "air75-v3" | "kick75";
  productId: number;
  firmwareVersion: string;
  deviceKey: string;
};
export type OutputColorProfile = {
  version: 1;
  enabled: boolean;
  binding: OutputColorBinding;
  transfer: "linear" | "srgb";
  gains: { r: number; g: number; b: number };
};
export type OutputColorProfileStatus = {
  active: boolean;
  matches: boolean;
  canBind: boolean;
  reason: "unconfigured" | "disabled" | "identityUnavailable" | "bindingMismatch" | "active";
  binding: OutputColorBinding | null;
};
export function validateOutputColorProfile(value: unknown): OutputColorProfile | null;
export function deriveOutputColorProfileStatus(profile: OutputColorProfile | null | undefined, binding: OutputColorBinding | null): OutputColorProfileStatus;
export function applyOutputColorProfile<T extends string[]>(colors: T, profile: OutputColorProfile | null | undefined, binding: OutputColorBinding | null): T | string[];
