# 実施した検査と結果（2026-11-23）

環境: NixOS (Linux 6.18, x86_64) / Node v24.22.2 / npm (Nix) / Claude Code 2.1.327 / `@microsoft/tui-test` 0.1.1

## 自動テスト（`npm run typecheck && npm run test:all`）

全45件合格。モック（偽ハーネス）による検証と、実 Claude Code による live 検証を区別して記載します。

### 単体（23件）— プロセス起動なし、またはモック runner
- スキーマ: 発注書の必須フィールド欠落・重複ID
- 納品書: 基準不足（必須要求の未カバー、CLIに command 基準なし、TUIに tui 基準なし、review のみ）、不正参照、予約ID、
  合格済み基準の無断変更・削除（理由付きなら受理）、問い合わせ未回答、blocked の理由なし
- 判定: 別成果物/基準版を指す判定、unverified のままの accepted、要求評価の欠落、具体的でない差し戻し理由、
  不適切と評価した基準での accepted、検証不合格が残る accepted → rework へのゲート
- ロック（生存PID拒否・死んだPID奪取）、fingerprint（内容/実行ビット/除外/gitignore）、redact
- Claude Code adapter: 使用フラグ、stdin渡し、予算超過/実行エラー/構造化出力なし/壊れたJSONの区別、認証関連フィールドを記録しない
- `--json-schema` 用スキーマに `$schema` と union type を含めない（live smoke で見つけた不具合の回帰テスト）

### 統合（13件）— 実 `ClaudeCodeAdapter` + 偽 `claude` プロセス（`test/fixtures/fake-claude.mjs`）+ 実プロセスによる検証
差し戻し→修正→受入（回帰基準への昇格と再現記録）、基準不足の再提出、受注の虚偽 self_check を検証で検出して自動差し戻し、
検収中の成果物変更（古い証拠）で判定破棄→再検証、別成果物の判定拒否と理由付き再提出、blocked（正当/不当）、
反復上限・累積予算上限・1回予算上限・ハーネス異常・起動不能、問い合わせ→回答→再検収、合格済み基準の無断弱体化、failed からの resume。

※ ここでの「検収AI/受注AI」は偽プロセスで、判断の質は検証していません（オーケストレータの状態遷移・検証・ゲートの検証）。

### E2E（9件）— ビルド済み配布物を実プロセス/PTYで起動
- `dist/cli.js` の help/version/不正引数/不正な発注書の終了コードと stdout/stderr
- init → run（差し戻し→受入）→ status --json → 再 run 拒否 → resume、受入後の改変で status が非0
- blocked = exit 2、limit_reached = exit 3
- SIGINT: exit 130、`interrupted` 保存、偽 claude 子プロセス終了、ロック解放、実行中の多重起動 exit 5、resume で受入
- TUI 納品物（`examples/todo-tui`）を PTY シナリオで検証: undo 不具合版が「元に戻しました」待ちで失敗→画面証拠（txt/json/svg）→自動差し戻し→修正版で32ステップ合格
- `term` デーモン: start/press/paste(bracketed)/wait/screen --style/step/resize/capture/wait_exit/restart（保存確認）/stop、履歴と隔離HOME
- `term run-scenario`: 正常版 exit 0、`notruncate` 不具合版は失敗ステップと期待/実際と失敗時の現在画面を報告して exit 1
- `npm pack` → 別ディレクトリへ `npm install` → インストール後の `kenshu-loop --version` / `schema order-example` / `term run-scenario` / `init`

サンプルTUIの不具合版（`nosave` / `notruncate` / `noundo`）は、同じシナリオでそれぞれ保存確認・狭い端末・取消のステップで検出されることを手動でも確認。

## live smoke（実 Claude Code, `scripts/live-smoke.mjs`, model=sonnet）

| 案件 | 結果 | ラウンド | コスト | 時間 | 内容 |
|---|---|---|---|---|---|
| 1回目 CLI | failed (exit 4) | 1 | $0 | 1s | `--json-schema` が `$schema`(2020-12) を拒否。ハーネス異常として `failed` を正直に報告 → 修正 |
| CLI「あいさつCLI」 | **accepted** | 1 | $0.70 | 30s | 受注: `greet.mjs` + command 基準2件。検証で再実行合格。検収AIが独自に3シナリオ（スペース入り名前、空文字、--help）を試行。`--help` の挙動は要求外として follow_ups へ |
| TUI「端末カウンター」 | **accepted** | 1 | $0.53 | 59s | 受注: tui 基準2件（+/-操作、q終了→再起動後の保存）をオーケストレータがPTYで再実行し合格。検収AIは `kenshu-loop term` で20操作（キャプチャ保存）し3シナリオ。即時保存/Ctrl+C時の保存は試行では `unverified` と申告、技術審査でコード確認の上 accepted |

live smoke で確認できたこと: Claude Code の構造化出力・セッション分離・resume（trial→review）・権限設定で権限拒否が0件であったこと、
検収AIがエージェント用端末ツールを実際に使えること。live smoke は小規模な2案件のみで、差し戻しループを実モデルで通した記録はありません（差し戻し系は偽ハーネスで検証）。

## 未検証

- macOS / Windows / aarch64、Node 22 系（engines は >=22.18 としたが実行確認は v24 のみ）
- GitHub Actions 上での実行（定義は `ci/github-actions.yml`。push に使った gh トークンに `workflow` スコープが無く `.github/workflows/` へ置けなかったため未実行。README の手順で有効化）
- 大規模リポジトリでの fingerprint/コピーの性能
- 実モデルでの差し戻し→修正→再検収、blocked、inquiry の挙動
