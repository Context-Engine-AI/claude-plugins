// Decides whether a Bash/Grep/Glob call is a code-discovery search across the indexed repo
// (an identifier or a concept) that one Context Engine call answers. Pure apart from ctx.stat.
// Returns null to allow, or { kind: "symbol" | "term" | "concept", text, pattern }.
import path from "node:path";

// Cheap pre-check so non-search Bash commands exit before any parsing or file access.
export const SEARCH_HINT = /(?:^|[^\w.-])(?:rg|grep|egrep|fgrep|ugrep|ag|ack)(?:$|[^\w.-])/;

const TOOLS = { rg: "rg", grep: "grep", egrep: "grep", fgrep: "grep", ugrep: "ugrep", ag: "ag", ack: "ag", git: "git" };
// Short flags that take a value, per tool (rg -r is --replace; grep -r is recursive).
const SHORT_VALUE = { rg: "efgtTABCmMjdrE", grep: "efABCmdD", ugrep: "efABCmdDgtOM", ag: "ABCmGg", "git-grep": "efABCm" };
const LONG_VALUE = new Set([
  "regexp", "file", "glob", "iglob", "type", "type-not", "type-add", "type-clear", "after-context",
  "before-context", "context", "max-count", "max-columns", "threads", "max-depth", "maxdepth", "replace",
  "encoding", "colors", "sort", "sortr", "max-filesize", "path-separator", "pre", "pre-glob", "ignore-file",
  "include", "exclude", "exclude-dir", "exclude-from", "directories", "devices", "label", "binary-files",
  "group-separator", "ignore", "ignore-dir", "file-search-regex", "depth", "after", "before", "engine",
  "context-separator", "field-match-separator", "field-context-separator", "path-to-ignore",
]);

const NON_CODE_EXT = new Set(("md mdx markdown txt rst adoc asciidoc json jsonc jsonl ndjson yaml yml toml ini cfg " +
  "conf env lock log csv tsv xml svg html htm css scss less properties plist sum pem crt png jpg jpeg gif ico pdf").split(" "));
const CODE_EXT = new Set(("js mjs cjs jsx ts tsx mts cts py pyi rs go java kt kts scala rb php c h cc cpp cxx hpp hh cs " +
  "swift m mm sh bash zsh ps1 lua dart ex exs erl hs ml clj vue svelte sql proto gradle tf").split(" "));
const NON_CODE_TYPES = new Set("md markdown json jsonl yaml toml txt log csv tsv xml html css svg rst asciidoc".split(" "));
// Paths inside the repo that the index skips.
const UNINDEXED_DIRS = new Set(["node_modules", ".git", "vendor", "target", "dist", "build", ".venv", "venv",
  "__pycache__", "site-packages", ".next", "coverage", ".tox", ".mypy_cache", ".pytest_cache"]);

const KEYWORDS = new Set(("fn def class struct enum trait impl interface type func function let const var val pub " +
  "public private protected static async await return import export from use mod module package require include " +
  "extends implements new self this super true false null nil none undefined void int string bool if else elif for " +
  "while loop match case switch try catch except finally raise throw throws yield lambda and or not in is as with " +
  "where unsafe mut ref dyn go defer chan select").split(" "));
const DEF_KEYWORDS = new Set("fn def class struct enum trait interface type func function module mod".split(" "));
const IMPORT_KEYWORDS = new Set(["import", "from", "use", "require", "include", "using"]);
const MARKER = /^(TODO|FIXME|XXX|HACK|NOCOMMIT)\b/i;

// ---------------------------------------------------------------- shell parsing

// Shell-ish tokenizer: quotes, escapes, comments; ops are ";" (for ; && || & newline ( )) and "|".
// Returns null on unbalanced quotes.
export function tokenize(cmd) {
  const out = [];
  let cur = "";
  let has = false;
  let quoted = false;
  const push = () => {
    if (has) out.push({ w: cur, q: quoted });
    cur = "";
    has = false;
    quoted = false;
  };
  for (let i = 0; i < cmd.length; ) {
    const c = cmd[i];
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      if (j < 0) return null;
      cur += cmd.slice(i + 1, j);
      has = quoted = true;
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < cmd.length && cmd[j] !== '"'; j += 1) {
        if (cmd[j] === "\\" && j + 1 < cmd.length && '"\\$`\n'.includes(cmd[j + 1])) {
          j += 1;
          if (cmd[j] !== "\n") cur += cmd[j];
        } else {
          cur += cmd[j];
        }
      }
      if (j >= cmd.length) return null;
      has = quoted = true;
      i = j + 1;
    } else if (c === "\\") {
      if (i + 1 < cmd.length && cmd[i + 1] !== "\n") {
        cur += cmd[i + 1];
        has = true;
      }
      i += 2;
    } else if (c === " " || c === "\t") {
      push();
      i += 1;
    } else if (c === "\n" || c === ";" || c === "(" || c === ")") {
      push();
      out.push({ op: ";" });
      i += 1;
    } else if (c === "|") {
      push();
      if (cmd[i + 1] === "|") {
        out.push({ op: ";" });
        i += 2;
      } else {
        out.push({ op: "|" });
        i += cmd[i + 1] === "&" ? 2 : 1;
      }
    } else if (c === "&" && cmd[i + 1] !== ">" && cmd[i - 1] !== ">") {
      push();
      out.push({ op: ";" });
      i += cmd[i + 1] === "&" ? 2 : 1;
    } else if (c === "#" && !has) {
      const j = cmd.indexOf("\n", i);
      i = j < 0 ? cmd.length : j;
    } else {
      cur += c;
      has = true;
      i += 1;
    }
  }
  push();
  return out;
}

function stripRedirects(words) {
  const out = [];
  for (let i = 0; i < words.length; i += 1) {
    const { w, q } = words[i];
    if (!q && /^(\d*|&)(>>?|<)&?$/.test(w)) i += 1; // "> file": drop the target too
    else if (!q && /^(\d*|&)(>>?|<)/.test(w)) continue; // "2>/dev/null", "2>&1"
    else out.push(words[i]);
  }
  return out;
}

// Parses one simple command; returns null unless it runs rg/grep/ugrep/ag/ack/git grep.
export function parseGrep(words) {
  let i = 0;
  const isAssign = (w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);
  while (i < words.length && isAssign(words[i].w)) i += 1;
  while (i < words.length && ["command", "builtin", "exec", "env", "nice", "noglob"].includes(words[i].w)) {
    i += 1;
    while (i < words.length && isAssign(words[i].w)) i += 1;
  }
  if (i >= words.length) return null;
  const head = path.basename(words[i].w);
  let tool = TOOLS[head];
  i += 1;
  if (!tool) return null;
  let gitC = null;
  if (tool === "git") {
    while (i < words.length && words[i].w.startsWith("-")) {
      const f = words[i].w;
      if (f === "-C") gitC = words[i + 1] ? words[i + 1].w : null;
      i += ["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(f) ? 2 : 1;
    }
    if (!words[i] || words[i].w !== "grep") return null;
    tool = "git-grep";
    i += 1;
  }
  const g = {
    tool, gitC, patterns: [], includes: [], prePaths: [], postPaths: [],
    fixed: head === "fgrep", recursive: tool !== "grep", noPattern: false,
    bre: head === "grep" || tool === "git-grep", // basic regex by default: \| alternates, ( is literal
    count: false, invert: false, filesWithout: false, quiet: false,
  };
  let endOpts = false;
  const positional = [];
  for (; i < words.length; i += 1) {
    const w = words[i].w;
    if (endOpts || !w.startsWith("-") || w === "-") {
      (endOpts ? g.postPaths : positional).push(w);
    } else if (w === "--") {
      endOpts = true;
    } else if (w.startsWith("--")) {
      const eq = w.indexOf("=");
      const name = eq < 0 ? w.slice(2) : w.slice(2, eq);
      let val = eq < 0 ? null : w.slice(eq + 1);
      if (val === null && (LONG_VALUE.has(name) || (name === "color" && tool === "rg"))) {
        i += 1;
        val = words[i] ? words[i].w : "";
      }
      applyLong(g, name, val);
    } else {
      for (let k = 1; k < w.length; k += 1) {
        const c = w[k];
        if (/\d/.test(c)) continue; // -5 (context lines)
        if (SHORT_VALUE[tool].includes(c)) {
          let val = w.slice(k + 1);
          if (!val) {
            i += 1;
            val = words[i] ? words[i].w : "";
          }
          applyShort(g, c, val);
          break;
        }
        applyShort(g, c, null);
      }
    }
  }
  if (!g.patterns.length && !g.noPattern) {
    if (!positional.length) g.noPattern = true;
    else g.patterns.push(positional.shift());
  }
  g.prePaths = positional;
  return g;
}

function applyShort(g, c, val) {
  const rgLike = g.tool === "rg" || g.tool === "ugrep";
  if (c === "e") g.patterns.push(val);
  else if (c === "f") g.noPattern = true; // patterns from a file
  else if (c === "g" && rgLike) g.includes.push(val);
  else if (c === "g" && g.tool === "ag") g.noPattern = true; // ag -g: file-name search
  else if (c === "t" && rgLike) g.includes.push(`type:${val}`);
  else if (c === "O" && g.tool === "ugrep") g.includes.push(`*.${val}`);
  else if (c === "c") g.count = true;
  else if (c === "v") g.invert = true;
  else if (c === "L") g.filesWithout = true;
  else if (c === "q") g.quiet = true;
  else if (c === "F") g.fixed = true;
  else if ((c === "E" || c === "P") && (g.tool === "grep" || g.tool === "git-grep")) g.bre = false;
  else if (c === "G" && (g.tool === "grep" || g.tool === "git-grep")) g.bre = true;
  else if ((c === "r" || c === "R") && g.tool === "grep") g.recursive = true;
  else if (c === "d" && g.tool === "grep" && val === "recurse") g.recursive = true;
}

function applyLong(g, name, val) {
  if (name === "regexp") g.patterns.push(val);
  else if (name === "file" || name === "files" || name === "type-list" || name === "help" || name === "version") g.noPattern = true;
  else if (name === "glob" || name === "iglob" || name === "include") g.includes.push(val);
  else if (name === "type") g.includes.push(`type:${val}`);
  else if (name === "count" || name === "count-matches") g.count = true;
  else if (name === "invert-match") g.invert = true;
  else if (name === "files-without-match") g.filesWithout = true;
  else if (name === "quiet" || name === "silent") g.quiet = true;
  else if (name === "fixed-strings") g.fixed = true;
  else if (name === "extended-regexp" || name === "perl-regexp") g.bre = false;
  else if (name === "basic-regexp") g.bre = true;
  else if (name === "recursive" || name === "dereference-recursive") g.recursive = true;
  else if (name === "directories" && val === "recurse") g.recursive = true;
}

// ---------------------------------------------------------------- scope (paths, file types)

function globExts(glob) {
  const tail = String(glob).split("/").pop();
  const brace = /\.\{([^}]+)\}$/.exec(tail);
  if (brace) return brace[1].split(",").map((e) => e.trim().toLowerCase());
  const m = /\.([A-Za-z0-9]+)$/.exec(tail);
  return m && /[*?]/.test(tail) ? [m[1].toLowerCase()] : [];
}

function isNonCodeInclude(inc) {
  if (inc.startsWith("type:")) return NON_CODE_TYPES.has(inc.slice(5));
  const exts = globExts(inc);
  return exts.length > 0 && exts.every((e) => NON_CODE_EXT.has(e));
}

function onlyNonCode(includes) {
  const real = includes.filter((inc) => inc && !inc.startsWith("!"));
  return real.length > 0 && real.every(isNonCodeInclude);
}

function inIndex(abs, root) {
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return !rel.split(path.sep).some((seg) => UNINDEXED_DIRS.has(seg));
}

// True when some path searches a directory (or glob) of code inside the indexed root.
// Named files only, paths outside the root, unindexed dirs and unresolvable paths are not repo-wide.
export function repoWide(paths, base, ctx) {
  return paths.some((p) => {
    if (/[$`]/.test(p)) return false;
    const expanded = p === "~" ? ctx.home : p.startsWith("~/") ? path.join(ctx.home, p.slice(2)) : p;
    const globAt = expanded.search(/[*?[{]/);
    if (globAt >= 0) {
      if (globExts(expanded).some((e) => NON_CODE_EXT.has(e))) return false;
      return inIndex(path.resolve(base, expanded.slice(0, globAt) || "."), ctx.root);
    }
    const abs = path.resolve(base, expanded);
    const kind = ctx.stat(abs) || (path.extname(abs) ? "file" : "dir");
    return kind === "dir" && inIndex(abs, ctx.root);
  });
}

// ---------------------------------------------------------------- pattern classification

function classifyWord(w) {
  if (w.length < 4 || w.startsWith("-") || /^\d/.test(w) || (/^[0-9a-f]+$/i.test(w) && /\d/.test(w))) return null;
  const parts = w.split(/::|->|\./);
  if (parts.some((p) => !/^[A-Za-z_$][A-Za-z0-9_$]*!?$/.test(p))) {
    return /^[A-Za-z][A-Za-z0-9]*(-[A-Za-z0-9]+)+$/.test(w) ? { kind: "term", text: w } : null; // kebab-case key
  }
  if (parts.length > 1) {
    const last = parts[parts.length - 1].toLowerCase();
    if (w.includes(".") && (NON_CODE_EXT.has(last) || CODE_EXT.has(last))) return null; // a file name
    return { kind: /::|->/.test(w) || /^[A-Z]/.test(parts[0]) ? "symbol" : "term", text: w };
  }
  if (KEYWORDS.has(w.toLowerCase()) || MARKER.test(w)) return null;
  if (/_/.test(w)) return { kind: /^[A-Z0-9_]+$/.test(w) ? "term" : "symbol", text: w };
  if (/[a-z0-9][A-Z]/.test(w) || /^[A-Z][a-z0-9]+$/.test(w)) return { kind: "symbol", text: w };
  return { kind: "term", text: w };
}

// Regex -> the literal words it searches for, or null when it is a real regex (classes, wildcards...).
function regexToText(s) {
  let t = s.replace(/^\^/, "").replace(/\$$/, "").replace(/\\[bB<>]/g, "");
  t = t.replace(/(\\s|\[\[:space:\]\]|\[ \\t\]|[ \t])[+*]?/g, " ");
  t = t.replace(/([A-Za-z0-9_])\.[*+]([A-Za-z_])/g, "$1 $2"); // retry.*backoff -> two words
  t = t.replace(/(\\\(\\\)|\\\()\s*$/, ""); // call site: foo\( or foo\(\)
  t = t.replace(/\\([.:\-/_#@!])/g, "$1").replace(/^\s*\.(?=[A-Za-z_])/, ""); // \.send( -> send
  if (/\\/.test(t) || /[*+?[\](){}|^$]/.test(t)) return null;
  if (/\.(?![A-Za-z_])|(^|[^A-Za-z0-9_])\./.test(t)) return null; // a bare "." wildcard
  return t;
}

function classifyAlt(raw, fixed) {
  let a = raw.trim();
  if (fixed && /\s/.test(a)) return null; // an explicit literal phrase
  a = fixed ? a.replace(/\(\)?$/, "") : regexToText(a);
  if (a === null) return null;
  const words = a.trim().replace(/^\.(?=[A-Za-z_])/, "").split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 8 || words.some((w) => MARKER.test(w))) return null;
  if (words.length === 1) return classifyWord(words[0]);
  if (!words.every((w) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(w))) return null; // a code snippet
  const rest = words.filter((w) => !KEYWORDS.has(w.toLowerCase()));
  if (!rest.length || IMPORT_KEYWORDS.has(words[0])) return null; // structural: "pub fn", "import React"
  if (DEF_KEYWORDS.has(words[0]) && rest.length === 1 && rest[0] === words[words.length - 1]) {
    return classifyWord(rest[0]) ? { kind: "symbol", text: rest[0] } : null; // "def load_settings"
  }
  return { kind: "concept", text: words.join(" ") };
}

// Basic regex (grep, git grep) -> extended: \| ( ) { } + ? swap meaning with their escaped forms.
function breToEre(p) {
  let out = "";
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i];
    if (c === "\\" && i + 1 < p.length) {
      i += 1;
      out += "|(){}+?".includes(p[i]) ? p[i] : `\\${p[i]}`;
    } else {
      out += "|(){}+?".includes(c) ? `\\${c}` : c;
    }
  }
  return out;
}

// Top-level alternatives of an extended regex, with one (a|b) group per alternative expanded:
// "func (Find|Extract)Name\\(|templateManager" -> ["func FindName\\(", "func ExtractName\\(", "templateManager"].
// null when the structure is more than that (nested groups, several groups, too many branches).
function alternatives(p) {
  const saved = [];
  const masked = p.replace(/\\./g, (x) => String.fromCharCode(0xe000 + saved.push(x) - 1));
  const unmask = (t) => t.replace(/[\ue000-\uefff]/g, (c) => saved[c.charCodeAt(0) - 0xe000]);
  const top = [];
  let depth = 0;
  let cur = "";
  for (const c of masked) {
    if (c === "(") depth += 1;
    if (c === ")") depth -= 1;
    if (depth < 0 || depth > 1) return null;
    if (c === "|" && depth === 0) {
      top.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  if (depth !== 0) return null;
  top.push(cur);
  const out = [];
  for (const alt of top) {
    const g = /^([^()]*)\((?:\?:)?([^()]*)\)([^()]*)$/.exec(alt);
    if (g) out.push(...g[2].split("|").map((x) => g[1] + x + g[3]));
    else if (/[()]/.test(alt)) return null;
    else out.push(alt);
  }
  return out.length <= 16 ? out.map(unmask) : null;
}

export function classifyPatterns(patterns, { fixed = false, bre = false } = {}) {
  const alts = [];
  for (const p of patterns) {
    const list = fixed ? [p] : alternatives(bre ? breToEre(p) : p);
    if (!list) return null;
    alts.push(...list);
  }
  const res = alts.map((a) => classifyAlt(a, fixed));
  if (!res.length || res.some((r) => !r)) return null;
  if (res.length === 1) return res[0];
  const texts = [...new Set(res.map((r) => r.text))];
  return res.every((r) => r.kind === "symbol") ? { kind: "symbol", text: texts.join("|") } : { kind: "concept", text: texts.join(" ") };
}

// ---------------------------------------------------------------- tool entry points

function isRev(p, base, ctx) {
  return /HEAD|[~^]|\.\.|@\{|^[0-9a-f]{7,40}$/.test(p) || !ctx.stat(path.resolve(base, p));
}

function judgeGrep(g, base, ctx, history) {
  if (g.noPattern || g.count || g.invert || g.filesWithout || g.quiet) return null;
  const paths = [...g.prePaths, ...g.postPaths];
  if (g.tool === "grep" && !g.recursive && !paths.length) return null; // reads stdin
  if (g.tool === "git-grep" && (history || g.prePaths.some((p) => isRev(p, base, ctx)))) return null;
  if (onlyNonCode(g.includes)) return null;
  if (!repoWide(paths.length ? paths : ["."], base, ctx)) return null;
  const hit = classifyPatterns(g.patterns, g);
  return hit && { ...hit, pattern: g.patterns.join("|") };
}

export function classifyBash(command, ctx) {
  if (typeof command !== "string" || command.length > 4000 || !SEARCH_HINT.test(command)) return null;
  if (/\$\(|`|<</.test(command)) return null; // substitutions and heredocs: not worth guessing
  const toks = tokenize(command);
  if (!toks) return null;
  const history = /\bgit\s+(log|show|diff|blame|rev-list|reflog|stash|bisect|whatchanged)\b/.test(command);
  const cmds = [];
  let stages = [[]];
  for (const t of toks) {
    if (t.op === ";") {
      cmds.push(stages);
      stages = [[]];
    } else if (t.op === "|") {
      stages.push([]);
    } else {
      stages[stages.length - 1].push(t);
    }
  }
  cmds.push(stages);
  let base = ctx.cwd;
  for (const st of cmds) {
    const words = stripRedirects(st[0]);
    if (!words.length) continue;
    if (words[0].w === "cd") {
      const d = words[1] ? words[1].w : "~";
      base = base === null || /[$`]/.test(d) || d === "-" ? null : path.resolve(base, d === "~" ? ctx.home : d.replace(/^~\//, `${ctx.home}/`));
      continue;
    }
    if (base === null) continue;
    // Only the first stage can be a discovery grep: a grep after a pipe filters output, and "| wc" counts.
    if (st.slice(1).some((s) => stripRedirects(s)[0] && stripRedirects(s)[0].w === "wc")) continue;
    const g = parseGrep(words);
    if (!g) continue;
    const hit = judgeGrep(g, g.gitC ? path.resolve(base, g.gitC) : base, ctx, history);
    if (hit) return hit;
  }
  return null;
}

export function classifyGrepTool(input, ctx) {
  const { pattern, glob, type, output_mode: mode, multiline } = input || {};
  if (typeof pattern !== "string" || mode === "count" || multiline) return null;
  if (onlyNonCode([glob, type ? `type:${type}` : ""].filter(Boolean))) return null;
  if (!repoWide([typeof input.path === "string" && input.path ? input.path : "."], ctx.cwd, ctx)) return null;
  const hit = classifyPatterns([pattern]);
  return hit && { ...hit, pattern };
}

// Glob is only a discovery search when it guesses at a name fragment: **/*AuthService*, src/**/*retry*.py
export function classifyGlobTool(input, ctx) {
  const { pattern } = input || {};
  if (typeof pattern !== "string") return null;
  if (!repoWide([typeof input.path === "string" && input.path ? input.path : "."], ctx.cwd, ctx)) return null;
  const m = /^\*+([^*?[\]{}/.]+)\*+(?:\.([A-Za-z0-9]+))?$/.exec(pattern.split("/").pop());
  if (!m || (m[2] && NON_CODE_EXT.has(m[2].toLowerCase()))) return null;
  const hit = classifyWord(m[1]);
  return hit && { kind: "term", text: hit.text, pattern };
}
