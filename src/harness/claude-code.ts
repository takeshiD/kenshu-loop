// Claude Code CLI アダプタ。
// 使用フラグは `claude --help` (v2.1.x) で確認済み: -p, --output-format json, --json-schema,
// --session-id / --resume, --permission-mode, --permission-prompts none, --allowedTools, --disallowedTools,
// --max-budget-usd, --append-system-prompt, --add-dir, --model。
// 結果JSONの structured_output / total_cost_usd / subtype / is_error / session_id を読む。
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CommandRunner } from "../exec.ts";
import type { HarnessAdapter, HarnessRequest, HarnessResult } from "./types.ts";
import { redact, truncate } from "../util.ts";

export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly name = "claude-code";
  private bin: string;
  private runner: CommandRunner;
  private model?: string;
  constructor(bin: string, runner: CommandRunner, model?: string) {
    this.bin = bin;
    this.runner = runner;
    this.model = model;
  }

  buildArgs(req: HarnessRequest): string[] {
    const args = [
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(req.jsonSchema),
      req.resume ? "--resume" : "--session-id",
      req.sessionId,
      "--permission-mode",
      req.permissions.permission_mode,
      "--permission-prompts",
      "none",
      "--max-budget-usd",
      String(req.maxBudgetUsd),
      "--append-system-prompt",
      req.systemPrompt,
    ];
    if (req.permissions.allowed_tools.length) args.push("--allowedTools", req.permissions.allowed_tools.join(","));
    if (req.permissions.disallowed_tools.length) args.push("--disallowedTools", req.permissions.disallowed_tools.join(","));
    for (const d of req.addDirs) args.push("--add-dir", d);
    if (this.model) args.push("--model", this.model);
    return args;
  }

  async invoke(req: HarnessRequest): Promise<HarnessResult> {
    const args = this.buildArgs(req);
    const env = { ...process.env };
    // 入れ子起動時に親セッションの設定を引き継がない
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    const res = await this.runner.run({
      argv: [this.bin, ...args],
      cwd: req.cwd,
      env,
      stdin: req.prompt,
      timeoutMs: req.timeoutMs,
      signal: req.signal,
      maxOutputBytes: 32 * 1024 * 1024,
    });
    const base = { sessionId: req.sessionId, costUsd: 0 };
    const record: Record<string, unknown> = {
      label: req.label,
      role: req.role,
      argv: [this.bin, ...args.map((a) => (a === req.systemPrompt || a === JSON.stringify(req.jsonSchema) ? `<${a.length} chars>` : a))],
      exit_code: res.exitCode,
      signal: res.signal,
      timed_out: res.timedOut,
      aborted: res.aborted,
      duration_ms: res.durationMs,
      stderr: redact(truncate(res.stderr, 4000)),
    };
    const save = (extra: Record<string, unknown>) => {
      mkdirSync(dirname(req.logPath), { recursive: true });
      writeFileSync(req.logPath, JSON.stringify({ ...record, ...extra }, null, 2));
    };
    if (res.aborted) {
      save({});
      return { ...base, ok: false, error: { kind: "aborted", message: "中断されました" } };
    }
    if (res.timedOut) {
      save({});
      return { ...base, ok: false, error: { kind: "timeout", message: `ハーネスが ${req.timeoutMs}ms でタイムアウト` } };
    }
    if (res.spawnError) {
      save({});
      return { ...base, ok: false, error: { kind: "spawn", message: `${this.bin} を起動できません: ${res.spawnError}` } };
    }
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(res.stdout.trim().split("\n").filter(Boolean).pop() ?? "");
    } catch {
      save({ stdout: redact(truncate(res.stdout, 4000)) });
      const hint = redact(res.stderr.trim().split("\n")[0] ?? "").slice(0, 300);
      return { ...base, ok: false, error: { kind: "parse", message: `結果JSONを解析できません (exit ${res.exitCode})${hint ? `: ${hint}` : ""}` } };
    }
    const cost = typeof json.total_cost_usd === "number" ? json.total_cost_usd : 0;
    const sessionId = typeof json.session_id === "string" ? json.session_id : req.sessionId;
    // 認証関連などの余計なフィールドは保存しない（ホワイトリスト）
    save({
      result: {
        subtype: json.subtype,
        is_error: json.is_error,
        session_id: sessionId,
        total_cost_usd: cost,
        num_turns: json.num_turns,
        duration_ms: json.duration_ms,
        terminal_reason: json.terminal_reason,
        errors: json.errors,
        permission_denials: Array.isArray(json.permission_denials)
          ? (json.permission_denials as Array<Record<string, unknown>>).map((d) => d.tool_name ?? "?")
          : undefined,
        result_text: typeof json.result === "string" ? redact(truncate(json.result, 6000)) : undefined,
        structured_output: json.structured_output,
      },
    });
    const out = { ...base, sessionId, costUsd: cost };
    if (json.subtype === "error_max_budget_usd") {
      return { ...out, ok: false, error: { kind: "budget", message: `1回あたりの予算上限 $${req.maxBudgetUsd} に到達` } };
    }
    if (json.is_error || (json.subtype && json.subtype !== "success")) {
      return { ...out, ok: false, error: { kind: "harness_error", message: `${String(json.subtype)}: ${JSON.stringify(json.errors ?? json.result ?? "")}`.slice(0, 500) } };
    }
    if (json.structured_output === undefined || json.structured_output === null) {
      return { ...out, ok: false, error: { kind: "no_structured_output", message: "structured_output がありません" } };
    }
    return { ...out, ok: true, structured: json.structured_output };
  }
}
