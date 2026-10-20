import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_DENIES, handle, workspaceDirName } from "../context-engine/hooks/lib/hook.mjs";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "context-engine", "hooks", "ce-hook.mjs");
const COLLECTION = "admin_demo-1a2b3c4d";
const CE_SERVER = { command: "node", args: ["/x/.ctxce/bin/ctx-mcp-proxy.js", "https://dev.context-engine.ai/indexer/mcp"] };

function fixture(t, { indexed = true, servers = { "context-engine": CE_SERVER } } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ce-hook-test-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, "home");
  const repo = path.join(base, "demo");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "config.ts"), "export function parseConfig() {}\n");
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: servers }));
  if (indexed) {
    const ws = path.join(home, ".ctxce", "workspaces", workspaceDirName(repo));
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, "ctx_config.json"), JSON.stringify({ default_collection: COLLECTION }));
  }
  const opts = { home, env: {}, parentArgs: "claude -p hi", stateDir: path.join(base, "state") };
  return { base, home, repo, opts };
}

const bash = (repo, command, session = "s1") => ({
  hook_event_name: "PreToolUse", session_id: session, cwd: repo, tool_name: "Bash", tool_input: { command },
});
const reasonOf = (out) => out && out.hookSpecificOutput.permissionDecisionReason;

test("SessionStart and SubagentStart state the collection in under 600 chars", (t) => {
  const { repo, opts } = fixture(t);
  for (const event of ["SessionStart", "SubagentStart"]) {
    const out = handle({ hook_event_name: event, session_id: "s1", cwd: path.join(repo, "src"), agent_type: "Explore" }, opts);
    assert.equal(out.hookSpecificOutput.hookEventName, event);
    const text = out.hookSpecificOutput.additionalContext;
    assert.match(text, new RegExp(COLLECTION));
    assert.match(text, /mcp__context-engine__repo_search/);
    assert.ok(text.length < 600, `${text.length} chars`);
  }
});

test("denies a discovery grep with the exact CE call and no bypass wording", (t) => {
  const { repo, opts } = fixture(t);
  const out = handle(bash(repo, 'rg -n "parseConfig" src'), opts);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  const reason = reasonOf(out);
  assert.ok(reason.includes(`mcp__context-engine__symbol_graph {"symbol":"parseConfig","query_type":"definition","collection":"${COLLECTION}"}`), reason);
  assert.ok(reason.includes(`mcp__context-engine__repo_search {"query":"parseConfig","collection":"${COLLECTION}"}`), reason);
  assert.doesNotMatch(reason, /re-?run|bypass|again|retry|CTXCE_/i);
  const concept = reasonOf(handle(bash(repo, 'rg -i "retry backoff"', "s2"), opts));
  assert.ok(concept.includes(`mcp__context-engine__repo_search {"query":"retry backoff","collection":"${COLLECTION}"}`), concept);
});

test(`throttle: at most ${MAX_DENIES} denies per session, repeats of a denied search run`, (t) => {
  const { repo, opts } = fixture(t);
  assert.ok(handle(bash(repo, "rg parseConfig"), opts));
  assert.equal(handle(bash(repo, "rg parseConfig"), opts), null, "same search after its deny runs");
  assert.ok(handle(bash(repo, 'rg "token refresh"'), opts));
  assert.equal(handle(bash(repo, "rg loadSettings"), opts), null, "third discovery grep runs");
  assert.ok(handle(bash(repo, "rg loadSettings", "other-session"), opts), "state is per session");
  assert.equal(handle({ ...bash(repo, "rg loadSettings"), session_id: undefined }, opts), null, "no session id: never deny");
});

test("no denies once the session has called a CE tool", (t) => {
  const { repo, opts } = fixture(t);
  assert.ok(handle(bash(repo, "rg parseConfig", "s3"), opts));
  const post = { hook_event_name: "PostToolUse", session_id: "s3", cwd: repo, tool_name: "mcp__context-engine__symbol_graph", tool_input: {} };
  assert.equal(handle(post, opts), null);
  assert.equal(handle(bash(repo, 'rg "token refresh"', "s3"), opts), null);
  assert.equal(handle({ ...post, session_id: "s4", tool_name: "mcp__other__search" }, opts), null);
  assert.ok(handle(bash(repo, 'rg "token refresh"', "s4"), opts), "another server's tool does not count");
});

test("silent when CE is not configured, the workspace is not indexed, or hooks are off", (t) => {
  const noServer = fixture(t, { servers: { other: { command: "x" } } });
  assert.equal(handle({ hook_event_name: "SessionStart", cwd: noServer.repo }, noServer.opts), null);
  assert.equal(handle(bash(noServer.repo, "rg parseConfig"), noServer.opts), null);

  const unindexed = fixture(t, { indexed: false });
  assert.equal(handle({ hook_event_name: "SessionStart", cwd: unindexed.repo }, unindexed.opts), null);
  assert.equal(handle(bash(unindexed.repo, "rg parseConfig"), unindexed.opts), null);

  const { repo, opts } = fixture(t);
  assert.equal(handle(bash(repo, "rg parseConfig"), { ...opts, env: { CTXCE_HOOKS: "0" } }), null);
  assert.equal(handle(bash(repo, "rg parseConfig"), { ...opts, env: { CTXCE_REDIRECT: "0" } }), null);
  assert.ok(handle({ hook_event_name: "SessionStart", cwd: repo }, { ...opts, env: { CTXCE_REDIRECT: "0" } }));
  assert.equal(handle(bash(repo, "rg parseConfig /etc"), opts), null, "outside the repo");
  assert.equal(handle(null, opts), null);
});

test("--strict-mcp-config uses only the --mcp-config files", (t) => {
  const { base, repo, opts } = fixture(t);
  const strict = { ...opts, parentArgs: "claude -p hi --strict-mcp-config --mcp-config /nonexistent.json" };
  assert.equal(handle(bash(repo, "rg parseConfig"), strict), null);
  const cfg = path.join(base, "ce-mcp.json");
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { "context-engine": CE_SERVER } }));
  const withCe = { ...opts, home: path.join(base, "empty-home-has-no-claude-json"), parentArgs: `claude -p hi --strict-mcp-config --mcp-config ${cfg} --tools Read` };
  assert.equal(handle(bash(repo, "rg parseConfig"), withCe), null, "workspace mapping lives in the real home");
  assert.ok(handle(bash(repo, "rg parseConfig"), { ...opts, parentArgs: withCe.parentArgs }));
});

test("hook process fails open and answers quickly", (t) => {
  const { home, repo } = fixture(t);
  const env = { ...process.env, HOME: home, TMPDIR: path.join(home, "tmp") };
  fs.mkdirSync(env.TMPDIR);
  const run = (input) => spawnSync(process.execPath, [HOOK], { input, env, encoding: "utf8" });
  for (const junk of ["", "not json", "[]", '{"hook_event_name":"PreToolUse","tool_input":null}']) {
    const r = run(junk);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  }
  const t0 = Date.now();
  const r = run(JSON.stringify(bash(repo, 'grep -rn "UserService" .')));
  const ms = Date.now() - t0;
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.ok(ms < 500, `${ms} ms including node startup`);
});
