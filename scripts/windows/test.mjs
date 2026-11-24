import {readdir} from 'node:fs/promises';
import path from 'node:path';
import {root,run} from './common.mjs';
try{
  await run('cargo',['build','--locked','-p','nuphylab-hid']);
  await run('cargo',['build','--locked','-p','nuphylab-core','--example','lighting-simulator']);
  const tests=(await readdir(path.join(root,'tests'))).filter(name=>name.startsWith('windows-')&&name.endsWith('.test.mjs')).map(name=>path.join(root,'tests',name));
  tests.push(path.join(root,'tests/contracts/windows-native-process.test.mjs'));
  tests.push(path.join(root,'tests/contracts/windows-lighting-process.test.mjs'));
  await run(process.execPath,['--test','--test-concurrency=2',...tests]);
  await run('cargo',['test','--locked','-p','nuphylab-core','-p','nuphylab-hid','-p','nuphylab-desktop']);
}catch(error){console.error(error.message);process.exitCode=1;}
