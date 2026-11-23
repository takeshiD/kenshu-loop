import { parseArgs } from "node:util";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Store } from "./store.ts";
import { Config, Order, Scenario, Submission, TrialReport, Verdict, defaultConfig, formatZodError, jsonSchemaOf, Step, type RunState } from "./schema.ts";
import { Orchestrator, newState, orderVersion, exitCodeFor, EXIT } from "./orchestrator.ts";
import { ClaudeCodeAdapter } from "./harness/claude-code.ts";
import { nodeRunner, isolatedEnv, killAllChildren } from "./exec.ts";
import { TuiTestDriver } from "./terminal/driver.ts";
import { runScenario } from "./terminal/session.ts";
import { CLI_PATH, request, serve, sessionDir, startDaemon } from "./terminal/daemon.ts";
import { fingerprint } from "./workspace.ts";
import { KenshuError, readJson, writeJsonAtomic } from "./util.ts";
import { SKILL_DIR } from "./prompts.ts";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;

const HELP = `kenshu-loop ${VERSION} — 発注・納品・検収型エージェントループ

使い方:
  kenshu-loop init   --order <order.json> [--dir <対象>] [--force] [--model <m>] [--claude-bin <path>]
  kenshu-loop run    [--dir <対象>]        受注→検証→検収のループを実行（前面）
  kenshu-loop resume [--dir <対象>]        中断/実行エラー/上限到達から再開
  kenshu-loop status [--dir <対象>] [--json]
  kenshu-loop schema <order|submission|trial|verdict|scenario|order-example>
  kenshu-loop term   <start|screen|type|paste|press|resize|wait|step|capture|restart|stop|run-scenario> ...
                     （kenshu-loop term --help を参照）

共通オプション:
  --dir <path>        対象の作業ディレクトリ（既定: カレント）
  --state-dir <path>  状態保存先（既定: <dir>/.kenshu）

終了コード: 0=accepted 1=使い方/入力エラー 2=blocked 3=limit_reached 4=failed 5=多重起動 130=interrupted
`;

const TERM_HELP = `kenshu-loop term — 端末アプリをPTYで操作する（AI探索と回帰シナリオで共通の実行器）

  term start   --name <s> [--cols 80] [--rows 24] [--cwd <dir>] [--env K=V ...] [--inherit-home] -- <argv...>
  term screen  --name <s> [--style]
  term type    --name <s> <text>
  term paste   --name <s> <text>
  term press   --name <s> <key...>          例: Down Enter Ctrl+C Escape F1
  term resize  --name <s> <cols> <rows>
  term wait    --name <s> <text> [--gone] [--regex] [--timeout <ms>]
  term step    --name <s> '<step json>'
  term capture --name <s> <label>
  term restart --name <s>
  term stop    --name <s>
  term run-scenario <scenario.json> [--cwd <dir>] [--out <dir>] [--inherit-home]

  --root <dir>  セッション/証拠の保存先（既定: ./.kenshu/term）
`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(HELP);
    return cmd ? 0 : 1;
  }
  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write(VERSION + "\n");
    return 0;
  }
  switch (cmd) {
    case "init":
      return cmdInit(rest);
    case "run":
      return cmdRun(rest, false);
    case "resume":
      return cmdRun(rest, true);
    case "status":
      return cmdStatus(rest);
    case "schema":
      return cmdSchema(rest);
    case "term":
      return cmdTerm(rest);
    default:
      process.stderr.write(`不明なコマンド: ${cmd}\n\n${HELP}`);
      return 1;
  }
}

const common = {
  dir: { type: "string" as const },
  "state-dir": { type: "string" as const },
};

function storeFrom(values: { dir?: string; "state-dir"?: string }): Store {
  return new Store(values.dir ?? process.cwd(), values["state-dir"]);
}

function cmdInit(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: { ...common, order: { type: "string" }, force: { type: "boolean" }, model: { type: "string" }, "claude-bin": { type: "string" } },
  });
  if (!values.order) throw new KenshuError("--order <order.json> が必要です（雛形: kenshu-loop schema order-example）", 1);
  const store = storeFrom(values);
  if (!existsSync(store.targetDir)) throw new KenshuError(`対象ディレクトリがありません: ${store.targetDir}`, 1);
  let raw: unknown;
  try {
    raw = readJson(resolve(values.order));
  } catch (e) {
    throw new KenshuError(`発注書を読めません: ${(e as Error).message}`, 1);
  }
  const parsed = Order.safeParse(raw);
  if (!parsed.success) throw new KenshuError(`発注書が不正です:\n  ${formatZodError(parsed.error).join("\n  ")}`, 1);
  if (store.exists() && !values.force) throw new KenshuError(`既に初期化済みです: ${store.dir}（再発注は --force）`, 1);
  if (store.exists()) {
    const release = store.acquireLock();
    release();
  }
  mkdirSync(store.dir, { recursive: true });
  const cfgPath = store.path("config.json");
  let config: Config;
  if (existsSync(cfgPath)) config = store.loadConfig();
  else config = defaultConfig();
  if (values.model) config.harness.model = values.model;
  if (values["claude-bin"]) config.harness.bin = values["claude-bin"];
  writeJsonAtomic(cfgPath, Config.parse(config));
  writeJsonAtomic(store.path("order.json"), parsed.data);
  const ver = orderVersion(parsed.data);
  writeJsonAtomic(store.path("orders", `${ver}.json`), parsed.data);
  store.saveState(newState(ver));
  // .kenshu を対象リポジトリの差分に混ぜない（.git/info/exclude はコミットされない）
  const exclude = join(store.targetDir, ".git", "info", "exclude");
  if (existsSync(join(store.targetDir, ".git")) && store.dir.startsWith(store.targetDir)) {
    const cur = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (!cur.split("\n").includes(".kenshu/")) {
      mkdirSync(join(store.targetDir, ".git", "info"), { recursive: true });
      writeFileSync(exclude, cur + (cur.endsWith("\n") || cur === "" ? "" : "\n") + ".kenshu/\n");
    }
  }
  store.event("init", { order_version: ver });
  const c = config.harness;
  process.stdout.write(
    [
      `初期化しました: ${store.dir}`,
      `  要求版: ${ver}（要求 ${parsed.data.requirements.length} 件）`,
      `  ハーネス: Claude Code (${c.bin}${c.model ? `, model=${c.model}` : ""})`,
      `  受注AIの権限: permission_mode=${c.contractor.permission_mode}, tools=${c.contractor.allowed_tools.join(",")}, cwd=${store.targetDir}`,
      `  検収AIの権限: permission_mode=${c.inspector.permission_mode}, tools=${c.inspector.allowed_tools.join(",")}, 禁止=${c.inspector.disallowed_tools.join(",")}`,
      `  上限: ${config.limits.max_rounds} 回 / ${config.limits.max_minutes} 分 / $${config.limits.max_budget_usd}`,
      `  注意: 受注AIは対象ディレクトリで Bash を実行できます。別セッション・別ディレクトリはOSレベルの隔離ではありません。`,
      `  変更は ${cfgPath} を編集してください。次: kenshu-loop run --dir ${store.targetDir}`,
      "",
    ].join("\n"),
  );
  return 0;
}

async function cmdRun(args: string[], isResume: boolean): Promise<number> {
  const { values } = parseArgs({ args, options: { ...common, quiet: { type: "boolean" } } });
  const store = storeFrom(values);
  const pre = store.loadState();
  if (!isResume && pre.status !== "ready_to_run") {
    throw new KenshuError(`この発注は既に実行されています（status=${pre.status}）。続きは kenshu-loop resume、状態は kenshu-loop status。`, 1);
  }
  if (isResume && (pre.status === "accepted" || pre.status === "blocked")) {
    process.stdout.write(`終了済みです: ${pre.status} — ${pre.status_reason}\n`);
    return exitCodeFor(pre);
  }
  const release = store.acquireLock();
  const config = store.loadConfig();
  const orch = new Orchestrator(store, {
    harness: new ClaudeCodeAdapter(process.env.KENSHU_CLAUDE_BIN ?? config.harness.bin, nodeRunner, config.harness.model),
    runner: nodeRunner,
    driverFactory: () => new TuiTestDriver(),
    cliCommand: `${process.execPath} ${CLI_PATH}`,
    log: (l) => {
      if (!values.quiet) process.stderr.write(l + "\n");
    },
  });
  let signals = 0;
  const onSignal = (sig: NodeJS.Signals) => {
    signals++;
    process.stderr.write(`\n${sig} を受信: 中断して状態を保存します…\n`);
    orch.interrupt();
    if (signals >= 2) {
      killAllChildren("SIGKILL");
      release();
      process.exit(EXIT.interrupted);
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
  process.on("exit", release);
  let state: RunState;
  try {
    state = await orch.run();
  } finally {
    release();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
  }
  printSummary(store, state);
  return exitCodeFor(state);
}

function printSummary(store: Store, s: RunState) {
  const lines = [`status: ${s.status}`, `round: ${s.round} phase: ${s.phase}`, `cost: $${s.cost_usd.toFixed(4)} elapsed: ${Math.round(s.elapsed_ms / 1000)}s`];
  if (s.status_reason) lines.push(`reason: ${s.status_reason}`);
  if (s.accepted) lines.push(`accepted: order=${s.accepted.order_version} deliverable=${s.accepted.deliverable_fingerprint} criteria=${s.accepted.criteria_version}`, `納品記録: ${store.path("DELIVERY.md")}`);
  process.stdout.write(lines.join("\n") + "\n");
}

function cmdStatus(args: string[]): number {
  const { values } = parseArgs({ args, options: { ...common, json: { type: "boolean" } } });
  const store = storeFrom(values);
  const s = store.loadState();
  let lock: unknown = null;
  if (existsSync(store.path("lock"))) {
    try {
      lock = JSON.parse(readFileSync(store.path("lock"), "utf8"));
    } catch {
      lock = "unreadable";
    }
  }
  const current = fingerprint(store.targetDir);
  const stale = s.accepted ? s.accepted.deliverable_fingerprint !== current : false;
  const verdictPath = join(store.roundDir(s.round), "verdict.json");
  const lastVerdict = existsSync(verdictPath) ? (readJson(verdictPath) as Record<string, unknown>) : null;
  if (values.json) {
    process.stdout.write(JSON.stringify({ ...s, current_fingerprint: current, acceptance_stale: stale, lock, last_verdict: lastVerdict }, null, 2) + "\n");
  } else {
    printSummary(store, s);
    if (stale) process.stdout.write(`注意: 受入後に成果物が変更されています（current=${current}）。この受入結果は現在の成果物には適用されません。\n`);
    if (lock) process.stdout.write(`lock: ${JSON.stringify(lock)}\n`);
    if (s.regressions.length) process.stdout.write(`回帰基準: ${s.regressions.map((r) => `${r.id}(${r.requirement_ids.join(",")})`).join(" ")}\n`);
    if (lastVerdict) process.stdout.write(`最新判定: ${String(lastVerdict.verdict)} — ${String(lastVerdict.summary).slice(0, 300)}\n`);
  }
  return s.status === "accepted" && stale ? EXIT.failed : ["accepted", "ready_to_run", "running"].includes(s.status) ? 0 : exitCodeFor(s);
}

function cmdSchema(args: string[]): number {
  const name = args[0];
  const map: Record<string, unknown> = {
    order: jsonSchemaOf(Order),
    submission: jsonSchemaOf(Submission),
    trial: jsonSchemaOf(TrialReport),
    verdict: jsonSchemaOf(Verdict),
    scenario: jsonSchemaOf(Scenario),
    step: jsonSchemaOf(Step),
    "order-example": JSON.parse(readFileSync(join(SKILL_DIR, "assets", "order-example.json"), "utf8")),
  };
  if (!name || !(name in map)) {
    process.stderr.write(`schema <${Object.keys(map).join("|")}>\n`);
    return 1;
  }
  process.stdout.write(JSON.stringify(map[name], null, 2) + "\n");
  return 0;
}

// ---------------- term ----------------

async function cmdTerm(args: string[]): Promise<number> {
  if (args[0] === "__serve") {
    await serve(args[1]!);
    return await new Promise<number>(() => {}); // サーバーは自身で終了する
  }
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(TERM_HELP);
    return args.length ? 0 : 1;
  }
  const { values, positionals: allPos } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      root: { type: "string" },
      name: { type: "string" },
      cols: { type: "string" },
      rows: { type: "string" },
      cwd: { type: "string" },
      env: { type: "string", multiple: true },
      "inherit-home": { type: "boolean" },
      style: { type: "boolean" },
      gone: { type: "boolean" },
      regex: { type: "boolean" },
      timeout: { type: "string" },
      out: { type: "string" },
    },
  });
  // サブコマンドは最初の位置引数（--root などのオプションは前後どちらにも置ける）
  const [sub, ...positionals] = allPos;
  const root = resolve(values.root ?? join(process.cwd(), ".kenshu", "term"));
  const out = (v: unknown) => process.stdout.write(JSON.stringify(v, null, 2) + "\n");

  if (sub === "run-scenario") {
    const file = positionals[0];
    if (!file) throw new KenshuError("run-scenario <scenario.json> が必要です", 1);
    const parsed = Scenario.safeParse(readJson(resolve(file)));
    if (!parsed.success) throw new KenshuError(`シナリオが不正です:\n  ${formatZodError(parsed.error).join("\n  ")}`, 1);
    const outDir = resolve(values.out ?? join(root, `scenario-${Date.now()}`));
    const home = values["inherit-home"] ? process.env.HOME! : join(outDir, "home");
    mkdirSync(home, { recursive: true });
    const res = await runScenario(() => new TuiTestDriver(), parsed.data, {
      baseDir: resolve(values.cwd ?? process.cwd()),
      home,
      env: envRecord(isolatedEnv(home)),
      artifactsDir: join(outDir, "captures"),
    });
    writeJsonAtomic(join(outDir, "result.json"), res);
    out({ status: res.status, failure: res.failure, steps: res.steps.length, not_run: res.not_run, result: join(outDir, "result.json") });
    return res.status === "pass" ? 0 : 1;
  }

  if (!values.name) throw new KenshuError("--name <session> が必要です", 1);
  const dir = sessionDir(root, values.name);
  const step = async (s: unknown) => {
    const r = await request(dir, { op: "step", step: s });
    out(r);
    return r.ok ? 0 : 1;
  };
  switch (sub) {
    case "start": {
      if (!positionals.length) throw new KenshuError("起動するコマンドを -- の後に指定してください", 1);
      const home = values["inherit-home"] ? process.env.HOME! : join(dir + "-home");
      mkdirSync(home, { recursive: true });
      await startDaemon(
        dir,
        {
          name: values.name,
          launch: { argv: positionals, cols: num(values.cols, 80), rows: num(values.rows, 24), env: parseEnv(values.env) },
          baseDir: resolve(values.cwd ?? process.cwd()),
          home,
          env: envRecord(isolatedEnv(home)),
          idleMinutes: 15,
        },
        CLI_PATH,
      );
      const r = await request(dir, { op: "screen" });
      out({ ok: true, session: values.name, home, history: join(dir, "history.jsonl"), screen: r.screen });
      return 0;
    }
    case "screen": {
      const r = await request(dir, { op: "screen", style: !!values.style });
      out(r);
      return 0;
    }
    case "type":
      return step({ do: "type", text: need(positionals[0], "text") });
    case "paste":
      return step({ do: "paste", text: need(positionals[0], "text") });
    case "press":
      if (!positionals.length) throw new KenshuError("キーを指定してください", 1);
      return step({ do: "press", keys: positionals });
    case "resize":
      return step({ do: "resize", cols: num(positionals[0], NaN), rows: num(positionals[1], NaN) });
    case "wait":
      return step({ do: values.gone ? "wait_gone" : "wait_text", text: need(positionals[0], "text"), regex: values.regex, timeout_ms: values.timeout ? num(values.timeout, 5000) : undefined });
    case "step": {
      let s: unknown;
      try {
        s = JSON.parse(need(positionals[0], "step json"));
      } catch (e) {
        throw new KenshuError(`step JSONが不正: ${(e as Error).message}`, 1);
      }
      return step(s);
    }
    case "capture":
      return step({ do: "capture", name: need(positionals[0], "label") });
    case "restart":
      return step({ do: "restart" });
    case "stop": {
      const r = await request(dir, { op: "stop" });
      out(r);
      return 0;
    }
    default:
      throw new KenshuError(`不明な term サブコマンド: ${sub}\n${TERM_HELP}`, 1);
  }
}

function need(v: string | undefined, what: string): string {
  if (v === undefined) throw new KenshuError(`${what} を指定してください`, 1);
  return v;
}
function num(v: string | undefined, d: number): number {
  if (v === undefined) return d;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new KenshuError(`数値が必要です: ${v}`, 1);
  return n;
}
function parseEnv(list: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of list ?? []) {
    const i = kv.indexOf("=");
    if (i <= 0) throw new KenshuError(`--env は K=V 形式: ${kv}`, 1);
    out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}
function envRecord(e: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(e)) if (typeof v === "string") out[k] = v;
  return out;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    if (err instanceof KenshuError) {
      process.stderr.write(`エラー: ${err.message}\n`);
      process.exitCode = err.exitCode;
    } else {
      process.stderr.write(`内部エラー: ${(err as Error)?.stack ?? String(err)}\n`);
      process.exitCode = EXIT.failed;
    }
  },
);
