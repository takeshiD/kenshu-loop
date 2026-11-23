// 永続状態（.kenshu/）と重複起動防止ロック。
import { existsSync, mkdirSync, openSync, writeSync, closeSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import { Config, Order, RunState, formatZodError } from "./schema.ts";
import { appendJsonl, nowIso, readJson, writeJsonAtomic, KenshuError } from "./util.ts";

export class Store {
  readonly targetDir: string;
  readonly dir: string;

  constructor(targetDir: string, stateDir?: string) {
    this.targetDir = resolve(targetDir);
    this.dir = stateDir ? resolve(stateDir) : join(this.targetDir, ".kenshu");
  }

  path(...parts: string[]): string {
    return join(this.dir, ...parts);
  }
  roundDir(round: number): string {
    return this.path("rounds", String(round).padStart(3, "0"));
  }
  exists(): boolean {
    return existsSync(this.path("state.json"));
  }

  loadConfig(): Config {
    return parseOrThrow(Config, this.path("config.json"), "config.json");
  }
  loadOrder(): Order {
    return parseOrThrow(Order, this.path("order.json"), "order.json");
  }
  loadState(): RunState {
    if (!this.exists()) throw new KenshuError(`状態がありません: ${this.dir}（先に kenshu-loop init を実行）`, 1);
    return parseOrThrow(RunState, this.path("state.json"), "state.json");
  }
  saveState(state: RunState): void {
    state.updated_at = nowIso();
    writeJsonAtomic(this.path("state.json"), RunState.parse(state));
  }
  event(type: string, data: Record<string, unknown> = {}): void {
    appendJsonl(this.path("events.jsonl"), { at: nowIso(), type, ...data });
  }

  /** 重複起動防止。生きているPIDが保持していれば失敗、死んでいれば奪取する。 */
  acquireLock(): () => void {
    mkdirSync(this.dir, { recursive: true });
    const lockPath = this.path("lock");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(lockPath, "wx");
        writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), at: nowIso() }));
        closeSync(fd);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          try {
            const cur = JSON.parse(readFileSync(lockPath, "utf8"));
            if (cur.pid === process.pid) unlinkSync(lockPath);
          } catch {
            /* already gone */
          }
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        let holder: { pid?: number; host?: string } = {};
        try {
          holder = JSON.parse(readFileSync(lockPath, "utf8"));
        } catch {
          /* 壊れたロックは奪取対象 */
        }
        if (holder.pid && holder.host === hostname() && pidAlive(holder.pid)) {
          throw new KenshuError(`別の kenshu-loop (pid ${holder.pid}) が実行中です: ${lockPath}`, 5);
        }
        if (holder.host && holder.host !== hostname()) {
          throw new KenshuError(`別ホスト ${holder.host} のロックがあります: ${lockPath}（不要なら削除）`, 5);
        }
        unlinkSync(lockPath); // stale
      }
    }
    throw new KenshuError(`ロックを取得できません: ${lockPath}`, 5);
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseOrThrow<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: import("zod").ZodError } }, path: string, label: string): T {
  if (!existsSync(path)) throw new KenshuError(`${label} がありません: ${path}`, 1);
  let raw: unknown;
  try {
    raw = readJson(path);
  } catch (e) {
    throw new KenshuError(`${label} をJSONとして読めません: ${(e as Error).message}`, 1);
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new KenshuError(`${label} が不正です:\n  ${formatZodError(r.error).join("\n  ")}`, 1);
  return r.data;
}
