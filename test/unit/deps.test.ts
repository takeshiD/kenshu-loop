// 開発用ハーネス（型検査・テスト）は src を直接 import するので、実行時依存をリポジトリ直下の devDependencies にも入れている。
// 配布物（skills/kenshu-loop/scripts/package.json）と版がずれると、テストが通っても配布物で壊れるので一致を保証する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../helpers/project.ts";

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

test("依存: 開発用の devDependencies は配布物の dependencies と同じ版", () => {
  const dist = readJson(join(ROOT, "skills", "kenshu-loop", "scripts", "package.json")).dependencies as Record<string, string>;
  const dev = readJson(join(ROOT, "package.json")).devDependencies as Record<string, string>;
  for (const [name, version] of Object.entries(dist)) {
    assert.equal(dev[name], version, `${name}: 配布物 ${version} / 開発用 ${dev[name]}`);
  }
});
