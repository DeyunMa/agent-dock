import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfig } from "../../src/router/core/config.js";
import { RouterEngine, type AiClassifier } from "../../src/router/core/engine.js";
import { ProtocolRouter } from "../../src/router/adapters/protocol-router.js";

async function fixture(fail = false) {
  const config = defaultConfig(); config.logging.auditFile = "";
  config.routing.stateDirectory = await mkdtemp(join(tmpdir(), "dock-pin-"));
  let calls = 0;
  const ai: AiClassifier = { async warmup() {}, async classify() {
    calls++; await new Promise(r => setTimeout(r, 20));
    return fail ? {status:"timeout"} : {status:"ok",decision:{routeName:"balanced",category:"IMPLEMENT_CHANGE",complexity:"normal",intent:"do",confidence:0.9,reason:"test",latencyMs:20}};
  } };
  return {config,ai,calls:()=>calls};
}
const turn = (id="task", text="PRIVATE_INITIAL_INPUT") => ({ threadId:id, model:"original",effort:"low",input:[{type:"text",text}] });

test("first route survives unrelated followups, process recreation and profile edits", async () => {
  const f = await fixture();
  const first = await new RouterEngine(f.config,f.ai).routeTurn(turn());
  f.config.routes.balanced!.model = "changed-model";
  const next = await new RouterEngine(f.config,f.ai).routeTurn(turn("task","完全不同且复杂的任务"));
  assert.equal(f.calls(),1); assert.deepEqual(next.profile,first.profile); assert.equal(next.reason,"first_turn_pinned");
  const files = await readdir(f.config.routing.stateDirectory);
  assert.equal(files.length,1);
  assert.equal((await readFile(join(f.config.routing.stateDirectory,files[0]!),"utf8")).includes("PRIVATE"),false);
});
test("concurrent first turns across independent engines claim only one API call", async () => {
  const f = await fixture();
  const decisions = await Promise.all([new RouterEngine(f.config,f.ai).routeTurn(turn()),new RouterEngine(f.config,f.ai).routeTurn(turn())]);
  assert.equal(f.calls(),1); assert.deepEqual(decisions[0]?.profile,decisions[1]?.profile);
});
test("first-call failure is remembered and never retried on later turns", async () => {
  const f = await fixture(true);
  assert.equal((await new RouterEngine(f.config,f.ai).routeTurn(turn())).action,"inherit");
  const next = await new RouterEngine(f.config,f.ai).routeTurn(turn());
  assert.equal(f.calls(),1); assert.equal(next.profile?.model,"original");
});
test("resumed and forked conversations with history are not treated as first turns", async () => {
  for (const method of ["thread/resume","thread/fork"]) {
    const f = await fixture(); const protocol = new ProtocolRouter(new RouterEngine(f.config,f.ai));
    const request = JSON.stringify({id:1,method,params:{threadId:"task"}});
    assert.equal(await protocol.transformClientLine(request),request);
    protocol.observeServerLine(JSON.stringify({id:1,result:{thread:{id:"task",turns:[{id:"old"}]}}}));
    const line = JSON.stringify({id:2,method:"turn/start",params:turn()});
    assert.equal(await protocol.transformClientLine(line),line); assert.equal(f.calls(),0);
  }
});
test("resume of a genuinely empty thread can route its first request", async () => {
  const f = await fixture(); const protocol = new ProtocolRouter(new RouterEngine(f.config,f.ai));
  await protocol.transformClientLine(JSON.stringify({id:1,method:"thread/resume",params:{threadId:"task"}}));
  await protocol.transformServerLine(JSON.stringify({id:1,result:{thread:{id:"task",turns:[]}}}));
  await protocol.transformClientLine(JSON.stringify({id:2,method:"turn/start",params:{...turn(),model:"jev-router"}}));
  assert.equal(f.calls(),1);
});
test("missing thread IDs never share a global default route", async () => {
  const f=await fixture(); const engine=new RouterEngine(f.config,f.ai);
  const params={input:[{type:"text",text:"请执行测试"}]};
  await engine.routeTurn(params); await engine.routeTurn(params); assert.equal(f.calls(),2);
});
