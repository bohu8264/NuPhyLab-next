export type FeatureId = 'studio'|'library'|'codex'|'game'|'typing-sounds'|'music'|'selection-question'|'drag-convert'|'keyboard-pocket'|'voice-input'|'dock-scenes'|'color-picker'|'screen-replay'|'screen-awareness'|'smart-clipboard'|'desktop-shelf';
export const FEATURE_IDS: readonly FeatureId[];
export const DEFAULT_SIDEBAR_FEATURES: readonly FeatureId[];
export function validateSidebarFeatures(value: unknown): FeatureId[];
export function sidebarFeatures(value: unknown): FeatureId[];
