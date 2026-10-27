import test from "node:test";
import assert from "node:assert/strict";
import { validateProbeRequest, partitionEndpoints, runProbePass, createControlHandler, DetectorLoop } from "./server.mjs";

test("health endpoint", async () => {
  const res = await createControlHandler({getSnapshot:async()=>({targets:[],records:[]}),saveResults:async()=>{}})(new Request("http://container/health"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, service: "lma-dialect-probe" });
});

test("batch limit and invalid URL validation", () => {
  assert.throws(() => validateProbeRequest({ bases: [] }), /1-4/);
  assert.throws(() => validateProbeRequest({ bases: Array(5).fill("https://example.com") }), /1-4/);
  assert.throws(() => validateProbeRequest({ bases: ["not-a-url"] }), /invalid base URL/);
  assert.throws(() => validateProbeRequest({ bases: ["file:///etc/passwd"] }), /http\(s\)/);
  assert.throws(() => validateProbeRequest({ bases: ["https://a.example", "https://a.example/"] }), /duplicate/);
});

test("supported and likely remain disjoint", () => {
  const result = partitionEndpoints([
    { dialect: "openai-chat", status: "likely", probedUrl: "https://x/chat/completions" },
    { dialect: "anthropic-messages", status: "supported", probedUrl: "https://x/v1/messages" },
    { dialect: "gemini-generate", status: "not-found", probedUrl: "https://x/models" },
  ]);
  assert.deepEqual(result, {
    supported: { "anthropic-messages": "https://x/v1/messages" },
    likely: { "openai-chat": "https://x/chat/completions" },
  });
});

test("long-running pass saves every result immediately and skips fresh records", async () => {
  const saved=[];
  const targets=[{base:"https://a.example"},{base:"https://b.example"}];
  const records=[{base:"https://a.example",nextAttemptAt:Date.now()+10000}];
  const result=await runProbePass(targets,records,{
    pauseMs:0,
    probe:async(base)=>({base,ok:true,endpoints:{supported:{},likely:{}},durationMs:1}),
    saveResults:async(results,...rest)=>saved.push(...results),
  });
  assert.equal(result.attempted,1);
  assert.equal(saved.length,1);
  assert.equal(saved[0].base,"https://b.example");
});

test("production control starts a nonblocking recurring loop", async () => {
  let probes = 0;
  const handler = createControlHandler({
    getSnapshot:async()=>({source:"test",targets:[{base:"https://a.example"}],records:[]}),
    saveResults:async(results)=>{if(results.length>0)probes++;},
    probe:async(base)=>({base,ok:true,endpoints:{supported:{},likely:{}},durationMs:1}),
  });
  const started = Date.now();
  const response = await handler(new Request("http://container/control",{method:"POST"}));
  assert.equal(response.status,202);
  assert.ok(Date.now()-started < 100, "control must return without waiting for the sweep");
  await new Promise((resolve)=>setTimeout(resolve,30));
  assert.ok(probes >= 1, "the real production handler must start probing");
  await handler(new Request("http://container/stop",{method:"POST"}));
});

test("a transient snapshot failure does not poison the next pass", async () => {
  let snapshots = 0;
  const loop = new DetectorLoop({
    getSnapshot:async()=>{
      snapshots++;
      if(snapshots===1) throw new Error("temporary");
      return {source:"test",targets:[],records:[]};
    },
    saveResults:async()=>{},
    pauseMs:0,
    idleMs:10,
  });
  await loop.configure();
  await loop.configure();
  assert.ok(snapshots >= 2);
  await loop.stop();
});

test("control serializes configuration and can be stopped", async () => {
  const loop = new DetectorLoop({
    getSnapshot:async()=>({source:"test",targets:[],records:[]}),
    saveResults:async()=>{},
    probe:async()=>{throw new Error("must not probe");},
    idleMs:60_000,
  });
  await loop.configure();
  await loop.stop();
});

test("stop waits for an in-flight probe and cancels the next scheduled pass", async () => {
  let probes = 0;
  const loop = new DetectorLoop({
    getSnapshot:async()=>({source:"test",targets:[{base:"https://a.example"}],records:[]}),
    saveResults:async(results)=>{if(results.length>0)probes++;},
    probe:async(base)=>({base,ok:true,endpoints:{supported:{},likely:{}},durationMs:1}),
    pauseMs:0,
    idleMs:10,
  });
  loop.start();
  await loop.stop();
  const after = probes;
  assert.equal(after,1);
  await new Promise((resolve)=>setTimeout(resolve,70));
  assert.equal(probes,after,"no new probe may start after stop");
});

test("the repeating loop actually repeats and stays serial", async () => {
  let probes = 0;
  const loop = new DetectorLoop({
    getSnapshot:async()=>({source:"test",targets:[{base:"https://a.example"}],records:[]}),
    saveResults:async(results)=>{if(results.length>0)probes++;},
    probe:async(base)=>({base,ok:true,endpoints:{supported:{},likely:{}},durationMs:1}),
    pauseMs:0,
    idleMs:10,
  });
  loop.start();
  await new Promise((resolve)=>setTimeout(resolve,50));
  await loop.stop();
  assert.ok(probes >= 2, `expected at least 2 passes, got ${probes}`);
});
