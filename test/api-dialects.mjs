// Full Worker handler tests with an in-memory singleton DO binding.
// No Docker or network: storage, read path and response shapes are real code.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "node_modules", ".cache", "api-test");
const files = [
  "src/handlers.ts", "src/dialects.ts", "src/dialect-client.ts",
  "src/dialect-store.ts", "src/dialect-targets.ts", "src/match.ts", "src/types.ts",
  "src/dialect-container.ts", "worker-configuration.d.ts",
];
execSync(
  `npx tsc ${files.join(" ")} --outDir "${out}" --module es2022 --target es2022 --moduleResolution bundler --strict --skipLibCheck --types @cloudflare/workers-types`,
  { cwd: root, stdio: "inherit" },
);
for (const file of ["handlers.js", "dialects.js", "dialect-client.js", "dialect-store.js", "dialect-targets.js", "dialect-container.js"]) {
  const fp = path.join(out, file);
  let source = readFileSync(fp, "utf8");
  source = source.replace(/from "(\.[^"]+)"/g, (match, spec) => `from "${spec}.js"`);
  writeFileSync(fp, source);
}
// Node cannot load the Workers-only cloudflare:workers scheme. Replace only
// that platform import in the compiled test copy; production uses the real one.
const dialectContainerPath = path.join(out, "dialect-container.js");
writeFileSync(dialectContainerPath, readFileSync(dialectContainerPath,"utf8").replace('from "cloudflare:workers"', 'from "./workers-test-double.js"'));
writeFileSync(path.join(out,"workers-test-double.js"), `
export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
`);
const { handleProvider, handleModel } = await import(path.join(out, "handlers.js"));
const { dialectMapForModels, scheduleDialectSync, dialectCacheStatus } = await import(path.join(out, "dialects.js"));
const { DialectStore } = await import(path.join(out, "dialect-store.js"));
const { DialectDetectorDurableContainer } = await import(path.join(out, "dialect-container.js"));

class MemoryStorage {
  values = new Map(); alarmAt = null;
  async get(k) { return this.values.get(k); }
  async put(k,v) { this.values.set(k,structuredClone(v)); }
  async delete(keys) { let n=0; for(const k of keys) if(this.values.delete(k))n++; return n; }
  async list({prefix}) { return new Map([...this.values].filter(([k])=>k.startsWith(prefix))); }
  async getAlarm() { return this.alarmAt; }
  async setAlarm(at) { this.alarmAt=at; }
}
const storage = new MemoryStorage();
const base="https://api.anthropic.com";
const endpoints={supported:{"anthropic-messages":`${base}/v1/messages`},likely:{"openai-chat":`${base}/v1/chat/completions`}};
const store = new DialectStore(storage);
await store.configure("test",[{base,providers:["anthropic"]}]);
await store.save(base,endpoints,1,null);
const ctxContainer = { storage, container: { async setInactivityTimeout() {} }, id: { toString: () => "container-id" } };
const container = new DialectDetectorDurableContainer(ctxContainer,{});
const stub={async getSnapshot(){return await store.snapshot();},async sync(source,targets){await store.configure(source,targets);}};
const env={DIALECT_DETECTOR:{idFromName(name){assert.equal(name,"global");return name;},getByName(name){assert.equal(name,"global");return stub;},get(id){assert.equal(id,"global");return stub;}}};
const model=(id,name)=>({id,name,family:"claude",attachment:true,tool_call:true,open_weights:false,reasoning:true,modalities:{input:["text"],output:["text"]},limit:{context:200000,output:64000},release_date:"2026-01-01",last_updated:"2026-01-01"});
const data={anthropic:{id:"anthropic",name:"Anthropic",npm:"@ai-sdk/anthropic",doc:"",env:[],models:{"claude-opus-4-5":model("claude-opus-4-5","Claude Opus 4.5")}}};
const map=await dialectMapForModels(env);
const response=handleProvider(data,map);
assert.equal(response.status,200);
assert.equal(response.headers.get("access-control-allow-origin"),"*");
const provider=await response.json();
assert.equal(provider.count,1);
assert.deepEqual(provider.providers[0],{name:"Anthropic",sdk:"anthropic",api:base,dialects:endpoints});
const modelResponse=handleModel(data,"claude-opus-4-5","anthropic",map);
const modelBody=await modelResponse.json();
assert.equal(modelBody.count,1);
assert.deepEqual(modelBody.models[0].dialects,endpoints);
const ctx={waitUntil(p){this.promise=p;}};
scheduleDialectSync(env,ctx,data);
assert.ok(ctx.promise,"sync must be registered with waitUntil");
await ctx.promise;
const status=await dialectCacheStatus(env);
const snapshot=await container.getSnapshot();
assert.equal(snapshot.records[0].base,base);
await container.saveResults({results:[{base,ok:true,endpoints,durationMs:1}],startedAt:Date.now(),lastError:null});
let startupOptions;
let intercepted;
const fakePort={async fetch(url,init){return new Response(null,{status:200});}};
const fakeContainer={running:false,images:{base:"registry.example/base@sha256:test"},async interceptOutboundHttp(host,binding){intercepted=host;},async setInactivityTimeout(){},getTcpPort(port){assert.equal(port,8080);return fakePort;},start(options){startupOptions=options;this.running=true;}};
const fakeCtx={storage,container:fakeContainer,id:{toString:()=>"container-id"},exports:{DialectResultsWorker(){return{};}}};
const containerWithLifecycle=new DialectDetectorDurableContainer(fakeCtx,{});
await containerWithLifecycle.sync("test",[{base,providers:["anthropic"]}]);
assert.equal(intercepted,"dialect-detector.internal");
assert.deepEqual(startupOptions,{image:"registry.example/base@sha256:test",instance:"standard-1",enableInternet:true});
assert.equal(status.backend,"cloudflare-container+durable-object");
assert.equal(status.providersWithDialects,1);
assert.equal(status.probedBaseUrls,1);
console.log("Worker /provider + /model DO-backed response shapes: ALL ASSERTIONS PASSED");
