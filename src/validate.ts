// LLM出力の参照整合性チェックと、検収判定のオーケストレータ側ゲート。
import type { Criterion, Order, RegressionCriterion, Submission, TrialReport, Verdict } from "./schema.ts";
import { shortHash } from "./util.ts";

export function criterionHash(c: Criterion): string {
  const { change_reason: _r, ...rest } = c;
  return shortHash(rest);
}

export interface SubmissionContext {
  previousPassed: Record<string, string>;
  pendingQuestionIds: string[];
}

export function validateSubmission(order: Order, sub: Submission, ctx: SubmissionContext): string[] {
  const errors: string[] = [];
  const reqIds = new Set(order.requirements.map((r) => r.id));
  const critIds = new Set<string>();
  for (const c of sub.criteria) {
    if (critIds.has(c.id)) errors.push(`基準IDが重複: ${c.id}`);
    critIds.add(c.id);
    if (c.id.startsWith("REG")) errors.push(`${c.id}: REG で始まるIDは回帰基準用に予約されています`);
    for (const r of c.requirement_ids) if (!reqIds.has(r)) errors.push(`${c.id}: 存在しない要求ID ${r}`);
  }
  for (const s of sub.self_check) if (!critIds.has(s.criterion_id)) errors.push(`self_check: 存在しない基準ID ${s.criterion_id}`);
  for (const b of sub.blockers) for (const r of b.requirement_ids) if (!reqIds.has(r)) errors.push(`blockers: 存在しない要求ID ${r}`);
  const epIds = new Set<string>();
  for (const e of sub.entrypoints) {
    if (epIds.has(e.id)) errors.push(`entrypoint IDが重複: ${e.id}`);
    epIds.add(e.id);
  }
  for (const q of ctx.pendingQuestionIds) {
    if (!sub.answers.some((a) => a.question_id === q)) errors.push(`問い合わせ ${q} への回答(answers)がありません`);
  }

  if (sub.status === "blocked") {
    if (sub.blockers.length === 0) errors.push("status=blocked には blockers が1件以上必要");
    return errors;
  }

  if (sub.criteria.length === 0) errors.push("検査基準(criteria)がありません");
  if (sub.entrypoints.length === 0 && order.deliverable_type !== "library") errors.push("entrypoints（利用者が起動する方法）がありません");
  // 基準不足: 必須要求ごとに最低1つの必須基準
  for (const r of order.requirements.filter((r) => r.must)) {
    if (!sub.criteria.some((c) => c.required && c.requirement_ids.includes(r.id))) {
      errors.push(`基準不足: 必須要求 ${r.id}「${r.text.slice(0, 40)}」を検査する必須基準がありません`);
    }
  }
  const types = new Set(sub.criteria.map((c) => c.check.type));
  if (order.deliverable_type.includes("tui") && !types.has("tui")) errors.push("基準不足: TUI納品物には実端末(PTY)で操作する tui 基準が必要");
  if (order.deliverable_type.includes("cli") && !types.has("command")) errors.push("基準不足: CLI納品物には実プロセスを起動する command 基準が必要");
  if (sub.criteria.length > 0 && sub.criteria.every((c) => c.check.type === "review")) errors.push("基準不足: 機械的に再実行できる基準がありません");

  // 合格済み基準の変更・削除には理由が必要（期待値の後退を防ぐ）
  for (const [id, hash] of Object.entries(ctx.previousPassed)) {
    if (id.startsWith("REG")) continue;
    const cur = sub.criteria.find((c) => c.id === id);
    if (!cur) {
      if (!sub.removed_criteria.some((r) => r.id === id)) errors.push(`合格済み基準 ${id} が削除されています（removed_criteria に理由を記載）`);
    } else if (criterionHash(cur) !== hash && !(cur.change_reason && cur.change_reason.trim().length >= 8)) {
      errors.push(`合格済み基準 ${id} の内容が変更されています（change_reason に要求との対応を含む理由を記載）`);
    }
  }
  return errors;
}

export function changedCriteria(sub: Submission, previousPassed: Record<string, string>) {
  const out: Array<{ id: string; kind: "changed" | "removed"; reason: string }> = [];
  for (const [id, hash] of Object.entries(previousPassed)) {
    if (id.startsWith("REG")) continue;
    const cur = sub.criteria.find((c) => c.id === id);
    if (!cur) out.push({ id, kind: "removed", reason: sub.removed_criteria.find((r) => r.id === id)?.reason ?? "" });
    else if (criterionHash(cur) !== hash) out.push({ id, kind: "changed", reason: cur.change_reason ?? "" });
  }
  return out;
}

export function validateTrial(order: Order, t: TrialReport): string[] {
  const errors: string[] = [];
  const reqIds = new Set(order.requirements.map((r) => r.id));
  const seen = new Set<string>();
  for (const s of t.scenarios) {
    if (seen.has(s.id)) errors.push(`シナリオIDが重複: ${s.id}`);
    seen.add(s.id);
    for (const r of s.requirement_ids) if (!reqIds.has(r)) errors.push(`${s.id}: 存在しない要求ID ${r}`);
  }
  for (const u of t.unverified) for (const r of u.requirement_ids) if (!reqIds.has(r)) errors.push(`unverified: 存在しない要求ID ${r}`);
  return errors;
}

export interface Identity {
  order_version: string;
  deliverable_fingerprint: string;
  criteria_version: string;
}

export interface GateInput {
  order: Order;
  verdict: Verdict;
  identity: Identity;
  criteria: Array<Criterion | RegressionCriterion>;
  verificationFailures: string[];
  submissionBlocked: boolean;
}

/** 判定の整合性検査。errors があれば検収AIに再提出させる。 */
export function validateVerdict(g: GateInput): string[] {
  const { order, verdict: v, identity } = g;
  const errors: string[] = [];
  const reqIds = new Set(order.requirements.map((r) => r.id));
  const critIds = new Set(g.criteria.map((c) => c.id));
  for (const k of ["order_version", "deliverable_fingerprint", "criteria_version"] as const) {
    if (v.inspected[k] !== identity[k]) errors.push(`inspected.${k}=${v.inspected[k]} は検収対象 ${identity[k]} と一致しません（古い/別の成果物の判定は受け付けない）`);
  }
  const assessed = new Map(v.requirement_assessment.map((a) => [a.requirement_id, a]));
  for (const r of order.requirements) if (!assessed.has(r.id)) errors.push(`requirement_assessment に ${r.id} がありません`);
  for (const a of v.requirement_assessment) if (!reqIds.has(a.requirement_id)) errors.push(`requirement_assessment: 存在しない要求ID ${a.requirement_id}`);
  for (const c of v.criteria_assessment) if (!critIds.has(c.criterion_id)) errors.push(`criteria_assessment: 存在しない基準ID ${c.criterion_id}`);
  for (const it of v.rework_items) {
    for (const r of it.requirement_ids) if (!reqIds.has(r)) errors.push(`rework_items: 存在しない要求ID ${r}`);
    for (const c of it.criterion_ids) if (!critIds.has(c)) errors.push(`rework_items: 存在しない基準ID ${c}`);
  }
  switch (v.verdict) {
    case "accepted": {
      if (g.submissionBlocked) errors.push("受注側が blocked を申告した納品を accepted にはできません");
      for (const r of order.requirements.filter((r) => r.must)) {
        const a = assessed.get(r.id);
        if (a && a.status !== "satisfied") errors.push(`accepted だが必須要求 ${r.id} が ${a.status}（未確認は合格にしない。必要なら blocked/rework）`);
      }
      for (const c of g.criteria.filter((c) => c.required)) {
        const ca = v.criteria_assessment.find((x) => x.criterion_id === c.id);
        if (ca && !ca.adequate) errors.push(`accepted だが必須基準 ${c.id} を不適切と評価しています（rework: inadequate_criteria にする）`);
        if (c.check.type === "review" && !ca) errors.push(`review 型の必須基準 ${c.id} の評価(criteria_assessment)がありません`);
      }
      if (v.rework_items.length) errors.push("accepted に rework_items は付けられません（要求外の改善は follow_ups へ）");
      break;
    }
    case "rework":
      if (v.rework_items.length === 0) errors.push("rework には具体的な rework_items が1件以上必要");
      break;
    case "blocked":
      if (v.blockers.length === 0) errors.push("blocked には blockers（何が不足し何が必要か）が必要");
      break;
    case "inquiry":
      if (v.questions.length === 0) errors.push("inquiry には questions が必要");
      break;
  }
  return errors;
}

/** オーケストレータの最終ゲート: 検証済み証拠に失敗がある限り accepted を反映しない。 */
export function gateVerdict(g: GateInput): { verdict: Verdict; overridden: boolean } {
  if (g.verdict.verdict === "accepted" && g.verificationFailures.length > 0) {
    return {
      overridden: true,
      verdict: {
        ...g.verdict,
        verdict: "rework",
        rework_items: g.verificationFailures.map((f) => ({
          category: "insufficient_evidence" as const,
          requirement_ids: [g.order.requirements[0]!.id],
          criterion_ids: [],
          reason: `オーケストレータ検証で不合格のまま accepted が提出されました: ${f}`,
          expected: "必須基準がすべて検証で合格していること",
          observed: f,
        })),
        summary: `[オーケストレータにより rework へ変更] ${g.verdict.summary}`,
      },
    };
  }
  return { verdict: g.verdict, overridden: false };
}
