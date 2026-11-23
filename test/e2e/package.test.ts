// 配布物はスキルのディレクトリ skills/kenshu-loop/ だけ。npx skills add / 手動コピーと同じく
// それだけを node_modules 抜きで別の場所へコピーし、同梱 CLI が初回セットアップから動くことを確認する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { ROOT } from "../helpers/project.ts";

const run = (args: string[], cwd: string) =>
  spawnSync(process.execPath, args, { cwd, encoding: "utf8", timeout: 300_000, env: { ...process.env, npm_config_prefer_offline: "true" } });

test("skill: スキルのディレクトリだけをコピー → 初回セットアップ → bin/プロンプト/PTYが動く", () => {
  const work = mkdtempSync(join(tmpdir(), "kenshu-skill-"));
  const src = join(ROOT, "skills", "kenshu-loop");
  const skill = join(work, ".claude", "skills", "kenshu-loop");
  cpSync(src, skill, { recursive: true, filter: (p) => !relative(src, p).split(sep).includes("node_modules") });
  assert.ok(!existsSync(join(skill, "scripts", "node_modules")), "コピー直後は依存が無い状態から始める");
  for (const f of ["SKILL.md", "references/contractor.md", "scripts/kenshu-loop.mjs", "scripts/package-lock.json", "scripts/src/cli.ts", "assets/order-example.json"]) {
    assert.ok(existsSync(join(skill, f)), `${f} がスキルに含まれる`);
  }
  const entry = join(skill, "scripts", "kenshu-loop.mjs");

  // 初回: 依存を入れてから実行。stdout は CLI の出力だけ（npm の出力は stderr）
  const ver = run([entry, "--version"], work);
  assert.equal(ver.status, 0, ver.stderr);
  assert.equal(ver.stdout.trim(), "0.1.0");
  assert.match(ver.stderr, /依存パッケージを導入しています/);
  assert.ok(readdirSync(join(skill, "scripts", "node_modules")).includes("zod"));
  // 2回目以降はセットアップしない
  const again = run([entry, "--version"], work);
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stderr, /依存パッケージ/);

  const ex = run([entry, "schema", "order-example"], work);
  assert.equal(ex.status, 0, ex.stderr);
  assert.deepEqual(JSON.parse(ex.stdout), JSON.parse(readFileSync(join(ROOT, "examples", "memo-cli", "order.json"), "utf8")), "雛形は examples/memo-cli と同じ");

  const todo = join(ROOT, "examples", "todo-tui");
  const sc = run([entry, "term", "run-scenario", join(todo, "scenario.json"), "--cwd", todo, "--out", join(work, "sc")], work);
  assert.equal(sc.status, 0, sc.stdout + sc.stderr);

  // init がコピー先スキルの references からプロンプトを読めること（run の前提）
  const target = join(work, "target");
  mkdirSync(target);
  const init = run([entry, "init", "--dir", target, "--order", join(ROOT, "examples", "memo-cli", "order.json")], work);
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /受注AIの権限: permission_mode=acceptEdits/);
});
