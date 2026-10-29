import test from "node:test";
import assert from "node:assert/strict";
import { compareVersions, parseFirmwareManifest, FirmwareChecker, FIRMWARE_API, firmwareAPI } from "../server/firmware.mjs";
const manifest = (version = "1.0.16.6", changes = {}) => ({code:200,data:{businessId:"1930212869851615233",type:"1",environment:"prod",status:"0",versionNumber:version,...changes}});
const device = (firmware = "1.0.16.6") => ({connected:true,firmware,capabilities:{perKey:true}});

test("four-part firmware versions compare numerically and reject malformed values", () => {
  assert.equal(compareVersions("1.0.9.6", "1.0.16.6"), -1);
  assert.equal(compareVersions("1.0.16.6", "1.0.16.6"), 0);
  assert.equal(compareVersions("1.0.16.513", "1.0.16.99"), 1);
  assert.equal(compareVersions("0.0.10.6", "1.0.1.5"), -1);
  for (const value of [null,"unknown","1.0.16","1.0.16.6-beta","1.0.999.6","1.0.16.99999"])
    assert.equal(compareVersions(value,"1.0.16.6"), null);
});
test("only the exact ANSI model's enabled official production release is accepted", () => {
  assert.equal(parseFirmwareManifest(manifest()).version,"1.0.16.6");
  for (const changes of [{businessId:"1935604237029969922"},{type:"2"},{environment:"dev"},{status:"1"},{versionNumber:"invalid"}])
    assert.throws(()=>parseFirmwareManifest(manifest("1.0.16.6",changes)));
  assert.throws(()=>parseFirmwareManifest({code:500,data:manifest().data}));
});
test("current, old, future, unknown and unplugged devices have distinct states", async () => {
  const checker=new FirmwareChecker({fetchImpl:async(url,options)=>{
    assert.equal(url,FIRMWARE_API); assert.equal(options.redirect,"error");
    return new Response(JSON.stringify(manifest()));
  }});
  await checker.refresh();
  assert.equal(checker.snapshot(device()).status,"current");
  assert.equal(checker.snapshot(device("1.0.14.6")).status,"updateAvailable");
  assert.equal(checker.snapshot(device("1.0.17.6")).status,"newer");
  assert.equal(checker.snapshot(device("unknown")).status,"unknown");
  assert.equal(checker.snapshot({...device(),connected:false}).status,"disconnected");
});
test("requests are coalesced and cached for six hours with explicit recheck support", async () => {
  let now=1000,calls=0,resolve;
  const checker=new FirmwareChecker({now:()=>now,fetchImpl:()=>{calls++;return new Promise(r=>{resolve=r;});}});
  const first=checker.refresh(); assert.equal(checker.refresh(true),first);
  await Promise.resolve(); assert.equal(checker.snapshot(device()).status,"checking");
  resolve(new Response(JSON.stringify(manifest()))); await first;
  await checker.refresh(); assert.equal(calls,1);
  now+=6*60*60*1000+1; assert.equal(checker.snapshot(device()).status,"unavailable");
  const second=checker.refresh(); await Promise.resolve(); resolve(new Response(JSON.stringify(manifest()))); await second;
  assert.equal(calls,2);
  const third=checker.refresh(true); await Promise.resolve(); resolve(new Response(JSON.stringify(manifest()))); await third;
  assert.equal(calls,3);
});
test("offline and invalid responses never falsely say current, and retry recovers", async () => {
  let mode="ok",now=1000,calls=0;
  const checker=new FirmwareChecker({now:()=>now,fetchImpl:async()=>{
    calls++; if(mode==="offline") throw new Error("offline");
    return new Response(mode==="invalid"?"not json":JSON.stringify(manifest()));
  }});
  await checker.refresh(); mode="offline"; await checker.refresh(true);
  assert.equal(checker.snapshot(device()).status,"unavailable");
  assert.equal(checker.snapshot(device()).stale,true);
  assert.equal(checker.snapshot(device()).latest,"1.0.16.6");
  await checker.refresh(); assert.equal(calls,2);
  now+=5*60*1000+1; mode="invalid"; await checker.refresh(); assert.equal(calls,3);
  mode="ok"; await checker.refresh(true); assert.equal(checker.snapshot(device()).status,"current");
});
test("HTTP errors and oversized payloads remain unavailable", async () => {
  for (const response of [new Response("error",{status:503}),new Response("x".repeat(128*1024+1))]) {
    const checker=new FirmwareChecker({fetchImpl:async()=>response}); await checker.refresh();
    assert.equal(checker.snapshot(device()).status,"unavailable");
    assert.equal(checker.snapshot(device()).latest,null);
  }
});
test("closing aborts an in-flight check without an unhandled rejection", async () => {
  const checker=new FirmwareChecker({fetchImpl:(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener("abort",()=>reject(new Error("aborted")),{once:true}))});
  const pending=checker.refresh(); await Promise.resolve(); checker.close(); await pending;
  assert.equal(checker.snapshot(device()).checking,false);
});

test('online latest version never grants missing device capabilities', async () => {
  const checker = new FirmwareChecker({fetchImpl: async () => new Response(JSON.stringify(manifest('1.0.23.6')))});
  await checker.refresh();
  for (const capabilities of [undefined, {}, {perKey:false}]) {
    const result = checker.snapshot({...device('1.0.23.6'), capabilities});
    assert.equal(result.status, 'current');
    assert.equal(result.compatible, false);
  }
  const next = checker.snapshot({...device('1.0.99.6'), capabilities:{perKey:true,protocol:'air75-s4',stateBytes:22}});
  assert.equal(next.status, 'newer');
  assert.equal(next.compatible, true);
  assert.equal(next.stateBytes, 22);
  assert.equal(next.verifiedVersion, '1.0.23.6', 'future protocol support must not claim future-firmware hardware testing');
});

const kickManifest = (version = "4.0.18.6", changes = {}) => manifest(version, { businessId: "1930094363885735938", ...changes });
const kickDevice = () => ({ ...device("4.0.15.6"), modelId: "kick75" });

test("Kick75 uses its exact official model manifest and has independent verified evidence", async () => {
  assert.equal(parseFirmwareManifest(kickManifest(), "kick75").version, "4.0.18.6");
  assert.throws(() => parseFirmwareManifest(kickManifest()));
  assert.throws(() => parseFirmwareManifest(manifest(), "kick75"));
  const calls = [];
  const checker = new FirmwareChecker({fetchImpl: async (url) => {
    calls.push(url);
    return new Response(JSON.stringify(url === FIRMWARE_API ? manifest() : kickManifest()));
  }});
  await checker.refresh();
  // Identification can precede the model setter; never show Air's cache here.
  assert.equal(checker.snapshot(kickDevice()).latest, null);
  assert.equal(checker.snapshot(kickDevice()).verifiedVersion, "4.0.18.6");
  checker.setModel("kick75");
  await checker.refresh();
  const kick = checker.snapshot(kickDevice());
  assert.equal(kick.status, "updateAvailable");
  assert.equal(kick.latest, "4.0.18.6");
  assert.equal(kick.current, "4.0.15.6");
  assert.equal(kick.verifiedVersion, "4.0.18.6");
  assert.equal(calls[1], "https://drive.nuphy.io/prod-api/api/nuphyIo/getLastFirmwareVersionsByType?businessId=1930094363885735938&type=1");
  checker.setModel("air75-v3");
  await checker.refresh();
  assert.equal(calls.length, 2, "returning to Air reuses only its own fresh cache");
  assert.equal(checker.snapshot({...device(), modelId: "air75-v3"}).latest, "1.0.16.6");
  checker.setModel("kick75");
  await checker.refresh();
  assert.equal(calls.length, 2);
  assert.equal(checker.snapshot(kickDevice()).latest, "4.0.18.6");
});

test("switching models aborts and invalidates old responses without clearing a new request", async () => {
  const requests = [];
  const checker = new FirmwareChecker({fetchImpl: (url, {signal}) => new Promise(resolve => requests.push({url, signal, resolve}))});
  const oldAir = checker.refresh();
  await Promise.resolve();
  checker.setModel("kick75");
  assert.equal(requests[0].signal.aborted, true);
  const kick = checker.refresh();
  await Promise.resolve();
  assert.equal(requests[1].url, firmwareAPI("kick75"));
  requests[1].resolve(new Response(JSON.stringify(kickManifest())));
  await kick;
  checker.setModel("air75-v3");
  const newAir = checker.refresh();
  await Promise.resolve();
  assert.equal(requests.length, 3);
  // Simulate a transport that returns despite its aborted signal.
  requests[0].resolve(new Response(JSON.stringify(manifest("1.0.99.6"))));
  await oldAir;
  assert.equal(checker.snapshot({...device(), modelId: "air75-v3"}).latest, null);
  assert.equal(checker.snapshot({...device(), modelId: "air75-v3"}).checking, true);
  assert.equal(checker.refresh(true), newAir, "stale completion cannot clear the newer pending request");
  requests[2].resolve(new Response(JSON.stringify(manifest("1.0.23.6"))));
  await newAir;
  assert.equal(checker.snapshot({...device(), modelId: "air75-v3"}).latest, "1.0.23.6");
  assert.equal(checker.snapshot(kickDevice()).latest, "4.0.18.6");
});

test("an unsupported model neither queries Air nor accepts another model's release", async () => {
  let calls = 0;
  const checker = new FirmwareChecker({fetchImpl: async () => { calls++; return new Response(JSON.stringify(manifest())); }});
  await checker.refresh();
  for (const modelId of ["unsupported", "toString", "__proto__"]) {
    checker.setModel(modelId);
    await checker.refresh(true);
    const result = checker.snapshot({...device(), modelId});
    assert.equal(result.latest, null);
    assert.equal(result.status, "unavailable");
    assert.equal(result.verifiedVersion, null);
    assert.equal(firmwareAPI(modelId), null);
    assert.throws(() => parseFirmwareManifest(manifest(), modelId));
  }
  assert.equal(calls, 1);
});

test("first-run firmware guidance distinguishes a confirmed release from an unchecked or stale cache", async () => {
  let now=1000;
  const checker=new FirmwareChecker({now:()=>now,fetchImpl:async()=>new Response(JSON.stringify(manifest('1.0.23.6')))});
  let result=checker.snapshot({...device('1.0.16.6'),modelId:'air75-v3'});
  assert.equal(result.hasChecked,false);
  assert.equal(result.latestConfirmed,false);
  assert.equal(result.upgradeRecommended,false,'an unchecked official latest is not guessed');
  await checker.refresh();
  result=checker.snapshot({...device('1.0.16.6'),modelId:'air75-v3'});
  assert.equal(result.modelName,'AIR75 V3');
  assert.equal(result.hasChecked,true);
  assert.equal(result.latestConfirmed,true);
  assert.equal(result.minimumRequired,'1.0.16.6');
  assert.equal(result.updateRequired,false);
  assert.equal(result.updateAvailable,true);
  assert.equal(result.upgradeRecommended,true,'compatible older firmware still receives the latest-release guidance');
  now+=6*60*60*1000+1;
  result=checker.snapshot({...device('1.0.16.6'),modelId:'air75-v3'});
  assert.equal(result.latestConfirmed,false);
  assert.equal(result.updateAvailable,false,'an expired response cannot cause an automatic latest-release redirect');
  assert.equal(result.upgradeRecommended,false);
});

test("known old Kick firmware receives an upgrade requirement even when the official check is offline", async () => {
  const checker=new FirmwareChecker({fetchImpl:async()=>{throw new Error('offline');}});
  checker.setModel('kick75');
  await checker.refresh();
  const result=checker.snapshot({...kickDevice(),capabilities:{perKey:false,functionKeyAdaptation:false}});
  assert.equal(result.status,'unavailable');
  assert.equal(result.modelName,'Kick75');
  assert.equal(result.hasChecked,false);
  assert.equal(result.latestConfirmed,false);
  assert.equal(result.latest,null);
  assert.equal(result.minimumRequired,'4.0.18.6');
  assert.equal(result.updateRequired,true);
  assert.equal(result.updateAvailable,false);
  assert.equal(result.upgradeRecommended,true);
  assert.equal(result.compatible,false,'the upgrade hint cannot make an unsupported protocol usable');
  assert.equal(result.updateUrl,'https://drive.nuphy.io/?lang=zh-CN');
});

test("upgrade guidance does not recommend a downgrade or guess unknown firmware and unsupported models", async () => {
  const checker=new FirmwareChecker({fetchImpl:async()=>new Response(JSON.stringify(kickManifest()))});
  checker.setModel('kick75');
  await checker.refresh();
  for(const firmware of ['4.0.18.6','4.0.99.6','unknown',null]) {
    const result=checker.snapshot({...kickDevice(),firmware,capabilities:{perKey:false}});
    assert.equal(result.updateRequired,false);
    assert.equal(result.updateAvailable,false);
    assert.equal(result.upgradeRecommended,false);
    assert.equal(result.compatible,false);
  }
  const disconnected=checker.snapshot({...kickDevice(),connected:false});
  assert.equal(disconnected.updateRequired,false);
  assert.equal(disconnected.updateAvailable,false);
  assert.equal(disconnected.upgradeRecommended,false);
  const unsupported=checker.snapshot({...kickDevice(),modelId:'unsupported'});
  assert.equal(unsupported.minimumRequired,null);
  assert.equal(unsupported.modelName,null);
  assert.equal(unsupported.latestConfirmed,false);
  assert.equal(unsupported.upgradeRecommended,false);
  assert.equal(unsupported.compatible,false);
});

test("a failed recheck removes latest-release redirect eligibility without hiding a known minimum", async () => {
  let offline=false;
  const checker=new FirmwareChecker({fetchImpl:async()=>{
    if(offline)throw new Error('offline');
    return new Response(JSON.stringify(kickManifest()));
  }});
  checker.setModel('kick75');
  await checker.refresh();
  assert.equal(checker.snapshot(kickDevice()).updateAvailable,true);
  offline=true;await checker.refresh(true);
  const result=checker.snapshot(kickDevice());
  assert.equal(result.latest,'4.0.18.6','last known version remains visible with stale evidence');
  assert.equal(result.hasChecked,true);
  assert.equal(result.latestConfirmed,false);
  assert.equal(result.updateAvailable,false);
  assert.equal(result.updateRequired,true);
  assert.equal(result.upgradeRecommended,true);
});

test("a failed LED-count handshake retains the identified keyboard's firmware upgrade path without granting lighting", async () => {
  const checker=new FirmwareChecker({fetchImpl:async()=>new Response(JSON.stringify(kickManifest()))});
  checker.setModel('kick75');await checker.refresh();
  const legacy={connected:false,identified:true,firmwareDetectionAvailable:true,modelId:'kick75',
    firmware:null,firmwareVersion:'4.0.15.6',errorCode:'LED_COUNT',
    capabilities:{perKey:false,functionKeyAdaptation:false}};
  const result=checker.snapshot(legacy);
  assert.equal(result.status,'updateAvailable');
  assert.equal(result.current,'4.0.15.6');
  assert.equal(result.latest,'4.0.18.6');
  assert.equal(result.firmwareDetectionAvailable,true);
  assert.equal(result.updateRequired,true);
  assert.equal(result.updateAvailable,true);
  assert.equal(result.upgradeRecommended,true);
  assert.equal(result.compatible,false);
  assert.equal(result.perKeyReady,false);
  assert.equal(result.functionKeysReady,false);
  assert.equal(result.updateUrl,'https://drive.nuphy.io/?lang=zh-CN');
  const unplugged=checker.snapshot({...legacy,identified:false,firmwareDetectionAvailable:false,firmwareVersion:null});
  assert.equal(unplugged.status,'disconnected');
  assert.equal(unplugged.firmwareDetectionAvailable,false);
  assert.equal(unplugged.upgradeRecommended,false);
});

test("identified legacy firmware remains actionable offline but incomplete or unknown identity cannot inherit another model", async () => {
  const checker=new FirmwareChecker({fetchImpl:async()=>{throw new Error('offline');}});
  checker.setModel('kick75');await checker.refresh();
  const legacy={connected:false,identified:true,firmwareDetectionAvailable:true,modelId:'kick75',firmwareVersion:'4.0.15.6'};
  const offline=checker.snapshot(legacy);
  assert.equal(offline.status,'unavailable');
  assert.equal(offline.updateRequired,true);
  assert.equal(offline.upgradeRecommended,true);
  assert.equal(offline.latestConfirmed,false);
  for(const device of [
    {...legacy,identified:false},
    {...legacy,firmwareDetectionAvailable:false},
    {...legacy,modelId:undefined},
    {...legacy,modelId:'unsupported'},
    {...legacy,firmwareVersion:'unknown'},
  ]) {
    const result=checker.snapshot(device);
    assert.equal(result.upgradeRecommended,false);
    assert.equal(result.firmwareDetectionAvailable,false);
    assert.equal(result.perKeyReady,false);
    assert.equal(result.functionKeysReady,false);
  }
});

test("protocol and function-key readiness require both a usable connection and explicit native capabilities", () => {
  const checker=new FirmwareChecker();
  const ready={connected:true,modelId:'kick75',firmwareVersion:'4.0.18.6',capabilities:{perKey:true,functionKeyAdaptation:true}};
  assert.equal(checker.snapshot(ready).perKeyReady,true);
  assert.equal(checker.snapshot(ready).functionKeysReady,true);
  for(const device of [
    {...ready,firmwareVersion:'4.0.15.6'},
    {...ready,firmwareVersion:'unknown'},
    {...ready,modelId:'unsupported'},
    {...ready,connected:false,identified:true,firmwareDetectionAvailable:true},
    {...ready,capabilities:{}},
  ]) {
    const result=checker.snapshot(device);
    assert.equal(result.compatible,false);
    assert.equal(result.perKeyReady,false);
    assert.equal(result.functionKeysReady,false);
  }
});
