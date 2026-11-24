export const FEATURE_IDS = Object.freeze(['studio','library','codex','game','typing-sounds','music','selection-question','drag-convert','keyboard-pocket','voice-input','dock-scenes','color-picker','screen-replay','screen-awareness','smart-clipboard']);
export const DEFAULT_SIDEBAR_FEATURES = Object.freeze(['studio','library','codex']);
export function validateSidebarFeatures(value) {
  if (!Array.isArray(value) || value.length > FEATURE_IDS.length || value.some(id => !FEATURE_IDS.includes(id)) || new Set(value).size !== value.length)
    throw new Error('功能列表格式无效');
  return [...value];
}
export function sidebarFeatures(value) {
  try { return validateSidebarFeatures(value); } catch { return [...DEFAULT_SIDEBAR_FEATURES]; }
}

// Hiding AI Assistant also disables both integrations; re-adding only restores
// the entry. All bindings and provider preferences remain unchanged.
export function deactivateHiddenFeatures(settings) {
  if (sidebarFeatures(settings.sidebarFeatures).includes('codex')) return settings;
  return {...settings,codexEnabled:false,claudeEnabled:false};
}
