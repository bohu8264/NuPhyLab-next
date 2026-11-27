import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {fakeService} from './helpers/fake-service.mjs';
import {Store} from '../server/storage.mjs';

const uiDir = fileURLToPath(new URL('../ui', import.meta.url));

for (const system of ['en', 'zh-CN']) {
  test(`first launch, manual override and return to system language on ${system}`, async t => {
    const service = await fakeService(t, {freshLibrary:true, skipInitialConnect:true}, {
      environment: {...process.env, AIR_STUDIO_SYSTEM_LANGUAGE:system}, uiDir,
    });
    const other = system === 'en' ? 'zh-CN' : 'en';
    async function checkLanguage(preference, language) {
      const state = await service.state();
      assert.equal(state.settings.languagePreference, preference);
      assert.equal(state.settings.language, language);
      const html = await (await fetch(service.url)).text();
      assert.ok(html.includes(`<html lang="${language}">`), 'first paint must agree with the native menu');
    }
    await checkLanguage('system', system);
    assert.equal((await service.command({op:'settings',settings:{language:other}})).ok, true);
    await checkLanguage(other, other);
    const reopen = async () => (await new Store(service.dataDir).load()).data.settings.language;
    assert.equal(await reopen(), other, 'legacy explicit preference survives reopening');
    assert.equal((await service.command({op:'settings',settings:{language:'system'}})).ok, true);
    assert.equal((await service.command({op:'settings',settings:{brightness:31}})).ok, true);
    await checkLanguage('system', system);
    assert.equal(await reopen(), 'system');
    const library = JSON.parse(await readFile(path.join(service.dataDir,'library.json')));
    assert.ok(!Object.hasOwn(library.settings, 'language'));
    assert.ok(!Object.hasOwn(library.settings, 'languagePreference'));
  });
}
