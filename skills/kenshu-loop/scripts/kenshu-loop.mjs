#!/usr/bin/env node
// kenshu-loop CLI の入口。
//
// スキルのディレクトリだけで動くように、ビルド済みファイルや PATH 上のコマンドに頼らない。
// 1. Node.js のバージョンを確認する（src/*.ts を型ストリッピングで直接実行するため 22.18 以上）
// 2. 依存（zod, @microsoft/tui-test）を、ロックのハッシュごとのキャッシュ
//    $KENSHU_LOOP_HOME > $XDG_CACHE_HOME/kenshu-loop > ~/.cache/kenshu-loop の deps-<hash>/ に npm ci --omit=dev する
//    （初回とロック変更時のみ。tui-test はプラットフォーム別のプリビルドバイナリなので同梱せず、その環境で取得する）
//    スキルのディレクトリには書かないので、Nix store などの読み取り専用インストールでも動く。
// 3. スキル内のコードからのパッケージ名 import をキャッシュ側から解決するフックを入れ、src/cli.ts を読み込んで実行する
//    （src はコピーしないのでパスは変わらない。祖先ディレクトリの node_modules より常にキャッシュを優先し、ロックどおりの版を使う）
//
// `node kenshu-loop.mjs setup` は 2 までを行って終わる（事前に依存を入れておきたいとき用）。
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  process.stderr.write(`kenshu-loop: Node.js 22.18 以上が必要です（現在 v${process.versions.node}）\n`);
  process.exit(1);
}

const lockHash = createHash("sha256").update(readFileSync(join(here, "package-lock.json"))).digest("hex");
const STAMP = ".kenshu-loop-lock";
const ready = (dir) => {
  const stamp = join(dir, "node_modules", STAMP);
  return existsSync(stamp) && readFileSync(stamp, "utf8") === lockHash;
};

/** dir にある package.json / package-lock.json で npm ci する。失敗したら終了する。 */
function npmCi(dir) {
  process.stderr.write("kenshu-loop: 依存パッケージを導入しています（初回のみ: npm ci --omit=dev）…\n");
  // stdout は CLI の出力（JSON など）に使うので、npm の出力はすべて stderr に流す
  const win = process.platform === "win32";
  const r = spawnSync(win ? "npm.cmd" : "npm", ["ci", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], {
    cwd: dir,
    stdio: ["ignore", 2, 2],
    shell: win,
  });
  if (r.status !== 0) {
    process.stderr.write(
      `kenshu-loop: 依存パッケージの導入に失敗しました（${r.error?.message ?? `終了コード ${r.status}`}）。\n` +
        `ネットワークと npm を確認し、もう一度実行してください（導入先: ${dir}）\n`,
    );
    rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  }
  writeFileSync(join(dir, "node_modules", STAMP), lockHash);
}

/** キャッシュに依存を用意し、そのディレクトリを返す。 */
function cachedDeps() {
  const root = process.env.KENSHU_LOOP_HOME || join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "kenshu-loop");
  const dir = join(root, `deps-${lockHash.slice(0, 16)}`);
  if (ready(dir)) return dir;
  // 同時に初回起動されても壊れないよう、一時ディレクトリに入れてから名前を変えて公開する
  const tmp = `${dir}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  for (const f of ["package.json", "package-lock.json"]) cpSync(join(here, f), join(tmp, f));
  npmCi(tmp);
  try {
    if (!ready(dir)) rmSync(dir, { recursive: true, force: true }); // 途中で壊れた残骸
    renameSync(tmp, dir);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    if (!ready(dir)) throw e; // 他のプロセスが先に公開したなら、それを使う
  }
  return dir;
}

const deps = cachedDeps();
const hereUrl = pathToFileURL(here).href;
const depsParent = pathToFileURL(join(deps, "package.json")).href;
const bare = (s) => !/^(\.|\/|#|[a-zA-Z][a-zA-Z0-9+.-]*:)/.test(s);
registerHooks({
  resolve(specifier, context, nextResolve) {
    // スキル内のコードからのパッケージ名 import は、キャッシュ側から import したものとして解決する
    if (bare(specifier) && context.parentURL?.startsWith(hereUrl)) {
      try {
        return nextResolve(specifier, { ...context, parentURL: depsParent });
      } catch {
        // キャッシュに無いもの（型だけの import 等）は通常の解決に任せる
      }
    }
    return nextResolve(specifier, context);
  },
});

if (process.argv[2] === "setup") {
  process.stdout.write("kenshu-loop: セットアップ済みです\n");
} else {
  await import("./src/cli.ts");
}
