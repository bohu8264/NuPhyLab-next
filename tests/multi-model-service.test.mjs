import test from "node:test";
import assert from "node:assert/strict";
import { fakeService, until } from "./helpers/fake-service.mjs";
import { Store } from "../server/storage.mjs";
import { kickLayout } from "../shared/layout.mjs";
import { PongGame } from "../server/games/pong.mjs";

test("USB model changes replace the canvas and keep each keyboard's works separate", async t => {
  const s = await fakeService(t);
  await s.command({op:"settings",settings:{autoConnect:false,codexEnabled:false}});
  const scene = {name:"AIR original", colors:Array(84).fill("#123456"), animation:{effect:"static"}};
  const air = (await s.command({op:"saveScene",scene})).result.savedScene;
  assert.equal(air.modelId,"air75-v3");
  assert.equal((await s.command({op:"play",...scene})).ok,true);
  await s.configure({disconnect:1,present:false});
  await until(s.state,v=>!v.device.connected,"AIR unplugged");
  await s.configure({present:true,modelId:"kick75",firmwareVersion:"4.0.15.6"});
  assert.equal((await s.command({op:"connect"})).ok,true);
  let next = await s.state();
  assert.equal(next.device.modelId,"kick75");
  assert.equal(next.layout.length,80);
  assert.equal(next.playback.mode,"idle");
  assert.equal(next.playback.playing,false);
  assert.deepEqual(next.scenes,[]);
  assert.equal((await s.command({op:"saveScene",scene:{...air,name:"wrong overwrite"}})).ok,false);
  const kick=(await s.command({op:"saveScene",scene:{...scene,name:"Kick original"}})).result.savedScene;
  assert.equal(kick.modelId,"kick75");
  const reopened = await new Store(s.dataDir).load();
  assert.equal(reopened.data.scenes.length,2);
  assert.equal(reopened.data.scenes.find(v=>v.id===air.id).name,"AIR original");
  await s.command({op:"disconnect"});
  await s.configure({modelId:"air75-v3",firmwareVersion:"1.0.23.6"});
  await s.command({op:"connect"});
  next = await s.state();
  assert.equal(next.layout.length,83);
  assert.deepEqual(next.scenes.map(v=>v.id),[air.id]);
});

test("Kick Pong uses all six physical rows including spaced function keys", () => {
  const game = new PongGame(()=>0.5,kickLayout);
  assert.deepEqual(game.rows.map(row=>row.length),[14,15,15,14,13,9]);
  game.start();
  assert(game.render().some((color,index)=>index>=14&&color!=="#000000"));
  assert.deepEqual(game.render().slice(80),Array(4).fill("#000000"));
});

test("older Kick firmware uses stock effects without sending per-key commands", async t => {
  const s = await fakeService(t,{modelId:"kick75",firmwareVersion:"4.0.15.6",compatible:false,mainWholeZone:true,functionKeyAdaptation:false});
  await s.command({op:"settings",settings:{codexEnabled:false,autoConnect:false}});
  const before = (await s.operations()).length;
  const result = await s.command({op:"nativeLighting",mode:3,brightness:10,speed:2,color:"#400000"});
  assert.equal(result.ok,true);
  const state = await s.state();
  assert.equal(state.layout.length,80);
  assert.equal(state.playback.mode,"native");
  assert.equal(state.device.state[0],3);
  assert.equal((await s.command({op:"play",colors:Array(84).fill("#123456"),animation:{effect:"static"}})).ok,false);
  assert(!(await s.operations()).slice(before).some(v=>["arm","paint","readKeymap","prepareFunctionKey","adaptKeys"].includes(v.op)));
  assert.equal((await s.command({op:"restore"})).ok,true);
  assert.equal((await s.state()).device.recoveryPending,false);
});
