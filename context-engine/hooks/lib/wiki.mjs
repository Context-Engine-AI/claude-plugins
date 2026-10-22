// Session wiki: citation-anchored episode memory across sessions.
// Writer (Stop+SessionEnd) stores verified path:line citations from the final answer.
// Retriever (UserPromptSubmit) injects prior-session anchors on the first prompt.
// Opt-in: CTXCE_SESSION_WIKI=1. All errors fail open (no output, exit 0).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWorkspace, findCeServer, sessionKey, readParentArgs } from "./hook.mjs";

// ---------------------------------------------------------------- citation extraction

// path:line or path:line-line (also L-prefixed, en/em dash); path must have a code-ish extension.
const EXT = "js|mjs|cjs|jsx|ts|tsx|mts|cts|py|pyi|rs|go|java|kt|kts|scala|rb|php|c|h|cc|cpp|cxx|hpp|hh" +
  "|cs|swift|m|mm|sh|bash|zsh|lua|dart|ex|exs|erl|hs|ml|clj|vue|svelte|sql|proto|gradle|tf" +
  "|toml|yaml|yml|json|md|mdx|cfg|conf|ini";
const CITE_RE = new RegExp(
  "(?<![\\w/])" +
  "([\\w.@+\\-]+(?:/[\\w.@+\\-]+)*\\.(?:" + EXT + "))" +
  ":L?(\\d{1,6})(?:\\s?[-–—]\\s?L?(\\d{1,6}))?",
  "g",
);

// Enclosing symbol: walk backwards from the cited line for a def/class/fn/struct declaration.
const SYM_RE = /^[ \t]*(?:(?:pub(?:\(crate\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:fn|def|class|struct|enum|trait|impl|interface|type|func|function|module|mod)\s+(\w+)|(?:export\s+)?(?:default\s+)?(?:const|let|var|function\*?|class|interface|type|enum)\s+(\w+))/;

export function extractCitations(text) {
  if (typeof text !== "string") return [];
  const seen = new Map();
  const out = [];
  let m;
  CITE_RE.lastIndex = 0;
  while ((m = CITE_RE.exec(text)) !== null) {
    const p = m[1];
    const start = parseInt(m[2], 10);
    const end = m[3] ? parseInt(m[3], 10) : start;
    const key = `${p}:${start}`;
    if (!seen.has(key)) {
      seen.set(key, true);
      out.push({ path: p, start, end });
    }
  }
  return out;
}

export function verifyCitations(citations, root) {
  const out = [];
  for (const c of citations) {
    const abs = path.isAbsolute(c.path) ? c.path : path.resolve(root, c.path);
    let lines;
    try { lines = fs.readFileSync(abs, "utf8").split("\n"); } catch { continue; }
    if (c.start < 1 || c.start > lines.length) continue;
    const symbol = findSymbol(lines, c.start);
    out.push({ path: c.path, start: c.start, end: Math.min(c.end, lines.length), symbol });
    if (out.length >= 20) break;
  }
  return out;
}

function findSymbol(lines, line) {
  for (let i = Math.min(line - 1, lines.length - 1); i >= Math.max(0, line - 60); i--) {
    const m = SYM_RE.exec(lines[i]);
    if (m) return m[1] || m[2];
  }
  return null;
}

export function formatAnchors(verified) {
  return verified.map((c) => {
    let s = `${c.path}:${c.start}`;
    if (c.end !== c.start) s += `-${c.end}`;
    if (c.symbol) s += ` (${c.symbol})`;
    return s;
  });
}

// ---------------------------------------------------------------- CE memory HTTP

function ceBaseUrl(config) {
  if (!config || typeof config !== "object") return null;
  const parts = [...(Array.isArray(config.args) ? config.args : []), config.url]
    .filter((a) => typeof a === "string");
  // Prefer a URL with /indexer/mcp or /memory/mcp (exact match).
  for (const a of parts) {
    const m = /^(https?:\/\/[^/\s]+)\/(?:indexer|memory)\/mcp/.exec(a);
    if (m) return m[1];
  }
  // Broader: any https URL in the server config.
  for (const a of parts) {
    const m = /^(https?:\/\/[^/\s]+)/.exec(a);
    if (m) return m[1];
  }
  return null;
}

function memoryUrl(env, config) {
  if (env.CTXCE_MEMORY_URL) return env.CTXCE_MEMORY_URL;
  const base = ceBaseUrl(config);
  // shortcut: no URL discovered from MCP config -> skip wiki; self-hosted users set CTXCE_MEMORY_URL.
  return base ? `${base}/memory/mcp` : null;
}

function bearer(url) {
  try {
    const u = new URL(url);
    const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".ctxce", "auth.json"), "utf8"));
    const e = auth[`${u.protocol}//${u.host}`] || {};
    return e.sessionId || e.session_id || "";
  } catch { return ""; }
}

async function mcpCall(url, method, args, timeoutMs) {
  const token = bearer(url);
  if (!token) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST", signal: ctl.signal,
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: method, arguments: args } }),
    });
    const body = await res.json();
    return (body.result || {}).structuredContent || {};
  } catch { return null; } finally { clearTimeout(timer); }
}

// ---------------------------------------------------------------- state files

function wikiDir(base, create) {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const d = base || path.join(os.tmpdir(), `ctxce-claude-hooks-${uid ?? "user"}`);
  if (create) try { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); } catch { /* exists */ }
  return d;
}

function fileFor(dir, sid, suffix) {
  const k = sessionKey(sid);
  return k ? path.join(dir, `${k}.${suffix}`) : null;
}

// ---------------------------------------------------------------- resolve helpers

function resolveCtx(input, opts) {
  const env = opts.env || process.env;
  if (env.CTXCE_SESSION_WIKI !== "1") return null;
  const cwd = input.cwd || process.cwd();
  const home = opts.home || os.homedir();
  const ws = resolveWorkspace(cwd, home, env);
  if (!ws) return null;
  const server = findCeServer(ws.root, cwd, home, env, opts.parentArgs);
  if (!server) return null;
  const url = memoryUrl(env, server.config);
  if (!url) return null;
  return { ws, url, env };
}

function messageText(msg) {
  if (typeof msg === "string") return msg;
  if (msg && typeof msg === "object") {
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content))
      return msg.content.filter((b) => b.type === "text").map((b) => b.text || "").join("\n");
  }
  return "";
}

// ---------------------------------------------------------------- handlers

/** UserPromptSubmit: save prompt to state + retrieve wiki entries for first prompt. */
export async function handleRetrieve(input, opts = {}) {
  const ctx = resolveCtx(input, opts);
  if (!ctx) return null;

  const dir = wikiDir(opts.stateDir, true);
  const pf = fileFor(dir, input.session_id, "wiki-prompt");
  if (!pf) return null;

  const prompt = String(input.prompt || "").trim().slice(0, 2000);
  let first = false;
  try { fs.writeFileSync(pf, prompt, { flag: "wx", mode: 0o600 }); first = true; } catch { /* not first */ }
  if (!first || prompt.length < 10) return null;

  const sc = await mcpCall(ctx.url, "memory_find", {
    query: prompt, collection: ctx.ws.collection, limit: 10,
  }, 1500);
  if (!sc || !Array.isArray(sc.results)) return null;

  const wikis = sc.results.filter((r) => r.metadata && r.metadata.kind === "wiki").slice(0, 3);
  if (!wikis.length) return null;

  const seen = new Set();
  const lines = [];
  for (const w of wikis) {
    for (const a of w.metadata.anchors || []) {
      let s = `${a.path}:${a.start}`;
      if (a.end && a.end !== a.start) s += `-${a.end}`;
      if (a.symbol) s += ` (${a.symbol})`;
      if (!seen.has(s)) { seen.add(s); lines.push(s); }
    }
  }
  if (!lines.length) return null;

  let text = "Earlier sessions on this codebase cited:";
  for (const l of lines) {
    const next = `\n- ${l}`;
    if (text.length + next.length > 1400) break;
    text += next;
  }
  text += "\nVerify before relying on them.";
  return text;
}

/** Stop: extract verified citations from last_assistant_message, save to state. */
export function handleStop(input, opts = {}) {
  const env = (opts.env || process.env);
  if (env.CTXCE_SESSION_WIKI !== "1") return;

  const cwd = input.cwd || process.cwd();
  const home = opts.home || os.homedir();
  const ws = resolveWorkspace(cwd, home, env);
  if (!ws) return;

  const text = messageText(input.last_assistant_message);
  if (!text) return;

  const citations = extractCitations(text);
  const verified = verifyCitations(citations, ws.root);
  if (!verified.length) return;

  const dir = wikiDir(opts.stateDir, true);
  const sf = fileFor(dir, input.session_id, "wiki-state");
  if (!sf) return;
  try { fs.writeFileSync(sf, JSON.stringify(verified), { mode: 0o600 }); } catch { /* ignore */ }
}

/** SessionEnd: flush saved state to CE memory_store. */
export async function handleSessionEnd(input, opts = {}) {
  const ctx = resolveCtx(input, opts);
  if (!ctx) return;

  const dir = wikiDir(opts.stateDir, false);
  const sf = fileFor(dir, input.session_id, "wiki-state");
  const pf = fileFor(dir, input.session_id, "wiki-prompt");
  let verified, prompt;
  try {
    verified = JSON.parse(fs.readFileSync(sf, "utf8"));
    prompt = fs.readFileSync(pf, "utf8");
  } catch { return; }
  if (!Array.isArray(verified) || !verified.length || !prompt) return;

  // Clean up state files before the network call (best effort).
  try { fs.unlinkSync(sf); } catch { /* ignore */ }
  try { fs.unlinkSync(pf); } catch { /* ignore */ }

  const anchorLines = formatAnchors(verified);
  const information = `Session task: ${prompt.slice(0, 500)}\nVerified code locations:\n${anchorLines.map((l) => `- ${l}`).join("\n")}`;

  await mcpCall(ctx.url, "memory_store", {
    information,
    collection: ctx.ws.collection,
    metadata: {
      kind: "wiki",
      created_at: new Date().toISOString(),
      workspace: ctx.ws.collection,
      prompt: prompt.slice(0, 2000),
      anchors: verified.map((c) => ({ path: c.path, start: c.start, end: c.end, symbol: c.symbol || undefined })),
    },
  }, 5000);
}
