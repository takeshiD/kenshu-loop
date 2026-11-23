import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, hostname } from "node:os";
import { spawnSync } from "node:child_process";
import { Store } from "../../src/store.ts";
import { fingerprint, listDeliverableFiles, copyDeliverable } from "../../src/workspace.ts";
import { redact } from "../../src/util.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "kenshu-unit-"));

test("ロック: 生存中のPIDが保持していれば多重起動を拒否、解放後は取得できる", () => {
  const s = new Store(tmp());
  const release = s.acquireLock();
  assert.throws(() => s.acquireLock(), /実行中/);
  release();
  assert.equal(existsSync(s.path("lock")), false);
  s.acquireLock()();
});

test("ロック: 死んだPIDのロック（クラッシュ跡）は奪取する", () => {
  const s = new Store(tmp());
  mkdirSync(s.dir, { recursive: true });
  writeFileSync(s.path("lock"), JSON.stringify({ pid: 2 ** 22 + 12345, host: hostname(), at: "x" }));
  const release = s.acquireLock();
  release();
});

test("fingerprint: 内容・実行ビットの変更で変わり、.kenshu や node_modules は無視する", () => {
  const d = tmp();
  writeFileSync(join(d, "a.txt"), "hello");
  const f1 = fingerprint(d);
  mkdirSync(join(d, ".kenshu"));
  writeFileSync(join(d, ".kenshu", "state.json"), "{}");
  mkdirSync(join(d, "node_modules"));
  writeFileSync(join(d, "node_modules", "x.js"), "1");
  assert.equal(fingerprint(d), f1);
  writeFileSync(join(d, "a.txt"), "hello!");
  const f2 = fingerprint(d);
  assert.notEqual(f2, f1);
  spawnSync("chmod", ["+x", join(d, "a.txt")]);
  assert.notEqual(fingerprint(d), f2);
});

test("fingerprint: git管理下では .gitignore 対象を除外し、未追跡ファイルは含める", () => {
  const d = tmp();
  spawnSync("git", ["init", "-q", d]);
  writeFileSync(join(d, ".gitignore"), "build/\n");
  writeFileSync(join(d, "src.js"), "1");
  mkdirSync(join(d, "build"));
  writeFileSync(join(d, "build", "out.js"), "x");
  assert.deepEqual(listDeliverableFiles(d), [".gitignore", "src.js"]);
  const f = fingerprint(d);
  writeFileSync(join(d, "build", "out.js"), "y");
  assert.equal(fingerprint(d), f);
  const e = tmp();
  copyDeliverable(d, e);
  assert.equal(existsSync(join(e, "build")), false);
});

test("redact: 認証情報らしき文字列を伏せる", () => {
  const s = redact(`key ${"sk-" + "ant-api03-"}abcdefghijklmnop and ${"gh" + "p_"}abcdefghijklmnopqrstuvwxyz012345 token=supersecretvalue`);
  assert.doesNotMatch(s, /abcdefghijklmnop|supersecretvalue/);
});
