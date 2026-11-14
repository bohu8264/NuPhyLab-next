import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const dir=await mkdtemp(path.join(tmpdir(),'nuphylab-pocket-hotkeys-'));
try {
 const binary=path.join(dir,'HotkeyTests');
 execFileSync('swiftc',['-swift-version','5','native/pocket/PocketL10n.swift','native/pocket/PocketSettings.swift','native/pocket/PocketHotkeys.swift','qa/pocket/HotkeyTests.swift','-o',binary,'-framework','AppKit','-framework','Carbon'],{stdio:'inherit'});
 execFileSync(binary,[],{stdio:'inherit'});
}finally{await rm(dir,{recursive:true,force:true});}
