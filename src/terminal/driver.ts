// 端末操作の境界。実装は @microsoft/tui-test を薄く包む（端末エミュレータは自作しない）。
import { TuiTest } from "@microsoft/tui-test";
import type { Launch } from "../schema.ts";

export interface CellInfo {
  x: number;
  y: number;
  char: string;
  fg: string | number;
  bg: string | number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  dim: boolean;
}
export interface ScreenState {
  cols: number;
  rows: number;
  cursor: { x: number; y: number; visible: boolean };
  lines: string[];
  exited: number | null;
  exitSignal: string | null;
  bracketedPaste: boolean;
  alternateScreen: boolean;
}

export interface TerminalDriver {
  launch(l: Required<Pick<Launch, "argv" | "cols" | "rows">> & { cwd: string; env: Record<string, string> }): Promise<void>;
  type(text: string): Promise<void>;
  write(data: string): Promise<void>;
  press(keys: string[]): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  signal(name: "INT" | "TERM" | "KILL" | "QUIT"): Promise<void>;
  screen(): Promise<ScreenState>;
  cells(): Promise<CellInfo[]>;
  /** 現在の画面に text が（hidden=true なら消えるまで）出るのを待つ。 */
  waitText(text: string, opts: { regex?: boolean; hidden?: boolean; timeoutMs: number }): Promise<boolean>;
  /** 現在画面上の一致位置。 */
  find(text: string, opts: { regex?: boolean }): Promise<Array<{ row: number; col: number; length: number }>>;
  waitExit(timeoutMs: number): Promise<number | null>;
  screenshotSvg(path: string): Promise<void>;
  close(): Promise<void>;
}

export type DriverFactory = () => TerminalDriver;

export class TuiTestDriver implements TerminalDriver {
  private t: TuiTest | undefined;

  private get term(): TuiTest {
    if (!this.t) throw new Error("端末が起動していません");
    return this.t;
  }

  async launch(l: { argv: string[]; cols: number; rows: number; cwd: string; env: Record<string, string> }): Promise<void> {
    await this.close();
    this.t = TuiTest.ephemeral("kenshu");
    const [prog, ...args] = l.argv;
    await this.t.run(prog!, args, { cols: l.cols, rows: l.rows, cwd: l.cwd, env: l.env });
  }
  async type(text: string) {
    await this.term.type(text);
  }
  async write(data: string) {
    await this.term.write(data);
  }
  async press(keys: string[]) {
    await this.term.press(...keys);
  }
  async resize(cols: number, rows: number) {
    await this.term.resize(cols, rows);
  }
  async signal(name: "INT" | "TERM" | "KILL" | "QUIT") {
    await this.term.signal(name);
  }
  async screen(): Promise<ScreenState> {
    const st = await this.term.state();
    const lines = st.text.split("\n");
    while (lines.length < st.rows) lines.push("");
    return {
      cols: st.cols,
      rows: st.rows,
      cursor: { x: st.cursor.x, y: st.cursor.y, visible: st.cursor.visible },
      lines: lines.slice(0, st.rows),
      exited: st.exited,
      exitSignal: st.exit_signal,
      bracketedPaste: !!st.modes["bracketed_paste"],
      alternateScreen: !!st.modes["alternate_screen"],
    };
  }
  async cells(): Promise<CellInfo[]> {
    const size = await this.term.getSize();
    const cells = await this.term.cells(0, 0, size.cols, size.rows);
    return cells.map((c) => ({
      x: c.x,
      y: c.y,
      char: c.char,
      fg: c.fg,
      bg: c.bg,
      bold: c.bold,
      italic: c.italic,
      underline: c.underline_style !== "none",
      inverse: c.inverse,
      dim: c.dim,
    }));
  }
  async waitText(text: string, opts: { regex?: boolean; hidden?: boolean; timeoutMs: number }): Promise<boolean> {
    const loc = opts.regex ? this.term.getByText(text, { regex: true }) : this.term.getByText(text);
    try {
      await loc.wait({ state: opts.hidden ? "hidden" : "visible", timeout: opts.timeoutMs });
      return true;
    } catch {
      return false;
    }
  }
  async find(text: string, opts: { regex?: boolean }) {
    // 現在画面の行テキストから一致を探す（全角文字は2セル幅として列を数える）
    const st = await this.screen();
    const out: Array<{ row: number; col: number; length: number }> = [];
    st.lines.forEach((line, row) => {
      const re = opts.regex ? new RegExp(text, "gu") : new RegExp(escapeRe(text), "gu");
      for (const m of line.matchAll(re)) {
        out.push({ row, col: displayWidth(line.slice(0, m.index)), length: displayWidth(m[0]) });
      }
    });
    return out;
  }
  async waitExit(timeoutMs: number): Promise<number | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const st = await this.term.state();
      if (st.exited !== null || st.exit_signal) return st.exited;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`プロセスが ${timeoutMs}ms 以内に終了しませんでした`);
  }
  async screenshotSvg(path: string) {
    await this.term.screenshot(path);
  }
  async close() {
    if (this.t) {
      const t = this.t;
      this.t = undefined;
      await t.closeQuiet();
    }
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 端末上の表示幅（東アジア全角=2）。 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}
export function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}
