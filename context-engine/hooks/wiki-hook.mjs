#!/usr/bin/env node
// Session wiki hook: UserPromptSubmit (retrieve), Stop (save), SessionEnd (flush).
// Gated by CTXCE_SESSION_WIKI=1. Fails open: any error -> no output, exit 0.
import { handleRetrieve, handleStop, handleSessionEnd } from "./lib/wiki.mjs";

setTimeout(() => process.exit(0), 8000).unref();
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("error", () => process.exit(0));
process.stdin.on("end", async () => {
  try {
    const input = JSON.parse(raw);
    const event = input.hook_event_name;
    if (event === "UserPromptSubmit") {
      const ctx = await handleRetrieve(input);
      if (ctx) process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ctx },
      }));
    } else if (event === "Stop") {
      handleStop(input);
    } else if (event === "SessionEnd") {
      await handleSessionEnd(input);
    }
  } catch {
    // fail open
  }
});
