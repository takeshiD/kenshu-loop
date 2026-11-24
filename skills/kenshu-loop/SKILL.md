---
name: kenshu-loop
description: 発注・納品・検収型のエージェントループ。人間のやりたいこと・利用状況・制約を発注書(order.json)に整理し、同梱のCLIで受注AI（実装と検査基準・証拠の提出）と別セッションの検収AI（利用者試行と技術審査）を回して、使い始められる状態まで確認する。CLI/TUIツールを作らせて検収まで任せたいとき、「kenshu-loopで」「発注して」「検収まで」と頼まれたとき、kenshu-loopの状態確認・再開・端末操作(term)を行うときに使う。
compatibility: Node.js 22.18 以上と npm、認証済みの Claude Code CLI (claude)、git が必要。初回実行時に npm レジストリへ接続する。
---

# kenshu-loop

製造業の発注→納品→受入検収をモデルにしたループ。人間は発注するだけで、検収はAIが行う。
「受注AIが完了と言った」は**納品開始**であって完了ではない。オーケストレータの検証と検収AIの判定が通って初めて `accepted` になる。

## CLI の呼び出し方

CLI はこのスキルに同梱されている。PATH 上の `kenshu-loop` は前提にしない。

```sh
node <このスキルのディレクトリ>/scripts/kenshu-loop.mjs <サブコマンド> ...
```

以下と references/ で `kenshu-loop ...` と書いているものは、すべてこの形で実行する。
初回だけ依存パッケージ（zod, @microsoft/tui-test）を `scripts/node_modules` に入れるので数秒かかり、ネットワークが要る。
進捗は stderr に出て、stdout には CLI の本来の出力だけが出る。
最初に `node <dir>/scripts/kenshu-loop.mjs setup` を実行しておくと、導入の失敗（Node が古い・npm が無い・オフライン）を発注前に見つけられる。
失敗したら、表示された理由を人間に伝えて止まる。

`scripts/src/` は CLI の実装なので、読まずに実行する。受注AI・検収AIへ渡す端末操作コマンドは CLI が自分で組み立てるので、手で渡す必要はない。

## 役割とこのスキルの使い分け

| 状況                                                       | 読むもの                                                         |
| ---                                                        | ---                                                              |
| 人間の依頼を発注書にする                                   | [references/ordering.md](references/ordering.md)                 |
| 受注AIとして実装・基準・証拠を出す（ランナーが自動で渡す） | [references/contractor.md](references/contractor.md)             |
| 検収AIの利用者試行（ランナーが自動で渡す）                 | [references/inspector-trial.md](references/inspector-trial.md)   |
| 検収AIの技術審査（ランナーが自動で渡す）                   | [references/inspector-review.md](references/inspector-review.md) |
| 端末アプリを1操作ずつ動かす / シナリオを書く               | [references/terminal.md](references/terminal.md)                 |

発注書の雛形は [assets/order-example.json](assets/order-example.json)（`kenshu-loop schema order-example` と同じ内容）。

## 人間から依頼を受けたときの手順

1. `kenshu-loop setup` で CLI が動くことを確かめる（上記）。
2. 対象の作業ディレクトリを決める（既存リポジトリでも空ディレクトリでもよい）。git管理を推奨。
3. [references/ordering.md](references/ordering.md) に従って発注書 `order.json` を作る。不明点は推測で埋めず、利用状況と制約として書けることだけを書く。
4. 初期化: `kenshu-loop init --dir <対象> --order order.json`
   - 既定の権限が表示される。受注AIは対象ディレクトリで Read/Edit/Write/Bash を使う。変更は `.kenshu/config.json`。
5. 実行: `kenshu-loop run --dir <対象>`（前面実行。数十分かかることがあるので、Bash のタイムアウトは長めにとる。上限は config の limits）
6. 結果: `kenshu-loop status --dir <対象>`。終了コード 0=accepted, 2=blocked, 3=limit_reached, 4=failed, 130=interrupted。
   受入後は `<対象>/.kenshu/DELIVERY.md` に使い始め方・後続事項があるので、それをもとに人間へ報告する。
7. 中断・上限到達・実行エラー後は `kenshu-loop resume --dir <対象>`。

人間承認ゲートは無い。`blocked` は「情報不足・実行不能」を正直に返した状態なので、`status` の blockers を人間に伝え、発注書を更新して `init --force` で再発注する。

## 守ること

- 未確認の項目を合格扱いにしない。予算・時間超過や実行不能を完了と報告しない。人間が判断を誤るので、結果は終了コードどおりに伝える。
- 検収判定ファイルを手で書き換えない。判定はオーケストレータが検証してから状態に反映する仕組みなので、手で書くと検収の意味がなくなる。
- 認証情報や利用者の私物データを証拠・ログ・発注書に入れない。証拠は保存され、受注AI・検収AIにも渡るため。
