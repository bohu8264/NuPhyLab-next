import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const temp=await mkdtemp(path.join(tmpdir(),'nuphylab-pocket-conflicts-'));
try {
  const output=path.join(temp,'checks');
  execFileSync('swiftc',['-swift-version','5','native/selection/SelectionModels.swift','native/selection/InputModifiers.swift','native/selection/InputBinding.swift','native/pocket/PocketL10n.swift','native/pocket/PocketSettings.swift','native/pocket/PocketConflictPolicy.swift','qa/PocketConflictChecks.swift','-o',output],{stdio:'inherit'});
  execFileSync(output,[],{stdio:'inherit'});
} finally {await rm(temp,{recursive:true,force:true});}
