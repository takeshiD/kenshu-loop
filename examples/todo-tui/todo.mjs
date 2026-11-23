#!/usr/bin/env node
// 端末TODOリスト（kenshu-loop の検証用サンプル納品物。依存なし）
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const BUGS = [];
const file = process.env.TODO_FILE ?? join(process.env.HOME ?? ".", ".todo-tui.json");
const out = process.stdout;
const ESC = "\x1b[";

let items = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
let sel = 0;
let mode = "list"; // list | input | help
let input = "";
let message = "";
let lastDeleted = null;

function save() {
  if (BUGS.includes("nosave")) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file + ".tmp", JSON.stringify(items, null, 2));
  renameSync(file + ".tmp", file);
}

function wide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)
  );
}
const width = (s) => [...s].reduce((w, ch) => w + (wide(ch.codePointAt(0)) ? 2 : 1), 0);
function fit(s, max) {
  if (BUGS.includes("notruncate")) return s;
  if (width(s) <= max) return s + " ".repeat(max - width(s));
  let o = "";
  let w = 0;
  for (const ch of s) {
    const cw = wide(ch.codePointAt(0)) ? 2 : 1;
    if (w + cw > max - 1) break;
    o += ch;
    w += cw;
  }
  return o + "…" + " ".repeat(Math.max(0, max - w - 1));
}

function render() {
  const cols = out.columns || 80;
  const rows = out.rows || 24;
  let s = `${ESC}H${ESC}2J`;
  s += `${ESC}1m` + fit(`TODO (${items.length}件)`, cols) + `${ESC}0m\r\n`;
  const listRows = rows - 3;
  if (mode === "help") {
    const lines = ["操作一覧", "a: 項目を追加 (Enterで確定 / Escで取消)", "Space: 完了/未完了を切替", "d: 削除", "u: 削除を元に戻す", "j/k または ↓/↑: 移動", "q: 保存して終了", "", "何かキーを押すと戻ります"];
    for (const l of lines.slice(0, listRows)) s += fit(l, cols) + "\r\n";
  } else if (!items.length) {
    s += fit("項目がありません。a で追加できます", cols) + "\r\n";
  } else {
    const start = Math.max(0, Math.min(sel - listRows + 1, items.length - listRows));
    items.slice(start, start + listRows).forEach((it, i) => {
      const idx = start + i;
      const line = fit(`${it.done ? "[x]" : "[ ]"} ${it.text}`, cols);
      s += (idx === sel ? `${ESC}7m${line}${ESC}0m` : line) + "\r\n";
    });
  }
  s += `${ESC}${rows - 1};1H`;
  if (mode === "input") {
    const prompt = "追加> ";
    const avail = cols - width(prompt) - 1;
    let shown = input;
    while (width(shown) > avail) shown = [...shown].slice(1).join("");
    s += `${ESC}2K${ESC}32m${message ? fit(message, cols) : ""}${ESC}0m`;
    s += `${ESC}${rows};1H${ESC}2K${prompt}${shown}${ESC}?25h`;
  } else {
    s += `${ESC}2K${ESC}32m${fit(message, cols)}${ESC}0m`;
    s += `${ESC}${rows};1H${ESC}2K${ESC}2m${fit("a:追加 Space:完了 d:削除 u:戻す ?:ヘルプ q:終了", cols)}${ESC}0m${ESC}?25l`;
  }
  out.write(s);
}

function quit(code = 0) {
  save();
  out.write(`${ESC}?25h${ESC}?2004l${ESC}?1049l`);
  process.exit(code);
}

function onKey(key) {
  message = "";
  if (mode === "help") {
    mode = "list";
    return;
  }
  if (mode === "input") {
    if (key === "\r") {
      const text = input.trim();
      if (text) {
        items.push({ text, done: false });
        sel = items.length - 1;
        save();
        message = "追加しました";
      }
      mode = "list";
      input = "";
    } else if (key === "\x1b") {
      mode = "list";
      input = "";
      message = "取り消しました";
    } else if (key === "\x7f" || key === "\b") {
      input = [...input].slice(0, -1).join("");
    } else if (!key.startsWith("\x1b") && key >= " ") {
      input += key.replace(/[\r\n]+/g, " ");
    }
    return;
  }
  switch (key) {
    case "q":
    case "\x03":
      quit(0);
      break;
    case "a":
      mode = "input";
      input = "";
      break;
    case "?":
      mode = "help";
      break;
    case "j":
    case "\x1b[B":
      sel = Math.min(items.length - 1, sel + 1);
      break;
    case "k":
    case "\x1b[A":
      sel = Math.max(0, sel - 1);
      break;
    case " ":
      if (items[sel]) {
        items[sel].done = !items[sel].done;
        save();
      }
      break;
    case "d":
      if (items[sel]) {
        lastDeleted = { item: items[sel], index: sel };
        items.splice(sel, 1);
        sel = Math.max(0, Math.min(sel, items.length - 1));
        save();
        message = "削除しました (u で元に戻す)";
      }
      break;
    case "u":
      if (lastDeleted && !BUGS.includes("noundo")) {
        items.splice(lastDeleted.index, 0, lastDeleted.item);
        sel = lastDeleted.index;
        lastDeleted = null;
        save();
        message = "元に戻しました";
      } else message = "元に戻す操作はありません";
      break;
  }
}

// 入力の分解: bracketed paste はまとめて1回の入力として扱う
let buf = "";
function feed(data) {
  buf += data;
  while (buf.length) {
    if (buf.startsWith("\x1b[200~")) {
      const end = buf.indexOf("\x1b[201~");
      if (end < 0) return;
      const pasted = buf.slice(6, end);
      buf = buf.slice(end + 6);
      if (mode === "input") input += pasted.replace(/[\r\n]+/g, " ");
      continue;
    }
    const m = buf.match(/^\x1b\[[0-9;]*[A-Za-z~]/);
    if (m) {
      onKey(m[0]);
      buf = buf.slice(m[0].length);
      continue;
    }
    const ch = [...buf][0];
    buf = buf.slice(ch.length);
    onKey(ch);
  }
  render();
}

if (!process.stdin.isTTY) {
  console.error("このアプリは端末で起動してください");
  process.exit(2);
}
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
out.write(`${ESC}?1049h${ESC}?2004h`);
process.stdin.on("data", feed);
out.on("resize", render);
process.on("SIGTERM", () => quit(0));
render();
