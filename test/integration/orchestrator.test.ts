// オーケストレータの状態遷移を、実際の ClaudeCodeAdapter + 偽claudeプロセス + 実プロセスでの検証で確かめる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { makeProject, runOrchestrator, memoSubmission, acceptVerdict, trialOk, memoCopy, fakeCalls, readEvents } from "../helpers/project.ts";
import { fingerprint } from "../../src/workspace.ts";

const reworkR3 = {
  output: {
    verdict: "rework",
    inspected: "{{identity}}",
    requirement_assessment: [
      { requirement_id: "R1", status: "satisfied", basis: "ok" },
      { requirement_id: "R2", status: "satisfied", basis: "ok" },
      { requirement_id: "R3", status: "not_satisfied", basis: "存在しない番号で終了コード0" },
      { requirement_id: "R4", status: "satisfied", basis: "ok" },
    ],
    rework_items: [
      {
        category: "nonconforming_deliverable",
        requirement_ids: ["R3"],
        reason: "memo rm 99 が終了コード0を返し、利用者が失敗に気付けない",
        expected: "非0終了とエラーメッセージ",
        observed: "exit 0",
        regression: { type: "command", argv: ["node", "memo.mjs", "rm", "99"], expect: { exit_code: 2, stderr_includes: ["エラー"] } },
      },
    ],
    summary: "R3 不適合",
  },
};

test("差し戻し→修正→受入: 回帰基準に昇格し、再現を記録し、修正版で合格して accepted", async () => {
  const p = makeProject({
    contractor: [
      { copy: memoCopy(["rm-exit0"]), output: memoSubmission() },
      { copy: memoCopy(), output: memoSubmission() },
    ],
    trial: [trialOk],
    review: [reworkR3, { output: acceptVerdict() }],
  });
  const logs: string[] = [];
  const s = await runOrchestrator(p, logs);
  assert.equal(s.status, "accepted", logs.join("\n") + s.status_reason);
  assert.equal(s.round, 2);
  assert.equal(s.regressions.length, 1);
  assert.equal(s.regressions[0]!.id, "REG1");
  assert.equal(s.regressions[0]!.reproduced, true, "差し戻し対象の成果物で回帰基準が失敗(=再現)すること");
  const v2 = JSON.parse(readFileSync(join(p.store.roundDir(2), "verification.json"), "utf8"));
  assert.equal(v2.results.find((r: { criterion_id: string }) => r.criterion_id === "REG1").status, "pass");
  assert.equal(s.accepted!.deliverable_fingerprint, fingerprint(p.dir));
  assert.ok(existsSync(p.store.path("DELIVERY.md")));
  assert.match(readFileSync(p.store.path("DELIVERY.md"), "utf8"), /後続事項/);
  const calls = fakeCalls(p);
  // 受注は2回目で同じセッションを resume、検収は毎回の新規セッションで trial→review を resume
  assert.equal(calls.filter((c) => c.role === "contractor")[1]!.resume, true);
  const trials = calls.filter((c) => c.role === "trial");
  const reviews = calls.filter((c) => c.role === "review");
  assert.equal(trials[0]!.prompt_has_criteria, false, "利用者試行には受注側の納品書を見せない");
  assert.equal(reviews[0]!.resume, true);
  assert.equal(reviews[0]!.session, trials[0]!.session);
  assert.notEqual(trials[0]!.session, calls.find((c) => c.role === "contractor")!.session, "受注と検収は別セッション");
  assert.equal(trials[0]!.permission_mode, "dontAsk");
  assert.equal(trials[0]!.permission_prompts, "none");
  // 受注の作業ディレクトリは対象、検収は新しい環境（コピー）
  assert.equal(calls[0]!.cwd, p.dir);
  assert.notEqual(trials[0]!.cwd, p.dir);
  assert.equal(existsSync(trials[0]!.cwd as string), false, "検査環境は判定後に片付ける");
});

test("基準不足の納品書は受理せず受注AIに具体的な理由で再提出させる", async () => {
  const bad = memoSubmission();
  bad.criteria = bad.criteria.filter((c) => c.id !== "C2");
  const p = makeProject({
    contractor: [{ copy: memoCopy(), output: bad }, { output: memoSubmission() }],
    trial: [trialOk],
    review: [{ output: acceptVerdict() }],
  });
  const s = await runOrchestrator(p);
  assert.equal(s.status, "accepted");
  const rejected = JSON.parse(readFileSync(join(p.store.roundDir(1), "submission-rejected-0.json"), "utf8"));
  assert.ok(rejected.errors.some((e: string) => e.includes("基準不足") && e.includes("R3")));
  assert.equal(s.round, 1, "不備の再提出は検収回数を消費しない");
});

test("検証で不合格なら検収AIを呼ばずに自動差し戻し（受注の自己申告passは信用しない）", async () => {
  const sub = memoSubmission();
  sub.criteria[1] = { ...sub.criteria[1]!, check: { type: "command", argv: ["node", "memo.mjs", "rm", "5"], expect: { exit_code: 2 } } };
  const p = makeProject({
    contractor: [{ copy: memoCopy(["rm-exit0"]), output: { ...sub, self_check: [{ criterion_id: "C2", result: "pass", note: "確認済み(虚偽)" }] } }, { copy: memoCopy(), output: sub }],
    trial: [trialOk],
    review: [{ output: acceptVerdict() }],
  });
  const s = await runOrchestrator(p);
  assert.equal(s.status, "accepted");
  assert.equal(s.round, 2);
  const calls = fakeCalls(p);
  assert.equal(calls.filter((c) => c.role === "trial").length, 1, "1回目は検証不合格で検収AIを呼ばない");
  const v1 = JSON.parse(readFileSync(join(p.store.roundDir(1), "verification.json"), "utf8"));
  assert.equal(v1.results.find((r: { criterion_id: string }) => r.criterion_id === "C2").status, "fail");
});

test("古い証拠: 検収中に成果物が変わったら判定を破棄して再検証し、新しい fingerprint で受入", async () => {
  const p = makeProject({ contractor: [{ copy: memoCopy(), output: memoSubmission() }], trial: [trialOk], review: [] });
  // review 1回目の最中に対象ディレクトリへ書き込む
  const script = JSON.parse(readFileSync(p.scriptPath, "utf8"));
  script.review = [{ append: [{ path: join(p.dir, "README.md"), text: "changed during inspection\n" }], output: acceptVerdict() }, { output: acceptVerdict() }];
  (await import("node:fs")).writeFileSync(p.scriptPath, JSON.stringify(script));
  const s = await runOrchestrator(p);
  assert.equal(s.status, "accepted");
  const ev = readEvents(p);
  const stale = ev.find((e) => e.type === "stale_evidence");
  assert.ok(stale, "stale_evidence イベント");
  assert.notEqual(stale!.verified, stale!.current);
  assert.equal(s.accepted!.deliverable_fingerprint, stale!.current);
  assert.equal(fakeCalls(p).filter((c) => c.role === "review").length, 2);
});

test("別の成果物を指す判定は受理せず検収AIに再提出させる", async () => {
  const wrong = acceptVerdict({ inspected: { order_version: "x", deliverable_fingerprint: "old", criteria_version: "y" } });
  const p = makeProject({ contractor: [{ copy: memoCopy(), output: memoSubmission() }], trial: [trialOk], review: [{ output: wrong }, { output: acceptVerdict() }] });
  const s = await runOrchestrator(p);
  assert.equal(s.status, "accepted");
  const rej = JSON.parse(readFileSync(join(p.store.roundDir(1), "verdict-rejected-0.json"), "utf8"));
  assert.ok(rej.errors.some((e: string) => e.includes("deliverable_fingerprint")));
  const second = fakeCalls(p).filter((c) => c.role === "review")[1]!;
  assert.equal(second.resume, true, "内容不備の再提出は同じ検収セッションで行う");
  assert.equal(second.prompt_has_rejection, true, "再提出の依頼には不受理の理由を含める");
});

test("blocked: 受注が実行不能を申告し、検収が妥当と判断したら blocked（完了に偽装しない）", async () => {
  const p = makeProject({
    contractor: [{ output: { status: "blocked", summary: "外部APIキーが必要", blockers: [{ requirement_ids: ["R1"], reason: "同期先サービスの資格情報が発注書にない", needed: "APIキーの提供" }] } }],
    trial: [trialOk],
    review: [{ output: { ...acceptVerdict(), verdict: "blocked", requirement_assessment: acceptVerdict().requirement_assessment.map((a) => ({ ...a, status: "unverified" })), blockers: [{ requirement_ids: ["R1"], reason: "資格情報が無く検証不能", needed: "APIキー" }], follow_ups: [] } }],
  });
  const s = await runOrchestrator(p);
  assert.equal(s.status, "blocked");
  assert.match(s.status_reason, /APIキー/);
  assert.equal(s.accepted, null);
  assert.equal(fakeCalls(p).filter((c) => c.role === "trial").length, 0, "blocked申告時は試行しない");
});

test("blocked申告でも検収が正当でないと判断すれば差し戻す", async () => {
  const p = makeProject({
    contractor: [{ output: { status: "blocked", summary: "難しい", blockers: [{ requirement_ids: ["R1"], reason: "実装方法が分からないため", needed: "仕様" }] } }, { copy: memoCopy(), output: memoSubmission() }],
    trial: [trialOk],
    review: [
      { output: { ...acceptVerdict(), verdict: "rework", follow_ups: [], requirement_assessment: acceptVerdict().requirement_assessment.map((a) => ({ ...a, status: "not_satisfied" })), rework_items: [{ category: "nonconforming_deliverable", requirement_ids: ["R1"], reason: "発注書の情報で実装可能であり blocked は不当", expected: "実装して納品" }] } },
      { output: acceptVerdict() },
    ],
  });
  const s = await runOrchestrator(p);
  assert.equal(s.status, "accepted");
  assert.equal(s.round, 2);
});

test("上限到達: 差し戻しが続けば limit_reached（未受入）で止まる", async () => {
  const p = makeProject(
    { contractor: [{ copy: memoCopy(["rm-exit0"]), output: memoSubmission() }], trial: [trialOk], review: [reworkR3] },
    { config: (c) => (c.limits.max_rounds = 2) },
  );
  const s = await runOrchestrator(p);
  assert.equal(s.status, "limit_reached");
  assert.match(s.status_reason, /反復上限/);
  assert.equal(s.accepted, null);
  // REG1 は2回目の検証で不合格 → 2回目は自動差し戻し
  assert.equal(fakeCalls(p).filter((c) => c.role === "review").length, 1);
});

test("予算上限: 累積コストが上限に達したら limit_reached", async () => {
  const p = makeProject(
    { contractor: [{ copy: memoCopy(), output: memoSubmission(), cost: 0.6 }], trial: [{ ...trialOk, cost: 0.6 }], review: [{ output: acceptVerdict() }] },
    { config: (c) => (c.limits.max_budget_usd = 1) },
  );
  const s = await runOrchestrator(p);
  assert.equal(s.status, "limit_reached");
  assert.match(s.status_reason, /予算/);
});

test("1回あたりの予算超過・ハーネス異常は区別される（limit_reached / failed）", async () => {
  const p1 = makeProject({ contractor: [{ subtype: "error_max_budget_usd", is_error: true }] });
  assert.equal((await runOrchestrator(p1)).status, "limit_reached");
  const p2 = makeProject({ contractor: [{ raw: "garbage", exit: 1 }] }, { config: (c) => (c.limits.max_invalid_outputs = 1) });
  const s2 = await runOrchestrator(p2);
  assert.equal(s2.status, "failed");
  assert.match(s2.status_reason, /結果JSON/);
  assert.equal(fakeCalls(p2).length, 2);
  const p3 = makeProject({ contractor: [{ output: memoSubmission() }] }, { config: (c) => (c.harness.bin = "/nonexistent/claude") });
  const s3 = await runOrchestrator(p3);
  assert.equal(s3.status, "failed");
  assert.match(s3.status_reason, /起動できません/);
});

test("問い合わせ(inquiry)→回答→再検収", async () => {
  const p = makeProject({
    contractor: [
      { copy: memoCopy(), output: memoSubmission() },
      { output: memoSubmission() }, // 回答なし → 拒否される
      { output: memoSubmission({ answers: [{ question_id: "Q1", answer: "MEMO_FILE で変更できます" }] }) },
    ],
    trial: [trialOk],
    review: [
      { output: { ...acceptVerdict(), verdict: "inquiry", follow_ups: [], questions: [{ id: "Q1", question: "保存先は変更できますか", requirement_ids: ["R4"] }] } },
      { output: acceptVerdict() },
    ],
  });
  const s = await runOrchestrator(p);
  assert.equal(s.status, "accepted");
  assert.equal(s.round, 2);
  const rej = JSON.parse(readFileSync(join(p.store.roundDir(2), "submission-rejected-0.json"), "utf8"));
  assert.ok(rej.errors.some((e: string) => e.includes("Q1")));
});

test("合格済み基準を理由なく弱めた再納品は受理しない", async () => {
  const weak = memoSubmission();
  weak.criteria[0] = { ...weak.criteria[0]!, check: { type: "command", argv: ["true"], expect: { exit_code: 0 } } };
  const p = makeProject({
    contractor: [{ copy: memoCopy(["rm-exit0"]), output: memoSubmission() }, { copy: memoCopy(), output: weak }, { output: memoSubmission() }],
    trial: [trialOk],
    review: [reworkR3, { output: acceptVerdict() }],
  });
  const s = await runOrchestrator(p);
  assert.equal(s.status, "accepted");
  const rej = JSON.parse(readFileSync(join(p.store.roundDir(2), "submission-rejected-0.json"), "utf8"));
  assert.ok(rej.errors.some((e: string) => e.includes("C1") && e.includes("変更")));
});

test("resume: 実行エラー(failed)後に再開すると続きの段階から進む", async () => {
  const p = makeProject({ contractor: [{ copy: memoCopy(), output: memoSubmission() }], trial: [{ raw: "boom", exit: 1 }], review: [{ output: acceptVerdict() }] }, { config: (c) => (c.limits.max_invalid_outputs = 0) });
  const s1 = await runOrchestrator(p);
  assert.equal(s1.status, "failed");
  assert.equal(s1.phase, "trial");
  const script = JSON.parse(readFileSync(p.scriptPath, "utf8"));
  script.trial = [trialOk];
  (await import("node:fs")).writeFileSync(p.scriptPath, JSON.stringify(script));
  // 偽claudeの呼び出し回数は維持されたまま（trial は2回目として trialOk の最後の要素を使う）
  const s2 = await runOrchestrator(p);
  assert.equal(s2.status, "accepted");
  assert.equal(fakeCalls(p).filter((c) => c.role === "contractor").length, 1, "受注をやり直さない");
  appendFileSync(join(p.dir, "README.md"), "x");
});
