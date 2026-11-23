// シナリオ実行器。AIの探索操作（term デーモン）と回帰/検証シナリオで同じ実装を使う。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Launch, Scenario, Step } from "../schema.ts";
import type { CellInfo, DriverFactory, ScreenState, TerminalDriver } from "./driver.ts";
import { redact } from "../util.ts";

export interface StepRecord {
  index: number;
  step: Step;
  ok: boolean;
  expected?: string;
  actual?: string;
  ms: number;
  screen?: string[];
  cursor?: { x: number; y: number; visible: boolean };
  size?: { cols: number; rows: number };
  artifacts?: string[];
}

export interface ScenarioResult {
  status: "pass" | "fail" | "error";
  failure?: string;
  steps: StepRecord[];
  not_run: number;
  launch: { argv: string[]; cols: number; rows: number; cwd: string };
  artifacts: string[];
}

export interface StyledRun {
  row: number;
  col: number;
  text: string;
  style: Partial<Pick<CellInfo, "fg" | "bg" | "bold" | "italic" | "underline" | "inverse" | "dim">>;
}

export function styledRuns(cells: CellInfo[]): StyledRun[] {
  const key = (c: CellInfo) => JSON.stringify(styleOf(c));
  const runs: StyledRun[] = [];
  let cur: (StyledRun & { k: string }) | undefined;
  const sorted = [...cells].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const c of sorted) {
    const st = styleOf(c);
    const k = key(c);
    if (Object.keys(st).length === 0) {
      if (cur) runs.push(strip(cur));
      cur = undefined;
      continue;
    }
    if (cur && cur.row === c.y && cur.k === k) cur.text += c.char;
    else {
      if (cur) runs.push(strip(cur));
      cur = { row: c.y, col: c.x, text: c.char, style: st, k };
    }
  }
  if (cur) runs.push(strip(cur));
  return runs.filter((r) => r.text.trim().length > 0 || r.style.bg !== undefined || r.style.inverse);
}
function strip(r: StyledRun & { k: string }): StyledRun {
  const { k: _k, ...rest } = r;
  return rest;
}
function styleOf(c: CellInfo): StyledRun["style"] {
  const s: StyledRun["style"] = {};
  if (c.fg !== "default") s.fg = c.fg;
  if (c.bg !== "default") s.bg = c.bg;
  if (c.bold) s.bold = true;
  if (c.italic) s.italic = true;
  if (c.underline) s.underline = true;
  if (c.inverse) s.inverse = true;
  if (c.dim) s.dim = true;
  return s;
}

/** 画面をカーソル付きのテキストに整形する（証拠・AIへの提示用）。 */
export function renderScreen(st: ScreenState): string {
  const border = "+" + "-".repeat(Math.max(0, st.cols)) + "+";
  const body = st.lines.map((l, i) => `${String(i).padStart(2)}|${l}`);
  return [
    `size=${st.cols}x${st.rows} cursor=(${st.cursor.x},${st.cursor.y})${st.cursor.visible ? "" : " hidden"}${st.exited !== null ? ` exited=${st.exited}` : ""}${st.alternateScreen ? " alt-screen" : ""}`,
    "  " + border,
    ...body,
    "  " + border,
  ].join("\n");
}

export interface SessionOptions {
  baseDir: string; // 相対cwd/パスの基準
  home: string; // 隔離HOME（$HOME 置換にも使う）
  env: Record<string, string>; // 端末アプリに渡す環境変数
  artifactsDir: string;
  defaultTimeoutMs?: number;
}

export class ScenarioSession {
  private driver: TerminalDriver;
  private launchCfg: { argv: string[]; cols: number; rows: number; cwd: string; env: Record<string, string> } | undefined;
  private counter = 0;
  readonly artifacts: string[] = [];

  private opts: SessionOptions;
  constructor(factory: DriverFactory, opts: SessionOptions) {
    this.opts = opts;
    this.driver = factory();
    mkdirSync(opts.artifactsDir, { recursive: true });
  }

  resolvePath(p: string, base = this.opts.baseDir): string {
    const expanded = p.replace(/^(\$HOME|~)(?=\/|$)/, this.opts.home);
    return isAbsolute(expanded) ? expanded : resolve(base, expanded);
  }

  async start(launch: Launch): Promise<void> {
    const cwd = launch.cwd ? this.resolvePath(launch.cwd) : this.opts.baseDir;
    this.launchCfg = {
      argv: launch.argv,
      cols: launch.cols ?? 80,
      rows: launch.rows ?? 24,
      cwd,
      env: { ...this.opts.env, ...(launch.env ?? {}) },
    };
    await this.driver.launch(this.launchCfg);
  }

  get launchInfo() {
    return this.launchCfg;
  }

  async screen(): Promise<ScreenState> {
    return this.driver.screen();
  }

  async describe(withStyle = false): Promise<{ text: string; screen: ScreenState; styled?: StyledRun[] }> {
    const screen = await this.driver.screen();
    const out: { text: string; screen: ScreenState; styled?: StyledRun[] } = { text: renderScreen(screen), screen };
    if (withStyle) out.styled = styledRuns(await this.driver.cells());
    return out;
  }

  async capture(name: string): Promise<string[]> {
    const base = join(this.opts.artifactsDir, `${String(++this.counter).padStart(3, "0")}-${name}`);
    const d = await this.describe(true);
    const files = [`${base}.txt`, `${base}.json`, `${base}.svg`];
    writeFileSync(files[0]!, redact(d.text) + "\n");
    writeFileSync(files[1]!, JSON.stringify({ screen: d.screen, styled: d.styled }, null, 2));
    try {
      await this.driver.screenshotSvg(files[2]!);
    } catch {
      files.pop();
    }
    this.artifacts.push(...files);
    return files;
  }

  async exec(step: Step, index: number): Promise<StepRecord> {
    const t0 = Date.now();
    const rec: StepRecord = { index, step, ok: true, ms: 0 };
    const to = (ms?: number) => ms ?? this.opts.defaultTimeoutMs ?? 5000;
    try {
      switch (step.do) {
        case "type":
          await this.driver.type(step.text);
          break;
        case "paste": {
          const st = await this.driver.screen();
          await this.driver.write(st.bracketedPaste ? `\x1b[200~${step.text}\x1b[201~` : step.text);
          rec.actual = st.bracketedPaste ? "bracketed paste" : "raw paste (アプリはbracketed pasteを有効化していない)";
          break;
        }
        case "press":
          await this.driver.press(step.keys);
          break;
        case "submit":
          if (step.text) await this.driver.type(step.text);
          await this.driver.press(["Enter"]);
          break;
        case "resize":
          await this.driver.resize(step.cols, step.rows);
          break;
        case "wait_text":
        case "wait_gone": {
          const hidden = step.do === "wait_gone";
          rec.expected = `${hidden ? "画面から消える" : "画面に表示"}: ${step.text}`;
          rec.ok = await this.driver.waitText(step.text, { regex: step.regex, hidden, timeoutMs: to(step.timeout_ms) });
          if (!rec.ok) rec.actual = `${to(step.timeout_ms)}ms 以内に条件を満たさなかった`;
          break;
        }
        case "expect_text": {
          const hits = await this.driver.find(step.text, { regex: step.regex });
          const match = hits.filter((h) => (step.row === undefined || h.row === step.row) && (step.col === undefined || h.col === step.col));
          rec.expected = `現在画面に "${step.text}"${step.row !== undefined ? ` row=${step.row}` : ""}${step.col !== undefined ? ` col=${step.col}` : ""}`;
          rec.ok = match.length > 0;
          rec.actual = hits.length ? `一致位置: ${hits.map((h) => `(${h.row},${h.col})`).join(" ")}` : "現在画面に存在しない";
          break;
        }
        case "expect_no_text": {
          const hits = await this.driver.find(step.text, { regex: step.regex });
          rec.expected = `現在画面に "${step.text}" が無い`;
          rec.ok = hits.length === 0;
          rec.actual = hits.length ? `表示されている: ${hits.map((h) => `(${h.row},${h.col})`).join(" ")}` : "無い";
          break;
        }
        case "expect_style": {
          const hits = await this.driver.find(step.text, { regex: false });
          rec.expected = `"${step.text}" のスタイル ${JSON.stringify(step.style)}`;
          if (!hits.length) {
            rec.ok = false;
            rec.actual = "文字列が現在画面に無い";
            break;
          }
          const cells = await this.driver.cells();
          const results = hits.map((h) => {
            const cs = cells.filter((c) => c.y === h.row && c.x >= h.col && c.x < h.col + h.length && c.char !== "");
            const bad = cs.find((c) => !styleMatches(c, step.style));
            return { h, ok: cs.length > 0 && !bad, sample: bad ?? cs[0] };
          });
          rec.ok = results.some((r) => r.ok);
          rec.actual = results
            .map((r) => `(${r.h.row},${r.h.col}) ${r.ok ? "一致" : `不一致 ${JSON.stringify(r.sample ? styleOf(r.sample) : {})}`}`)
            .join("; ");
          break;
        }
        case "expect_cursor": {
          const st = await this.driver.screen();
          rec.expected = `cursor ${JSON.stringify({ x: step.x, y: step.y, visible: step.visible })}`;
          rec.actual = `cursor ${JSON.stringify(st.cursor)}`;
          rec.ok =
            (step.x === undefined || st.cursor.x === step.x) &&
            (step.y === undefined || st.cursor.y === step.y) &&
            (step.visible === undefined || st.cursor.visible === step.visible);
          break;
        }
        case "capture":
          rec.artifacts = await this.capture(step.name);
          break;
        case "wait_exit": {
          rec.expected = step.exit_code !== undefined ? `exit ${step.exit_code}` : "プロセス終了";
          try {
            const code = await this.driver.waitExit(to(step.timeout_ms));
            rec.actual = `exit ${code}`;
            rec.ok = step.exit_code === undefined || code === step.exit_code;
          } catch (e) {
            rec.ok = false;
            rec.actual = (e as Error).message;
          }
          break;
        }
        case "restart":
          if (!this.launchCfg) throw new Error("restart 前に起動していません");
          await this.driver.launch(this.launchCfg);
          break;
        case "signal":
          await this.driver.signal(step.name);
          break;
        case "expect_file": {
          const p = this.resolvePath(step.path, this.launchCfg?.cwd ?? this.opts.baseDir);
          const exists = existsSync(p);
          const wantExists = step.exists ?? true;
          rec.expected = `${step.path} ${wantExists ? "が存在" : "が存在しない"}${step.includes?.length ? ` かつ ${JSON.stringify(step.includes)} を含む` : ""}`;
          if (exists !== wantExists) {
            rec.ok = false;
            rec.actual = exists ? "存在する" : "存在しない";
            break;
          }
          if (exists && step.includes?.length) {
            const body = readFileSync(p, "utf8");
            const missing = step.includes.filter((s) => !body.includes(s));
            rec.ok = missing.length === 0;
            rec.actual = missing.length ? `含まれない: ${JSON.stringify(missing)}` : "すべて含む";
          } else rec.actual = exists ? "存在する" : "存在しない";
          break;
        }
      }
    } catch (e) {
      rec.ok = false;
      rec.actual = `操作エラー: ${(e as Error).message}`;
    }
    rec.ms = Date.now() - t0;
    try {
      const st = await this.driver.screen();
      rec.screen = st.lines.map(redact);
      rec.cursor = st.cursor;
      rec.size = { cols: st.cols, rows: st.rows };
    } catch {
      /* 端末が閉じている */
    }
    return rec;
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}

function styleMatches(c: CellInfo, want: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(want)) {
    if (v === undefined) continue;
    const actual = (c as unknown as Record<string, unknown>)[k];
    if (k === "fg" || k === "bg") {
      if (String(actual).toLowerCase() !== String(v).toLowerCase()) return false;
    } else if (actual !== v) return false;
  }
  return true;
}

/** シナリオを最初から最後まで実行し、失敗時は画面証拠を残して打ち切る。 */
export async function runScenario(factory: DriverFactory, scenario: Scenario, opts: SessionOptions): Promise<ScenarioResult> {
  const session = new ScenarioSession(factory, opts);
  const steps: StepRecord[] = [];
  let status: ScenarioResult["status"] = "pass";
  let failure: string | undefined;
  try {
    await session.start(scenario.launch);
    for (let i = 0; i < scenario.steps.length; i++) {
      const rec = await session.exec(scenario.steps[i]!, i);
      steps.push(rec);
      if (!rec.ok) {
        status = rec.actual?.startsWith("操作エラー") ? "error" : "fail";
        failure = `step ${i} (${rec.step.do}): 期待=${rec.expected ?? "-"} 実際=${rec.actual ?? "-"}`;
        rec.artifacts = await session.capture(`fail-step${i}`).catch(() => []);
        break;
      }
    }
  } catch (e) {
    status = "error";
    failure = `起動エラー: ${(e as Error).message}`;
  } finally {
    await session.close();
  }
  const li = session.launchInfo;
  return {
    status,
    failure,
    steps,
    not_run: scenario.steps.length - steps.length,
    launch: { argv: scenario.launch.argv, cols: li?.cols ?? scenario.launch.cols ?? 80, rows: li?.rows ?? scenario.launch.rows ?? 24, cwd: li?.cwd ?? opts.baseDir },
    artifacts: session.artifacts,
  };
}
