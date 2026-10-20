import test from "node:test";
import assert from "node:assert/strict";
import { classifyBash, classifyGlobTool, classifyGrepTool } from "../context-engine/hooks/lib/classify.mjs";

const FILES = new Set(["/repo/src/config.ts", "/repo/package.json", "/repo/README.md", "/repo/app.log", "/repo/src/app.ts"]);
const DIRS = new Set(["/repo", "/repo/src", "/repo/lib", "/repo/logs", "/repo/node_modules", "/home/u/.cargo/registry", "/tmp/elsewhere"]);
const ctx = {
  cwd: "/repo",
  root: "/repo",
  home: "/home/u",
  stat: (p) => (FILES.has(p) ? "file" : DIRS.has(p) ? "dir" : null),
};

// [command, expected]: "allow", or [kind, text] for a deny.
const BASH = [
  // discovery searches across the repo -> deny
  ["rg parseConfig", ["symbol", "parseConfig"]],
  ['rg -n "parseConfig" src/', ["symbol", "parseConfig"]],
  ['grep -rn "UserService" --include="*.ts" .', ["symbol", "UserService"]],
  ['grep -rn "def load_settings" .', ["symbol", "load_settings"]],
  ['rg "fn\\s+parse_config"', ["symbol", "parse_config"]],
  ['rg -i "retry backoff"', ["concept", "retry backoff"]],
  ['rg "rate limit.*middleware" src', ["concept", "rate limit middleware"]],
  ['cd src && rg -l "HttpClient"', ["symbol", "HttpClient"]],
  ['rg -n "handleRequest|handleResponse" src', ["symbol", "handleRequest|handleResponse"]],
  ['git grep -n "load_config"', ["symbol", "load_config"]],
  ['rg "Session::new"', ["symbol", "Session::new"]],
  ['grep -rn "MAX_RETRIES" .', ["term", "MAX_RETRIES"]],
  ['rg "useEffect" --type ts', ["symbol", "useEffect"]],
  ['grep -R "authenticate" src/ lib/', ["term", "authenticate"]],
  ["rg -n 'impl Display for'", ["concept", "impl Display for"]],
  ['grep -rnw "socket_timeout" /repo', ["symbol", "socket_timeout"]],
  ['rg -n "parseConfig\\(" | head -20', ["symbol", "parseConfig"]],
  ["rg -e parseConfig -e loadConfig src", ["symbol", "parseConfig|loadConfig"]],
  ['rg -tpy -C2 "class UserRepository" 2>/dev/null', ["symbol", "UserRepository"]],
  ['grep -rn "\\.send(" src', ["term", "send"]],
  ['rg -n "self.config" -g "!*.md"', ["term", "self.config"]],
  ['rg "token refresh" src/**/*.ts', ["concept", "token refresh"]],
  ['grep -rn "parseConfig\\|loadConfig" src', ["symbol", "parseConfig|loadConfig"]],
  ['rg "func (Find|Extract)Name\\("', ["symbol", "FindName|ExtractName"]],
  ['grep -rnE "load_(config|settings)" .', ["symbol", "load_config|load_settings"]],
  ["pushd src && rg HttpClient", ["symbol", "HttpClient"]],
  ["ugrep -N skipme -r parseConfig src", ["symbol", "parseConfig"]],
  // everything else -> allow
  ['rg -c "parseConfig" src/', "allow"],
  ["rg parseConfig | wc -l", "allow"],
  ['grep -n "parseConfig" src/config.ts', "allow"],
  ['cat src/app.ts | grep "useState"', "allow"],
  ["ps aux | grep node", "allow"],
  ['rg "TODO"', "allow"],
  ['rg "FIXME: remove"', "allow"],
  ['rg "foo"', "allow"],
  ['grep -rn "version" package.json', "allow"],
  ['rg -n "parseConfig" --glob "*.md"', "allow"],
  ['grep -rn "parseConfig" ~/.cargo/registry', "allow"],
  ['rg "parseConfig" node_modules/', "allow"],
  ['git grep "parseConfig" HEAD~5', "allow"],
  ["git log -S parseConfig --oneline", "allow"],
  ['rg "https://api.example.com"', "allow"],
  ['rg -F "connection refused by peer"', "allow"],
  ['rg "^\\s*import .* from"', "allow"],
  ['rg "\\d{3}-\\d{4}"', "allow"],
  ["rg --files | rg config", "allow"],
  ['rg -v "debug" logs/', "allow"],
  ["npm test", "allow"],
  ['rg "pub fn"', "allow"],
  ['rg -l "src/components/Button"', "allow"],
  ['rg "8080"', "allow"],
  ['rg -q "parseConfig" src && echo yes', "allow"],
  ['grep -rn "parseConfig" $HOME/other', "allow"],
  ['find . -name "*.py" | xargs grep -l "parseConfig"', "allow"],
  ['rg "parseConfig" /tmp/elsewhere', "allow"],
  ['rg -n "class .*Handler" -t py', "allow"],
  ['grep -c "error" app.log', "allow"],
  ['rg "import React"', "allow"],
  ['grep "parseConfig"', "allow"],
  ['rg -n "parseConfig" $(git ls-files)', "allow"],
  ['git grep -n "parseConfig" -- "*.md"', "allow"],
  ['echo "use rg parseConfig to search"', "allow"],
  ['grep -rn "foo(bar)" src', "allow"],
  ['rg "(load|save(Config|State))"', "allow"],
  // review findings: renames and batch edits, named files via braces, ignored files, git exclusions
  ["rg -l oldName | xargs sed -i '' 's/oldName/newName/g'", "allow"],
  ["grep -rl parseConfig src | while read f; do echo $f; done", "allow"],
  ["rg parseConfig src/{config,app}.ts", "allow"],
  ["rg --no-ignore parseConfig", "allow"],
  ["rg -uu parseConfig", "allow"],
  ["git grep \"rate limit\" -- '*.md' ':!node_modules'", "allow"],
];

for (const [cmd, want] of BASH) {
  test(`Bash: ${cmd}`, () => {
    const got = classifyBash(cmd, ctx);
    if (want === "allow") assert.equal(got, null);
    else assert.deepEqual(got && [got.kind, got.text], want);
  });
}

test("Grep tool", () => {
  assert.equal(classifyGrepTool({ pattern: "createServer", path: "/repo/src" }, ctx).text, "createServer");
  assert.equal(classifyGrepTool({ pattern: "createServer", output_mode: "count" }, ctx), null);
  assert.equal(classifyGrepTool({ pattern: "createServer", path: "/repo/src/app.ts" }, ctx), null);
  assert.equal(classifyGrepTool({ pattern: "createServer", glob: "*.md" }, ctx), null);
  assert.equal(classifyGrepTool({ pattern: "createServer", path: "/tmp/elsewhere" }, ctx), null);
  // first searches Sonnet 5.5 actually ran in the local A/B (keras, cli/cli)
  const keras = "LearningRateSchedule|learning_rate\\(|_get_current_learning_rate|def finalize_variable_values|def apply_gradients|def _learning_rate";
  assert.equal(classifyGrepTool({ pattern: keras, path: "/repo/src" }, ctx).text,
    "LearningRateSchedule|learning_rate|_get_current_learning_rate|finalize_variable_values|apply_gradients|_learning_rate");
  const cli = "func (FindLegacy|FindNonLegacy|ExtractTitle)\\(|templateManager|ghrepo.*Template";
  assert.deepEqual(classifyGrepTool({ pattern: cli, path: "/repo", glob: "*.go" }, ctx),
    { kind: "concept", text: "FindLegacy FindNonLegacy ExtractTitle templateManager ghrepo Template", pattern: cli });
});

test("Glob tool", () => {
  assert.deepEqual(classifyGlobTool({ pattern: "**/*AuthService*" }, ctx), { kind: "term", text: "AuthService", pattern: "**/*AuthService*" });
  assert.equal(classifyGlobTool({ pattern: "**/*.ts" }, ctx), null);
  assert.equal(classifyGlobTool({ pattern: "**/package.json" }, ctx), null);
  assert.equal(classifyGlobTool({ pattern: "**/*config*.json" }, ctx), null);
  for (const pattern of ["**/*README*", "*Dockerfile*", "**/*test*", "*tsconfig*", "*docker-compose*", "**/*retry*"]) {
    assert.equal(classifyGlobTool({ pattern }, ctx), null, pattern);
  }
  assert.equal(classifyGlobTool({ pattern: "src/**/*user_service*.py" }, ctx).text, "user_service");
});

test("classifies a search in well under 50 ms", () => {
  const t0 = process.hrtime.bigint();
  for (const [cmd] of BASH) classifyBash(cmd, ctx);
  const perCallMs = Number(process.hrtime.bigint() - t0) / 1e6 / BASH.length;
  assert.ok(perCallMs < 5, `${perCallMs} ms per call`);
});
