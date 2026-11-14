import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {DEFAULT_SIDEBAR_FEATURES,FEATURE_IDS} from '../shared/sidebar-features.mjs';

// Read only evidence of prior use. Never rewrite feature settings, works or slots.
// Unreadable existing preferences keep their entry visible for recovery.
export async function migrateSidebarFeatures(dir, data) {
  const selected = new Set(DEFAULT_SIDEBAR_FEATURES);
  if (data.bestScore > 0 || Object.values(data.gameBestScores ?? {}).some(value => value > 0)) selected.add('game');
  const checks = [
    ['typing-sounds','typing-sound-preferences.json', value => value.enabled === true],
    ['selection-question','selection-preferences.json', value => value.enabled === true],
    ['drag-convert','drag-convert.json', value => value.enabled === true],
    ['drag-convert','drag-convert-history.json', value => Array.isArray(value) ? value.length > 0 : Object.keys(value ?? {}).length > 0],
    ['keyboard-pocket','keyboard-pocket/settings.json', value => value.enabled === true],
    ['keyboard-pocket','keyboard-pocket/pockets.json', value => value.slots?.some(Boolean) || value.history?.length > 0],
    ['music','music-session.json', value => value.events?.length > 0 || value.drumEnabled || value.clips?.some(clip => clip.audio)],
  ];
  await Promise.all(checks.map(async ([id,file,used]) => {
    try { if (used(JSON.parse(await readFile(path.join(dir,file),'utf8')))) selected.add(id); }
    catch (error) { if (error.code !== 'ENOENT') selected.add(id); }
  }));
  try { if ((await readdir(path.join(dir,'music-works'))).some(name => name.endsWith('.json'))) selected.add('music'); }
  catch (error) { if (error.code !== 'ENOENT') selected.add('music'); }
  return FEATURE_IDS.filter(id => selected.has(id));
}
