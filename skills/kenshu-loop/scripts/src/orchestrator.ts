// 状態遷移: contract → verify → trial → review → decide。各段階の入出力を永続化し、どこからでも再開できる。
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import {
  Submission,
  TrialReport,
  Verdict,
  jsonSchemaOf,
  formatZodError,
  type Config,
  type Order,
  type RunState,
  type Criterion,
  type RegressionCriterion,
  type ReworkItem,
} from "./schema.ts";
import { Store } from "./store.ts";
import type { HarnessAdapter, HarnessResult, Role } from "./harness/types.ts";
import type { RoleConfig } from "./schema.ts";
import { contractPrompt, reviewPrompt, systemPrompt, trialPrompt } from "./prompts.ts";
import { changedCriteria, criterionHash, gateVerdict, validateSubmission, validateTrial, validateVerdict, type Identity } from "./validate.ts";
import { removeEnvironment, verifyDeliverable, writeVerificationReport, type Verification, type VerifyDeps } from "./verify.ts";
import { fingerprint } from "./workspace.ts";
import { nowIso, readJson, readJsonIfExists, shortHash, writeJsonAtomic, KenshuError } from "./util.ts";
import { killAllChildren } from "./exec.ts";

export interface OrchestratorDeps extends VerifyDeps {
  harness: HarnessAdapter;
  /** エージェントに渡す `kenshu-loop` コマンドの前置き（例: node /abs/skills/kenshu-loop/scripts/kenshu-loop.mjs） */
  cliCommand: string;
  log: (line: string) => void;
  now?: () => number;
}

export const EXIT = { accepted: 0, usage: 1, blocked: 2, limit_reached: 3, failed: 4, locked: 5, interrupted: 130 } as const;

type Feedback =
  | { type: "invalid_submission"; errors: string[]; previous?: Feedback | null }
  | { type: "rework"; source: "inspector" | "orchestrator"; summary: string; rework_items: ReworkItem[]; follow_ups?: unknown[] }
  | { type: "inquiry"; summary: string; questions: Verdict["questions"] };

export function newState(orderVersion: string): RunState {
  return {
    schema: "kenshu-loop/state@1",
    order_version: orderVersion,
    status: "ready_to_run",
    status_reason: "",
    round: 1,
    phase: "contract",
    invalid_outputs: 0,
    elapsed_ms: 0,
    cost_usd: 0,
    contractor_session: null,
    pending_feedback: null,
    regressions: [],
    passed_criteria: {},
    accepted: null,
    updated_at: nowIso(),
  };
}

export function orderVersion(order: Order): string {
  return shortHash(order);
}

class Interrupted extends Error {}
class Stop extends Error {
  readonly status: "failed" | "limit_reached";
  constructor(status: "failed" | "limit_reached", message: string) {
    super(message);
    this.status = status;
  }
}

export class Orchestrator {
  private config: Config;
  private order: Order;
  private state: RunState;
  private tick: number;
  private abort = new AbortController();

  private store: Store;
  private deps: OrchestratorDeps;
  constructor(store: Store, deps: OrchestratorDeps) {
    this.store = store;
    this.deps = deps;
    this.config = store.loadConfig();
    this.order = store.loadOrder();
    this.state = store.loadState();
    this.tick = this.now();
    if (this.state.order_version !== orderVersion(this.order)) {
      throw new KenshuError("order.json が状態の要求版と一致しません。発注を変えた場合は init --force で再発注してください。", 1);
    }
  }

  private now() {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** 外部（シグナルハンドラ）から中断を要求する。 */
  interrupt(): void {
    this.abort.abort();
    killAllChildren("SIGTERM");
  }

  private save() {
    const t = this.now();
    this.state.elapsed_ms += t - this.tick;
    this.tick = t;
    this.store.saveState(this.state);
  }

  private get rdir() {
    return this.store.roundDir(this.state.round);
  }

  async run(): Promise<RunState> {
    const s = this.state;
    if (s.status === "accepted" || s.status === "blocked") return s;
    s.status = "running";
    s.status_reason = "";
    this.save();
    this.store.event("run_start", { round: s.round, phase: s.phase });
    try {
      for (;;) {
        if (this.abort.signal.aborted) throw new Interrupted();
        this.checkLimits();
        const done = await this.step();
        this.save();
        if (done) break;
      }
    } catch (e) {
      if (e instanceof Interrupted || this.abort.signal.aborted) {
        s.status = "interrupted";
        s.status_reason = `中断（phase=${s.phase}, round=${s.round}）。kenshu-loop resume で再開できます。`;
      } else if (e instanceof Stop) {
        s.status = e.status;
        s.status_reason = e.message;
      } else {
        s.status = "failed";
        s.status_reason = `実行エラー: ${(e as Error).message}`;
      }
      this.save();
      this.store.event("run_stop", { status: s.status, reason: s.status_reason });
    }
    return s;
  }

  private checkLimits() {
    const L = this.config.limits;
    const s = this.state;
    if (s.round > L.max_rounds) throw new Stop("limit_reached", `反復上限 ${L.max_rounds} 回に到達（未受入）。`);
    const elapsed = s.elapsed_ms + (this.now() - this.tick);
    if (elapsed > L.max_minutes * 60_000) throw new Stop("limit_reached", `時間上限 ${L.max_minutes} 分に到達（未受入）。`);
    if (s.cost_usd >= L.max_budget_usd) throw new Stop("limit_reached", `予算上限 $${L.max_budget_usd} に到達（未受入）。`);
  }

  /** 1段階進める。終了状態に達したら true。 */
  private async step(): Promise<boolean> {
    switch (this.state.phase) {
      case "contract":
        return this.phaseContract();
      case "verify":
        return this.phaseVerify();
      case "trial":
        return this.phaseTrial();
      case "review":
        return this.phaseReview();
      case "decide":
        return this.phaseDecide();
    }
  }

  private allCriteria(sub: Submission): Array<Criterion | RegressionCriterion> {
    return [...sub.criteria, ...this.state.regressions];
  }
  private criteriaVersion(sub: Submission): string {
    return shortHash(this.allCriteria(sub).map((c) => ({ ...c, change_reason: undefined, origin_round: undefined, reproduced: undefined })));
  }

  // ---------- 受注 ----------
  private async phaseContract(): Promise<boolean> {
    const s = this.state;
    mkdirSync(this.rdir, { recursive: true });
    const feedback = s.pending_feedback as Feedback | null;
    const prev = this.latestSubmission(s.round - 1);
    const base = feedback?.type === "invalid_submission" ? (feedback.previous ?? null) : feedback;
    const pendingQuestionIds = base?.type === "inquiry" ? base.questions.map((q) => q.id) : [];
    const resume = !!s.contractor_session;
    if (!s.contractor_session) s.contractor_session = randomUUID();
    this.save();
    this.deps.log(`[round ${s.round}] 受注AI: ${feedback ? "指摘への対応" : "初回納品"}を依頼`);
    const res = await this.callHarness(
      "contractor",
      `contract-r${s.round}-${Date.now()}`,
      this.store.targetDir,
      contractPrompt({
        order: this.order,
        orderVersion: s.order_version,
        round: s.round,
        workDir: this.store.targetDir,
        termCmd: `${this.deps.cliCommand} term --root ${join(this.rdir, "contractor-term")}`,
        feedback,
        regressions: s.regressions,
        previousSubmission: prev,
      }),
      systemPrompt("contractor"),
      Submission,
      s.contractor_session,
      resume,
      [],
    );
    if (!res.ok) {
      // セッションが作られていない可能性があるので、次の試行は新しいセッションで行う（文脈はプロンプトで渡す）
      if (res.error!.kind !== "aborted") s.contractor_session = null;
      return this.invalidOutput(`受注AIの実行に失敗: ${res.error!.message}`, res.error!.kind, (errs) => ({ type: "invalid_submission", errors: errs, previous: base }));
    }
    const parsed = Submission.safeParse(res.structured);
    const errors = parsed.success
      ? validateSubmission(this.order, parsed.data, { previousPassed: s.passed_criteria, pendingQuestionIds })
      : formatZodError(parsed.error);
    if (errors.length) {
      writeJsonAtomic(join(this.rdir, `submission-rejected-${s.invalid_outputs}.json`), { errors, raw: res.structured });
      this.store.event("submission_rejected", { round: s.round, errors });
      this.deps.log(`[round ${s.round}] 納品書を受理せず: ${errors.slice(0, 3).join(" / ")}`);
      s.pending_feedback = { type: "invalid_submission", errors, previous: base } satisfies Feedback;
      return this.countInvalid(`納品書の不備が上限回数を超えました: ${errors.slice(0, 3).join(" / ")}`);
    }
    const sub = parsed.data!;
    writeJsonAtomic(join(this.rdir, "submission.json"), sub);
    s.pending_feedback = null;
    s.invalid_outputs = 0;
    s.phase = "verify";
    this.store.event("submission_accepted_for_inspection", { round: s.round, status: sub.status, criteria: sub.criteria.map((c) => c.id) });
    this.deps.log(`[round ${s.round}] 納品書を受理（${sub.status}, 基準 ${sub.criteria.length} 件）→ 検証へ`);
    return false;
  }

  // ---------- オーケストレータ検証 ----------
  private async phaseVerify(): Promise<boolean> {
    const s = this.state;
    const sub = this.submission();
    const criteria = this.allCriteria(sub);
    const oldVer = this.verification();
    if (oldVer) removeEnvironment(oldVer.env_dir);
    this.deps.log(`[round ${s.round}] 検証: 新しい環境で setup と基準 ${criteria.length} 件を実行`);
    let v: Verification;
    try {
      v = await verifyDeliverable({
        targetDir: this.store.targetDir,
        orderVersion: s.order_version,
        criteriaVersion: this.criteriaVersion(sub),
        submission: sub,
        criteria: sub.status === "blocked" ? [] : criteria,
        artifactsDir: join(this.rdir, "verification"),
        commandTimeoutMs: this.config.verification.command_timeout_ms,
        setupTimeoutMs: this.config.verification.setup_timeout_ms,
        deps: { runner: this.deps.runner, driverFactory: this.deps.driverFactory, signal: this.abort.signal },
      });
    } catch (e) {
      if (this.abort.signal.aborted) throw new Interrupted();
      throw e;
    }
    writeJsonAtomic(join(this.rdir, "verification.json"), v);
    writeVerificationReport(join(this.rdir, "verification.md"), v);
    this.store.event("verified", { round: s.round, fingerprint: v.deliverable_fingerprint, failures: v.failures.length });
    if (sub.status === "delivered" && v.failures.length) {
      this.deps.log(`[round ${s.round}] 検証不合格 ${v.failures.length} 件 → 差し戻し`);
      for (const f of v.failures) this.deps.log(`    - ${f.slice(0, 200)}`);
      const results = v.results.filter((r) => r.required && (r.status === "fail" || r.status === "error"));
      s.pending_feedback = {
        type: "rework",
        source: "orchestrator",
        summary: "オーケストレータの受入検査（新しい環境での再実行）で不合格。基準自体が不適切なら change_reason を付けて直すこと。",
        rework_items: (results.length ? results : [{ criterion_id: undefined, requirement_ids: [this.order.requirements[0]!.id], detail: v.failures.join("; ") }]).map(
          (r) => ({
            category: "nonconforming_deliverable",
            requirement_ids: r.requirement_ids,
            criterion_ids: r.criterion_id ? [r.criterion_id] : [],
            reason: `新しい環境での検証で不合格: ${r.detail}`.slice(0, 2000),
            expected: "必須基準が新しい環境で合格すること",
            observed: r.detail.slice(0, 2000),
          }),
        ),
      } satisfies Feedback;
      this.recordPassed(sub, v);
      return this.nextRound();
    }
    this.recordPassed(sub, v);
    s.phase = sub.status === "blocked" ? "review" : "trial";
    return false;
  }

  private recordPassed(sub: Submission, v: Verification) {
    for (const r of v.results) {
      if (r.status !== "pass") continue;
      const c = sub.criteria.find((c) => c.id === r.criterion_id);
      if (c) this.state.passed_criteria[c.id] = criterionHash(c);
    }
  }

  // ---------- 検収: 利用者試行 ----------
  private async phaseTrial(): Promise<boolean> {
    const s = this.state;
    const sub = this.submission();
    const v = this.verification()!;
    if (!existsSync(v.env_dir)) {
      s.phase = "verify"; // 再開時に環境が消えていれば作り直す
      return false;
    }
    const identity = this.identity(sub, v);
    const sid = randomUUID();
    writeJsonAtomic(join(this.rdir, "inspector-session.json"), { session_id: sid, identity });
    const evidenceDir = join(this.rdir, "trial-evidence");
    mkdirSync(evidenceDir, { recursive: true });
    this.deps.log(`[round ${s.round}] 検収AI(利用者試行): 要求だけから独自シナリオで操作`);
    const res = await this.callHarness(
      "inspector",
      `trial-r${s.round}`,
      v.env_dir,
      trialPrompt({
        order: this.order,
        orderVersion: s.order_version,
        round: s.round,
        envDir: v.env_dir,
        homeDir: v.home_dir,
        entrypoints: sub.entrypoints,
        termCmd: `${this.deps.cliCommand} term --root ${evidenceDir}`,
        evidenceDir,
        rejection: readJsonIfExists(join(this.rdir, "trial-rejection.json")) as string[] | undefined,
      }),
      systemPrompt("trial"),
      TrialReport,
      sid,
      false,
      [evidenceDir],
    );
    if (!res.ok) return this.invalidOutput(`検収AI(試行)の実行に失敗: ${res.error!.message}`, res.error!.kind);
    const parsed = TrialReport.safeParse(res.structured);
    const errors = parsed.success ? validateTrial(this.order, parsed.data) : formatZodError(parsed.error);
    if (errors.length) {
      this.store.event("trial_rejected", { round: s.round, errors });
      writeJsonAtomic(join(this.rdir, "trial-rejection.json"), errors);
      return this.countInvalid(`試行レポートの不備が上限回数を超えました: ${errors.slice(0, 3).join(" / ")}`);
    }
    writeJsonAtomic(join(this.rdir, "trial.json"), parsed.data);
    rmSync(join(this.rdir, "trial-rejection.json"), { force: true });
    s.invalid_outputs = 0;
    s.phase = "review";
    const t = parsed.data!;
    this.deps.log(`[round ${s.round}] 試行: ${t.scenarios.length} シナリオ (fail ${t.scenarios.filter((x) => x.result === "fail").length}, 未確認 ${t.scenarios.filter((x) => x.result === "could_not_test").length + t.unverified.length})`);
    return false;
  }

  // ---------- 検収: 技術審査と判定 ----------
  private async phaseReview(): Promise<boolean> {
    const s = this.state;
    const sub = this.submission();
    const v = this.verification()!;
    const identity = this.identity(sub, v);
    const sessFile = readJsonIfExists(join(this.rdir, "inspector-session.json")) as { session_id: string; fresh?: boolean } | undefined;
    const trial = (readJsonIfExists(join(this.rdir, "trial.json")) as TrialReport | undefined) ?? null;
    const resume = !!sessFile && !!trial && !sessFile.fresh;
    const sid = sessFile?.session_id ?? randomUUID();
    if (!sessFile) writeJsonAtomic(join(this.rdir, "inspector-session.json"), { session_id: sid, identity });
    const cwd = existsSync(v.env_dir) ? v.env_dir : this.store.targetDir;
    this.deps.log(`[round ${s.round}] 検収AI(技術審査): 基準・証拠・実装を審査して判定`);
    const res = await this.callHarness(
      "inspector",
      `review-r${s.round}`,
      cwd,
      reviewPrompt({
        order: this.order,
        identity,
        round: s.round,
        submission: sub,
        verification: v,
        trial,
        regressions: s.regressions,
        changedCriteria: changedCriteria(sub, this.previousPassedBefore(sub)),
        sourceDir: cwd,
        evidenceDir: this.rdir,
        previousVerdicts: this.previousVerdicts(),
        rejection: readJsonIfExists(join(this.rdir, "review-rejection.json")) as string[] | undefined,
      }),
      systemPrompt("review"),
      Verdict,
      sid,
      resume,
      [this.rdir],
    );
    if (!res.ok) {
      if (res.error!.kind !== "aborted") writeJsonAtomic(join(this.rdir, "inspector-session.json"), { session_id: randomUUID(), identity, fresh: true });
      return this.invalidOutput(`検収AI(審査)の実行に失敗: ${res.error!.message}`, res.error!.kind);
    }
    const parsed = Verdict.safeParse(res.structured);
    const gateIn = parsed.success
      ? {
          order: this.order,
          verdict: parsed.data,
          identity,
          criteria: this.allCriteria(sub),
          verificationFailures: v.failures,
          submissionBlocked: sub.status === "blocked",
        }
      : undefined;
    const errors = gateIn ? validateVerdict(gateIn) : formatZodError(parsed.error!);
    if (errors.length) {
      writeJsonAtomic(join(this.rdir, `verdict-rejected-${s.invalid_outputs}.json`), { errors, raw: res.structured });
      this.store.event("verdict_rejected", { round: s.round, errors });
      writeJsonAtomic(join(this.rdir, "review-rejection.json"), errors);
      this.deps.log(`[round ${s.round}] 判定を受理せず: ${errors.slice(0, 3).join(" / ")}`);
      return this.countInvalid(`検収判定の不備が上限回数を超えました: ${errors.slice(0, 3).join(" / ")}`);
    }
    const gated = gateVerdict(gateIn!);
    writeJsonAtomic(join(this.rdir, "verdict.json"), { ...gated.verdict, orchestrator_overridden: gated.overridden });
    rmSync(join(this.rdir, "review-rejection.json"), { force: true });
    s.invalid_outputs = 0;
    s.phase = "decide";
    return false;
  }

  // ---------- 判定の反映（オーケストレータのみが行う） ----------
  private async phaseDecide(): Promise<boolean> {
    const s = this.state;
    const sub = this.submission();
    const v = this.verification()!;
    const verdict = Verdict.parse(stripExtra(readJson(join(this.rdir, "verdict.json"))));
    const current = fingerprint(this.store.targetDir);
    if (current !== v.deliverable_fingerprint) {
      // 検証後に成果物が変わった → 古い証拠・判定は使わない
      this.store.event("stale_evidence", { round: s.round, verified: v.deliverable_fingerprint, current });
      this.deps.log(`[round ${s.round}] 検証後に成果物が変更された (${v.deliverable_fingerprint} → ${current})。判定を破棄して再検証`);
      s.invalid_outputs++;
      if (s.invalid_outputs > this.config.limits.max_invalid_outputs) throw new Stop("failed", "検収中に成果物が繰り返し変更され、判定を確定できません。");
      s.phase = "verify";
      return false;
    }
    this.store.event("verdict", { round: s.round, verdict: verdict.verdict, identity: verdict.inspected });
    this.deps.log(`[round ${s.round}] 判定: ${verdict.verdict} — ${verdict.summary.slice(0, 200)}`);
    switch (verdict.verdict) {
      case "accepted": {
        s.accepted = { round: s.round, ...this.identity(sub, v), at: nowIso() };
        s.status = "accepted";
        s.status_reason = verdict.summary;
        this.writeDelivery(sub, v, verdict);
        removeEnvironment(v.env_dir);
        return true;
      }
      case "blocked":
        s.status = "blocked";
        s.status_reason = verdict.blockers.map((b) => `${b.requirement_ids.join(",")}: ${b.reason} → 必要: ${b.needed}`).join(" / ");
        removeEnvironment(v.env_dir);
        return true;
      case "inquiry":
        s.pending_feedback = { type: "inquiry", summary: verdict.summary, questions: verdict.questions } satisfies Feedback;
        return this.nextRound();
      case "rework": {
        await this.promoteRegressions(verdict, v);
        s.pending_feedback = { type: "rework", source: "inspector", summary: verdict.summary, rework_items: verdict.rework_items, follow_ups: verdict.follow_ups } satisfies Feedback;
        return this.nextRound();
      }
    }
  }

  /** 再現する問題を回帰基準に昇格し、現成果物で実行して再現を記録する。 */
  private async promoteRegressions(verdict: Verdict, v: Verification) {
    const s = this.state;
    const items = verdict.rework_items.filter((i) => i.regression && i.regression.type !== "review");
    for (const it of items) {
      const id = `REG${s.regressions.length + 1}`;
      const crit: RegressionCriterion = {
        id,
        requirement_ids: it.requirement_ids,
        title: `回帰: ${it.reason.slice(0, 80)}`,
        rationale: `第${s.round}回検収の差し戻し項目から昇格。期待: ${it.expected}`.slice(0, 500),
        required: true,
        check: it.regression!,
        origin_round: s.round,
        reproduced: null,
      };
      // 現在の（差し戻し対象の）成果物で実行し、問題を再現できるかを記録
      if (existsSync(v.env_dir)) {
        try {
          const rv = await verifyDeliverable({
            targetDir: this.store.targetDir,
            orderVersion: s.order_version,
            criteriaVersion: "regression-probe",
            submission: { ...this.submission(), setup: this.submission().setup },
            criteria: [crit],
            artifactsDir: join(this.rdir, "regression-probe", id),
            commandTimeoutMs: this.config.verification.command_timeout_ms,
            setupTimeoutMs: this.config.verification.setup_timeout_ms,
            deps: { runner: this.deps.runner, driverFactory: this.deps.driverFactory, signal: this.abort.signal },
          });
          crit.reproduced = rv.results[0] ? rv.results[0].status !== "pass" : null;
          removeEnvironment(rv.env_dir);
        } catch {
          crit.reproduced = null;
        }
      }
      s.regressions.push(crit);
      this.store.event("regression_added", { id, reproduced: crit.reproduced });
      this.deps.log(`[round ${s.round}] 回帰基準 ${id} を追加（現成果物で再現: ${crit.reproduced}）`);
    }
  }

  private nextRound(): boolean {
    const s = this.state;
    const v = this.verification();
    if (v) removeEnvironment(v.env_dir);
    s.round++;
    s.phase = "contract";
    s.invalid_outputs = 0;
    return false;
  }

  private invalidOutput(message: string, kind: NonNullable<HarnessResult["error"]>["kind"], fb?: (errs: string[]) => Feedback): boolean {
    if (kind === "aborted") throw new Interrupted();
    if (kind === "spawn") throw new Stop("failed", message);
    if (kind === "budget") throw new Stop("limit_reached", message);
    this.store.event("harness_error", { round: this.state.round, phase: this.state.phase, kind, message });
    this.deps.log(`[round ${this.state.round}] ${message}`);
    if (fb && this.state.phase === "contract") this.state.pending_feedback = fb([message]);
    return this.countInvalid(`ハーネス実行エラーが上限回数を超えました: ${message}`);
  }

  private countInvalid(message: string): boolean {
    const s = this.state;
    s.invalid_outputs++;
    if (s.invalid_outputs > this.config.limits.max_invalid_outputs) throw new Stop("failed", message);
    return false;
  }

  private async callHarness(
    role: Role,
    label: string,
    cwd: string,
    prompt: string,
    sys: string,
    schema: z.ZodType,
    sessionId: string,
    resume: boolean,
    addDirs: string[],
  ): Promise<HarnessResult> {
    const L = this.config.limits;
    const roleCfg: RoleConfig = this.config.harness[role];
    const remainingBudget = L.max_budget_usd - this.state.cost_usd;
    const remainingMs = L.max_minutes * 60_000 - this.state.elapsed_ms - (this.now() - this.tick);
    const res = await this.deps.harness.invoke({
      role,
      label,
      cwd,
      prompt,
      systemPrompt: sys,
      jsonSchema: jsonSchemaOf(schema),
      sessionId,
      resume,
      permissions: roleCfg,
      maxBudgetUsd: Math.max(0.01, Math.min(roleCfg.max_budget_usd_per_call, remainingBudget)),
      timeoutMs: Math.max(1000, Math.min(roleCfg.timeout_minutes * 60_000, remainingMs)),
      addDirs,
      signal: this.abort.signal,
      logPath: join(this.rdir, "harness", `${label}.json`),
    });
    this.state.cost_usd += res.costUsd;
    if (role === "contractor" && res.sessionId) this.state.contractor_session = res.sessionId;
    this.save();
    this.store.event("harness_call", { role, label, ok: res.ok, cost_usd: res.costUsd, error: res.error });
    return res;
  }

  private submission(): Submission {
    return Submission.parse(readJson(join(this.rdir, "submission.json")));
  }
  private latestSubmission(round: number): Submission | undefined {
    for (let r = round; r >= 1; r--) {
      const p = join(this.store.roundDir(r), "submission.json");
      if (existsSync(p)) return Submission.parse(readJson(p));
    }
    return undefined;
  }
  private verification(): Verification | undefined {
    return readJsonIfExists(join(this.rdir, "verification.json")) as Verification | undefined;
  }
  private identity(sub: Submission, v: Verification): Identity {
    return { order_version: this.state.order_version, deliverable_fingerprint: v.deliverable_fingerprint, criteria_version: this.criteriaVersion(sub) };
  }
  private previousPassedBefore(_sub: Submission): Record<string, string> {
    const prev = this.latestSubmission(this.state.round - 1);
    if (!prev) return {};
    const out: Record<string, string> = {};
    for (const c of prev.criteria) if (this.state.passed_criteria[c.id] !== undefined) out[c.id] = criterionHash(c);
    return out;
  }
  private previousVerdicts(): unknown[] {
    const out: unknown[] = [];
    for (let r = 1; r < this.state.round; r++) {
      const v = readJsonIfExists(join(this.store.roundDir(r), "verdict.json")) as Verdict | undefined;
      if (v) out.push({ round: r, verdict: v.verdict, summary: v.summary, rework_items: v.rework_items });
    }
    return out;
  }

  private writeDelivery(sub: Submission, v: Verification, verdict: Verdict) {
    const lines = [
      `# 納品・受入記録: ${this.order.title}`,
      ``,
      `- 受入日時: ${nowIso()}`,
      `- 要求版: ${this.state.order_version}`,
      `- 成果物 fingerprint: ${v.deliverable_fingerprint}`,
      `- 基準版: ${this.criteriaVersion(sub)}`,
      `- 検収回数: ${this.state.round}`,
      ``,
      `## 使い始め方`,
      ``,
      ...(sub.setup.length ? ["準備:", "", ...sub.setup.map((a) => `    ${a.join(" ")}`), ""] : []),
      ...sub.entrypoints.map((e) => `- **${e.id}** (${e.kind}): \`${e.argv.join(" ")}\` — ${e.description}`),
      ``,
      `## 検収判定`,
      ``,
      verdict.summary,
      ``,
      ...verdict.requirement_assessment.map((a) => `- ${a.requirement_id}: ${a.status} — ${a.basis}`),
      ``,
      ...(verdict.follow_ups.length ? ["## 後続事項（要求外・受入を妨げない）", "", ...verdict.follow_ups.map((f) => `- ${f.title}: ${f.detail}`), ""] : []),
    ];
    writeFileSync(this.store.path("DELIVERY.md"), lines.join("\n") + "\n");
  }
}

function stripExtra(v: unknown): unknown {
  if (v && typeof v === "object") {
    const { orchestrator_overridden: _o, ...rest } = v as Record<string, unknown>;
    return rest;
  }
  return v;
}

export function exitCodeFor(state: RunState): number {
  switch (state.status) {
    case "accepted":
      return EXIT.accepted;
    case "blocked":
      return EXIT.blocked;
    case "limit_reached":
      return EXIT.limit_reached;
    case "interrupted":
      return EXIT.interrupted;
    case "failed":
      return EXIT.failed;
    default:
      return EXIT.failed;
  }
}
