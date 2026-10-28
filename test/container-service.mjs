// Exercise the exact Node service used by the Cloudflare Container image.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const child = spawn(process.execPath, ["-e", `import { createServer } from "./server.mjs"; createServer({startLoop:false}).listen(18080,"0.0.0.0");`], {
  cwd: path.join(root, "container"),
  env: { ...process.env, PORT: "18080", DIALECT_RESULTS_URL: "http://127.0.0.1:18080/results" },
  stdio: ["ignore", "pipe", "pipe"],
});
const probeLog = [];
child.stdout.on("data", (chunk) => { probeLog.push(chunk.toString()); process.stdout.write(chunk); });
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
try {
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      const response = await fetch("http://127.0.0.1:18080/health");
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, "container service must listen on 0.0.0.0:18080");

  const response = await fetch("http://127.0.0.1:18080/probe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bases: ["https://api.anthropic.com", "https://api.openai.com/v1"],
      timeoutMs: 4000,
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.results.length, 2);
  const [anthropic, openai] = body.results;
  assert.equal(anthropic.endpoints.supported["anthropic-messages"], "https://api.anthropic.com");
  assert.ok(!anthropic.endpoints.likely["anthropic-messages"]);
  assert.equal(anthropic.rawEndpoints.supported["anthropic-messages"], "https://api.anthropic.com/v1/messages");
  assert.equal(openai.endpoints.likely["openai-chat"] || openai.endpoints.supported["openai-chat"], "https://api.openai.com/v1");
  console.log("Real npm detector via container HTTP service:", JSON.stringify(body, null, 2));

  const invalid = await fetch("http://127.0.0.1:18080/probe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bases: [] }),
  });
  assert.equal(invalid.status, 400);
  console.log("Container service live HTTP: ALL ASSERTIONS PASSED");
} finally {
  child.kill("SIGTERM");
}
