// Hook logic: workspace -> CE collection (same files the ctxce bridge and proxy use), CE MCP server
// detection, the per-session deny throttle, and the text Claude sees. Local files only, no network.
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SEARCH_HINT, classifyBash, classifyGlobTool, classifyGrepTool } from "./classify.mjs";

export const MAX_DENIES = 2;
const CE_MARK = /context-engine|ctxce|ctx-mcp-proxy/i;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function realpathOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

export function stat(abs) {
  try {
    const s = fs.statSync(abs);
    return s.isFile() ? "file" : s.isDirectory() ? "dir" : null;
  } catch {
    return null;
  }
}

function findGitRoot(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 64; i += 1) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// Same as computeWorkspaceDir() in ~/.ctxce/bin/ctx-mcp-proxy.js and the bridge's _computeWorkspaceDir().
export function workspaceDirName(workspacePath) {
  const normalized = path.resolve(workspacePath).replace(/\\/g, "/").toLowerCase();
  const hash = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  return `${path.basename(workspacePath).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50)}-${hash}`;
}

function collectionIn(configFile) {
  const cfg = readJson(configFile);
  const c = cfg && typeof cfg.default_collection === "string" ? cfg.default_collection.trim() : "";
  return c || null;
}

// Resolution order of the ctxce proxy (forward hash lookup, then meta.json reverse lookup), then the
// bridge's repo-local ctx_config.json walk-up, then CTXCE_COLLECTION.
// shortcut: skips the proxy's process-tree hints (VS Code PID files); add them if editor-only users miss out.
export function resolveWorkspace(cwd, home, env) {
  const wsRoot = path.join(home, ".ctxce", "workspaces");
  const gitRoot = findGitRoot(cwd);
  const cands = [...new Set([gitRoot, cwd].filter(Boolean).flatMap((p) => [p, realpathOr(p)]))];
  for (const c of cands) {
    const collection = collectionIn(path.join(wsRoot, workspaceDirName(c), "ctx_config.json"));
    if (collection) return { root: c, collection };
  }
  let best = null;
  try {
    for (const entry of fs.readdirSync(wsRoot)) {
      const meta = readJson(path.join(wsRoot, entry, "meta.json"));
      const wp = meta && typeof meta.workspace_path === "string" ? meta.workspace_path.replace(/\\/g, "/") : "";
      if (!wp || (best && wp.length <= best.root.length)) continue;
      if (!cands.some((c) => c === wp || c.startsWith(`${wp}/`))) continue;
      const collection = collectionIn(path.join(wsRoot, entry, "ctx_config.json"));
      if (collection) best = { root: wp, collection };
    }
  } catch {
    // no ~/.ctxce/workspaces
  }
  if (best) return best;
  let dir = path.resolve(cwd);
  for (let i = 0; i < 5; i += 1) {
    const collection = collectionIn(path.join(dir, "ctx_config.json"));
    if (collection) return { root: dir, collection };
    if (path.dirname(dir) === dir) break;
    dir = path.dirname(dir);
  }
  const envCollection = String(env.CTXCE_COLLECTION || "").trim();
  return envCollection ? { root: gitRoot || cwd, collection: envCollection } : null;
}

// Command line of the Claude Code process that ran this hook (to see --mcp-config / --strict-mcp-config).
export function readParentArgs() {
  if (process.platform === "win32") return "";
  try {
    let pid = process.ppid;
    for (let i = 0; i < 3 && pid > 1; i += 1) {
      const out = execFileSync("ps", ["-ww", "-o", "ppid=,args=", "-p", String(pid)], {
        encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const m = /^(\d+)\s+([\s\S]*)$/.exec(out);
      if (!m) return "";
      if (!m[2].includes("ce-hook.mjs")) return m[2]; // skip the sh -c wrapper that started us
      pid = Number(m[1]);
    }
  } catch {
    // no ps
  }
  return "";
}

function mcpConfigArgs(args) {
  const out = [];
  const toks = args.split(/\s+/);
  for (let i = 0; i < toks.length; i += 1) {
    if (toks[i].startsWith("--mcp-config=")) out.push(toks[i].slice(13));
    else if (toks[i] === "--mcp-config") {
      for (i += 1; i < toks.length && !toks[i].startsWith("-"); i += 1) out.push(toks[i]);
      i -= 1;
    }
  }
  return out;
}

function serverEntries(obj) {
  return obj && typeof obj === "object" ? Object.entries(obj) : [];
}

function explicitCollection(cfg) {
  const args = cfg && Array.isArray(cfg.args) ? cfg.args : [];
  const i = args.indexOf("--collection");
  return i >= 0 && typeof args[i + 1] === "string" ? args[i + 1] : null;
}

// The CE indexer server visible to this session, or null. Honors --strict-mcp-config.
// shortcut: ignores project-scope approval and plugin-bundled servers (mcp__plugin_*); none ship CE today.
export function findCeServer(root, cwd, home, env, parentArgs) {
  const args = parentArgs ?? readParentArgs();
  const strict = /(^|\s)--strict-mcp-config(\s|$)/.test(args);
  const found = [];
  for (const value of mcpConfigArgs(args)) {
    const cfg = readJson(path.resolve(cwd, value));
    if (cfg) found.push(...serverEntries(cfg.mcpServers));
    else if (/"context-engine"/.test(value)) found.push(["context-engine", {}]); // inline JSON config
  }
  const disabled = new Set();
  if (!strict) {
    const claudeJson = readJson(path.join(env.CLAUDE_CONFIG_DIR || home, ".claude.json")) || {};
    found.push(...serverEntries(claudeJson.mcpServers));
    for (const p of new Set([root, cwd])) {
      const proj = claudeJson.projects && claudeJson.projects[p];
      if (!proj) continue;
      found.push(...serverEntries(proj.mcpServers));
      for (const n of Array.isArray(proj.disabledMcpServers) ? proj.disabledMcpServers : []) disabled.add(n);
    }
    const projectFile = readJson(path.join(root, ".mcp.json"));
    found.push(...serverEntries(projectFile && projectFile.mcpServers));
  }
  const servers = found.filter(([n]) => !disabled.has(n));
  const hit = servers.find(([n]) => n === "context-engine")
    || servers.find(([n, c]) => !/memory/i.test(n) && !/memory/i.test(JSON.stringify(c)) && (CE_MARK.test(n) || CE_MARK.test(JSON.stringify(c))));
  if (!hit) return null;
  return { name: hit[0], prefix: `mcp__${hit[0].replace(/[^A-Za-z0-9_-]/g, "_")}__`, collection: explicitCollection(hit[1]) };
}

// ---------------------------------------------------------------- throttle state

export function statePath(sessionId, dir) {
  const id = String(sessionId || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128);
  return id ? path.join(dir || path.join(os.tmpdir(), "ctxce-claude-hooks"), `${id}.json`) : null;
}

export function readState(file) {
  const s = readJson(file);
  return {
    denies: s && Number.isInteger(s.denies) ? s.denies : 0,
    denied: s && Array.isArray(s.denied) ? s.denied.filter((k) => typeof k === "string") : [],
    ce: Boolean(s && s.ce),
  };
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- text Claude sees

export function sessionContext(collection, server) {
  const p = server.prefix;
  return `Context Engine has this workspace indexed as collection ${collection}. ` +
    `${p}repo_search {"query": "..."} returns the matching code as verified source with exact line ranges and callers in one call. ` +
    `${p}symbol_graph {"symbol": "X", "query_type": "definition"} returns where X is defined; "callers", "callees" and "importers" walk the graph. ` +
    `A grep returns matching lines only and usually needs several Reads after it. ` +
    "Grep fits an exact string in a known file, counts, and files outside the index.";
}

export function denyReason(hit, collection, server) {
  const p = server.prefix;
  const head = `Not run. Context Engine has this workspace indexed (collection ${collection}). `;
  const repoSearch = `${p}repo_search ${JSON.stringify({ query: hit.text, collection })}`;
  if (hit.kind === "symbol") {
    const symbolGraph = `${p}symbol_graph ${JSON.stringify({ symbol: hit.text, query_type: "definition", collection })}`;
    return `${head}${symbolGraph} returns where ${hit.text} is defined with exact lines in one call ` +
      `(query_type "callers" lists its callers); ${repoSearch} returns the code that uses it as verified source.`;
  }
  return `${head}${repoSearch} returns the matching code as verified source with exact line ranges and callers ` +
    "in one call; a grep returns matching lines only and usually needs several Reads after it.";
}

// ---------------------------------------------------------------- entry

// Returns the hook's JSON output, or null for no output. Never throws on bad input.
export function handle(input, opts = {}) {
  const env = opts.env || process.env;
  if (!input || typeof input !== "object" || env.CTXCE_HOOKS === "0") return null;
  const event = input.hook_event_name;
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const home = opts.home || os.homedir();
  const findServer = (root) => findCeServer(root, cwd, home, env, opts.parentArgs);
  // The workspace mapping, else a collection pinned with --collection on the CE server entry.
  const workspace = () => {
    const ws = resolveWorkspace(cwd, home, env);
    if (ws) return { ws, server: null };
    const root = findGitRoot(cwd) || cwd;
    const server = findServer(root);
    return server && server.collection ? { ws: { root, collection: server.collection }, server } : null;
  };

  if (event === "SessionStart" || event === "SubagentStart") {
    const w = workspace();
    const server = w && (w.server || findServer(w.ws.root));
    return server && { hookSpecificOutput: { hookEventName: event, additionalContext: sessionContext(w.ws.collection, server) } };
  }
  if (env.CTXCE_REDIRECT === "0") return null;
  const tool = input.tool_name;
  // After the session has used CE, its greps are deliberate (verification, exhaustive lists): stop denying.
  // shortcut: matches the standard "context-engine" server name only, like the hooks.json matcher.
  if (event === "PostToolUse" && typeof tool === "string" && tool.startsWith("mcp__context-engine__")) {
    const file = statePath(input.session_id, opts.stateDir);
    const state = file && readState(file);
    if (state && !state.ce) writeState(file, { ...state, ce: true });
    return null;
  }
  if (event !== "PreToolUse") return null;
  const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  if (tool === "Bash" ? !SEARCH_HINT.test(String(toolInput.command || "")) : tool !== "Grep" && tool !== "Glob") return null;
  const file = statePath(input.session_id, opts.stateDir);
  if (!file) return null;
  const state = readState(file);
  if (state.ce || state.denies >= MAX_DENIES) return null;
  const w = workspace();
  if (!w) return null;
  const ctx = { cwd, root: w.ws.root, home, stat: opts.stat || stat };
  const hit = tool === "Bash" ? classifyBash(toolInput.command, ctx)
    : tool === "Grep" ? classifyGrepTool(toolInput, ctx) : classifyGlobTool(toolInput, ctx);
  if (!hit) return null;
  const key = `${tool}:${hit.pattern}`;
  if (state.denied.includes(key)) return null; // the same search again after a deny: let it run
  const server = w.server || findServer(w.ws.root);
  if (!server) return null;
  writeState(file, { ...state, denies: state.denies + 1, denied: [...state.denied, key] });
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: denyReason(hit, w.ws.collection, server),
    },
  };
}
