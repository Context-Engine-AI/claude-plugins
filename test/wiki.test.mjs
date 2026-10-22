import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractCitations, verifyCitations, formatAnchors } from "../context-engine/hooks/lib/wiki.mjs";
import { handleStop, handleRetrieve, handleSessionEnd } from "../context-engine/hooks/lib/wiki.mjs";
import { workspaceDirName } from "../context-engine/hooks/lib/hook.mjs";

const CE_SERVER = { command: "node", args: ["/x/.ctxce/bin/ctx-mcp-proxy.js", "https://dev.context-engine.ai/indexer/mcp"] };
const COLLECTION = "admin_demo-1a2b3c4d";

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wiki-test-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, "home");
  const repo = path.join(base, "repo");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "config.ts"),
    "import { z } from 'zod';\n\nexport function parseConfig(raw: string) {\n  return z.object({}).parse(JSON.parse(raw));\n}\n\nexport class ConfigManager {\n  load() {}\n}\n");
  fs.writeFileSync(path.join(repo, "src", "app.ts"),
    "const x = 1;\n".repeat(200));
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { "context-engine": CE_SERVER } }));
  const ws = path.join(home, ".ctxce", "workspaces", workspaceDirName(repo));
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "ctx_config.json"), JSON.stringify({ default_collection: COLLECTION }));
  return { base, home, repo, opts: { home, env: { CTXCE_SESSION_WIKI: "1" }, parentArgs: "claude -p hi", stateDir: path.join(base, "state") } };
}

// ---- extractCitations ----

test("extractCitations: standard path:line citations", () => {
  const text = "See `src/config.ts:3` for the parser and `src/app.ts:10-20` for usage.";
  const cites = extractCitations(text);
  assert.equal(cites.length, 2);
  assert.deepEqual(cites[0], { path: "src/config.ts", start: 3, end: 3 });
  assert.deepEqual(cites[1], { path: "src/app.ts", start: 10, end: 20 });
});

test("extractCitations: deduplicates by path:start", () => {
  const text = "See src/config.ts:3 and again src/config.ts:3-5 and src/config.ts:3.";
  const cites = extractCitations(text);
  assert.equal(cites.length, 1);
  assert.equal(cites[0].start, 3);
});

test("extractCitations: handles L-prefixed lines and en/em dashes", () => {
  const text = "src/app.ts:L42–44 and src/config.ts:L10";
  const cites = extractCitations(text);
  assert.equal(cites.length, 2);
  assert.deepEqual(cites[0], { path: "src/app.ts", start: 42, end: 44 });
  assert.deepEqual(cites[1], { path: "src/config.ts", start: 10, end: 10 });
});

test("extractCitations: ignores non-code paths and bare URLs", () => {
  const text = "Visit https://example.com:8080/foo and see image.png:5.";
  assert.equal(extractCitations(text).length, 0);
});

test("extractCitations: returns empty for non-string input", () => {
  assert.deepEqual(extractCitations(null), []);
  assert.deepEqual(extractCitations(42), []);
  assert.deepEqual(extractCitations(undefined), []);
});

test("extractCitations: nested paths with directories", () => {
  const text = "Check routers/api/v1/repo/repo.go:140-155";
  const cites = extractCitations(text);
  assert.equal(cites.length, 1);
  assert.equal(cites[0].path, "routers/api/v1/repo/repo.go");
  assert.equal(cites[0].start, 140);
  assert.equal(cites[0].end, 155);
});

// ---- verifyCitations ----

test("verifyCitations: keeps only existing files with valid lines", (t) => {
  const { repo } = fixture(t);
  const cites = [
    { path: "src/config.ts", start: 3, end: 4 },
    { path: "src/nonexistent.ts", start: 1, end: 1 },
    { path: "src/app.ts", start: 9999, end: 9999 },
    { path: "src/app.ts", start: 5, end: 10 },
  ];
  const v = verifyCitations(cites, repo);
  assert.equal(v.length, 2);
  assert.equal(v[0].path, "src/config.ts");
  assert.equal(v[0].start, 3);
  assert.equal(v[0].symbol, "parseConfig");
  assert.equal(v[1].path, "src/app.ts");
  assert.equal(v[1].start, 5);
});

test("verifyCitations: caps at 20", (t) => {
  const { repo } = fixture(t);
  const cites = Array.from({ length: 30 }, (_, i) => ({ path: "src/app.ts", start: i + 1, end: i + 1 }));
  assert.equal(verifyCitations(cites, repo).length, 20);
});

test("verifyCitations: clamps end to file length", (t) => {
  const { repo } = fixture(t);
  const v = verifyCitations([{ path: "src/config.ts", start: 1, end: 9999 }], repo);
  assert.equal(v.length, 1);
  assert.ok(v[0].end < 9999);
});

// ---- formatAnchors ----

test("formatAnchors: formats with optional range and symbol", () => {
  const lines = formatAnchors([
    { path: "a.ts", start: 5, end: 5, symbol: "foo" },
    { path: "b.rs", start: 10, end: 20, symbol: null },
    { path: "c.py", start: 1, end: 3, symbol: "Bar" },
  ]);
  assert.deepEqual(lines, ["a.ts:5 (foo)", "b.rs:10-20", "c.py:1-3 (Bar)"]);
});

// ---- opt-in gate ----

test("all handlers are silent when CTXCE_SESSION_WIKI is not 1", (t) => {
  const { repo, opts } = fixture(t);
  const off = { ...opts, env: {} };
  const input = { hook_event_name: "Stop", session_id: "s1", cwd: repo, last_assistant_message: "src/config.ts:3" };
  handleStop(input, off);
  assert.equal(fs.existsSync(path.join(off.stateDir, "s1.wiki-state")), false);
});

test("handleStop is silent when wiki is on but no citations", (t) => {
  const { repo, opts } = fixture(t);
  handleStop({ hook_event_name: "Stop", session_id: "s1", cwd: repo, last_assistant_message: "no citations here" }, opts);
  const sf = path.join(opts.stateDir, "s1.wiki-state");
  assert.equal(fs.existsSync(sf), false);
});

// ---- handleStop: saves verified citations ----

test("handleStop: saves verified citations to state file", (t) => {
  const { repo, opts } = fixture(t);
  handleStop({
    hook_event_name: "Stop", session_id: "s1", cwd: repo,
    last_assistant_message: "The parser is at src/config.ts:3-4 and the app at src/app.ts:5.",
  }, opts);
  const sf = path.join(opts.stateDir, "s1.wiki-state");
  assert.ok(fs.existsSync(sf));
  const saved = JSON.parse(fs.readFileSync(sf, "utf8"));
  assert.equal(saved.length, 2);
  assert.equal(saved[0].path, "src/config.ts");
  assert.equal(saved[0].symbol, "parseConfig");
});

test("handleStop: overwrites on subsequent stops", (t) => {
  const { repo, opts } = fixture(t);
  const base = { hook_event_name: "Stop", session_id: "s1", cwd: repo };
  handleStop({ ...base, last_assistant_message: "src/config.ts:1" }, opts);
  handleStop({ ...base, last_assistant_message: "src/app.ts:5" }, opts);
  const saved = JSON.parse(fs.readFileSync(path.join(opts.stateDir, "s1.wiki-state"), "utf8"));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].path, "src/app.ts");
});

test("handleStop: handles structured last_assistant_message", (t) => {
  const { repo, opts } = fixture(t);
  handleStop({
    hook_event_name: "Stop", session_id: "s1", cwd: repo,
    last_assistant_message: { content: [{ type: "text", text: "See src/config.ts:3" }, { type: "tool_use", id: "x" }] },
  }, opts);
  const saved = JSON.parse(fs.readFileSync(path.join(opts.stateDir, "s1.wiki-state"), "utf8"));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].path, "src/config.ts");
});

// ---- handleRetrieve: opt-in and first-prompt gate ----

test("handleRetrieve: returns null when wiki off", async (t) => {
  const { repo, opts } = fixture(t);
  const result = await handleRetrieve({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: repo, prompt: "hello world" }, { ...opts, env: {} });
  assert.equal(result, null);
});

test("handleRetrieve: marks first prompt and skips second", async (t) => {
  const { repo, opts } = fixture(t);
  const input = { hook_event_name: "UserPromptSubmit", session_id: "r1", cwd: repo, prompt: "find the bug in the auth middleware" };
  // First call saves state; API call will fail (no real server) -> null
  const r1 = await handleRetrieve(input, opts);
  // Second call: not first prompt
  const r2 = await handleRetrieve(input, opts);
  assert.equal(r2, null);
  // Verify prompt file exists
  assert.ok(fs.existsSync(path.join(opts.stateDir, "r1.wiki-prompt")));
});

test("handleRetrieve: skips short prompts", async (t) => {
  const { repo, opts } = fixture(t);
  await handleRetrieve({ hook_event_name: "UserPromptSubmit", session_id: "r2", cwd: repo, prompt: "hi" }, opts);
  assert.ok(fs.existsSync(path.join(opts.stateDir, "r2.wiki-prompt")));
});

// ---- handleSessionEnd: flushes and cleans up ----

test("handleSessionEnd: returns silently when no state", async (t) => {
  const { repo, opts } = fixture(t);
  // No state files -> nothing to do
  await handleSessionEnd({ hook_event_name: "SessionEnd", session_id: "e1", cwd: repo }, opts);
});

test("handleSessionEnd: cleans up state files", async (t) => {
  const { repo, opts } = fixture(t);
  fs.mkdirSync(opts.stateDir, { recursive: true });
  fs.writeFileSync(path.join(opts.stateDir, "e2.wiki-prompt"), "find the bug");
  fs.writeFileSync(path.join(opts.stateDir, "e2.wiki-state"), JSON.stringify([
    { path: "src/config.ts", start: 3, end: 4, symbol: "parseConfig" },
  ]));
  // API call will fail (no real server) but state should be cleaned up
  await handleSessionEnd({ hook_event_name: "SessionEnd", session_id: "e2", cwd: repo }, opts);
  assert.equal(fs.existsSync(path.join(opts.stateDir, "e2.wiki-prompt")), false);
  assert.equal(fs.existsSync(path.join(opts.stateDir, "e2.wiki-state")), false);
});
