# 0003: `.everypath/review.json` は常に git 管理する

日付: 2026-10-21
状態: 採用
影響する不変条件: R-01（`init` が書く雛形に `.gitignore` の追記を含める）

## 背景

`SPEC.md` §17.6 は「チームなら commit、個人なら `.gitignore`。`init` で聞く」としていた。利用者は作者本人と OSS の不特定多数で、個人利用から始まる。

## 決定

`everypath init` は `.gitignore` に `.everypath/*` と `!.everypath/review.json` を追記し、承認の記録だけを常に git 管理する。`graph.json`、`layout.json`、`history.jsonl`、`tla/` は生成物なので無視する。`init` では聞かない。

## 捨てた案

- `init` で個人かチームかを聞く。対話が 1 つ増えるうえ、個人で始めてチーム化したときに切り替える手順が要る。
- 常に `.gitignore`。個人でも「いつ何を承認したか」の履歴が消え、`changedSinceReview` の根拠が端末に閉じる。

## 影響

`docs/REQUIREMENTS.md` の決定記録に追加。`SPEC.md` §17.6 を決定済みに書き換え、§15 の `init` の説明に `.gitignore` 追記を加える。

## 追記（2026-10-22、0004）

承認の記録の置き場は `docs/decisions/0004-review-events.md` で `.everypath/review/`（1 件 1 ファイル）に変わった。`review.json` は読み続け、書かない。`init` が書く 2 行はそのままで、`review/` は `.everypath/.gitignore` の `!review/` で管理に戻す。「承認の記録だけを常に git 管理する」は両方を指す。
