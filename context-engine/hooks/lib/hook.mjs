// Hook logic: workspace -> CE collection (same files the ctxce bridge and proxy use), CE MCP server
// detection, the per-session deny throttle, and the text Claude sees. Local files only, no network.
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SEARCH_HINT, classifyBash, classifyGlobTool, classifyGrepTool } from "./classify.mjs";

export const MAX_DENIES = 2;
// What a ctxce-launched CE server runs: the proxy, the bridge package or binary, or the SaaS URL.
const CE_COMMAND = /ctx-mcp-proxy|context-engine-mcp-bridge|context-engine\.ai|(^|[\s/\\])ctxce(\.js|\.cmd)?(\s|$)/i;
// Collection names are inserted into text Claude reads; anything else (e.g. from a cloned repo's ctx_config.json) is ignored.
const COLLECTION = /^[A-Za-z0-9_.-]{1,128}$/;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

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
  return COLLECTION.test(c) ? c : null;
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
  return COLLECTION.test(envCollection) ? { root: gitRoot || cwd, collection: envCollection } : null;
}

// Command line of the Claude Code process that ran this hook (to see --mcp-config / --strict-mcp-config).
export function readParentArgs() {
  if (process.platform === "win32") return "";
  try {
    let pid = process.ppid;
    for (let i = 0; i < 3 && pid > 1; i += 1) {
      const out = execFileSync("ps", ["-ww", "-o", "ppid=,args=", "-p", String(pid)], {
        encoding: "utf8", timeout: 500, stdio: ["ignore", "pipe", "ignore"],
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
  return i >= 0 && COLLECTION.test(String(args[i + 1])) ? args[i + 1] : null;
}

function looksLikeCe(name, cfg) {
  if (/memory/i.test(name)) return false;
  const parts = cfg && typeof cfg === "object" ? [cfg.command, cfg.url, ...(Array.isArray(cfg.args) ? cfg.args : [])] : [];
  const text = parts.filter((x) => typeof x === "string").join(" ");
  return CE_COMMAND.test(text) && !/memory\/mcp/i.test(text);
}

function listOf(obj, key) {
  return obj && Array.isArray(obj[key]) ? obj[key].filter((x) => typeof x === "string") : [];
}

// The CE indexer server visible to this session, or null. Honors --strict-mcp-config, disabled servers,
// and project (.mcp.json) server approval.
// shortcut: ignores managed settings and plugin-bundled servers (mcp__plugin_*); none ship CE today.
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
    const configDir = env.CLAUDE_CONFIG_DIR || null;
    const claudeJson = readJson(path.join(configDir || home, ".claude.json")) || {};
    found.push(...serverEntries(claudeJson.mcpServers));
    const approvals = [
      readJson(path.join(configDir || path.join(home, ".claude"), "settings.json")),
      readJson(path.join(root, ".claude", "settings.json")),
      readJson(path.join(root, ".claude", "settings.local.json")),
    ];
    for (const p of new Set([root, cwd])) {
      const proj = claudeJson.projects && claudeJson.projects[p];
      if (!proj) continue;
      found.push(...serverEntries(proj.mcpServers));
      for (const n of listOf(proj, "disabledMcpServers")) disabled.add(n);
      approvals.push(proj);
    }
    const all = approvals.some((a) => a && a.enableAllProjectMcpServers === true);
    const enabled = new Set(approvals.flatMap((a) => listOf(a, "enabledMcpjsonServers")));
    const rejected = new Set(approvals.flatMap((a) => listOf(a, "disabledMcpjsonServers")));
    const projectFile = readJson(path.join(root, ".mcp.json"));
    found.push(...serverEntries(projectFile && projectFile.mcpServers).filter(([n]) => (all || enabled.has(n)) && !rejected.has(n)));
  }
  const servers = found.filter(([n]) => !disabled.has(n));
  const hit = servers.find(([n]) => n === "context-engine") || servers.find(([n, c]) => looksLikeCe(n, c));
  if (!hit) return null;
  return { name: hit[0], prefix: `mcp__${hit[0].replace(/[^A-Za-z0-9_-]/g, "_")}__`, collection: explicitCollection(hit[1]), config: hit[1] };
}

// ---------------------------------------------------------------- throttle state

// Per session: <id>.done once CE was called or a file edited, and <id>.deny<N> per deny (holding its key).
// Every file is created with O_EXCL, so parallel hook processes cannot exceed MAX_DENIES or follow a
// planted symlink, and the directory must belong to this user.
export function sessionKey(sessionId) {
  return String(sessionId || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128) || null;
}

// The state directory, created only when `create` is set; null when it doesn't exist yet.
export function stateDir(dir, create) {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const d = dir || path.join(os.tmpdir(), `ctxce-claude-hooks-${uid ?? "user"}`);
  if (create) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  else if (!fs.existsSync(d)) return null;
  const st = fs.lstatSync(d);
  if (!st.isDirectory() || (uid !== null && st.uid !== uid)) throw new Error(`${d} is not this user's directory`);
  return d;
}

function create(file, content) {
  try {
    fs.writeFileSync(file, content, { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export function readState(dir, id) {
  if (!dir) return { denied: [], done: false };
  const denied = [];
  for (let i = 0; i < MAX_DENIES; i += 1) {
    try {
      denied.push(fs.readFileSync(path.join(dir, `${id}.deny${i}`), "utf8"));
    } catch {
      // free slot
    }
  }
  return { denied, done: fs.existsSync(path.join(dir, `${id}.done`)) };
}

function claimDeny(dir, id, key) {
  for (let i = 0; i < MAX_DENIES; i += 1) if (create(path.join(dir, `${id}.deny${i}`), key)) return true;
  return false;
}

// ---------------------------------------------------------------- text Claude sees

export function sessionContext(collection, server) {
  const p = server.prefix;
  return `This workspace is indexed by Context Engine (collection ${collection}): for any question about the codebase, call ${p}repo_search FIRST, before ls/find/Grep/Read, and again whenever you move to a new area; for how/why questions that span several files use ${p}context_answer. Results are verified source with exact line ranges: treat them as already read. Use Grep only to confirm an exact literal in a file you already know, or to count.`;
}

export function denyReason(hit, collection, server) {
  const p = server.prefix;
  const head = `Not run. This workspace is indexed (collection ${collection}). `;
  const repoSearch = `${p}repo_search ${JSON.stringify({ query: hit.text, collection })}`;
  if (hit.kind === "symbol") {
    const symbolGraph = `${p}symbol_graph ${JSON.stringify({ symbol: hit.text, query_type: "definition", collection })}`;
    return `${head}${symbolGraph} returns where ${hit.text} is defined with exact lines in one call (query_type "callers" lists its callers); ${repoSearch} returns the code as verified source with exact line ranges: treat it as already read. Use Grep only to confirm an exact literal in a file you already know.`;
  }
  return `${head}${repoSearch} returns the matching code as verified source with exact line ranges: treat it as already read. Use Grep only to confirm an exact literal in a file you already know, or to count.`;
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
  const id = sessionKey(input.session_id);
  // Once the session has called CE, its greps are deliberate (verification, exhaustive lists); once it
  // edits files, greps check the edit and the index may lag behind it. Either way: stop denying.
  // shortcut: matches the standard "context-engine" server name only, like the hooks.json matcher.
  if (event === "PostToolUse") {
    const ce = typeof tool === "string" && tool.startsWith("mcp__context-engine__");
    if (!id || (!ce && !EDIT_TOOLS.has(tool))) return null;
    // shortcut: an edit is recorded only where state already exists, so non-CE users get no files;
    // the first CE session on a machine can still see one deny after an edit.
    const dir = stateDir(opts.stateDir, ce);
    if (dir) create(path.join(dir, `${id}.done`), "1");
    return null;
  }
  if (event !== "PreToolUse") return null;
  const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  if (tool === "Bash" ? !SEARCH_HINT.test(String(toolInput.command || "")) : tool !== "Grep" && tool !== "Glob") return null;
  if (!id) return null;
  const state = readState(stateDir(opts.stateDir, false), id);
  if (state.done || state.denied.length >= MAX_DENIES) return null;
  const w = workspace();
  if (!w) return null;
  const ctx = { cwd, root: w.ws.root, home, stat: opts.stat || stat };
  const hit = tool === "Bash" ? classifyBash(toolInput.command, ctx)
    : tool === "Grep" ? classifyGrepTool(toolInput, ctx) : classifyGlobTool(toolInput, ctx);
  if (!hit) return null;
  const key = `${tool}:${hit.pattern}`;
  if (state.denied.includes(key)) return null; // the same search again after a deny: let it run
  const server = w.server || findServer(w.ws.root);
  if (!server || !claimDeny(stateDir(opts.stateDir, true), id, key)) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: denyReason(hit, w.ws.collection, server),
    },
  };
}
