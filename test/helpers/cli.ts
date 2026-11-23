import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "./project.ts";

export const CLI = join(ROOT, "skills", "kenshu-loop", "scripts", "kenshu-loop.mjs");

export function cli(args: string[], opts: { cwd?: string; env?: Record<string, string>; input?: string } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, ...opts.env },
    input: opts.input,
    encoding: "utf8",
    timeout: 180_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function cliAsync(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const child = spawn(process.execPath, [CLI, ...args], { cwd: opts.cwd ?? ROOT, env: { ...process.env, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((res) =>
    child.on("close", (code, signal) => res({ code, signal, stdout, stderr })),
  );
  return { child, done };
}

export async function waitFor(cond: () => boolean, timeoutMs = 20_000, what = "condition") {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${what}`);
}
