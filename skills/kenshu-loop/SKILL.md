---
name: kenshu-loop
description: 発注・納品・検収型のエージェントループ。人間のやりたいこと・利用状況・制約を発注書(order.json)に整理し、kenshu-loop CLIで受注AI（実装と検査基準・証拠の提出）と別セッションの検収AI（利用者試行と技術審査）を回して、使い始められる状態まで確認する。CLI/TUIツールを作らせて検収まで任せたいとき、kenshu-loopの状態確認・再開・端末操作(term)を行うときに使う。
---

# kenshu-loop

製造業の発注→納品→受入検収をモデルにしたループ。人間は発注するだけで、検収はAIが行う。
「受注AIが完了と言った」は**納品開始**であって完了ではない。オーケストレータの検証と検収AIの判定が通って初めて `accepted` になる。

## 役割とこのスキルの使い分け

| 状況 | 読むもの |
|---|---|
| 人間の依頼を発注書にする | [references/ordering.md](references/ordering.md) |
| 受注AIとして実装・基準・証拠を出す（ランナーが自動で渡す） | [references/contractor.md](references/contractor.md) |
| 検収AIの利用者試行（ランナーが自動で渡す） | [references/inspector-trial.md](references/inspector-trial.md) |
| 検収AIの技術審査（ランナーが自動で渡す） | [references/inspector-review.md](references/inspector-review.md) |
| 端末アプリを1操作ずつ動かす / シナリオを書く | [references/terminal.md](references/terminal.md) |

## 人間から依頼を受けたときの手順

1. 対象の作業ディレクトリを決める（既存リポジトリでも空ディレクトリでもよい）。git管理を推奨。
2. [references/ordering.md](references/ordering.md) に従って発注書 `order.json` を作る。不明点は推測で埋めず、利用状況と制約として書けることだけを書く。
3. 初期化: `kenshu-loop init --dir <対象> --order order.json`
   - 既定の権限が表示される。受注AIは対象ディレクトリで Read/Edit/Write/Bash を使う。変更は `.kenshu/config.json`。
4. 実行: `kenshu-loop run --dir <対象>`（前面実行。上限は config の limits）
5. 結果: `kenshu-loop status --dir <対象>`。終了コード 0=accepted, 2=blocked, 3=limit_reached, 4=failed, 130=interrupted。
6. 中断・上限到達・実行エラー後は `kenshu-loop resume --dir <対象>`。

人間承認ゲートは無い。`blocked` は「情報不足・実行不能」を正直に返した状態なので、`status` の blockers を人間に伝え、発注書を更新して `init --force` で再発注する。

## 守ること

- 未確認の項目を合格扱いにしない。予算・時間超過や実行不能を完了と報告しない。
- 検収判定ファイルを手で書き換えない。判定はオーケストレータが検証してから状態に反映する。
- 認証情報や利用者の私物データを証拠・ログ・発注書に入れない。
