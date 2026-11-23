// エージェントが Bash から1操作ずつ端末を動かすための小さなセッションデーモン。
// tui-test のセッションはプロセス内でしか保持できないため、Unixソケット越しに同じ ScenarioSession を操作する。
import { createServer, createConnection, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Launch, Step } from "../schema.ts";
import { appendJsonl, nowIso, sha256, KenshuError } from "../util.ts";
import { ScenarioSession } from "./session.ts";
import { TuiTestDriver } from "./driver.ts";
import { pidAlive } from "../store.ts";

export interface TermSessionConfig {
  name: string;
  launch: Launch;
  baseDir: string;
  home: string;
  env: Record<string, string>;
  idleMinutes: number;
}

export function sessionDir(root: string, name: string): string {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw new Error(`不正なセッション名: ${name}`);
  return join(root, name);
}
export function socketPath(dir: string): string {
  return join(process.platform === "win32" ? "\\\\.\\pipe" : tmpdir(), `kenshu-term-${sha256(dir).slice(0, 12)}.sock`);
}

type Req = { op: "step"; step: unknown } | { op: "screen"; style?: boolean } | { op: "stop" } | { op: "ping" };

/** デーモン本体（`kenshu-loop term __serve <dir>` から呼ばれる）。 */
export async function serve(dir: string): Promise<void> {
  const cfg = JSON.parse(readFileSync(join(dir, "session.json"), "utf8")) as TermSessionConfig;
  const sock = socketPath(dir);
  rmSync(sock, { force: true });
  const session = new ScenarioSession(() => new TuiTestDriver(), {
    baseDir: cfg.baseDir,
    home: cfg.home,
    env: cfg.env,
    artifactsDir: join(dir, "captures"),
  });
  const history = join(dir, "history.jsonl");
  let index = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  const shutdown = async (reason: string) => {
    appendJsonl(history, { at: nowIso(), op: "shutdown", reason });
    await session.close().catch(() => {});
    server.close();
    rmSync(sock, { force: true });
    rmSync(join(dir, "daemon.pid"), { force: true });
    process.exit(0);
  };
  const bumpIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void shutdown("idle timeout"), cfg.idleMinutes * 60_000);
  };

  try {
    await session.start(cfg.launch);
  } catch (e) {
    writeFileSync(join(dir, "error.txt"), String((e as Error).message));
    process.exit(1);
  }
  appendJsonl(history, { at: nowIso(), op: "start", launch: cfg.launch });

  const handle = async (req: Req): Promise<unknown> => {
    bumpIdle();
    if (req.op === "ping") return { ok: true };
    if (req.op === "screen") {
      const d = await session.describe(!!req.style);
      return { ok: true, screen: d.text, styled: d.styled, exited: d.screen.exited };
    }
    if (req.op === "stop") {
      setTimeout(() => void shutdown("stop requested"), 10);
      return { ok: true, captures: session.artifacts };
    }
    const parsed = Step.safeParse(req.step);
    if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
    const rec = await session.exec(parsed.data, index++);
    appendJsonl(history, { at: nowIso(), op: "step", record: { ...rec, screen: undefined } });
    const d = await session.describe(false).catch(() => undefined);
    return { ok: rec.ok, record: { ...rec, screen: undefined }, screen: d?.text };
  };

  const server = createServer((conn: Socket) => {
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let req: Req;
        try {
          req = JSON.parse(line);
        } catch {
          conn.write(JSON.stringify({ ok: false, error: "invalid json" }) + "\n");
          continue;
        }
        handle(req)
          .then((res) => conn.write(JSON.stringify(res) + "\n"))
          .catch((e) => conn.write(JSON.stringify({ ok: false, error: String(e?.message ?? e) }) + "\n"));
      }
    });
    conn.on("error", () => {});
  });
  server.listen(sock, () => {
    writeFileSync(join(dir, "daemon.pid"), String(process.pid));
    bumpIdle();
  });
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => void shutdown(sig));
}

export async function request(dir: string, req: Req, timeoutMs = 120_000): Promise<Record<string, unknown>> {
  const sock = socketPath(dir);
  return new Promise((resolve, reject) => {
    const conn = createConnection(sock);
    let buf = "";
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error("端末デーモンが応答しません"));
    }, timeoutMs);
    conn.on("connect", () => conn.write(JSON.stringify(req) + "\n"));
    conn.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        conn.end();
        resolve(JSON.parse(buf.slice(0, nl)));
      }
    });
    conn.on("error", (e) => {
      clearTimeout(timer);
      reject(new KenshuError(`端末セッションに接続できません（start済みか確認）: ${e.message}`, 1));
    });
  });
}

/** デーモンを起動し、ソケットが応答するまで待つ。 */
export async function startDaemon(dir: string, cfg: TermSessionConfig, cliPath: string): Promise<void> {
  const pidFile = join(dir, "daemon.pid");
  if (existsSync(pidFile) && pidAlive(Number(readFileSync(pidFile, "utf8")))) {
    throw new Error(`セッション ${cfg.name} は既に起動中です（term stop で終了）`);
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.json"), JSON.stringify(cfg, null, 2));
  const log = openSync(join(dir, "daemon.log"), "a");
  const child = spawn(process.execPath, [cliPath, "term", "__serve", dir], { detached: true, stdio: ["ignore", log, log] });
  child.unref();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(join(dir, "error.txt"))) throw new Error(`起動失敗: ${readFileSync(join(dir, "error.txt"), "utf8")}`);
    try {
      const r = await request(dir, { op: "ping" }, 2000);
      if (r.ok) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("端末デーモンが起動しませんでした");
}

/** CLI の入口（依存の導入を済ませてから src/cli.ts を読む）。デーモンやエージェントへ渡すコマンドはこれを指す。 */
export const CLI_PATH = fileURLToPath(new URL("../../kenshu-loop.mjs", import.meta.url));
