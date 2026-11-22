import {createPresets} from './presets.mjs';
import {airLayout} from './layout.mjs';
import {translate} from './i18n.mjs';

// Saved copies of retired presets keep their original localized titles.
const titles = [...createPresets(airLayout).map(preset => preset.name), "流星划过", "琥珀落雨", "青绿扫描"];
const names = new Map(titles.flatMap(name => [[name, name], [translate('en', name), name]]));
for (const oldTitle of ["黑白剪影 · Bad Apple!!", "Bad Apple!! Silhouette"]) names.set(oldTitle, "Bad Apple");
/** Localize only exact built-in titles, including drafts made in another UI
 * language. This is display-only: it never renames saved artwork or translates
 * arbitrary user titles with the general UI dictionary. */
export function displayPresetName(name,translator){
  const canonical=names.get(name);
  return canonical ? translator(canonical) : name;
}
