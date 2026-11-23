import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeCodeAdapter } from "../../skills/kenshu-loop/scripts/src/harness/claude-code.ts";
import type { CommandRunner, ExecRequest } from "../../skills/kenshu-loop/scripts/src/exec.ts";
import { defaultConfig } from "../../skills/kenshu-loop/scripts/src/schema.ts";

function req(logPath: string) {
  return {
    role: "inspector" as const,
    label: "t",
    cwd: "/tmp",
    prompt: "PROMPT",
    systemPrompt: "SYS",
    jsonSchema: { type: "object" },
    sessionId: "11111111-1111-1111-1111-111111111111",
    resume: false,
    permissions: defaultConfig().harness.inspector,
    maxBudgetUsd: 0.5,
    timeoutMs: 1000,
    addDirs: ["/ev"],
    signal: new AbortController().signal,
    logPath,
  };
}
const runnerReturning = (stdout: string, seen: ExecRequest[] = []): CommandRunner => ({
  async run(r) {
    seen.push(r);
    return { exitCode: 0, signal: null, stdout, stderr: "", timedOut: false, aborted: false, durationMs: 1 };
  },
});

test("adapter: ヘルプで確認したフラグで起動し、プロンプトはstdinで渡す", async () => {
  const seen: ExecRequest[] = [];
  const log = join(mkdtempSync(join(tmpdir(), "ad-")), "h.json");
  const a = new ClaudeCodeAdapter("claude", runnerReturning(JSON.stringify({ subtype: "success", is_error: false, session_id: "s", total_cost_usd: 0.2, structured_output: { ok: 1 } }), seen), "sonnet");
  const r = await a.invoke(req(log));
  assert.equal(r.ok, true);
  assert.deepEqual(r.structured, { ok: 1 });
  assert.equal(r.costUsd, 0.2);
  const argv = seen[0]!.argv;
  for (const f of ["-p", "--output-format", "--json-schema", "--session-id", "--permission-mode", "--permission-prompts", "--max-budget-usd", "--append-system-prompt", "--allowedTools", "--disallowedTools", "--add-dir", "--model"]) {
    assert.ok(argv.includes(f), f);
  }
  assert.equal(argv[argv.indexOf("--permission-mode") + 1], "dontAsk");
  assert.match(argv[argv.indexOf("--disallowedTools") + 1]!, /Edit/);
  assert.equal(seen[0]!.stdin, "PROMPT");
});

test("adapter: 予算超過・エラー・構造化出力なし・壊れたJSONを区別する", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "ad-")), "h.json");
  const run = (s: string) => new ClaudeCodeAdapter("claude", runnerReturning(s)).invoke(req(log));
  assert.equal((await run(JSON.stringify({ subtype: "error_max_budget_usd", is_error: true }))).error?.kind, "budget");
  assert.equal((await run(JSON.stringify({ subtype: "error_during_execution", is_error: true }))).error?.kind, "harness_error");
  assert.equal((await run(JSON.stringify({ subtype: "success", is_error: false }))).error?.kind, "no_structured_output");
  assert.equal((await run("not json")).error?.kind, "parse");
});

test("adapter: 記録に認証関連フィールドを保存しない", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "ad-")), "h.json");
  await new ClaudeCodeAdapter("claude", runnerReturning(JSON.stringify({ subtype: "success", structured_output: {}, credential_expires_at: "X-SECRET", result: "sk-ant-api03-zzzzzzzzzzzzzzzz" }))).invoke(req(log));
  const saved = readFileSync(log, "utf8");
  assert.doesNotMatch(saved, /X-SECRET|credential_expires_at|zzzzzzzzzzzzzzzz/);
});
