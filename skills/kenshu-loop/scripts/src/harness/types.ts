// エージェントハーネスの境界。初版の実装は Claude Code のみ。
import type { RoleConfig } from "../schema.ts";

export type Role = "contractor" | "inspector";

export interface HarnessRequest {
  role: Role;
  /** 記録用のラベル（例: contract-r1, trial-r1） */
  label: string;
  cwd: string;
  prompt: string;
  systemPrompt: string;
  jsonSchema: Record<string, unknown>;
  /** 新規セッションID、または resume するセッションID */
  sessionId: string;
  resume: boolean;
  permissions: RoleConfig;
  maxBudgetUsd: number;
  timeoutMs: number;
  addDirs: string[];
  signal: AbortSignal;
  /** ハーネス生出力の保存先（認証情報は保存しない） */
  logPath: string;
}

export interface HarnessResult {
  ok: boolean;
  /** 構造化出力（未検証）。オーケストレータがスキーマ検証する。 */
  structured?: unknown;
  sessionId: string;
  costUsd: number;
  /** 失敗分類: 実行エラー/予算超過/タイムアウト/中断 */
  error?: { kind: "spawn" | "exit" | "parse" | "budget" | "timeout" | "aborted" | "no_structured_output" | "harness_error"; message: string };
}

export interface HarnessAdapter {
  readonly name: string;
  invoke(req: HarnessRequest): Promise<HarnessResult>;
}
