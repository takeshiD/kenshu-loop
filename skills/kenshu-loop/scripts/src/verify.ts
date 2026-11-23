// オーケストレータ自身による検証: 新しい環境に納品物を展開し、setup→基準を実プロセス/PTYで再実行する。
// 受注AIの自己申告結果ではなく、ここで得た結果だけを「検証済み証拠」とする。
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Criterion, RegressionCriterion, Submission } from "./schema.ts";
import { isolatedEnv, type CommandRunner, type ExecResult } from "./exec.ts";
import { copyDeliverable, fingerprint } from "./workspace.ts";
import { runScenario, type ScenarioResult } from "./terminal/session.ts";
import type { DriverFactory } from "./terminal/driver.ts";
import { redact, truncate } from "./util.ts";

export interface CriterionResult {
  criterion_id: string;
  requirement_ids: string[];
  required: boolean;
  type: "command" | "tui" | "review";
  status: "pass" | "fail" | "error" | "needs_review";
  detail: string;
  command?: { argv: string[]; exit_code: number | null; stdout: string; stderr: string; timed_out: boolean; duration_ms: number };
  scenario?: ScenarioResult;
}

export interface Verification {
  order_version: string;
  deliverable_fingerprint: string;
  criteria_version: string;
  env_dir: string;
  home_dir: string;
  setup: Array<{ argv: string[]; exit_code: number | null; ok: boolean; stdout: string; stderr: string; duration_ms: number }>;
  setup_ok: boolean;
  results: CriterionResult[];
  failures: string[];
  started_at: string;
  finished_at: string;
}

export interface VerifyDeps {
  runner: CommandRunner;
  driverFactory: DriverFactory;
  signal?: AbortSignal;
}

export interface Environment {
  envDir: string;
  homeDir: string;
}

export function createEnvironment(targetDir: string): Environment {
  const base = mkdtempSync(join(tmpdir(), "kenshu-env-"));
  const envDir = join(base, "work");
  const homeDir = join(base, "home");
  mkdirSync(envDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  copyDeliverable(targetDir, envDir);
  return { envDir, homeDir };
}
export function removeEnvironment(envDir: string): void {
  if (envDir && envDir.includes("kenshu-env-")) rmSync(resolve(envDir, ".."), { recursive: true, force: true });
}

export async function verifyDeliverable(args: {
  targetDir: string;
  orderVersion: string;
  criteriaVersion: string;
  submission: Submission;
  criteria: Array<Criterion | RegressionCriterion>;
  artifactsDir: string;
  commandTimeoutMs: number;
  setupTimeoutMs: number;
  deps: VerifyDeps;
}): Promise<Verification> {
  const started = new Date().toISOString();
  const fp = fingerprint(args.targetDir);
  const env = createEnvironment(args.targetDir);
  // コピー後の環境でも識別が一致することを確認（コピー漏れの検出）
  const envFp = fingerprint(env.envDir);
  const v: Verification = {
    order_version: args.orderVersion,
    deliverable_fingerprint: fp,
    criteria_version: args.criteriaVersion,
    env_dir: env.envDir,
    home_dir: env.homeDir,
    setup: [],
    setup_ok: true,
    results: [],
    failures: [],
    started_at: started,
    finished_at: "",
  };
  if (envFp !== fp) {
    v.setup_ok = false;
    v.failures.push(`検査環境へのコピーが納品物と一致しません (${fp} != ${envFp})`);
  }
  for (const argv of args.submission.setup) {
    if (!v.setup_ok) break;
    const r = await args.deps.runner.run({ argv, cwd: env.envDir, env: isolatedEnv(env.homeDir), timeoutMs: args.setupTimeoutMs, signal: args.deps.signal });
    const ok = r.exitCode === 0 && !r.timedOut && !r.spawnError;
    v.setup.push({ argv, exit_code: r.exitCode, ok, stdout: clip(r.stdout), stderr: clip(r.stderr || r.spawnError || ""), duration_ms: r.durationMs });
    if (!ok) {
      v.setup_ok = false;
      v.failures.push(`setup ${JSON.stringify(argv)} が新しい環境で失敗 (exit ${r.exitCode}${r.timedOut ? ", timeout" : ""}${r.spawnError ? `, ${r.spawnError}` : ""}): ${clip(r.stderr, 400)}`);
    }
    if (args.deps.signal?.aborted) throw new Error("aborted");
  }

  for (const c of args.criteria) {
    if (args.deps.signal?.aborted) throw new Error("aborted");
    const base = { criterion_id: c.id, requirement_ids: c.requirement_ids, required: c.required, type: c.check.type };
    if (!v.setup_ok) {
      v.results.push({ ...base, status: "error", detail: "setup失敗のため未実行" });
      continue;
    }
    let res: CriterionResult;
    // 基準ごとに独立した空のHOME（基準間の順序依存を防ぐ）
    const cEnv: Environment = { envDir: env.envDir, homeDir: join(env.homeDir, "..", `home-${c.id}`) };
    mkdirSync(cEnv.homeDir, { recursive: true });
    if (c.check.type === "review") {
      res = { ...base, status: "needs_review", detail: `検収AIの審査が必要: ${c.check.instructions}` };
    } else if (c.check.type === "command") {
      res = await runCommandCheck(c, c.check, cEnv, args.commandTimeoutMs, args.deps);
    } else {
      const sc = await runScenario(args.deps.driverFactory, c.check.scenario, {
        baseDir: env.envDir,
        home: cEnv.homeDir,
        env: stringEnv(isolatedEnv(cEnv.homeDir)),
        artifactsDir: join(args.artifactsDir, c.id),
      });
      res = {
        ...base,
        status: sc.status,
        detail: sc.status === "pass" ? `${sc.steps.length} ステップ合格` : (sc.failure ?? sc.status),
        scenario: sc,
      };
    }
    v.results.push(res);
  }
  for (const r of v.results) {
    if (r.required && (r.status === "fail" || r.status === "error")) v.failures.push(`${r.criterion_id} (${r.requirement_ids.join(",")}): ${r.detail}`);
  }
  v.finished_at = new Date().toISOString();
  mkdirSync(args.artifactsDir, { recursive: true });
  return v;
}

async function runCommandCheck(
  c: { id: string; requirement_ids: string[]; required: boolean },
  check: Extract<Criterion["check"], { type: "command" }>,
  env: Environment,
  defaultTimeout: number,
  deps: VerifyDeps,
): Promise<CriterionResult> {
  const cwd = check.cwd ? resolveIn(env, check.cwd, env.envDir) : env.envDir;
  const r: ExecResult = await deps.runner.run({
    argv: check.argv.map((a) => a.replace(/^\$HOME(?=\/|$)/, env.homeDir)),
    cwd,
    env: isolatedEnv(env.homeDir, check.env ?? {}),
    stdin: check.stdin,
    timeoutMs: check.timeout_ms ?? defaultTimeout,
    signal: deps.signal,
  });
  const problems: string[] = [];
  const e = check.expect;
  if (r.spawnError) problems.push(`起動できない: ${r.spawnError}`);
  if (r.timedOut) problems.push("タイムアウト");
  if (e.exit_code !== undefined && r.exitCode !== e.exit_code) problems.push(`終了コード 期待=${e.exit_code} 実際=${r.exitCode}`);
  for (const s of e.stdout_includes ?? []) if (!r.stdout.includes(s)) problems.push(`stdoutに ${JSON.stringify(s)} が無い`);
  for (const s of e.stdout_excludes ?? []) if (r.stdout.includes(s)) problems.push(`stdoutに ${JSON.stringify(s)} が含まれる`);
  for (const s of e.stderr_includes ?? []) if (!r.stderr.includes(s)) problems.push(`stderrに ${JSON.stringify(s)} が無い`);
  if (e.stdout_regex) {
    try {
      if (!new RegExp(e.stdout_regex, "mu").test(r.stdout)) problems.push(`stdoutが /${e.stdout_regex}/ に一致しない`);
    } catch (err) {
      problems.push(`不正な正規表現: ${(err as Error).message}`);
    }
  }
  for (const f of e.files ?? []) {
    const p = resolveIn(env, f.path, cwd);
    const exists = existsSync(p);
    if ((f.exists ?? true) !== exists) problems.push(`ファイル ${f.path} ${exists ? "が存在する" : "が存在しない"}`);
    else if (exists && f.includes) {
      const body = readFileSync(p, "utf8");
      for (const s of f.includes) if (!body.includes(s)) problems.push(`ファイル ${f.path} に ${JSON.stringify(s)} が無い`);
    }
  }
  return {
    criterion_id: c.id,
    requirement_ids: c.requirement_ids,
    required: c.required,
    type: "command",
    status: r.spawnError ? "error" : problems.length ? "fail" : "pass",
    detail: problems.length ? problems.join("; ") : "期待どおり",
    command: { argv: check.argv, exit_code: r.exitCode, stdout: clip(r.stdout), stderr: clip(r.stderr), timed_out: r.timedOut, duration_ms: r.durationMs },
  };
}

function resolveIn(env: Environment, p: string, base: string): string {
  const expanded = p.replace(/^(\$HOME|~)(?=\/|$)/, env.homeDir);
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}
function clip(s: string, n = 4000): string {
  return redact(truncate(s, n));
}
function stringEnv(e: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(e)) if (typeof v === "string") out[k] = v;
  return out;
}

export function writeVerificationReport(path: string, v: Verification): void {
  const lines = [
    `# 検証結果`,
    ``,
    `- 要求版: ${v.order_version}`,
    `- 成果物: ${v.deliverable_fingerprint}`,
    `- 基準版: ${v.criteria_version}`,
    `- setup: ${v.setup_ok ? "OK" : "失敗"}`,
    ``,
    `| 基準 | 要求 | 種別 | 結果 | 詳細 |`,
    `|---|---|---|---|---|`,
    ...v.results.map((r) => `| ${r.criterion_id} | ${r.requirement_ids.join(",")} | ${r.type} | ${r.status} | ${r.detail.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 200)} |`),
  ];
  writeFileSync(path, lines.join("\n") + "\n");
}
