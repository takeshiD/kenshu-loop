// 納品物の識別（fingerprint）と、新しい検査環境へのコピー。
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, mkdirSync, copyFileSync, existsSync, lstatSync, readlinkSync, symlinkSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { createHash } from "node:crypto";

const ALWAYS_EXCLUDE = new Set([".git", ".kenshu", "node_modules"]);

function isExcluded(rel: string): boolean {
  const first = rel.split(/[\\/]/)[0] ?? "";
  return ALWAYS_EXCLUDE.has(first);
}

/** 納品物を構成するファイル一覧（相対パス、ソート済み）。gitなら追跡+未追跡(ignore除外)、それ以外は走査。 */
export function listDeliverableFiles(root: string): string[] {
  let files: string[] | undefined;
  if (existsSync(join(root, ".git"))) {
    try {
      const out = execFileSync("git", ["-C", root, "ls-files", "-co", "--exclude-standard", "-z"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 256 * 1024 * 1024,
      });
      files = out.split("\0").filter(Boolean);
    } catch {
      files = undefined;
    }
  }
  if (!files) {
    files = [];
    const walk = (dir: string) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, ent.name);
        const rel = relative(root, abs);
        if (isExcluded(rel)) continue;
        if (ent.isDirectory()) walk(abs);
        else if (ent.isFile() || ent.isSymbolicLink()) files!.push(rel.split(sep).join("/"));
      }
    };
    walk(root);
  }
  return [...new Set(files)].filter((f) => !isExcluded(f) && existsOrLink(join(root, f))).sort();
}

function existsOrLink(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** パス・実行ビット・内容から決まる納品物の識別子。 */
export function fingerprint(root: string): string {
  const h = createHash("sha256");
  for (const rel of listDeliverableFiles(root)) {
    const abs = join(root, rel);
    const st = lstatSync(abs);
    h.update(rel + "\0");
    if (st.isSymbolicLink()) h.update("L" + readlinkSync(abs));
    else if (st.isFile()) {
      h.update(st.mode & 0o111 ? "X" : "F");
      h.update(createHash("sha256").update(readFileSync(abs)).digest());
    }
    h.update("\n");
  }
  return h.digest("hex").slice(0, 24);
}

/** 新しい検査環境: 納品物ファイルだけを別ディレクトリへコピーする（ビルド生成物・依存は持ち込まない）。 */
export function copyDeliverable(root: string, dest: string): number {
  const files = listDeliverableFiles(root);
  for (const rel of files) {
    const src = join(root, rel);
    const dst = join(dest, rel);
    mkdirSync(dirname(dst), { recursive: true });
    const st = lstatSync(src);
    if (st.isSymbolicLink()) symlinkSync(readlinkSync(src), dst);
    else if (st.isFile()) copyFileSync(src, dst);
  }
  return files.length;
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
