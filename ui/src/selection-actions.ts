export const selectionActions = [
  ['translate', '翻译'], ['summarize', '总结'], ['explain', '解释'],
  ['reply', '回复'],
] as const;
export type SelectionActionID = typeof selectionActions[number][0];
export function enabledSelectionActions(saved?: readonly string[], fallback: string = 'translate'): SelectionActionID[] {
  const ordered = selectionActions.map(([id]) => id).filter(id => saved === undefined || saved.includes(id));
  return ordered.length ? ordered : [selectionActions.find(([id]) => id === fallback)?.[0] ?? 'translate'];
}
