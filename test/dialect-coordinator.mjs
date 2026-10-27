// Deterministic Durable Object coordinator tests: no network or Docker needed.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "node_modules", ".cache", "coordinator-test");
execSync(
  `npx tsc src/dialect-coordinator.ts src/types.ts --outDir "${out}" --module es2022 --target es2022 --moduleResolution bundler --strict --skipLibCheck --types @cloudflare/workers-types`,
  { cwd: root, stdio: "inherit" },
);
const { DialectCoordinator } = await import(path.join(out, "dialect-coordinator.js"));

class MemoryStorage {
  values = new Map();
  alarmAt = null;
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(keys) {
    let count = 0;
    for (const key of keys) { if (this.values.delete(key)) count++; }
    return count;
  }
  async list({ prefix }) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix)));
  }
  async getAlarm() { return this.alarmAt; }
  async setAlarm(at) { this.alarmAt = at; }
  async deleteAlarm() { this.alarmAt = null; }
}
const target = (base, providers = [base]) => ({ base, providers });
const endpoints = (base) => ({ supported: {}, likely: { "openai-chat": `${base}/chat/completions` } });

// Progress persists per URL: later failure cannot discard the first success.
{
  const storage = new MemoryStorage();
  const attempted = [];
  const coordinator = new DialectCoordinator(storage, async (base) => {
    attempted.push(base);
    if (base === "https://bad.example") throw new Error("probe timeout");
    return { endpoints: endpoints(base), durationMs: 12 };
  });
  await coordinator.sync("source-a", [
    target("https://good.example"),
    target("https://bad.example"),
    target("https://later.example"),
  ]);
  await coordinator.alarm();
  const snapshot = await coordinator.snapshot();
  assert.deepEqual(attempted, ["https://good.example", "https://bad.example", "https://later.example"]);
  assert.deepEqual(snapshot.records.map((r) => [r.base, r.error]), [
    ["https://good.example", null],
    ["https://bad.example", "probe timeout"],
    ["https://later.example", null],
  ]);
  assert.equal(snapshot.records.find((r) => r.base === "https://good.example").endpoints.likely["openai-chat"],
    "https://good.example/chat/completions");
  assert.ok(storage.alarmAt > Date.now(), "all fresh targets schedule their TTL refresh");
}

// Failed attempts are retried after backoff; successes remain undisturbed.
{
  const storage = new MemoryStorage();
  let fail = true;
  const attempts = [];
  const coordinator = new DialectCoordinator(storage, async (base) => {
    attempts.push(base);
    if (fail) throw new Error("temporary");
    return { endpoints: endpoints(base), durationMs: 1 };
  });
  await coordinator.sync("a", [target("https://a.example")]);
  await coordinator.alarm();
  assert.equal((await coordinator.snapshot()).records[0].error, "temporary");
  fail = false;
  const previous = storage.values.get("record:v2:https://a.example");
  previous.nextAttemptAt = Date.now() - 1;
  storage.alarmAt = null;
  await coordinator.alarm();
  assert.equal((await coordinator.snapshot()).records[0].error, null);
  assert.equal(attempts.length, 2);
}

// A transient failure preserves the last known good endpoint data while its
// retry metadata still records the failure for diagnostics/backoff.
{
  const storage = new MemoryStorage();
  let fail = false;
  const coordinator = new DialectCoordinator(storage, async (base) => {
    if (fail) throw new Error("container restart");
    return { endpoints: endpoints(base), durationMs: 1 };
  });
  await coordinator.sync("a", [target("https://a.example")]);
  await coordinator.alarm();
  fail = true;
  storage.values.get("record:v2:https://a.example").nextAttemptAt = Date.now()-1;
  storage.alarmAt = null;
  await coordinator.alarm();
  const record = (await coordinator.snapshot()).records[0];
  assert.equal(record.error,"container restart");
  assert.equal(record.endpoints.likely["openai-chat"],"https://a.example/chat/completions");
}

// Interruption is recoverable: completed writes survive, pending bases continue.
{
  const storage = new MemoryStorage();
  let calls = 0;
  const coordinator = new DialectCoordinator(storage, async (base) => {
    calls++;
    if (calls === 2) {
      // Simulate a container/DO cancellation before this result is written.
      throw new Error("instance evicted");
    }
    return { endpoints: endpoints(base), durationMs: 5 };
  });
  await coordinator.sync("a", [target("https://a.example"), target("https://b.example"), target("https://c.example")]);
  await coordinator.alarm();
  assert.equal(storage.values.has("record:v2:https://a.example"), true);
  assert.equal(storage.values.has("record:v2:https://c.example"), true);
  await coordinator.alarm(); // no network needed: fresh and retry backoff skip all
  assert.equal(calls, 3);
}

// Removed base URLs are deleted; existing results survive source changes.
{
  const storage = new MemoryStorage();
  let calls = 0;
  const coordinator = new DialectCoordinator(storage, async (base) => {
    calls++;
    return { endpoints: endpoints(base), durationMs: 5 };
  });
  await coordinator.sync("a", [target("https://a.example"), target("https://b.example")]);
  await coordinator.alarm();
  assert.equal(calls, 2);
  await coordinator.sync("b", [target("https://a.example")]);
  assert.equal(storage.values.has("record:v2:https://b.example"), false);
  await coordinator.alarm();
  assert.equal(calls, 2, "unchanged fresh base is not probed again");
}

console.log("Durable Object coordinator: ALL ASSERTIONS PASSED");

// All eligible URLs are eventually covered across small alarm batches, even
// when a source change reorders targets between batches.
{
  const storage = new MemoryStorage();
  const attempted = [];
  const coordinator = new DialectCoordinator(storage, async (base) => {
    attempted.push(base);
    return { endpoints: endpoints(base), durationMs: 1 };
  });
  await coordinator.sync("a", Array.from({length: 8},(_,i)=>target(`https://${i}.example`)));
  await coordinator.alarm();
  assert.equal(attempted.length, 3, "each alarm is bounded to three probes");
  await coordinator.alarm();
  await coordinator.alarm();
  assert.equal(attempted.length, 8, "remaining due targets continue on later alarms");
  const snapshot = await coordinator.snapshot();
  assert.equal(snapshot.records.length, 8);
  assert.ok(storage.alarmAt > Date.now());
}

// Legacy/unversioned metadata never stops fresh results from being rebuilt.
{
  const storage = new MemoryStorage();
  await storage.put("meta:v2", { source: "old", targets: [{base:"https://old.example",providers:["old"]}], cursor:0 });
  const coordinator = new DialectCoordinator(storage, async (base) => ({endpoints:endpoints(base),durationMs:1}));
  await coordinator.sync("new", [target("https://new.example")]);
  await coordinator.alarm();
  assert.equal((await coordinator.snapshot()).records[0].base,"https://new.example");
}
