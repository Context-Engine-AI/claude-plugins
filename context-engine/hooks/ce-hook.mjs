#!/usr/bin/env node
// Claude Code hook entry for SessionStart, SubagentStart, PreToolUse (Bash|Grep|Glob) and PostToolUse (CE tools).
// Fails open: any error, timeout or unexpected input means no output and exit 0.
import { handle } from "./lib/hook.mjs";

setTimeout(() => process.exit(0), 2000).unref();
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("error", () => process.exit(0));
process.stdin.on("end", () => {
  try {
    const out = handle(JSON.parse(raw));
    if (out) process.stdout.write(JSON.stringify(out));
  } catch {
    // fail open
  }
});
