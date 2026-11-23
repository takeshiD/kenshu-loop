// npm pack した配布物を新しいディレクトリにインストールし、インストール後のCLIを起動して確認する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { ROOT } from "../helpers/project.ts";

const sh = (cmd: string, args: string[], cwd: string, env: Record<string, string> = {}) =>
  spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 300_000, env: { ...process.env, ...env } });

test("package: npm pack → 別ディレクトリへインストール → bin/スキル/サンプル/PTYが動く", () => {
  const work = mkdtempSync(join(tmpdir(), "kenshu-pkg-"));
  const pack = sh("npm", ["pack", "--pack-destination", work, "--json"], ROOT);
  assert.equal(pack.status, 0, pack.stderr);
  const info = JSON.parse(pack.stdout)[0];
  const files: string[] = info.files.map((f: { path: string }) => f.path);
  assert.ok(files.includes("dist/cli.js"));
  assert.ok(files.includes("skills/kenshu-loop/SKILL.md"));
  assert.ok(!files.some((f) => f.startsWith("src/") || f.startsWith("test/")), "ソースとテストは配布物に含めない");
  const app = join(work, "app");
  sh("mkdir", ["-p", app], work);
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "consumer", private: true }));
  const inst = sh("npm", ["install", "--no-audit", "--no-fund", "--prefer-offline", join(work, info.filename)], app);
  assert.equal(inst.status, 0, inst.stderr);
  const bin = join(app, "node_modules", ".bin", "kenshu-loop");
  assert.ok(existsSync(bin));
  const ver = sh(bin, ["--version"], app);
  assert.equal(ver.status, 0, ver.stderr);
  assert.equal(ver.stdout.trim(), info.version);
  const ex = sh(bin, ["schema", "order-example"], app);
  assert.equal(ex.status, 0, ex.stderr);
  assert.equal(JSON.parse(ex.stdout).schema, "kenshu-loop/order@1");
  const pkgDir = join(app, "node_modules", "kenshu-loop");
  const sc = sh(bin, ["term", "run-scenario", join(pkgDir, "examples", "todo-tui", "scenario.json"), "--cwd", join(pkgDir, "examples", "todo-tui"), "--out", join(work, "sc")], app);
  assert.equal(sc.status, 0, sc.stdout + sc.stderr);
  // init が同梱スキルからプロンプトを読めること（run の前提）
  const target = join(work, "target");
  sh("mkdir", ["-p", target], work);
  const init = sh(bin, ["init", "--dir", target, "--order", join(pkgDir, "examples", "memo-cli", "order.json")], app);
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /受注AIの権限: permission_mode=acceptEdits/);
});
