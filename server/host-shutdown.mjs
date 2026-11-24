import contract from '../shared/contracts/windows-host-v2.json' with {type:'json'};
export const WINDOWS_HOST=Object.freeze({...contract});
export function shutdownReceipt(shutdownId,exitCode,evidence) {
  if(shutdownId!==null&&(typeof shutdownId!=='string'||!/^[a-f0-9]{64}$/.test(shutdownId)))throw new TypeError('Invalid shutdown identity');
  const verified=evidence?.verified===true&&evidence.recoveryPending===false;
  return {event:'hostShutdownComplete',protocolVersion:WINDOWS_HOST.protocolVersion,shutdownId,
    success:exitCode===0&&verified,keyboardVerified:verified,
    recoveryPending:evidence?.recoveryPending!==false,noMutation:evidence?.noMutation===true};
}
export function writeShutdownReceipt(output,value) {
  return new Promise((resolve,reject)=>{output.write(JSON.stringify(value)+'\n',error=>error?reject(error):resolve());});
}
