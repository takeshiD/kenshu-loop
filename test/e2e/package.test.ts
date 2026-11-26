// 配布物はスキルのディレクトリ skills/kenshu-loop/ だけ。npx skills add / 手動コピーと同じく
// それだけを node_modules 抜きで別の場所へコピーし、同梱 CLI が初回セットアップから動くことを確認する。
// 依存はスキルの中ではなく、ロックごとのキャッシュ（既定 $XDG_CACHE_HOME/kenshu-loop）に入る。
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { ROOT } from "../helpers/project.ts";

function copySkill(dest: string): string {
  const src = join(ROOT, "skills", "kenshu-loop");
  cpSync(src, dest, { recursive: true, filter: (p) => !relative(src, p).split(sep).includes("node_modules") });
  return join(dest, "scripts", "kenshu-loop.mjs");
}

function runner(cwd: string, env: Record<string, string | undefined>) {
  return (args: string[]) =>
    spawnSync(process.execPath, args, { cwd, encoding: "utf8", timeout: 300_000, env: { ...process.env, npm_config_prefer_offline: "true", ...env } });
}

function depsDirs(cacheRoot: string): string[] {
  return existsSync(cacheRoot) ? readdirSync(cacheRoot).filter((d) => d.startsWith("deps-")) : [];
}

test("skill: スキルのディレクトリだけをコピー → 初回セットアップ（既定のキャッシュ）→ bin/プロンプト/PTYが動く", () => {
  const work = mkdtempSync(join(tmpdir(), "kenshu-skill-"));
  // 利用者のプロジェクトに別版の zod が入っていても、スキルはロックどおりの版をキャッシュから使う
  const fakeZod = join(work, "node_modules", "zod");
  mkdirSync(fakeZod, { recursive: true });
  writeFileSync(join(fakeZod, "package.json"), JSON.stringify({ name: "zod", version: "0.0.0-fake", type: "module", exports: "./index.js" }));
  writeFileSync(join(fakeZod, "index.js"), 'throw new Error("祖先の node_modules の zod が使われた");\n');

  const skill = join(work, ".claude", "skills", "kenshu-loop");
  const entry = copySkill(skill);
  for (const f of ["SKILL.md", "references/contractor.md", "scripts/kenshu-loop.mjs", "scripts/package-lock.json", "scripts/src/cli.ts", "assets/order-example.json"]) {
    assert.ok(existsSync(join(skill, f)), `${f} がスキルに含まれる`);
  }
  const xdg = join(work, "xdg");
  const run = runner(work, { KENSHU_LOOP_HOME: undefined, XDG_CACHE_HOME: xdg });

  // 初回: 依存を入れてから実行。stdout は CLI の出力だけ（npm の出力は stderr）
  const ver = run([entry, "--version"]);
  assert.equal(ver.status, 0, ver.stderr);
  assert.equal(ver.stdout.trim(), "0.1.0");
  assert.match(ver.stderr, /依存パッケージを導入しています/);
  assert.ok(!existsSync(join(skill, "scripts", "node_modules")), "スキルのディレクトリには書かない");
  const cache = join(xdg, "kenshu-loop");
  const deps = depsDirs(cache);
  assert.equal(deps.length, 1, `既定のキャッシュにロックごとの依存が1つできる: ${deps.join(",")}`);
  assert.ok(readdirSync(join(cache, deps[0]!, "node_modules")).includes("zod"));
  // 2回目以降はセットアップしない
  const again = run([entry, "--version"]);
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stderr, /依存パッケージ/);

  const ex = run([entry, "schema", "order-example"]);
  assert.equal(ex.status, 0, ex.stderr);
  assert.deepEqual(JSON.parse(ex.stdout), JSON.parse(readFileSync(join(ROOT, "examples", "memo-cli", "order.json"), "utf8")), "雛形は examples/memo-cli と同じ");

  const todo = join(ROOT, "examples", "todo-tui");
  const sc = run([entry, "term", "run-scenario", join(todo, "scenario.json"), "--cwd", todo, "--out", join(work, "sc")]);
  assert.equal(sc.status, 0, sc.stdout + sc.stderr);

  // init がコピー先スキルの references からプロンプトを読めること（run の前提）
  const target = join(work, "target");
  mkdirSync(target);
  const init = run([entry, "init", "--dir", target, "--order", join(ROOT, "examples", "memo-cli", "order.json")]);
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /受注AIの権限: permission_mode=acceptEdits/);
});

test("skill: 読み取り専用のスキル（Nix store 等）でも動き、KENSHU_LOOP_HOME でキャッシュ先を変えられる", (t) => {
  const work = mkdtempSync(join(tmpdir(), "kenshu-skill-ro-"));
  const skill = join(work, "store", "kenshu-loop");
  const entry = copySkill(skill);
  const chmodTree = (mode: "a-w" | "u+w") => spawnSync("chmod", ["-R", mode, skill]);
  chmodTree("a-w");
  t.after(() => chmodTree("u+w"));
  const cache = join(work, "cache");
  const run = runner(work, { KENSHU_LOOP_HOME: cache });

  const ver = run([entry, "--version"]);
  assert.equal(ver.status, 0, ver.stderr);
  assert.equal(ver.stdout.trim(), "0.1.0");
  assert.match(ver.stderr, /依存パッケージを導入しています/);
  assert.equal(depsDirs(cache).length, 1);

  // ネイティブ依存（tui-test）もキャッシュから読み込めて PTY が動く
  const todo = join(ROOT, "examples", "todo-tui");
  const sc = run([entry, "term", "run-scenario", join(todo, "scenario.json"), "--cwd", todo, "--out", join(work, "sc")]);
  assert.equal(sc.status, 0, sc.stdout + sc.stderr);

  const target = join(work, "target");
  mkdirSync(target);
  const init = run([entry, "init", "--dir", target, "--order", join(ROOT, "examples", "memo-cli", "order.json")]);
  assert.equal(init.status, 0, init.stderr);
});
