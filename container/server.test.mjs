import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest, validateProbeRequest, partitionEndpoints } from "./server.mjs";

test("health endpoint", async () => {
  const res = await handleRequest(new Request("http://container/health"));
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
