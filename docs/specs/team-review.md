# チームでの承認（承認の記録を 1 件 1 ファイルにする）

## 目的
同じリポジトリを複数人で使う開発者が、別々のブランチで承認しても git の合流で手直しが要らず、同じ状態への食い違った承認は図とパネルと CLI に食い違いとして見え、パネルで承認者と前回承認日時を読めるようになる。保守する人は、承認の記録は `.everypath/review/` の不変のファイルの集合で、作るのは serve の書き込み列だけ、生きているのは誰にも置き換えられていない記録、とだけ覚えればよい。
満たす: R-01（書くのは `.everypath/review/` と `.everypath/.gitignore` だけ）、R-04（読めない記録も衝突印も警告にして、スキャンを止めない）、R-05（`git pull` で届いた記録も監視が拾う）

## 完了条件
- [x] 1. `npm run typecheck`、`npm run lint`、`npm test` が exit 0。承認と取り消しは `src/server/writer.ts` の列から `writeReviewChange` だけが書き、`test/single-writer.test.ts` が通る（`writeApproval` は消す）
- [x] 2. 別々の状態の合流。init の 2 行だけの `.gitignore` のリポジトリで、2 本のブランチが別々の状態を承認して commit すると、`git merge-tree --write-tree`（`.gitattributes` を読まないサーバー側の合流）も `git merge` も exit 0 で衝突が無い。合流後の scan で両方が `reviewed: true`、`review.approval.by` がそれぞれの承認者（`test/review-merge.test.ts`）
- [x] 3. 食い違いの合流。同じ状態を別の hash で承認した 2 本、同じ状態の承認と取り消しの 2 本は、どちらも git では衝突しない。scan ではその状態が `reviewed: false`、`changedSinceReview: false` で、`review.conflict` に両方の記録（承認者、時刻、版、または取り消し）が載り、どちらも勝たない。`graph.warnings` に「承認が食い違っています」が 1 件あり、`scan` と `check` の標準エラーに出る。承認し直すか取り消すと食い違いは消える（`test/review-merge.test.ts`）
- [x] 4. パネル。承認済みなら「承認者」と「承認日時」、承認後に変わったなら「承認時からの変更あり（hash 不一致）」と「承認者」「前回承認日時」、食い違いなら記録ごとの承認者・時刻・版（今の内容か）と、承認と取り消しの両方のボタンを出す。食い違いの状態は証明が通っていても青にも緑にもならない（`test/review-viewer.test.ts`）
- [x] 5. 旧形式。`.everypath/review.json`（版 1）だけのリポジトリは今と同じ `reviewed`、`changedSinceReview`、`stats.unreviewed` になり、`review.approval` に旧項目が載る。serve で承認と取り消しをしても `review.json` のバイトは変わらない。git の衝突印（merge 形式と diff3 形式）が残った `review.json` でも scan は exit 0 で警告 1 件、両側を読み、同じ状態の違う hash は食い違いになる（`test/review.test.ts`、`test/review-merge.test.ts`）
- [x] 6. 接ぎ木 1、旧新の混在。同じ状態に生きた旧形式の承認と `review/` の記録が並ぶと、その状態を名指しした警告が出る。新しい記録が旧承認に勝つのは `supersedes` で名指ししたときだけで、取り消した旧承認は、古い everypath が旧ファイルを書き直しても取り消されたまま（`test/review.test.ts`、`test/review-merge.test.ts`）
- [x] 7. 接ぎ木 2、読めない記録は閉じる。新しい版の記録（`v` が 1 でない、知らない `kind`）は、名指しした記録を置き換え、その状態を食い違いにする。どの状態のものか分からない記録（JSON でない、名前が違う、リンク、32 KiB 超）は、承認のあるすべての状態を食い違いにする。どちらも古い承認を生き返らせず、ファイルを名指しした警告を出し、scan は exit 0（`test/review.test.ts`）
- [x] 8. 接ぎ木 3、読んだ記録の再利用。同じプロセスの 2 回目以降の読み込みは、読めた記録ファイルを読み直さない。5,000 件で 1 回目と 2 回目の読み込み時間を計り、下に数値を残す（`test/review.test.ts`、`scripts/bench-review.ts`）
- [x] 9. 承認の無いリポジトリの graph.json は前の版とバイト単位で同じ（`example/` の写しを前の版と今の版で scan し、時刻を揃えて比べる。テストでは、記録の無いとき、空の `review.json`、空の `review/` で graph.json が同じで、`review` キーが無いこと）
- [x] 10. R-01。serve で承認と取り消しをしても `.everypath/` の外は 1 バイトも変わらず、`.everypath/` に増えるのは `review/` の記録と `.gitignore` だけ。scan だけではどちらも作らない（`test/requirements.test.ts`）
- [x] 11. git の管理。init の 2 行だけの `.gitignore` のリポジトリで承認すると、`git status --porcelain -uall` に `.everypath/review/<id>.jsonl` が出て、`git check-ignore` は無視しない。新しいリポジトリには `init` が `.everypath/.gitignore` も書く（`test/review-merge.test.ts`、`test/init.test.ts`）
- [x] 12. 文書。`docs/decisions/0004-review-events.md`、`docs/REQUIREMENTS.md` の決定記録の行、`skill/SKILL.md`、README、SPEC が新しい形を書く（読んで確認）
- [x] 13. 実物。`example/` の写しに、承認済み、食い違い、旧形式だけの状態を 1 つずつ作り、`scan` と `check` の出力を貼る。ブラウザでの確認は lead が行う（写しのパスを返答に書く）

## データの形
```ts
// .everypath/review/<id>.jsonl。1 ファイル 1 行。everypath は作るだけで、書き換えも削除もしない。
// id = sha256(行) の先頭 16 桁。supersedes は書いた人が見ていた、その状態の生きた記録の id
{"v":1,"kind":"approve","node":"ログイン","hash":"…","by":"taro","at":"…","note":"","supersedes":["…"]}
{"v":1,"kind":"revoke","node":"ログイン","by":"taro","at":"…","supersedes":["…"]}
// graph.json。生きた承認があるときだけ書く
type Approval = { hash: string; at: string; by: string; note: string };
type ReviewMark = ({ kind: "approve" } & Approval) | { kind: "revoke"; at: string; by: string }
  | { kind: "unreadable"; file: string };
type NodeReview = { approval: Approval } | { conflict: AtLeastTwo<ReviewMark> };
type StateNode = … & { review?: NodeReview };
// src/core/review.ts（純粋）。旧 review.json の項目は supersedes の無い承認として同じ集合に入る
type LiveEvent = ApproveEvent | RevokeEvent | OpaqueEvent; // opaque: 状態は読めたが中身は読めない
type ReviewState = { live: Map<StateName, LiveEvent[]>; blind: string[] }; // blind: 状態の分からない記録
```
表し方: 記録の集合と「置き換える」関係。生きた記録は誰にも置き換えられていない記録で、状態ごとの判定は `verdictOf` の 1 か所にある。承認がすべて同じ hash で、取り消しも読めない記録も無いときだけ `approval`（いちばん新しいもの）、それ以外は `conflict`。理由: 2 本のブランチが知らずに書いた記録は両方生き残るので、食い違いは合流の失敗ではなく、読み手が計算する値になる。

計測（条件 8、`npx tsx scripts/bench-review.ts`、手元の macOS、新しいプロセス 5〜7 回の中央値）: 5,000 件 500 状態で、最初のスキャン 193〜202 ms、以後のスキャン 40〜42 ms。記録の無い同じリポジトリは 46 ms と 32〜33 ms。記録の分は 1 回目が約 150 ms（5,000 ファイルを開いて読む）、以後が約 9 ms（ディレクトリの一覧と畳み込み）。1,000 件 100 状態では 49 ms と 9 ms（記録なしは 17 ms と 8 ms）。

決めたこと（synthesis に無かったもの）。
- 承認は、同じ hash の承認も含めて、その状態の生きた記録をすべて置き換える。graph.json が出す承認は 1 件なので、同じ版の承認を残しても見えないため。2 本のブランチが同じ版を承認した場合は両方が生き、合意として新しい方を出す。
- 食い違いの状態は `changedSinceReview` も `false` にする。`changedSinceReview` は「承認が 1 つあり、その後に変わった」だけを指し、色は未レビュー（灰）になる。
- 同じ人が同じ版を同じメモで承認し直しても何も書かない（二度押し）。メモか承認者が違えば 1 件足す。
- 状態の分からない記録は、承認のあるすべての状態を止める。どの状態の取り消しだったか分からないため。`.jsonl` でない名前（一時ファイル、`.DS_Store`）は記録ではないので読まない。名前が 16 桁でない `.jsonl` は、記録の名付けを変えた新しい版かもしれないので止める側に倒す。止めた記録は承認や取り消しでは置き換えられず、git で戻すか消すまで残る。
- 読んだ記録の再利用は、読めた記録だけを名前で覚える。手で中身を書き換えた記録は、serve を起動し直すまで前の中身のまま（`test/review.test.ts` が固定する）。
- 旧 `review.json` の diff3 の基点の節は読まない。両側の和を読み、警告を 1 件出す。
- CLI の警告には時刻を入れず、承認者と版の先頭 7 桁だけを出す。時刻はパネルと `--json` で見る。
- `init` の `.everypath/.gitignore` の書き込みは、既存の `.gitignore` と同じくリンクを辿る。serve の書き込みはリンクを拒む。

## 非目標
- 置き換えられた記録の掃除（prune）。記録は増え続ける
- 承認者の本人確認。`by` は表示名で、署名ではない
- 地図の新しい色。食い違いは未レビューの色で塗り、パネルと警告で示す

## 検証方法
`test/review.test.ts`（読み書きと判定）、`test/review-merge.test.ts`（本物の git）、`test/review-viewer.test.ts`（パネルと色）、`test/requirements.test.ts`、`test/server.test.ts`、`test/single-writer.test.ts`、`test/init.test.ts`、`test/watch.test.ts` に足す。作る。性能は `scripts/bench-review.ts`。
