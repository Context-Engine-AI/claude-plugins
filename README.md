# Context Engine plugins for Claude Code

A Claude Code plugin marketplace with one plugin, `context-engine`. It gets Claude Code, and the
subagents it starts, to use Context Engine's indexed code search instead of grepping the repo.

## Install

```sh
claude plugin marketplace add Context-Engine-AI/claude-plugins
claude plugin install context-engine@context-engine-ai --scope user
```

Or run `ctxce setup claude` from the Context Engine CLI (`ctxce setup claude --uninstall` removes it).

The plugin does not add an MCP server. It works with the `context-engine` MCP server that `ctxce` or
the Context Engine extension already configured, so tool names stay `mcp__context-engine__*`.

## What it does

The hooks act only when both of these are true. Otherwise they print nothing and change nothing.

- The workspace maps to a Context Engine collection. The plugin reads the mappings `ctxce` keeps under
  `~/.ctxce/workspaces/`, a `ctx_config.json` in the repo, or `CTXCE_COLLECTION`.
- A Context Engine MCP server is configured for the session: `~/.claude.json` (user or local scope),
  the repo's `.mcp.json` once approved, or `--mcp-config` (with `--strict-mcp-config` respected).

**SessionStart and SubagentStart.** Adds a short factual note (under 600 characters): the collection,
and when `repo_search`, `symbol_graph` or grep fits. SubagentStart matters because Explore and Plan
don't read CLAUDE.md.

**PreToolUse on Bash, Grep and Glob.** It looks at each search locally, with no network calls, in a few
milliseconds. A grep for an identifier or a concept across the indexed repo is denied, and the reason
gives the exact Context Engine call to make instead:

```
Not run. Context Engine has this workspace indexed (collection admin_demo-1a2b3c4d).
mcp__context-engine__symbol_graph {"symbol":"parseConfig","query_type":"definition","collection":"admin_demo-1a2b3c4d"}
returns where parseConfig is defined with exact lines in one call (query_type "callers" lists its callers);
mcp__context-engine__repo_search {"query":"parseConfig","collection":"admin_demo-1a2b3c4d"} returns the code
that uses it as verified source.
```

- At most 2 denies per session, and none once the session has called a Context Engine tool or edited
  a file (a PostToolUse hook records that). A search that was already denied runs if Claude tries it again.
- Never denied:
  - searches scoped to named files, or to paths outside the repo or in `node_modules`, `vendor`,
    `target`, `dist` and similar;
  - counts (`-c`, `| wc`), greps that filter piped input, and greps whose matches feed `xargs`, `sed`,
    `while read` and similar (renames, batch edits);
  - `-v`, `-L`, `-q`, `--no-ignore`, `--hidden`, and non-code file types (`--include=*.md`, `-t json`);
  - patterns that are real regexes, under 4 characters, numbers, URLs, paths, file names, TODO/FIXME
    markers, keywords only, or `-F` literal phrases;
  - `git grep` against a revision or next to `git log`/`show`/`diff`, and anything with `$(...)` or a heredoc;
  - a Glob, unless it guesses at a multi-part name such as `**/*AuthService*`.
- Any error, timeout or unreadable input means the tool call goes ahead unchanged.

State is a few small marker files per session in `$TMPDIR/ctxce-claude-hooks-<uid>/`.

## Switches

- `CTXCE_HOOKS=0`: turn every hook off.
- `CTXCE_REDIRECT=0`: keep the session notes, never deny.

## Develop

Node 18 or later, no dependencies.

```sh
node --test
claude --plugin-dir ./context-engine    # load the working copy without installing
claude plugin validate .
```
