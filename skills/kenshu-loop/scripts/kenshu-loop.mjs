#!/usr/bin/env node
// kenshu-loop CLI の入口。
//
// スキルのディレクトリだけで動くように、ビルド済みファイルや PATH 上のコマンドに頼らない。
// 1. Node.js のバージョンを確認する（src/*.ts を型ストリッピングで直接実行するため 22.18 以上）
// 2. 依存（zod, @microsoft/tui-test）が package-lock.json どおりに入っていなければ npm ci --omit=dev する
//    （初回のみ。tui-test はプラットフォーム別のプリビルドバイナリなので同梱せず、その環境で取得する）
// 3. src/cli.ts を読み込んで実行する
//
// `node kenshu-loop.mjs setup` は 2 までを行って終わる（事前に依存を入れておきたいとき用）。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  process.stderr.write(`kenshu-loop: Node.js 22.18 以上が必要です（現在 v${process.versions.node}）\n`);
  process.exit(1);
}

const lockHash = createHash("sha256").update(readFileSync(join(here, "package-lock.json"))).digest("hex");
const stamp = join(here, "node_modules", ".kenshu-loop-lock");
const installed = existsSync(stamp) && readFileSync(stamp, "utf8") === lockHash;
if (!installed) {
  process.stderr.write("kenshu-loop: 依存パッケージを導入しています（初回のみ: npm ci --omit=dev）…\n");
  // stdout は CLI の出力（JSON など）に使うので、npm の出力はすべて stderr に流す
  const win = process.platform === "win32";
  const r = spawnSync(win ? "npm.cmd" : "npm", ["ci", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], {
    cwd: here,
    stdio: ["ignore", 2, 2],
    shell: win,
  });
  if (r.status !== 0) {
    process.stderr.write(
      `kenshu-loop: 依存パッケージの導入に失敗しました（${r.error?.message ?? `終了コード ${r.status}`}）。\n` +
        `ネットワークと npm を確認し、次を手動で実行してください: cd ${here} && npm ci --omit=dev\n`,
    );
    process.exit(1);
  }
  writeFileSync(stamp, lockHash);
}

if (process.argv[2] === "setup") {
  process.stdout.write("kenshu-loop: セットアップ済みです\n");
} else {
  await import("./src/cli.ts");
}
