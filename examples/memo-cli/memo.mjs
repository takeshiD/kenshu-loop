#!/usr/bin/env node
// 小さなメモCLI（kenshu-loop の検証用サンプル納品物）
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
const BUGS = [];
const file = process.env.MEMO_FILE ?? join(process.env.HOME ?? ".", ".memo.json");
const load = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : []);
const save = (items) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file + ".tmp", JSON.stringify(items, null, 2));
  renameSync(file + ".tmp", file);
};
const [cmd, ...args] = process.argv.slice(2);
const help = "使い方: memo add <テキスト> | memo list | memo rm <番号> | memo --help";
if (!cmd || cmd === "--help" || cmd === "-h") {
  console.log(help);
  process.exit(cmd ? 0 : 1);
}
if (cmd === "add") {
  const text = args.join(" ").trim();
  if (!text) {
    console.error("エラー: テキストが必要です\n" + help);
    process.exit(2);
  }
  const items = load();
  items.push(text);
  if (!BUGS.includes("nosave")) save(items);
  console.log(`追加しました (#${items.length})`);
} else if (cmd === "list") {
  const items = load();
  if (!items.length) console.log("メモはありません");
  items.forEach((t, i) => console.log(`${i + 1}. ${t}`));
} else if (cmd === "rm") {
  const items = load();
  const n = Number(args[0]);
  if (!Number.isInteger(n) || n < 1 || n > items.length) {
    console.error(`エラー: 番号 ${args[0] ?? ""} のメモはありません`);
    process.exit(BUGS.includes("rm-exit0") ? 0 : 2);
  }
  const [removed] = items.splice(n - 1, 1);
  save(items);
  console.log(`削除しました: ${removed}`);
} else {
  console.error(`エラー: 不明なコマンド ${cmd}\n${help}`);
  process.exit(2);
}
