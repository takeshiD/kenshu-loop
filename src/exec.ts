// 子プロセス実行。タイムアウト・中断時はプロセスグループごと終了させる。
import { spawn } from "node:child_process";

export interface ExecRequest {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
}
export interface ExecResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
  durationMs: number;
}

export interface CommandRunner {
  run(req: ExecRequest): Promise<ExecResult>;
}

/** 実行中の子プロセスグループ（中断時の後始末用）。 */
const live = new Set<number>();
export function killAllChildren(sig: NodeJS.Signals = "SIGTERM"): void {
  for (const pid of live) {
    try {
      process.kill(-pid, sig);
    } catch {
      /* gone */
    }
  }
}

export const nodeRunner: CommandRunner = {
  run(req) {
    const started = Date.now();
    const max = req.maxOutputBytes ?? 4 * 1024 * 1024;
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let aborted = false;
      const [cmd, ...args] = req.argv;
      const child = spawn(cmd!, args, {
        cwd: req.cwd,
        env: req.env,
        detached: true, // 独立したプロセスグループ
        stdio: ["pipe", "pipe", "pipe"],
      });
      const pid = child.pid;
      if (pid) live.add(pid);
      const killGroup = (sig: NodeJS.Signals) => {
        if (!pid) return;
        try {
          process.kill(-pid, sig);
        } catch {
          /* gone */
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup("SIGTERM");
        setTimeout(() => killGroup("SIGKILL"), 3000).unref();
      }, req.timeoutMs);
      const onAbort = () => {
        aborted = true;
        killGroup("SIGTERM");
        setTimeout(() => killGroup("SIGKILL"), 3000).unref();
      };
      req.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (d: Buffer) => {
        if (stdout.length < max) stdout += d.toString("utf8");
      });
      child.stderr.on("data", (d: Buffer) => {
        if (stderr.length < max) stderr += d.toString("utf8");
      });
      child.stdin.on("error", () => {});
      if (req.stdin !== undefined) child.stdin.end(req.stdin);
      else child.stdin.end();
      let spawnError: string | undefined;
      child.on("error", (e) => {
        spawnError = e.message;
      });
      child.on("close", (code, sig) => {
        clearTimeout(timer);
        req.signal?.removeEventListener("abort", onAbort);
        if (pid) {
          killGroup("SIGKILL"); // 残った孫プロセスも片付ける
          live.delete(pid);
        }
        resolve({ exitCode: code, signal: sig, stdout, stderr, timedOut, aborted, spawnError, durationMs: Date.now() - started });
      });
    });
  },
};

/** 検査用の最小環境変数。利用者の認証情報を検査対象へ渡さない。 */
export function isolatedEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: `${home}/.config`,
    XDG_DATA_HOME: `${home}/.local/share`,
    XDG_STATE_HOME: `${home}/.local/state`,
    XDG_CACHE_HOME: `${home}/.cache`,
    LANG: process.env.LANG && process.env.LANG !== "C" ? process.env.LANG : "C.UTF-8",
    TERM: "xterm-256color",
    TZ: process.env.TZ ?? "UTC",
  };
  for (const k of ["NIX_PATH", "NIX_PROFILES", "LOCALE_ARCHIVE", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "npm_config_cache"]) {
    if (process.env[k]) env[k] = process.env[k];
  }
  // npmキャッシュは元のHOMEのものを共有（オフラインでのsetupを可能にするため。認証情報は含まない）
  if (!env.npm_config_cache && process.env.HOME) env.npm_config_cache = `${process.env.HOME}/.npm`;
  return { ...env, ...extra };
}
