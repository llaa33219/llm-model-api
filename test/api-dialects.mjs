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
  "src/dialect-container.ts",
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
// Node cannot resolve the Workers-only cloudflare:workers module. The real
// Cloudflare package is bundled in production; replace only that platform
// import with a base DurableObject class for the container subclass test.
const testPackageDir = path.join(out, "node_modules", "@cloudflare", "containers");
execSync(`mkdir -p "${testPackageDir}"`, { stdio: "inherit" });
writeFileSync(path.join(testPackageDir, "package.json"), JSON.stringify({type:"module",exports:"./index.js"}));
writeFileSync(path.join(testPackageDir, "index.js"), `
import { getContainer as realGetContainer } from ${JSON.stringify(path.join(root,"node_modules/@cloudflare/containers/dist/lib/utils.js"))};
export { realGetContainer as getContainer };
export class Container { constructor(ctx, env) { this.ctx = ctx; this.env = env; } async getState() { return {status:"healthy"}; } renewActivityTimeout() {} }
`);
const helper = await import(path.join(root,"node_modules/@cloudflare/containers/dist/lib/utils.js"));
const getContainer = helper.getContainer;
const { handleProvider, handleModel } = await import(path.join(out, "handlers.js"));
const { dialectMapForModels, scheduleDialectSync, dialectCacheStatus } = await import(path.join(out, "dialects.js"));
const { DialectStore } = await import(path.join(out, "dialect-store.js"));
const { DialectDetectorContainer } = await import(path.join(out, "dialect-container.js"));

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
const ctxContainer = { storage, container: {}, id: { toString: () => "container-id" } };
const container = new DialectDetectorContainer(ctxContainer,{});
const stub={async getSnapshot(){return await store.snapshot();},async sync(source,targets){await store.configure(source,targets);}};
const env={DIALECT_DETECTOR:{idFromName(name){assert.equal(name,"cf-singleton-container");return name;},get(id){assert.equal(id,"cf-singleton-container");return stub;}}};
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
assert.ok(DialectDetectorContainer.outboundByHost["dialect-detector.internal"], "static initializer must invoke the base setter and register the handler");
let outboundRequest;
const outboundEnv={DIALECT_DETECTOR:{idFromString(id){assert.equal(id,"container-id");return id;},get(id){assert.equal(id,"container-id");return{async fetch(request){outboundRequest=request;return Response.json({ok:true});}};}}};
const outboundResponse=await DialectDetectorContainer.outboundByHost["dialect-detector.internal"](new Request("http://dialect-detector.internal/results",{method:"POST",body:"{}"}),outboundEnv,{containerId:"container-id"});
assert.equal(outboundResponse.status,200);
assert.equal(new URL(outboundRequest.url).pathname,"/results");
assert.equal(status.backend,"cloudflare-container+durable-object");
assert.equal(status.providersWithDialects,1);
assert.equal(status.probedBaseUrls,1);
console.log("Worker /provider + /model DO-backed response shapes: ALL ASSERTIONS PASSED");
