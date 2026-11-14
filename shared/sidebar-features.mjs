export const FEATURE_IDS = Object.freeze(['studio','library','codex','game','typing-sounds','music','selection-question','drag-convert','keyboard-pocket']);
export const DEFAULT_SIDEBAR_FEATURES = Object.freeze(['studio','library','codex']);
export function validateSidebarFeatures(value) {
  if (!Array.isArray(value) || value.length > FEATURE_IDS.length || value.some(id => !FEATURE_IDS.includes(id)) || new Set(value).size !== value.length)
    throw new Error('功能列表格式无效');
  return [...value];
}
export function sidebarFeatures(value) {
  try { return validateSidebarFeatures(value); } catch { return [...DEFAULT_SIDEBAR_FEATURES]; }
}
