#!/usr/bin/env node
// 実際の Claude Code を使う小さな live smoke。予算・反復を絞って一時ディレクトリで1案件を回す。
// 使い方: node scripts/live-smoke.mjs [--model sonnet] [--budget 3]
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { model: { type: "string", default: "sonnet" }, budget: { type: "string", default: "3" }, keep: { type: "string" }, kind: { type: "string", default: "cli" } } });
const root = resolve(import.meta.dirname, "..");
const cli = join(root, "skills", "kenshu-loop", "scripts", "kenshu-loop.mjs");
const base = values.keep ?? mkdtempSync(join(tmpdir(), "kenshu-live-"));
const target = join(base, "target");
mkdirSync(target, { recursive: true });
spawnSync("git", ["init", "-q", target]);
const cliOrder = {
  schema: "kenshu-loop/order@1",
  title: "あいさつCLI",
  summary: "名前を渡すと日本語であいさつを返す小さなCLIがほしい。",
  deliverable_type: "cli",
  context: "Node.js が入ったLinux端末で使う。依存パッケージは不要。",
  requirements: [
    { id: "R1", kind: "goal", text: "node greet.mjs <名前> で「こんにちは、<名前>さん」と1行出力し終了コード0で終わる", must: true },
    { id: "R2", kind: "usage", text: "名前を渡さずに実行したら使い方を標準エラーに出して終了コード2で終わる", must: true },
  ],
  out_of_scope: ["多言語対応"],
};
const tuiOrder = {
  schema: "kenshu-loop/order@1",
  title: "端末カウンター",
  summary: "端末で数を数えるための小さなTUIがほしい。",
  deliverable_type: "tui",
  context: "Node.js が入ったLinux端末で使う。依存パッケージは不要。",
  requirements: [
    { id: "R1", kind: "goal", text: "起動すると現在の数が画面に表示され、+ で1増え - で1減る。操作方法が画面に表示されている", must: true },
    { id: "R2", kind: "constraint", text: "q で終了し、再起動すると前回の数が表示される（$HOME/.counter.json に保存）", must: true },
  ],
  out_of_scope: ["マウス操作"],
};
const order = values.kind === "tui" ? tuiOrder : cliOrder;
writeFileSync(join(base, "order.json"), JSON.stringify(order, null, 2));
const run = (args) => spawnSync(process.execPath, [cli, ...args], { stdio: "inherit" });
let r = run(["init", "--dir", target, "--order", join(base, "order.json"), "--model", values.model]);
if (r.status !== 0) process.exit(r.status ?? 1);
const cfgPath = join(target, ".kenshu", "config.json");
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
cfg.limits = { ...cfg.limits, max_rounds: 2, max_minutes: 25, max_budget_usd: Number(values.budget), max_invalid_outputs: 1 };
cfg.harness.contractor.max_budget_usd_per_call = 1;
cfg.harness.inspector.max_budget_usd_per_call = 0.8;
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
r = run(["run", "--dir", target]);
console.log(`\nlive smoke exit=${r.status} dir=${target}`);
run(["status", "--dir", target]);
process.exit(r.status ?? 1);
