// モデルへ渡す役割と手順はスキル(skills/kenshu-loop/references)を唯一の情報源として読み込む。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Order, Submission, TrialReport } from "./schema.ts";
import type { Verification } from "./verify.ts";
import type { Identity } from "./validate.ts";

export const SKILL_DIR = fileURLToPath(new URL("../skills/kenshu-loop/", import.meta.url));

function ref(name: string): string {
  return readFileSync(`${SKILL_DIR}references/${name}`, "utf8");
}

export function systemPrompt(role: "contractor" | "trial" | "review"): string {
  const common =
    "あなたは kenshu-loop（発注・納品・検収型エージェントループ）の一員です。最終回答は必ず指定されたJSONスキーマの構造化出力で返してください。" +
    "実行できなかったこと・確認できなかったことを成功や合格として報告してはいけません。認証情報や利用者の私物データを出力・保存しないでください。\n\n";
  if (role === "contractor") return common + ref("contractor.md") + "\n\n" + ref("terminal.md");
  if (role === "trial") return common + ref("inspector-trial.md") + "\n\n" + ref("terminal.md");
  return common + ref("inspector-review.md");
}

const json = (v: unknown) => "```json\n" + JSON.stringify(v, null, 2) + "\n```";

export function contractPrompt(a: {
  order: Order;
  orderVersion: string;
  round: number;
  workDir: string;
  termCmd: string;
  feedback: unknown;
  regressions: unknown[];
  previousSubmission?: Submission;
}): string {
  const parts = [
    `# 発注（要求版 ${a.orderVersion}） — 第${a.round}回 納品`,
    json(a.order),
    `作業ディレクトリ: ${a.workDir}`,
    `端末操作ツール: \`${a.termCmd}\`（使い方はシステムプロンプトの「端末操作」）`,
  ];
  if (a.feedback) {
    parts.push("# 前回の検収結果・指摘（すべてに対応すること）", json(a.feedback));
  }
  if (a.regressions.length) {
    parts.push("# 回帰基準（オーケストレータが毎回再実行する。削除・変更不可）", json(a.regressions));
  }
  if (a.previousSubmission) {
    parts.push("# あなたの前回の納品書（参考。合格済み基準の変更・削除には理由が必要）", json(a.previousSubmission));
  }
  parts.push("作業を終えたら、納品書を構造化出力で返してください。");
  return parts.join("\n\n");
}

export function trialPrompt(a: {
  order: Order;
  orderVersion: string;
  round: number;
  envDir: string;
  homeDir: string;
  entrypoints: Submission["entrypoints"];
  termCmd: string;
  evidenceDir: string;
  rejection?: string[];
}): string {
  return [
    `# 検収（第${a.round}回）第1段: 利用者試行`,
    a.rejection?.length ? `前回のレポートは次の理由で受理されませんでした（修正して再提出）:\n${a.rejection.map((e) => `- ${e}`).join("\n")}` : "",
    `発注書（要求版 ${a.orderVersion}）:`,
    json(a.order),
    `## 試用環境`,
    `- 成果物は新しい環境 ${a.envDir} に展開・setup済みです。ここをカレントディレクトリとして操作してください。`,
    `- 隔離HOME: ${a.homeDir}（CLIを直接実行するときは \`HOME=${a.homeDir}\` を付けてください）`,
    `- 利用者向けの起動方法（受注側が申告したもの）:`,
    json(a.entrypoints.map((e) => ({ id: e.id, kind: e.kind, argv: e.argv, description: e.description }))),
    `- 端末操作: \`${a.termCmd}\`（start の --cwd には ${a.envDir} を指定）`,
    `- 証拠の保存先: ${a.evidenceDir}`,
    `受注側の検査基準や実装はまだ見ずに、要求から独自の利用シナリオを作って試してください。終わったら TrialReport を構造化出力で返してください。`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function reviewPrompt(a: {
  order: Order;
  identity: Identity;
  round: number;
  submission: Submission;
  verification: Verification;
  trial: TrialReport | null;
  regressions: unknown[];
  changedCriteria: unknown[];
  sourceDir: string;
  evidenceDir: string;
  previousVerdicts: unknown[];
  rejection?: string[];
}): string {
  const ver = {
    setup_ok: a.verification.setup_ok,
    setup: a.verification.setup.map((s) => ({ argv: s.argv, exit_code: s.exit_code, ok: s.ok })),
    results: a.verification.results.map((r) => ({
      criterion_id: r.criterion_id,
      status: r.status,
      detail: r.detail,
      command: r.command ? { argv: r.command.argv, exit_code: r.command.exit_code, stdout: r.command.stdout.slice(0, 1500), stderr: r.command.stderr.slice(0, 800) } : undefined,
      scenario: r.scenario
        ? { status: r.scenario.status, failure: r.scenario.failure, steps: r.scenario.steps.map((s) => ({ do: s.step.do, ok: s.ok, expected: s.expected, actual: s.actual })), artifacts: r.scenario.artifacts }
        : undefined,
    })),
    failures: a.verification.failures,
  };
  return [
    `# 検収（第${a.round}回）第2段: 技術審査と判定`,
    `## 検収対象の識別情報（inspected にそのまま書く）`,
    json(a.identity),
    `## 発注書`,
    json(a.order),
    `## 受注側の納品書`,
    json(a.submission),
    a.submission.status === "blocked" ? "受注側は blocked を申告しています。理由が正当か（受注側の努力で解決できないか）を審査してください。" : "",
    `## オーケストレータによる検証結果（新しい環境での再実行。これが検証済み証拠）`,
    json(ver),
    `## あなたの利用者試行の結果`,
    a.trial ? json(a.trial) : "（受注側が blocked を申告したため試行なし）",
    a.regressions.length ? `## 回帰基準\n${json(a.regressions)}` : "",
    a.changedCriteria.length ? `## 前回合格済みから変更・削除された基準（理由を再審査すること）\n${json(a.changedCriteria)}` : "",
    a.previousVerdicts.length ? `## 過去の判定（参考）\n${json(a.previousVerdicts)}` : "",
    `実装は ${a.sourceDir} で読めます（変更禁止）。証拠は ${a.evidenceDir} にあります。`,
    a.rejection?.length ? `## 前回あなたが返した判定は次の理由で受理されませんでした（修正して再提出）\n${a.rejection.map((e) => `- ${e}`).join("\n")}` : "",
    `判定を構造化出力で返してください。`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
