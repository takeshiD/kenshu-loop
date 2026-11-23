import { test } from "node:test";
import assert from "node:assert/strict";
import { Submission, Verdict, Order } from "../../src/schema.ts";
import { validateSubmission, validateVerdict, gateVerdict, criterionHash, changedCriteria } from "../../src/validate.ts";
import { memoOrder, memoSubmission, acceptVerdict } from "../helpers/project.ts";

const order = memoOrder();
const identity = { order_version: "o1", deliverable_fingerprint: "f1", criteria_version: "c1" };
const sub = () => Submission.parse(memoSubmission());
const verdict = (extra: Record<string, unknown> = {}) => Verdict.parse({ ...acceptVerdict(), inspected: identity, ...extra });

test("発注書: 必須フィールド欠落と重複IDを拒否する", () => {
  assert.equal(Order.safeParse({ ...order, title: "" }).success, false);
  const dup = { ...order, requirements: [...order.requirements, { ...order.requirements[0] }] };
  const r = Order.safeParse(dup);
  assert.equal(r.success, false);
  assert.match(JSON.stringify(r.error?.issues), /重複/);
});

test("納品書: 妥当な提出は受理される", () => {
  assert.deepEqual(validateSubmission(order, sub(), { previousPassed: {}, pendingQuestionIds: [] }), []);
});

test("納品書: 必須要求を検査する基準が無ければ「基準不足」で拒否", () => {
  const s = sub();
  s.criteria = s.criteria.filter((c) => !c.requirement_ids.includes("R3"));
  const errs = validateSubmission(order, s, { previousPassed: {}, pendingQuestionIds: [] });
  assert.ok(errs.some((e) => e.includes("基準不足") && e.includes("R3")), errs.join("\n"));
});

test("納品書: review型だけの基準・CLIなのにcommand基準なし を拒否", () => {
  const s = sub();
  s.criteria = s.criteria.map((c) => ({ ...c, check: { type: "review" as const, instructions: "目視で確認" } }));
  const errs = validateSubmission(order, s, { previousPassed: {}, pendingQuestionIds: [] });
  assert.ok(errs.some((e) => e.includes("command 基準")));
  assert.ok(errs.some((e) => e.includes("機械的に再実行")));
});

test("納品書: 存在しない要求ID・重複基準ID・予約ID(REG)を拒否", () => {
  const s = sub();
  s.criteria.push({ ...s.criteria[0]!, requirement_ids: ["R9"] });
  s.criteria.push({ ...s.criteria[1]!, id: "REG1" });
  const errs = validateSubmission(order, s, { previousPassed: {}, pendingQuestionIds: [] });
  assert.ok(errs.some((e) => e.includes("R9")));
  assert.ok(errs.some((e) => e.includes("重複")));
  assert.ok(errs.some((e) => e.includes("予約")));
});

test("納品書: 合格済み基準の無断変更・無断削除を拒否し、理由付きなら受理", () => {
  const s = sub();
  const passed = { C1: criterionHash(s.criteria[0]!), C2: criterionHash(s.criteria[1]!) };
  const weakened = sub();
  weakened.criteria[0] = { ...weakened.criteria[0]!, check: { type: "command", argv: ["true"], expect: { exit_code: 0 } } };
  weakened.criteria = weakened.criteria.filter((c) => c.id !== "C2");
  weakened.criteria.push({ ...sub().criteria[1]!, id: "C9" });
  let errs = validateSubmission(order, weakened, { previousPassed: passed, pendingQuestionIds: [] });
  assert.ok(errs.some((e) => e.includes("C1") && e.includes("変更")));
  assert.ok(errs.some((e) => e.includes("C2") && e.includes("削除")));
  weakened.criteria[0]!.change_reason = "R1の解釈を発注書の文言に合わせて修正したため";
  weakened.removed_criteria = [{ id: "C2", reason: "C9 に統合し R3 の失敗系も確認するため" }];
  errs = validateSubmission(order, weakened, { previousPassed: passed, pendingQuestionIds: [] });
  assert.deepEqual(errs, []);
  assert.equal(changedCriteria(weakened, passed).length, 2);
});

test("納品書: 問い合わせへの回答が無ければ拒否", () => {
  const errs = validateSubmission(order, sub(), { previousPassed: {}, pendingQuestionIds: ["Q1"] });
  assert.ok(errs.some((e) => e.includes("Q1")));
});

test("納品書: blocked には理由が必要", () => {
  const s = Submission.parse({ status: "blocked", summary: "無理" });
  assert.ok(validateSubmission(order, s, { previousPassed: {}, pendingQuestionIds: [] }).some((e) => e.includes("blockers")));
});

const gate = (v: Verdict, extra: Partial<Parameters<typeof validateVerdict>[0]> = {}) => ({
  order,
  verdict: v,
  identity,
  criteria: sub().criteria,
  verificationFailures: [],
  submissionBlocked: false,
  ...extra,
});

test("判定: 別の成果物/基準版を指す判定（古い証拠）は拒否", () => {
  const v = verdict({ inspected: { ...identity, deliverable_fingerprint: "old" } });
  const errs = validateVerdict(gate(v));
  assert.ok(errs.some((e) => e.includes("deliverable_fingerprint")));
});

test("判定: 必須要求が unverified のまま accepted は拒否（未確認を合格にしない）", () => {
  const v = verdict();
  v.requirement_assessment[2]!.status = "unverified";
  assert.ok(validateVerdict(gate(v)).some((e) => e.includes("R3") && e.includes("unverified")));
});

test("判定: 要求評価の欠落・rework理由なし・blocked理由なしを拒否", () => {
  const v = verdict();
  v.requirement_assessment.pop();
  assert.ok(validateVerdict(gate(v)).some((e) => e.includes("R4")));
  assert.ok(validateVerdict(gate(verdict({ verdict: "rework" }))).some((e) => e.includes("rework_items")));
  assert.ok(validateVerdict(gate(verdict({ verdict: "blocked" }))).some((e) => e.includes("blockers")));
  assert.ok(validateVerdict(gate(verdict({ verdict: "inquiry" }))).some((e) => e.includes("questions")));
});

test("判定: 差し戻し理由は具体的でなければスキーマで拒否", () => {
  const r = Verdict.safeParse({ ...acceptVerdict(), inspected: identity, verdict: "rework", rework_items: [{ category: "nonconforming_deliverable", requirement_ids: ["R1"], reason: "ダメ", expected: "x" }] });
  assert.equal(r.success, false);
});

test("判定: 必須基準を不適切と評価しつつ accepted は拒否、blocked申告の納品を accepted も拒否", () => {
  const v = verdict({ criteria_assessment: [{ criterion_id: "C1", adequate: false, comment: "甘い" }] });
  assert.ok(validateVerdict(gate(v)).some((e) => e.includes("C1")));
  assert.ok(validateVerdict(gate(verdict(), { submissionBlocked: true })).some((e) => e.includes("blocked")));
});

test("ゲート: 検証不合格が残っていれば accepted を rework に変更する", () => {
  const g = gateVerdict(gate(verdict(), { verificationFailures: ["C2: 終了コード 期待=2 実際=0"] }));
  assert.equal(g.overridden, true);
  assert.equal(g.verdict.verdict, "rework");
  assert.equal(g.verdict.rework_items[0]!.category, "insufficient_evidence");
});
