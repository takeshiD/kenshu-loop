// 構造化データのスキーマ。LLM出力・設定・状態はすべてここで実行時検証する。
import { z } from "zod";

const nonEmpty = z.string().trim().min(1);
const reqId = z.string().regex(/^R\d+$/, "要求IDは R<number> 形式");
const critId = z.string().regex(/^(C\d+|REG\d+)$/, "基準IDは C<number>（回帰は REG<number>）形式");

// ---------- 端末シナリオ（AI探索・回帰テスト・検証で共有） ----------

export const StyleExpectation = z
  .object({
    fg: z.union([z.string(), z.number()]).optional(),
    bg: z.union([z.string(), z.number()]).optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    inverse: z.boolean().optional(),
    dim: z.boolean().optional(),
  })
  .strict();

const timeout = z.number().int().positive().max(600_000).optional();

export const Step = z.discriminatedUnion("do", [
  z.object({ do: z.literal("type"), text: z.string() }).strict(),
  z.object({ do: z.literal("paste"), text: z.string() }).strict(),
  z.object({ do: z.literal("press"), keys: z.array(nonEmpty).min(1) }).strict(),
  z.object({ do: z.literal("submit"), text: z.string().optional() }).strict(),
  z.object({ do: z.literal("resize"), cols: z.number().int().min(2).max(500), rows: z.number().int().min(2).max(300) }).strict(),
  z.object({ do: z.literal("wait_text"), text: nonEmpty, regex: z.boolean().optional(), timeout_ms: timeout }).strict(),
  z.object({ do: z.literal("wait_gone"), text: nonEmpty, regex: z.boolean().optional(), timeout_ms: timeout }).strict(),
  z
    .object({
      do: z.literal("expect_text"),
      text: nonEmpty,
      regex: z.boolean().optional(),
      row: z.number().int().min(0).optional(),
      col: z.number().int().min(0).optional(),
    })
    .strict(),
  z.object({ do: z.literal("expect_no_text"), text: nonEmpty, regex: z.boolean().optional() }).strict(),
  z.object({ do: z.literal("expect_style"), text: nonEmpty, style: StyleExpectation }).strict(),
  z
    .object({
      do: z.literal("expect_cursor"),
      x: z.number().int().min(0).optional(),
      y: z.number().int().min(0).optional(),
      visible: z.boolean().optional(),
    })
    .strict(),
  z.object({ do: z.literal("capture"), name: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/) }).strict(),
  z.object({ do: z.literal("wait_exit"), timeout_ms: timeout, exit_code: z.number().int().optional() }).strict(),
  z.object({ do: z.literal("restart") }).strict(),
  z.object({ do: z.literal("signal"), name: z.enum(["INT", "TERM", "KILL", "QUIT"]) }).strict(),
  z
    .object({
      do: z.literal("expect_file"),
      path: nonEmpty,
      exists: z.boolean().optional(),
      includes: z.array(z.string()).optional(),
    })
    .strict(),
]);
export type Step = z.infer<typeof Step>;

export const Launch = z
  .object({
    argv: z.array(nonEmpty).min(1),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    cols: z.number().int().min(2).max(500).optional(),
    rows: z.number().int().min(2).max(300).optional(),
  })
  .strict();
export type Launch = z.infer<typeof Launch>;

export const Scenario = z.object({ launch: Launch, steps: z.array(Step).min(1) }).strict();
export type Scenario = z.infer<typeof Scenario>;

// ---------- 発注書 ----------

export const Requirement = z
  .object({
    id: reqId,
    kind: z.enum(["goal", "usage", "constraint"]),
    text: nonEmpty,
    must: z.boolean().default(true),
  })
  .strict();

export const Order = z
  .object({
    schema: z.literal("kenshu-loop/order@1"),
    title: nonEmpty,
    summary: nonEmpty,
    deliverable_type: z.enum(["cli", "tui", "cli+tui", "library", "other"]),
    context: z.string().default(""),
    requirements: z.array(Requirement).min(1),
    out_of_scope: z.array(nonEmpty).default([]),
  })
  .strict()
  .superRefine((o, ctx) => {
    const seen = new Set<string>();
    for (const r of o.requirements) {
      if (seen.has(r.id)) ctx.addIssue({ code: "custom", message: `要求IDが重複: ${r.id}`, path: ["requirements"] });
      seen.add(r.id);
    }
  });
export type Order = z.infer<typeof Order>;

// ---------- 検査基準 ----------

export const CommandCheck = z
  .object({
    type: z.literal("command"),
    argv: z.array(nonEmpty).min(1),
    cwd: z.string().optional(),
    stdin: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    timeout_ms: timeout,
    expect: z
      .object({
        exit_code: z.number().int().optional(),
        stdout_includes: z.array(z.string()).optional(),
        stdout_excludes: z.array(z.string()).optional(),
        stderr_includes: z.array(z.string()).optional(),
        stdout_regex: z.string().optional(),
        files: z
          .array(z.object({ path: nonEmpty, exists: z.boolean().optional(), includes: z.array(z.string()).optional() }).strict())
          .optional(),
      })
      .strict()
      .refine((e) => Object.values(e).some((v) => v !== undefined), "expect に最低1つの期待値が必要"),
  })
  .strict();

export const TuiCheck = z.object({ type: z.literal("tui"), scenario: Scenario }).strict();
export const ReviewCheck = z.object({ type: z.literal("review"), instructions: nonEmpty }).strict();
export const Check = z.discriminatedUnion("type", [CommandCheck, TuiCheck, ReviewCheck]);
export type Check = z.infer<typeof Check>;

export const Criterion = z
  .object({
    id: critId,
    requirement_ids: z.array(reqId).min(1),
    title: nonEmpty,
    rationale: z.string().trim().min(8, "根拠(rationale)は具体的に"),
    required: z.boolean().default(true),
    check: Check,
    change_reason: z.string().optional(),
  })
  .strict();
export type Criterion = z.infer<typeof Criterion>;

// ---------- 受注AIの納品書 ----------

export const Entrypoint = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]{1,32}$/),
    kind: z.enum(["cli", "tui"]),
    argv: z.array(nonEmpty).min(1),
    description: nonEmpty,
  })
  .strict();

export const Blocker = z
  .object({ requirement_ids: z.array(reqId).min(1), reason: z.string().trim().min(8), needed: nonEmpty })
  .strict();

export const Submission = z
  .object({
    status: z.enum(["delivered", "blocked"]),
    summary: nonEmpty,
    setup: z.array(z.array(nonEmpty).min(1)).default([]),
    entrypoints: z.array(Entrypoint).default([]),
    criteria: z.array(Criterion).default([]),
    self_check: z
      .array(z.object({ criterion_id: critId, result: z.enum(["pass", "fail", "not_run"]), note: z.string() }).strict())
      .default([]),
    removed_criteria: z.array(z.object({ id: critId, reason: z.string().trim().min(8) }).strict()).default([]),
    blockers: z.array(Blocker).default([]),
    answers: z.array(z.object({ question_id: nonEmpty, answer: nonEmpty }).strict()).default([]),
  })
  .strict();
export type Submission = z.infer<typeof Submission>;

// ---------- 検収AI: 利用者試行レポート ----------

export const TrialReport = z
  .object({
    scenarios: z
      .array(
        z
          .object({
            id: z.string().regex(/^S\d+$/),
            requirement_ids: z.array(reqId).min(1),
            title: nonEmpty,
            intent: nonEmpty,
            operations: nonEmpty,
            expected: nonEmpty,
            actual: nonEmpty,
            result: z.enum(["pass", "fail", "could_not_test"]),
            evidence: z.array(z.string()).default([]),
          })
          .strict(),
      )
      .min(1),
    unverified: z.array(z.object({ requirement_ids: z.array(reqId).min(1), reason: nonEmpty }).strict()).default([]),
    notes: z.string().default(""),
  })
  .strict();
export type TrialReport = z.infer<typeof TrialReport>;

// ---------- 検収AI: 判定 ----------

export const ReworkItem = z
  .object({
    category: z.enum(["nonconforming_deliverable", "inadequate_criteria", "insufficient_evidence"]),
    requirement_ids: z.array(reqId).min(1),
    criterion_ids: z.array(critId).default([]),
    reason: z.string().trim().min(10, "差し戻し理由は具体的に"),
    expected: nonEmpty,
    observed: z.string().default(""),
    regression: Check.optional(),
  })
  .strict();
export type ReworkItem = z.infer<typeof ReworkItem>;

export const Verdict = z
  .object({
    verdict: z.enum(["accepted", "rework", "blocked", "inquiry"]),
    inspected: z
      .object({ order_version: nonEmpty, deliverable_fingerprint: nonEmpty, criteria_version: nonEmpty })
      .strict(),
    requirement_assessment: z
      .array(
        z
          .object({
            requirement_id: reqId,
            status: z.enum(["satisfied", "not_satisfied", "unverified"]),
            basis: nonEmpty,
            evidence_refs: z.array(z.string()).default([]),
          })
          .strict(),
      )
      .min(1),
    criteria_assessment: z
      .array(z.object({ criterion_id: critId, adequate: z.boolean(), comment: z.string() }).strict())
      .default([]),
    rework_items: z.array(ReworkItem).default([]),
    questions: z
      .array(z.object({ id: z.string().regex(/^Q\d+$/), question: nonEmpty, requirement_ids: z.array(reqId).min(1) }).strict())
      .default([]),
    blockers: z.array(Blocker).default([]),
    follow_ups: z.array(z.object({ title: nonEmpty, detail: z.string() }).strict()).default([]),
    summary: nonEmpty,
  })
  .strict();
export type Verdict = z.infer<typeof Verdict>;

// ---------- 設定 ----------

const RoleConfig = z
  .object({
    permission_mode: z.enum(["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]),
    allowed_tools: z.array(z.string()),
    disallowed_tools: z.array(z.string()),
    max_budget_usd_per_call: z.number().positive(),
    timeout_minutes: z.number().positive(),
  })
  .strict();
export type RoleConfig = z.infer<typeof RoleConfig>;

export const Config = z
  .object({
    schema: z.literal("kenshu-loop/config@1"),
    harness: z
      .object({
        kind: z.literal("claude-code"),
        bin: nonEmpty,
        model: z.string().optional(),
        contractor: RoleConfig,
        inspector: RoleConfig,
      })
      .strict(),
    limits: z
      .object({
        max_rounds: z.number().int().min(1),
        max_minutes: z.number().positive(),
        max_budget_usd: z.number().positive(),
        max_invalid_outputs: z.number().int().min(0),
      })
      .strict(),
    verification: z
      .object({
        command_timeout_ms: z.number().int().positive(),
        setup_timeout_ms: z.number().int().positive(),
      })
      .strict(),
    deploy_policy: z.literal("none"),
  })
  .strict();
export type Config = z.infer<typeof Config>;

export function defaultConfig(): Config {
  return {
    schema: "kenshu-loop/config@1",
    harness: {
      kind: "claude-code",
      bin: "claude",
      contractor: {
        // 対象ディレクトリ内の編集を自動承認し、それ以外の確認が必要な操作は拒否する（ヘッドレス実行のため）。
        permission_mode: "acceptEdits",
        allowed_tools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
        disallowed_tools: ["WebFetch", "WebSearch"],
        max_budget_usd_per_call: 2,
        timeout_minutes: 30,
      },
      inspector: {
        // 検収側は成果物を編集しない。Bashは成果物と kenshu-loop term の起動に使う。
        permission_mode: "dontAsk",
        allowed_tools: ["Read", "Glob", "Grep", "Bash"],
        disallowed_tools: ["Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"],
        max_budget_usd_per_call: 1,
        timeout_minutes: 20,
      },
    },
    limits: { max_rounds: 4, max_minutes: 120, max_budget_usd: 10, max_invalid_outputs: 2 },
    verification: { command_timeout_ms: 60_000, setup_timeout_ms: 300_000 },
    deploy_policy: "none",
  };
}

// ---------- 実行状態 ----------

export const Phase = z.enum(["contract", "verify", "trial", "review", "decide"]);
export type Phase = z.infer<typeof Phase>;

export const RunStatus = z.enum([
  "ready_to_run", // init直後
  "running",
  "interrupted", // 中断（resume可能）
  "accepted",
  "blocked",
  "limit_reached",
  "failed", // 実行エラー（resume可能）
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const RegressionCriterion = Criterion.extend({ origin_round: z.number().int(), reproduced: z.boolean().nullable() });
export type RegressionCriterion = z.infer<typeof RegressionCriterion>;

export const RunState = z
  .object({
    schema: z.literal("kenshu-loop/state@1"),
    order_version: z.string(),
    status: RunStatus,
    status_reason: z.string().default(""),
    round: z.number().int().min(0),
    phase: Phase,
    invalid_outputs: z.number().int().min(0),
    elapsed_ms: z.number().min(0),
    cost_usd: z.number().min(0),
    contractor_session: z.string().nullable(),
    pending_feedback: z.unknown().nullable(),
    regressions: z.array(RegressionCriterion),
    passed_criteria: z.record(z.string(), z.string()), // criterion id -> 合格時のcanonical hash
    accepted: z
      .object({
        round: z.number().int(),
        order_version: z.string(),
        deliverable_fingerprint: z.string(),
        criteria_version: z.string(),
        at: z.string(),
      })
      .nullable(),
    updated_at: z.string(),
  })
  .strict();
export type RunState = z.infer<typeof RunState>;

export function formatZodError(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`);
}

/** Claude Code の --json-schema に渡すJSON Schema（draft-07。Claude Code 2.1.x は $schema=2020-12 を受け付けない）。 */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const s = z.toJSONSchema(schema, { io: "input", unrepresentable: "any", target: "draft-7" }) as Record<string, unknown>;
  delete s.$schema;
  return strictCompatible(s) as Record<string, unknown>;
}

/** Ajv strict モード互換に変換: `type: [a, b]` を `anyOf` に分解する。 */
function strictCompatible(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictCompatible);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = strictCompatible(v);
  if (Array.isArray(out.type)) {
    const types = out.type as string[];
    delete out.type;
    const variants = types.map((t) => ({ type: t }));
    if (out.anyOf) return { allOf: [{ anyOf: variants }, { anyOf: out.anyOf }], ...omit(out, "anyOf") };
    out.anyOf = variants;
  }
  return out;
}
function omit(o: Record<string, unknown>, k: string) {
  const { [k]: _x, ...rest } = o;
  return rest;
}
