// スキル同梱の CLI 入口(skills/kenshu-loop/scripts/kenshu-loop.mjs)を実プロセスとして起動し、args/stdout/stderr/終了コード/ファイルを検証する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cli, cliAsync, waitFor } from "../helpers/cli.ts";
import { FAKE_CLAUDE, ROOT, TODO, memoSubmission, acceptVerdict, trialOk, memoCopy } from "../helpers/project.ts";
import { pidAlive } from "../../skills/kenshu-loop/scripts/src/store.ts";

function setup(script: unknown, orderPath = join(ROOT, "examples", "memo-cli", "order.json")) {
  const base = mkdtempSync(join(tmpdir(), "kenshu-e2e-"));
  const dir = join(base, "target");
  mkdirSync(dir);
  const scriptPath = join(base, "script.json");
  const statePath = join(base, "fake-state.json");
  writeFileSync(scriptPath, JSON.stringify(script));
  const env = { FAKE_CLAUDE_SCRIPT: scriptPath, FAKE_CLAUDE_STATE: statePath };
  const init = cli(["init", "--dir", dir, "--order", orderPath, "--claude-bin", FAKE_CLAUDE]);
  assert.equal(init.code, 0, init.stderr);
  return { dir, env, statePath, scriptPath };
}
const calls = (statePath: string) => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")).calls : []);

test("CLI: --help/--version/不正な引数の終了コードと出力先", () => {
  const h = cli(["--help"]);
  assert.equal(h.code, 0);
  assert.match(h.stdout, /kenshu-loop init/);
  assert.equal(cli(["--version"]).stdout.trim(), JSON.parse(readFileSync(join(ROOT, "skills", "kenshu-loop", "scripts", "package.json"), "utf8")).version);
  const bad = cli(["frobnicate"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /不明なコマンド/);
  const noState = cli(["status", "--dir", mkdtempSync(join(tmpdir(), "k-"))]);
  assert.equal(noState.code, 1);
  assert.match(noState.stderr, /init/);
});

test("CLI: 不正な発注書は具体的なフィールド名付きで拒否（exit 1）", () => {
  const d = mkdtempSync(join(tmpdir(), "k-"));
  writeFileSync(join(d, "order.json"), JSON.stringify({ schema: "kenshu-loop/order@1", title: "x", summary: "y", deliverable_type: "cli", requirements: [{ id: "X1", kind: "goal", text: "t" }] }));
  const r = cli(["init", "--dir", d, "--order", join(d, "order.json")]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /requirements\.0\.id/);
  assert.equal(existsSync(join(d, ".kenshu", "state.json")), false);
});

test("CLI: init → run(差し戻し→受入) → status → 再run拒否 → resume は終了済み", () => {
  const p = setup({
    contractor: [{ copy: memoCopy(["rm-exit0"]), output: memoSubmission() }, { copy: memoCopy(), output: memoSubmission() }],
    trial: [trialOk],
    review: [
      {
        output: {
          ...acceptVerdict(),
          verdict: "rework",
          follow_ups: [],
          requirement_assessment: acceptVerdict().requirement_assessment.map((a) => ({ ...a, status: a.requirement_id === "R3" ? "not_satisfied" : "satisfied" })),
          rework_items: [{ category: "nonconforming_deliverable", requirement_ids: ["R3"], reason: "存在しない番号の削除で終了コード0", expected: "非0終了", regression: { type: "command", argv: ["node", "memo.mjs", "rm", "7"], expect: { exit_code: 2 } } }],
        },
      },
      { output: acceptVerdict() },
    ],
  });
  const run = cli(["run", "--dir", p.dir], { env: p.env });
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /status: accepted/);
  assert.match(run.stderr, /回帰基準 REG1 を追加（現成果物で再現: true）/);
  assert.match(run.stderr, /判定: rework/);
  const st = cli(["status", "--dir", p.dir, "--json"]);
  assert.equal(st.code, 0);
  const j = JSON.parse(st.stdout);
  assert.equal(j.status, "accepted");
  assert.equal(j.acceptance_stale, false);
  assert.equal(j.round, 2);
  assert.ok(readFileSync(join(p.dir, ".kenshu", "DELIVERY.md"), "utf8").includes("node memo.mjs"));
  // ハーネス記録に認証関連フィールドが残っていない
  const harness = readFileSync(join(p.dir, ".kenshu", "rounds", "001", "harness", "trial-r1.json"), "utf8");
  assert.doesNotMatch(harness, /credential_expires_at|SHOULD-NOT-BE-SAVED/);
  const again = cli(["run", "--dir", p.dir], { env: p.env });
  assert.equal(again.code, 1);
  assert.match(again.stderr, /resume/);
  assert.equal(cli(["resume", "--dir", p.dir], { env: p.env }).code, 0);
  // 受入後に成果物を変えると status は古い受入として非0
  writeFileSync(join(p.dir, "memo.mjs"), readFileSync(join(p.dir, "memo.mjs"), "utf8") + "\n// edit\n");
  const stale = cli(["status", "--dir", p.dir]);
  assert.equal(stale.code, 4);
  assert.match(stale.stdout, /受入後に成果物が変更/);
});

test("CLI: blocked は exit 2、limit_reached は exit 3", () => {
  const b = setup({
    contractor: [{ output: { status: "blocked", summary: "不可", blockers: [{ requirement_ids: ["R1"], reason: "必要な資格情報が発注書にない", needed: "資格情報" }] } }],
    review: [{ output: { ...acceptVerdict(), verdict: "blocked", follow_ups: [], requirement_assessment: acceptVerdict().requirement_assessment.map((a) => ({ ...a, status: "unverified" })), blockers: [{ requirement_ids: ["R1"], reason: "検証に資格情報が必要", needed: "資格情報" }] } }],
  });
  const r = cli(["run", "--dir", b.dir], { env: b.env });
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stdout, /status: blocked/);
  const l = setup({ contractor: [{ copy: memoCopy(["rm-exit0"]), output: { ...memoSubmission(), criteria: memoSubmission().criteria.map((c) => (c.id === "C2" ? { ...c, check: { type: "command", argv: ["node", "memo.mjs", "rm", "9"], expect: { exit_code: 2 } } } : c)) } }] });
  const cfgPath = join(l.dir, ".kenshu", "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.limits.max_rounds = 2;
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const r2 = cli(["run", "--dir", l.dir], { env: l.env });
  assert.equal(r2.code, 3, r2.stderr);
  assert.match(r2.stdout, /limit_reached/);
});

test("CLI: SIGINT で中断→状態保存・子プロセス終了・ロック解放、多重起動は拒否、resume で完了", async () => {
  const p = setup({
    contractor: [{ sleep_ms: 30_000, copy: memoCopy(), output: memoSubmission() }, { copy: memoCopy(), output: memoSubmission() }],
    trial: [trialOk],
    review: [{ output: acceptVerdict() }],
  });
  const { child, done } = cliAsync(["run", "--dir", p.dir], { env: p.env });
  await waitFor(() => calls(p.statePath).length === 1, 20_000, "contractor call");
  const fakePid = calls(p.statePath)[0].pid as number;
  // 実行中の多重起動は拒否
  const dup = cli(["resume", "--dir", p.dir], { env: p.env });
  assert.equal(dup.code, 5, dup.stderr);
  assert.match(dup.stderr, /実行中/);
  child.kill("SIGINT");
  const r = await done;
  assert.equal(r.code, 130, r.stdout + r.stderr);
  assert.match(r.stdout, /status: interrupted/);
  await waitFor(() => !pidAlive(fakePid), 5000, "fake claude to exit");
  assert.equal(existsSync(join(p.dir, ".kenshu", "lock")), false);
  const st = JSON.parse(cli(["status", "--dir", p.dir, "--json"]).stdout);
  assert.equal(st.status, "interrupted");
  assert.equal(st.phase, "contract");
  const res = cli(["resume", "--dir", p.dir], { env: p.env });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /status: accepted/);
});

test("CLI+PTY: TUI納品物を実端末シナリオで検証（undo不具合で自動差し戻し→修正→受入）", () => {
  const scenario = JSON.parse(readFileSync(join(ROOT, "examples", "todo-tui", "scenario.json"), "utf8"));
  const sub = {
    status: "delivered",
    summary: "TODO TUI",
    setup: [],
    entrypoints: [{ id: "todo", kind: "tui", argv: ["node", "todo.mjs"], description: "TODOリスト" }],
    criteria: [
      { id: "C1", requirement_ids: ["R1", "R2", "R3", "R4"], title: "主要操作の通し", rationale: "初回起動からヘルプ・貼り付け追加・狭い端末・削除と取消・終了と再起動後の保存までを現在画面で確認する", required: true, check: { type: "tui", scenario } },
    ],
    self_check: [],
  };
  const p = setup(
    {
      contractor: [{ copy: [{ from: TODO, to: "todo.mjs", bugs: ["noundo"] }], output: sub }, { copy: [{ from: TODO, to: "todo.mjs" }], output: sub }],
      trial: [{ output: { scenarios: [{ id: "S1", requirement_ids: ["R1"], title: "初回", intent: "追加", operations: "a→入力→Enter", expected: "表示", actual: "表示", result: "pass", evidence: [] }], unverified: [], notes: "" } }],
      review: [{ output: acceptVerdict() }],
    },
    join(ROOT, "examples", "todo-tui", "order.json"),
  );
  const r = cli(["run", "--dir", p.dir], { env: p.env });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /検証不合格 1 件/);
  const v1 = JSON.parse(readFileSync(join(p.dir, ".kenshu", "rounds", "001", "verification.json"), "utf8"));
  assert.equal(v1.results[0].status, "fail");
  assert.match(v1.results[0].detail, /元に戻しました/);
  // 失敗時の画面証拠（テキスト・スタイルJSON・SVG）が残る
  const arts: string[] = v1.results[0].scenario.artifacts;
  assert.ok(arts.some((a) => a.endsWith(".svg")) && arts.some((a) => a.endsWith(".txt")));
  assert.ok(existsSync(arts[0]!));
  const v2 = JSON.parse(readFileSync(join(p.dir, ".kenshu", "rounds", "002", "verification.json"), "utf8"));
  assert.equal(v2.results[0].status, "pass");
  assert.equal(v2.results[0].scenario.steps.length, scenario.steps.length);
});
