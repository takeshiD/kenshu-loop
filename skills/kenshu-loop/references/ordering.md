# 発注書の書き方（order.json）

人間の「やりたいこと・利用状況・守るべき制約」を、検収で照合できる粒度の要求に分解する。
実装方法や検査方法は書かない（それは受注AIが提案し、検収AIが妥当性を審査する）。

```json
{
  "schema": "kenshu-loop/order@1",
  "title": "短い題名",
  "summary": "やりたいこと（1〜3文）",
  "deliverable_type": "cli | tui | cli+tui | library | other",
  "context": "誰が・どんな端末/環境で・どの頻度で使うか",
  "requirements": [
    { "id": "R1", "kind": "goal", "text": "利用者が達成したいこと", "must": true },
    { "id": "R2", "kind": "usage", "text": "利用状況（例: 80x24未満の狭い端末でも使う、日本語の長い文を入力する）", "must": true },
    { "id": "R3", "kind": "constraint", "text": "守るべき制約（例: 外部ネットワークに接続しない、データは ~/.xxx に保存）", "must": true }
  ],
  "out_of_scope": ["今回やらないこと"]
}
```

- `id` は `R1, R2, ...`。各要求は1つの観察可能な事柄にする。
- `must: false` は「あれば良い」。必須でない要求は受入を妨げない。
- 曖昧な形容（使いやすい、速い）は、利用状況として具体化する（例:「初めての人がヘルプだけで追加・削除できる」）。
- 分からないことは要求にせず、`context` に「未定」と書く。検収AIは不足を blocked/inquiry として返せる。
- 認証情報や個人データを書かない。

検証: `kenshu-loop init --order order.json` がスキーマ違反を具体的に報告する。
