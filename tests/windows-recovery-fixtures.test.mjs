import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {recoveryFixturePath,recoveryFixtureSource} from '../scripts/windows/generate-recovery-fixtures.mjs';

test('committed recovery vectors match the pinned official Swift functions and current Windows device configuration',async()=>{
  const {manifest}=await recoveryFixtureSource(),fixture=JSON.parse(await readFile(recoveryFixturePath,'utf8'));
  for(const key of ['schema','oracleVersion','oracleSourceDigest','generatorDigest','models'])assert.deepEqual(fixture[key],manifest[key],`${key}: regenerate the Swift recovery fixture on Mac`);
  assert.equal(fixture.colors.length,4096);assert.equal(fixture.palettes.length,manifest.models.length);
  assert.equal(fixture.sleepFrames.length,9);
  assert.equal(fixture.frames.length,manifest.models.reduce((sum,model)=>sum+Math.ceil(model.keyCount/13)+1,0)*6);
});
