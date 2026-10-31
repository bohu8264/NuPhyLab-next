import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {tmpdir} from 'node:os';

test('native restoration diagnostics survive a closed host stderr/stdout pipe without an Objective-C abort',{skip:process.platform!=='darwin'},async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'nuphylab-pipe-close-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=await readFile(new URL('../native/HIDBridge.swift',import.meta.url),'utf8');
  const extract=name=>{const start=source.indexOf('func '+name+'(');assert.ok(start>=0);let i=source.indexOf('{',start),depth=1;for(i++;depth;i++){if(source[i]==='{')depth++;if(source[i]==='}')depth--;}return source.slice(start,i);};
  const main=path.join(dir,'main.swift'),binary=path.join(dir,'check');
  await writeFile(main,`import Foundation\nimport Darwin\n${extract('writePipe')}\n${extract('diagnostic')}\n${extract('emit')}
signal(SIGPIPE,SIG_IGN)
let output=dup(STDOUT_FILENO)
func breakPipe(_ descriptor:Int32){var fds:[Int32]=[0,0];precondition(pipe(&fds)==0);close(fds[0]);precondition(dup2(fds[1],descriptor)>=0);close(fds[1])}
breakPipe(STDERR_FILENO)
diagnostic("RESTORE REQUIRED: synthetic closed host")
breakPipe(STDOUT_FILENO)
emit(["event":"restoredOnExit","result":["restored":true]])
close(STDERR_FILENO)
diagnostic("closed descriptor must not throw")
writePipe(output,Data("pipe-close-passed\\n".utf8))
`);
  const run=promisify(execFile);await run('swiftc',[main,'-o',binary]);
  const result=await run(binary);assert.equal(result.stdout,'pipe-close-passed\n');
});
