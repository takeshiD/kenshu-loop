import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../../skills/kenshu-loop/scripts/src/store.ts";
import { defaultConfig, Order, type Config } from "../../skills/kenshu-loop/scripts/src/schema.ts";
import { newState, orderVersion, Orchestrator } from "../../skills/kenshu-loop/scripts/src/orchestrator.ts";
import { ClaudeCodeAdapter } from "../../skills/kenshu-loop/scripts/src/harness/claude-code.ts";
import { nodeRunner } from "../../skills/kenshu-loop/scripts/src/exec.ts";
import { TuiTestDriver } from "../../skills/kenshu-loop/scripts/src/terminal/driver.ts";
import { writeJsonAtomic } from "../../skills/kenshu-loop/scripts/src/util.ts";

export const ROOT = resolve(import.meta.dirname, "..", "..");
export const FAKE_CLAUDE = join(ROOT, "test", "fixtures", "fake-claude.mjs");
export const MEMO = join(ROOT, "examples", "memo-cli", "memo.mjs");
export const TODO = join(ROOT, "examples", "todo-tui", "todo.mjs");

export function memoOrder() {
  return Order.parse(JSON.parse(readFileSync(join(ROOT, "examples", "memo-cli", "order.json"), "utf8")));
}

export interface Project {
  dir: string;
  store: Store;
  scriptPath: string;
  statePath: string;
}

export function makeProject(script: unknown, opts: { order?: unknown; config?: (c: Config) => void } = {}): Project {
  const base = mkdtempSync(join(tmpdir(), "kenshu-test-"));
  const dir = join(base, "target");
  mkdirSync(dir);
  writeFileSync(join(dir, "README.md"), "# target\n");
  const store = new Store(dir);
  const config = defaultConfig();
  config.harness.bin = FAKE_CLAUDE;
  config.limits.max_rounds = 3;
  opts.config?.(config);
  const order = Order.parse(opts.order ?? memoOrder());
  writeJsonAtomic(store.path("config.json"), config);
  writeJsonAtomic(store.path("order.json"), order);
  store.saveState(newState(orderVersion(order)));
  const scriptPath = join(base, "script.json");
  const statePath = join(base, "fake-state.json");
  writeFileSync(scriptPath, JSON.stringify(script, null, 2));
  return { dir, store, scriptPath, statePath };
}

export async function runOrchestrator(p: Project, logs: string[] = []) {
  process.env.FAKE_CLAUDE_SCRIPT = p.scriptPath;
  process.env.FAKE_CLAUDE_STATE = p.statePath;
  const config = p.store.loadConfig();
  const orch = new Orchestrator(p.store, {
    harness: new ClaudeCodeAdapter(config.harness.bin, nodeRunner),
    runner: nodeRunner,
    driverFactory: () => new TuiTestDriver(),
    cliCommand: `node ${join(ROOT, "skills", "kenshu-loop", "scripts", "kenshu-loop.mjs")}`,
    log: (l) => logs.push(l),
  });
  return orch.run();
}

export function fakeCalls(p: Project): Array<Record<string, unknown>> {
  try {
    return JSON.parse(readFileSync(p.statePath, "utf8")).calls;
  } catch {
    return [];
  }
}

export function readEvents(p: Project): Array<Record<string, unknown>> {
  return readFileSync(p.store.path("events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

// ---- memo CLI 用の納品書・判定の雛形 ----

export function memoSubmission(extra: Record<string, unknown> = {}) {
  return {
    status: "delivered",
    summary: "memo CLI を実装",
    setup: [],
    entrypoints: [{ id: "memo", kind: "cli", argv: ["node", "memo.mjs"], description: "メモCLI" }],
    criteria: [
      {
        id: "C1",
        requirement_ids: ["R1", "R2"],
        title: "追加と一覧",
        rationale: "追加した日本語メモが番号付きで一覧に出ることを実プロセスで確認する",
        required: true,
        check: { type: "command", argv: ["sh", "-c", "node memo.mjs add 牛乳を買う && node memo.mjs list"], expect: { exit_code: 0, stdout_includes: ["1. 牛乳を買う"] } },
      },
      {
        id: "C2",
        requirement_ids: ["R3"],
        title: "削除",
        rationale: "追加後に削除でき、削除メッセージが出ることを確認する",
        required: true,
        check: { type: "command", argv: ["sh", "-c", "node memo.mjs add a && node memo.mjs rm 1"], expect: { exit_code: 0, stdout_includes: ["削除しました"] } },
      },
      {
        id: "C3",
        requirement_ids: ["R4"],
        title: "保存先",
        rationale: "HOME直下の .memo.json に保存されることを確認する",
        required: true,
        check: { type: "command", argv: ["node", "memo.mjs", "add", "保存テスト"], expect: { exit_code: 0, files: [{ path: "$HOME/.memo.json", includes: ["保存テスト"] }] } },
      },
    ],
    self_check: [{ criterion_id: "C1", result: "pass", note: "手元で確認" }],
    ...extra,
  };
}

export function acceptVerdict(extra: Record<string, unknown> = {}) {
  return {
    verdict: "accepted",
    inspected: "{{identity}}",
    requirement_assessment: ["R1", "R2", "R3", "R4"].map((id) => ({ requirement_id: id, status: "satisfied", basis: "試行と検証で確認", evidence_refs: [] })),
    criteria_assessment: [],
    summary: "要求を満たしている",
    follow_ups: [{ title: "色付け", detail: "要求外の改善案" }],
    ...extra,
  };
}

export const trialOk = {
  output: {
    scenarios: [
      { id: "S1", requirement_ids: ["R1"], title: "初回利用", intent: "メモを追加して一覧", operations: "add→list", expected: "番号付き", actual: "番号付き", result: "pass", evidence: [] },
    ],
    unverified: [],
    notes: "",
  },
};

export const memoCopy = (bugs?: string[]) => [{ from: MEMO, to: "memo.mjs", ...(bugs ? { bugs } : {}) }];
