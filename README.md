<img src="assets/icon.svg" width="64" height="64" alt="">

# ai-loop

**AI-Loop(Acceptance Inspection Loop)** 

発注 -> 検収 -> 納品 の業務フローをモデルにしたエージェントループスキルです。

受注AIが実装と一緒に「何をどう検査すべきか（基準・根拠）」と検査結果を提出し、別セッションの検収AIが元の要求に照らして成果物と検査基準の妥当性を審査します。

- 人間は **やりたいこと・利用状況・守るべき制約** を発注書に書くだけ。通常進行に人間の承認ゲートはありません。
- 「受注AIが完了と言った」＝**納品開始**。オーケストレータが新しい環境で基準を再実行し、検収AIが利用者として試し、技術審査を通って初めて `accepted` です。
- 実行不能・情報不足・予算超過は `blocked` / `limit_reached` / `failed` として返し、合格や完了に偽装しません。
- 初版の対象は **CLI/TUI** の成果物。ハーネスは **Claude Code**（adapterで差し替え可能）。

## 全体の流れ

人間が話しかけるのは Claude Code だけです。Claude Code は **スキル**（`skills/kenshu-loop/SKILL.md`）の手順に沿って発注書を作り、
**CLI**（`kenshu-loop`）を実行します。CLI は受注AIと検収AIを、それぞれ別の Claude Code プロセスとして起動してループを回します。

```mermaid
sequenceDiagram
    actor H as 人間
    participant S as Claude Code<br/>(kenshu-loop スキル)
    participant O as kenshu-loop CLI<br/>(オーケストレータ)
    participant C as 受注AI<br/>(別プロセス)
    participant I as 検収AI<br/>(別セッション)

    H->>S: 「kenshu-loopで◯◯を作って」
    S->>S: 依頼を order.json（要求 R1, R2…）に整理
    S->>O: kenshu-loop init / run

    loop 受入されるまで（回数・時間・予算に上限あり）
        O->>C: 発注書（2回目以降は差し戻し理由・問い合わせも渡す）
        C->>C: 対象ディレクトリで実装
        C-->>O: 納品書（setup・検査基準・自己チェック）
        O->>O: 納品書を検証（スキーマ・基準不足・基準の無断変更）
        O->>O: 一時ディレクトリにコピーし、検査基準を自分で再実行
        alt 検証が不合格
            O->>O: 検収AIを呼ばずに自動で差し戻し
        else 検証が合格
            O->>I: 第1段: 要求だけを渡す（実装・納品書は見せない）
            I->>I: 利用者として実際に操作（TUIは term で PTY 操作）
            O->>I: 第2段: 納品書・検証結果・実装を渡す
            I-->>O: 判定（accepted / rework / inquiry / blocked）
            O->>O: 判定の整合性と成果物の fingerprint を確認して反映
        end
    end

    O-->>S: 終了コード + .kenshu/DELIVERY.md
    S-->>H: 使い始め方 / 足りない情報 を報告
```

各ラウンドの判定で、次にどうなるかは以下のとおりです。

```mermaid
flowchart TD
    A[受注AIが納品] --> B{CLIが基準を再実行}
    B -- 不合格 --> R[差し戻し]
    B -- 合格 --> T[検収AI: 利用者試行] --> V{検収AI: 技術審査}
    V -- accepted --> OK([accepted: 受入完了 / 終了コード 0])
    V -- rework --> R
    V -- inquiry --> Q[質問を受注AIへ渡す]
    V -- blocked --> BL([blocked: 情報不足・実行不能 / 終了コード 2])
    R --> L{上限に達した?}
    Q --> L
    L -- いいえ --> A
    L -- はい --> LR([limit_reached / 終了コード 3])
```

差し戻しの原因になったチェックは回帰基準 `REG*` として残り、以後のラウンドでも毎回再実行されます。
実行エラーは `failed`（終了コード 4）、Ctrl-C は `interrupted`（130）になり、どちらも `resume` で再開できます。

## 導入

必要なもの: Node.js 22.18 以上と npm（開発・検証は v24.22 で実施）、git、Claude Code CLI（`claude`、認証済み）。

配布物はスキルのディレクトリ `skills/kenshu-loop/` だけです。CLI もその中の `scripts/` に入っているので、**スキルを入れれば CLI も一緒に入ります**。
ビルドも PATH の設定も要りません。

```sh
# skills CLI（https://skills.sh）。-g でユーザー全体に入れる
npx skills add takeshiD/kenshu-loop -a claude-code

# または Claude Code のプラグインとして
/plugin marketplace add takeshiD/kenshu-loop
/plugin install kenshu-loop@kenshu-loop

# または手でコピー
cp -r skills/kenshu-loop <your-project>/.claude/skills/
```

Claude Code で「kenshu-loopで◯◯を発注して」と頼むと、スキルの手順に沿って発注書を作り、同梱の CLI を実行します。
ランナーも同じ `references/*.md` を受注AI・検収AIのシステムプロンプトとして読み込みます（役割と手順の唯一の情報源）。

### 同梱 CLI の仕組み

```
skills/kenshu-loop/
├── SKILL.md              # 手順（発注書の作り方・CLI の呼び方）
├── references/           # 役割ごとの手順。受注AI・検収AIのシステムプロンプトにもなる
├── assets/
│   └── order-example.json  # 発注書の雛形
└── scripts/
    ├── kenshu-loop.mjs   # CLI の入口
    ├── package.json      # 実行時の依存（zod, @microsoft/tui-test）
    ├── package-lock.json
    └── src/              # CLI 本体（TypeScript。Node の型ストリッピングでそのまま実行）
```

`node <skill>/scripts/kenshu-loop.mjs <サブコマンド>` で実行します。入口のスクリプトは、初回だけ `npm ci --omit=dev` で依存を `scripts/node_modules` に入れます。
依存を入れ直すのは `package-lock.json` が変わったときだけです。
tui-test はプラットフォーム別のプリビルドバイナリ（linux-x64-gnu 等）なので同梱せず、その環境で取得します。
そのため初回はネットワークが必要です。コンパイラや Python は不要です（NixOS 上で確認済み）。
事前に入れておくには `node <skill>/scripts/kenshu-loop.mjs setup` を実行します。

人間が端末から `kenshu-loop` として使いたい場合は、入口のスクリプトへのシンボリックリンクを PATH 上に置きます（任意）。

```sh
ln -s "$PWD/.claude/skills/kenshu-loop/scripts/kenshu-loop.mjs" ~/.local/bin/kenshu-loop
```

Nix の場合は `nix shell nixpkgs#nodejs_24 nixpkgs#git` などで Node と git を用意してください。

## 最小利用例

```sh
# kenshu-loop = node <skill>/scripts/kenshu-loop.mjs（上記のリンクを置いた場合はそのまま）
# 1. 発注書を用意（雛形: kenshu-loop schema order-example）
kenshu-loop schema order-example > order.json   # 編集する

# 2. 対象ディレクトリで初期化（既定の権限が表示される）
kenshu-loop init --dir ./my-tool --order order.json

# 3. ループ実行（受注→検証→利用者試行→技術審査→判定 を繰り返す）
kenshu-loop run --dir ./my-tool

# 4. 状態確認・再開
kenshu-loop status --dir ./my-tool [--json]
kenshu-loop resume --dir ./my-tool
```

終了コード: `0` accepted / `1` 使い方・入力エラー / `2` blocked / `3` limit_reached / `4` failed / `5` 多重起動 / `130` interrupted

受入後は `.kenshu/DELIVERY.md` に使い始め方・検収判定・後続事項（要求外の改善案）が残ります。
受入後に成果物を変更すると `status` は「この受入は現在の成果物に適用されない」と報告し、非0で終わります。

## アーキテクチャ

```
人間 ──order.json──▶ kenshu-loop (オーケストレータ)
                      │  state.json / events.jsonl / rounds/NNN/ に全段階を永続化
                      ├─ contract : 受注AI (Claude Code, 対象dirで実装) → 納品書(JSON Schema 構造化出力)
                      │             └ スキーマ + 参照整合性 + 基準不足 + 合格済み基準の無断変更 を検証
                      ├─ verify   : 納品物を一時ディレクトリへコピー(新しい環境) → setup → 基準を実プロセス/PTYで再実行
                      │             └ 不合格なら検収AIを呼ばずに具体的理由で自動差し戻し
                      ├─ trial    : 検収AI(新規セッション) 第1段: 要求だけから独自シナリオで利用者として操作
                      ├─ review   : 同セッション第2段: 納品書・検証結果・実装を審査 → 判定(JSON)
                      └─ decide   : オーケストレータだけが判定を検証して状態に反映
                                    (fingerprint再計算で古い証拠を排除 / 回帰基準へ昇格)
```

| モジュール（`skills/kenshu-loop/` 配下） | 役割 |
|---|---|
| `scripts/src/schema.ts` | 発注書・納品書・試行レポート・判定・設定・状態の zod スキーマ（実行時検証、`--json-schema` 生成） |
| `scripts/src/validate.ts` | 参照整合性、基準不足、合格済み基準の変更理由、判定の整合性、最終ゲート |
| `scripts/src/orchestrator.ts` | 状態遷移・再開・上限・中断・判定反映 |
| `scripts/src/verify.ts` | 新しい環境での setup と基準再実行（検証済み証拠） |
| `scripts/src/workspace.ts` | 納品物の識別（fingerprint）とコピー |
| `scripts/src/harness/` | `HarnessAdapter` 境界と Claude Code 実装 |
| `scripts/src/terminal/` | `TerminalDriver`（tui-test を包む薄いadapter）、シナリオ実行器、エージェント用 `term` デーモン |
| `scripts/src/exec.ts` | コマンド実行（プロセスグループ単位のtimeout/中断）、隔離環境変数 |
| `scripts/kenshu-loop.mjs` | CLI の入口（Node のバージョン確認・初回の依存導入・`src/cli.ts` の読み込み） |

DI境界: `HarnessAdapter`（ハーネス）、`CommandRunner`（コマンド実行）、`DriverFactory`/`TerminalDriver`（端末操作）、`Store`（状態保存）。

### Claude Code の呼び出し

`claude --help`（v2.1.327）で確認したフラグのみを使います:

```
claude -p --output-format json --json-schema <schema> (--session-id <uuid> | --resume <uuid>)
       --permission-mode <mode> --permission-prompts none --max-budget-usd <n>
       --append-system-prompt <skill references> [--allowedTools ...] [--disallowedTools ...] [--add-dir ...] [--model ...]
```

プロンプトは stdin で渡し、結果JSONの `structured_output` / `total_cost_usd` / `subtype` / `is_error` / `session_id` を読みます。
`error_max_budget_usd` は上限到達、それ以外のエラー・構造化出力なしは再試行対象の実行エラーとして区別します。
ハーネス記録はフィールドのホワイトリストのみ保存し、認証関連フィールドは保存しません。

## 設定（`.kenshu/config.json`）

| 項目 | 既定 | 意味 |
|---|---|---|
| `harness.bin` / `model` | `claude` / 未指定 | Claude Code 実行ファイル・モデル |
| `harness.contractor.permission_mode` | `acceptEdits` | 受注AI。対象ディレクトリを cwd に、`Read,Edit,Write,Glob,Grep,Bash` を許可（`WebFetch,WebSearch` 禁止） |
| `harness.inspector.permission_mode` | `dontAsk` | 検収AI。`Read,Glob,Grep,Bash` を許可、`Edit,Write,NotebookEdit,WebFetch,WebSearch` 禁止 |
| `*.max_budget_usd_per_call` / `timeout_minutes` | 2・30 / 1・20 | 1回の呼び出し上限 |
| `limits.max_rounds` | 4 | 納品回数の上限 |
| `limits.max_minutes` / `max_budget_usd` | 120 / 10 | 累積時間・累積コスト上限（resume をまたいで累積） |
| `limits.max_invalid_outputs` | 2 | 不正な出力・ハーネス異常の連続許容回数 |
| `verification.command_timeout_ms` / `setup_timeout_ms` | 60000 / 300000 | 検証時のタイムアウト |
| `deploy_policy` | `none` | 外部への自動マージ・デプロイは行わない（初版は固定） |

**権限について:** 受注AIは対象ディレクトリで Bash を実行できます（任意コマンド実行に相当）。
`--permission-prompts none` により確認が必要な操作は自動的に拒否されます。
`bypassPermissions` は既定では使いません。必要なら利用者が config で明示的に設定してください。
**別セッション・別ディレクトリは OS レベルのセキュリティ分離ではありません。** 検収AIの編集系ツールは禁止していますが Bash は使えます。
成果物の改変はfingerprintで検出し、その判定を無効にします（防止ではなく検出）。

## 検収の仕組み

1. **発注書（要求版）**: `order.json` の canonical hash が要求版。要求は `R1..` で、`must` が必須。
2. **納品書**: 受注AIが `setup`・`entrypoints`・`criteria`（`command` / `tui` / `review`）・`self_check` を提出。
   - 必須要求ごとに必須基準が無ければ **基準不足** として受理しない。CLIには `command` 基準、TUIには実端末の `tui` 基準が必須。
   - 前回合格した基準を変更・削除するには要求との対応を含む理由が必須（期待値の後退防止）。検収AIにも再審査させる。
3. **検証（オーケストレータ）**: 納品物（git追跡+未追跡、ignore対象・`node_modules`・`.kenshu` 除外）を一時ディレクトリへコピーし、
   空の隔離 HOME（基準ごとに独立）と最小限の環境変数で `setup` → 基準を再実行。受注AIの自己申告は信用しない。
4. **利用者試行（検収AI 第1段）**: 納品書・実装を見せず、要求から独自シナリオを作ってユーザー向け画面・ヘルプだけで操作。
5. **技術審査（検収AI 第2段、同セッション）**: 納品書・検証結果・実装を確認し `accepted` / `rework` / `inquiry` / `blocked` を判定。
   - 差し戻しは `nonconforming_deliverable`（成果物不適合）/ `inadequate_criteria`（基準不適切）/ `insufficient_evidence`（証拠不足）に分類し、要求ID・理由・期待・観察が必須。
   - 要求に結びつかない改善案は `follow_ups` に回し、受入を妨げない。
6. **判定の反映（オーケストレータのみ）**:
   - 判定の `inspected`（要求版・成果物fingerprint・基準版）が検収対象と一致しなければ受理しない。
   - 必須要求が `unverified` / `not_satisfied` のまま `accepted` は受理しない。検証不合格が残る `accepted` は `rework` に変更。
   - 反映直前に fingerprint を再計算し、検証後に成果物が変わっていたら判定を破棄して再検証（古い合格の流用禁止）。
   - 差し戻しに添えられた再現チェックは **回帰基準 `REG*`** に昇格。差し戻し対象の成果物で再現したかを記録し、以後毎回再実行。
7. 状態は `accepted` / `blocked` / `limit_reached` / `failed`（実行エラー）/ `interrupted`（中断）を区別。後3者は `resume` 可能。

## 端末操作（CLI/TUI の E2E と AI 探索の共通基盤）

[`@microsoft/tui-test`](https://github.com/microsoft/tui-test)（PTY + 実端末エミュレータ）を `TerminalDriver` で薄く包みます。
検査は **現在の画面**（文字配置・色/太字/反転・カーソル・サイズ）に対して行い、待機は状態条件 + timeout です。

```sh
K="kenshu-loop term --root ./evidence"
$K start --name s1 --cols 40 --rows 10 -- node todo.mjs
$K press --name s1 a
$K paste --name s1 "とても長い日本語のタスク名"   # bracketed paste
$K press --name s1 Enter
$K wait  --name s1 "追加しました"
$K screen --name s1 --style
$K resize --name s1 24 8
$K capture --name s1 narrow                      # テキスト/スタイルJSON/SVG
$K restart --name s1                             # 再起動後の保存確認
$K stop --name s1
kenshu-loop term run-scenario examples/todo-tui/scenario.json --cwd examples/todo-tui
```

`term` は tui-test のセッションがプロセス内にしか保持できないため、Unix ソケットの小さなデーモンで1操作ずつ操作できるようにしています。
AIの探索操作（`term start/press/...`）、検査基準の `tui` シナリオ、回帰テストは同じ `ScenarioSession` 実行器を使います。
シナリオ形式は `kenshu-loop schema scenario`、手順は `skills/kenshu-loop/references/terminal.md`。

`microsoft/tui-test` と `beorn/termless` を比較し、tui-test を選びました（理由は [docs/design.md](docs/design.md)）。

## 検証済み範囲

実行結果の詳細は [docs/verification.md](docs/verification.md)。

- 単体（23件）: スキーマ・参照整合性・基準不足・基準変更・判定ゲート・ロック・fingerprint・redact・adapter のフラグ/エラー分類
- 統合（13件）: 実 `ClaudeCodeAdapter` + 偽 `claude` プロセス + 実プロセス検証で、差し戻し→修正→受入、基準不足、自己申告の虚偽、古い証拠、別成果物の判定、blocked（正当/不当）、反復・予算・1回予算上限、ハーネス異常、問い合わせ、基準の無断弱体化、failed からの resume
- E2E（9件）: スキル同梱の CLI 入口 `scripts/kenshu-loop.mjs` を実プロセスとして起動。終了コード、SIGINT 中断と resume、多重起動拒否、TUI 納品物の PTY 検証（不具合版の自動差し戻し→修正→受入）、`term` デーモン操作、`run-scenario`、スキルのディレクトリだけを別の場所へコピーし、依存の無い状態からの初回セットアップと起動
- live smoke: 実 Claude Code (sonnet) で CLI 1件・TUI 1件がいずれも1回目で accepted（$0.70 / $0.53）。TUI では検収AIが `kenshu-loop term` で実際にPTY操作した。差し戻しループの実モデル検証は未実施

## 制約・未検証

- 確認した環境は NixOS (Linux x86_64) + Node v24.22 + Claude Code 2.1.327 のみ。macOS/Windows は未確認です。
- ハーネスは Claude Code のみ実装（Codex 等は `HarnessAdapter` を実装すれば追加可能だが未実装）。
- 検収の品質はモデルの判断に依存します。オーケストレータが保証するのは「構造・参照・版の整合」「検証済み証拠の再実行」「不合格の受入防止」「古い証拠の流用防止」までで、UI/UXの完全性は保証しません。
- 分離はOSレベルではありません（上記「権限について」）。
- Web/ブラウザ/GUI は対象外。外部への自動マージ・デプロイは行いません。

## CI

GitHub Actions の定義は `ci/github-actions.yml`（Node 24 で typecheck・単体/統合・E2E）。
初回 push に使った gh トークンに `workflow` スコープが無かったため、`.github/workflows/` には置いていません。有効化するには:

```sh
gh auth refresh -s workflow
mkdir -p .github/workflows && git mv ci/github-actions.yml .github/workflows/ci.yml
git commit -m "ci: GitHub Actions を有効化" && git push
```

## 開発

```sh
npm ci              # 開発用の依存（typescript 等）。postinstall で同梱 CLI の実行時依存も入る
npm run typecheck
npm test            # 単体 + 統合
npm run test:e2e    # 同梱 CLI を実プロセス/PTYで検証（スキルだけをコピーした状態からの初回セットアップを含む）
node scripts/live-smoke.mjs --model sonnet --budget 3   # 実 Claude Code（課金あり）
```

リポジトリ直下の `package.json` は開発用（型検査・テスト）で、配布物には含まれません。
CLI のバージョンと実行時の依存は `skills/kenshu-loop/scripts/package.json` で管理します。
依存を変えたら `cd skills/kenshu-loop/scripts && npm install` で `package-lock.json` を更新してください（入口のスクリプトはロックの変化を検知して入れ直します）。
