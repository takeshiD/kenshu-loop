# 端末操作（kenshu-loop term）

AIの探索的操作と回帰テスト・検証シナリオは同じステップ形式・同じ実行器（@microsoft/tui-test によるPTY）を使う。

## 1操作ずつ動かす（探索）

```sh
K="kenshu-loop term --root <証拠ディレクトリ>"     # ランナーから渡されたコマンドを使う
$K start --name s1 --cols 80 --rows 24 --cwd <起動ディレクトリ> -- <argv...>
$K screen --name s1            # 現在画面（行番号・カーソル位置・サイズ付き）
$K screen --name s1 --style    # 色/太字/反転などのスタイル付き区間も表示
$K type   --name s1 "テキスト"
$K paste  --name s1 "貼り付ける長い文"   # アプリが有効化していれば bracketed paste
$K press  --name s1 Down Enter           # キー名: Up Down Left Right Home End PageUp PageDown Tab Enter Escape Backspace Delete Space F1..F12, Ctrl+C など
$K resize --name s1 40 12
$K wait   --name s1 "保存しました" --timeout 5000      # 現在画面に出るまで待つ（--gone で消えるまで）
$K step   --name s1 '{"do":"expect_style","text":"選択中","style":{"inverse":true}}'
$K capture --name s1 after-add   # 画面テキスト/スタイルJSON/SVGを証拠として保存
$K restart --name s1             # 同じコマンドで再起動（保存状態の確認）
$K stop   --name s1
```

- 各コマンドはJSONを返す（`ok`, `record.expected`, `record.actual`, `screen`）。`ok:false` は期待不一致。
- 起動時の `HOME` は隔離された空ディレクトリ（`--inherit-home` を付けない限り）。
- 操作履歴は `<root>/<name>/history.jsonl`、キャプチャは `<root>/<name>/captures/` に残る。
- idle（画面が止まった）ことはタスク完了ではない。期待する画面状態を待つ。

## シナリオ（回帰テスト・検査基準）

```json
{
  "launch": { "argv": ["node", "app.js"], "cols": 80, "rows": 24, "env": {} },
  "steps": [
    { "do": "wait_text", "text": "ヘルプ: ?", "timeout_ms": 5000 },
    { "do": "press", "keys": ["a"] },
    { "do": "paste", "text": "とても長い日本語の項目名…" },
    { "do": "press", "keys": ["Enter"] },
    { "do": "expect_text", "text": "とても長い", "row": 2 },
    { "do": "expect_style", "text": "とても長い", "style": { "inverse": true } },
    { "do": "resize", "cols": 30, "rows": 10 },
    { "do": "expect_cursor", "visible": false },
    { "do": "capture", "name": "narrow" },
    { "do": "press", "keys": ["q"] },
    { "do": "wait_exit", "exit_code": 0 },
    { "do": "expect_file", "path": "$HOME/.app/data.json", "includes": ["とても長い"] },
    { "do": "restart" },
    { "do": "wait_text", "text": "とても長い" }
  ]
}
```

ステップ一覧: `type{text}` `paste{text}` `press{keys[]}` `submit{text?}` `resize{cols,rows}`
`wait_text{text,regex?,timeout_ms?}` `wait_gone{text,...}` `expect_text{text,regex?,row?,col?}` `expect_no_text{text}`
`expect_style{text,style{fg,bg,bold,italic,underline,inverse,dim}}` `expect_cursor{x?,y?,visible?}` `capture{name}`
`wait_exit{timeout_ms?,exit_code?}` `restart{}` `signal{name: INT|TERM|KILL|QUIT}` `expect_file{path,exists?,includes?}`

色は ANSI パレット番号（例: 赤=1, 緑=2）または `#rrggbb`。`col` は表示幅（全角=2）で数える。

実行: `kenshu-loop term run-scenario scenario.json --cwd <dir> --out <証拠dir>`（終了コード 0=pass, 1=fail/error）
