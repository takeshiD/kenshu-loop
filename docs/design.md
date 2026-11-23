# 設計判断

## 1. 役割分担: スキル / ランナー / モデル

- **スキル**（`skills/kenshu-loop/`）: モデルに渡す役割・判断基準・作業手順。ランナーは `references/*.md` をそのまま
  `--append-system-prompt` に入れるため、手順の情報源は1つ。人間の依頼を受けた Claude Code が発注書を作る入口にもなる。
- **ランナー**（`kenshu-loop` CLI）: プロセス起動、状態遷移、永続化、再開、ロック、上限、検証の再実行、判定の反映。
- **モデル**: 実装・基準設計（受注）、利用者試行・技術審査（検収）。モデルの文章から `COMPLETE` 等を探す終了判定はしない。
  終了は、JSON Schema 付き構造化出力 → zod 検証 → 参照整合性 → オーケストレータのゲート を通った判定だけで決まる。

## 2. 「完了」の定義

受注AIの納品は状態遷移の入力にすぎない。`accepted` になる条件:

1. 納品書がスキーマ・参照整合性・基準カバレッジ・基準変更規則を満たす
2. オーケストレータが新しい環境（コピー + setup + 隔離HOME）で全必須基準と回帰基準を再実行して合格
3. 検収AIが要求だけから作った利用シナリオで操作（第1段）
4. 検収AIの判定が検収対象の識別情報と一致し、必須要求がすべて satisfied、必須基準が妥当
5. 反映直前の fingerprint が検証時と一致

「人間が使い始められる状態」は (2) の「新しい環境での setup と起動」で担保し、`DELIVERY.md` に使い始め方を残す。

## 3. 版の固定と古い証拠

- 要求版 = `order.json` の canonical JSON の hash
- 成果物版 = 納品物ファイル（パス・実行ビット・内容）の hash。git 管理下では追跡 + 未追跡（ignore 対象外）。`.kenshu`/`.git`/`node_modules` は除外
- 基準版 = 受注基準 + 回帰基準の canonical hash（`change_reason` 等の注記は除外）

検収AIの判定は `inspected` にこの3つを書き写す必要があり、不一致は受理しない。
判定反映の直前に fingerprint を再計算し、変わっていれば判定を破棄して検証からやり直す。
受入後に成果物が変わった場合、`status` は受入が現在の成果物に適用されないと報告する。

## 4. 判定はオーケストレータだけが反映する

受注AIは対象ディレクトリで動くが、状態ファイル（`.kenshu/state.json`）に書かれた判定は使わない。
判定は毎回 `rounds/NNN/verdict.json` を zod で再検証し、さらに fingerprint 照合を経て状態に反映する。
受注AIが `.kenshu` を改ざんすることは OS レベルでは防げない（同一ユーザー権限）。これは README に明記している。
fingerprint は `.kenshu` を除外するので、成果物への変更は検出できる。

## 5. 差し戻しの分類と終わらない差し戻しの防止

- 分類: `nonconforming_deliverable` / `inadequate_criteria` / `insufficient_evidence`。理由は10文字以上、要求IDが必須。
- 要求に結びつかない改善案は `follow_ups`。`accepted` に `rework_items` を付けることは禁止。
- `max_rounds` / `max_minutes` / `max_budget_usd` で上限。到達は `limit_reached`（未受入）として区別。
- 検証で不合格の納品は検収AIを呼ばずに自動差し戻し（コスト削減と、自己申告の虚偽を判定前に弾くため）。

## 6. 回帰基準への昇格

検収AIが差し戻し項目に `regression`（command/tui の check）を添えると、オーケストレータが `REG<n>` として保存し:

- 差し戻し対象の成果物で即時に実行して「再現したか」(`reproduced`) を記録
- 以後の全ラウンドで必須基準として再実行。受注AIは削除・変更できない（`REG` IDは予約）

合格済み基準の変更・削除には `change_reason` / `removed_criteria` が必要で、変更点は検収AIの技術審査に「再審査対象」として提示される。

## 7. 検収AIの2段構成

- 第1段（利用者試行）は納品書・実装を見せないプロンプトで、新しい環境を cwd にして起動する。
  「ソースを読まない」は指示であり強制ではない（Bash は使える）。強制隔離はしていないと明記。
- 第2段（技術審査）は同じセッションを `--resume` し、試行の文脈を保ったまま納品書・検証結果・実装を確認する。
- 受注AIと検収AIは別セッション（別 session id）。同じモデルでもよい。

## 8. 端末操作基盤の選定

候補を実際に導入して確認した（2026-11-23, NixOS x86_64, Node 24）:

| 候補 | 結果 |
|---|---|
| `@microsoft/tui-test` 0.1.1 | プリビルドの `tui-test-ffi`（koffi 経由）で追加ビルドなしに動作。PTY起動、キー/貼り付け/リサイズ、セル単位の色・太字・反転、カーソル、終了コード、SVGスクリーンショット、locator 待機を確認 |
| `termless` 0.11.0 (beorn/termless) | `@termless/core` が `node-pty` を peer 依存。`node-pty` 1.1.0 は NixOS 上でネイティブビルド（python/gcc）が必要で導入に失敗。engines も node>=23.6 |

→ `@microsoft/tui-test` を選び、`TerminalDriver` インターフェースで包んだ（差し替え可能）。
tui-test のセッションはプロセス内に限られる（別プロセスから同名セッションに接続できないことを確認）ため、
エージェントが Bash から1操作ずつ動かせるよう Unix ソケットの小さなデーモン（`term start/...`）を追加した。
端末エミュレータ自体は自作していない。

検査は「現在の画面」に対して行う。`expect_text` は現在画面の行テキスト、`wait_text` は tui-test の locator 待機（最新画面）。
`col` は表示幅（全角=2）。待機は状態条件 + timeout で、idle を完了とみなす API は提供しない。

## 9. 検証環境と証拠

- 一時ディレクトリにコピーするのは、受注AIの手元に残ったビルド成果物や依存で検査が通ってしまうのを防ぐため。
  親ディレクトリの `node_modules` を拾わないよう、対象リポジトリの外（OS の tmpdir）に作る。
- 基準ごとに空の HOME を作る（順序依存の排除）。環境変数は PATH/LANG/TERM/TZ など最小限で、利用者の認証情報を渡さない。
- ハーネス記録はホワイトリストのフィールドのみ保存し、stderr・出力は redact（APIキー・トークン形状）する。
- 証拠: `rounds/NNN/verification.{json,md}`、失敗時の画面（テキスト・スタイルJSON・SVG）、`term` の `history.jsonl`/captures、
  `harness/*.json`、`events.jsonl`。

## 10. Claude Code CLI の仕様確認

`claude --help`（2.1.327）で以下を確認し、それ以外のフラグは使っていない:
`-p`, `--output-format json`, `--json-schema`, `--session-id`, `--resume`, `--permission-mode`, `--permission-prompts none`,
`--allowedTools`, `--disallowedTools`, `--max-budget-usd`, `--append-system-prompt`, `--add-dir`, `--model`。

実測で確認した挙動:
- 結果JSONの `structured_output` に構造化出力、`total_cost_usd`、`session_id`、`subtype`
- 予算超過は `subtype: "error_max_budget_usd"`, `is_error: true`
- stdin でプロンプトを渡せる。`--session-id` で作ったセッションは `--resume` で続けられる
- `--json-schema` は `$schema`（draft 2020-12）を含むと拒否され、Ajv strict モードで `type: [..]` の union を拒否する
  → draft-07 で生成し `$schema` を削除、union は `anyOf` に変換（live smoke で発見し修正、単体テストで固定）
