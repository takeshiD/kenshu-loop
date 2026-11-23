import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

/** キー順を固定したJSON。ハッシュ・比較用。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = sortKeys(val);
    }
    return out;
  }
  return v;
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
export function shortHash(value: unknown): string {
  return sha256(canonicalJson(value)).slice(0, 16);
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}
export function writeTextAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}
export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
export function readJsonIfExists(path: string): unknown | undefined {
  return existsSync(path) ? readJson(path) : undefined;
}
export function appendJsonl(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(value) + "\n");
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[abpr]-[A-Za-z0-9-]{10,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
  /((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"']{8,}/gi,
];
/** 証拠・ログに認証情報らしき文字列を残さない。 */
export function redact(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p, (m, prefix) => (typeof prefix === "string" && prefix.length < m.length ? `${prefix}[REDACTED]` : "[REDACTED]"));
  }
  return out;
}

export function truncate(text: string, max = 8000): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…(${text.length - max} chars truncated)`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export class KenshuError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}
