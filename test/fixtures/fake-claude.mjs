#!/usr/bin/env node
// テスト用の偽 Claude Code CLI。実際の ClaudeCodeAdapter のプロセス境界（引数・stdin・JSON結果）を検証するために使う。
// FAKE_CLAUDE_SCRIPT: { contractor: Action[], trial: Action[], review: Action[] }（呼び出し順に消費、最後の要素を繰り返す）
// FAKE_CLAUDE_STATE: 呼び出し回数と記録を残すJSONファイル
import { readFileSync, writeFileSync, existsSync, copyFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const prompt = readFileSync(0, "utf8");
const sys = opt("--append-system-prompt") ?? "";
const role = sys.includes("受注AIの作業手順") ? "contractor" : sys.includes("利用者試行（第1段）") ? "trial" : sys.includes("技術審査と判定") ? "review" : "unknown";
const script = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_SCRIPT, "utf8"));
const statePath = process.env.FAKE_CLAUDE_STATE;
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { calls: [] };
const n = state.calls.filter((c) => c.role === role).length;
const list = script[role] ?? [];
const action = list[Math.min(n, list.length - 1)] ?? {};
const sessionId = opt("--session-id") ?? opt("--resume");
state.calls.push({
  role,
  n,
  pid: process.pid,
  cwd: process.cwd(),
  resume: args.includes("--resume"),
  session: sessionId,
  has_schema: !!opt("--json-schema"),
  permission_mode: opt("--permission-mode"),
  permission_prompts: opt("--permission-prompts"),
  allowed: opt("--allowedTools"),
  disallowed: opt("--disallowedTools"),
  budget: opt("--max-budget-usd"),
  prompt_has_criteria: prompt.includes("受注側の納品書"),
  prompt_has_rejection: prompt.includes("受理されませんでした"),
  prompt_len: prompt.length,
});
writeFileSync(statePath, JSON.stringify(state, null, 2));

const identity = () => {
  const m = (k) => (prompt.match(new RegExp(`"${k}": "([^"]+)"`)) ?? [])[1];
  return { order_version: m("order_version"), deliverable_fingerprint: m("deliverable_fingerprint"), criteria_version: m("criteria_version") };
};
const subst = (v) =>
  JSON.parse(
    JSON.stringify(v)
      .replace(/"\{\{identity\}\}"/g, JSON.stringify(identity()))
      .replace(/\{\{cwd\}\}/g, process.cwd()),
  );

if (action.sleep_ms) await new Promise((r) => setTimeout(r, action.sleep_ms));
for (const c of action.copy ?? []) {
  mkdirSync(dirname(join(process.cwd(), c.to)), { recursive: true });
  copyFileSync(c.from, join(process.cwd(), c.to));
  if (c.bugs) {
    const p = join(process.cwd(), c.to);
    writeFileSync(p, readFileSync(p, "utf8").replace("const BUGS = [];", `const BUGS = ${JSON.stringify(c.bugs)};`));
  }
}
for (const a of action.append ?? []) appendFileSync(a.path, a.text);
if (action.raw !== undefined) {
  process.stdout.write(action.raw);
  process.exit(action.exit ?? 1);
}
const result = {
  type: "result",
  subtype: action.subtype ?? "success",
  is_error: !!action.is_error,
  session_id: sessionId,
  total_cost_usd: action.cost ?? 0.01,
  num_turns: 1,
  result: "fake",
  credential_expires_at: "SHOULD-NOT-BE-SAVED",
  structured_output: action.output === undefined ? undefined : subst(action.output),
};
process.stdout.write(JSON.stringify(result) + "\n");
process.exit(action.exit ?? 0);
