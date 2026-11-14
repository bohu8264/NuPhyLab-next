import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const dir=await mkdtemp(path.join(tmpdir(),'nuphylab-pocket-file-transfer-'));
try {
  for(const suite of ['FileTransferTests','StoreTests']) {
    const binary=path.join(dir,suite);
    execFileSync('swiftc',['-swift-version','5','native/pocket/PocketL10n.swift','native/pocket/PocketFileTransfer.swift','native/pocket/PocketStore.swift',`qa/pocket/${suite}.swift`,'-o',binary,'-framework','AppKit','-framework','ImageIO'],{stdio:'inherit'});
    execFileSync(binary,[],{stdio:'inherit'});
  }
}finally{await rm(dir,{recursive:true,force:true});}
