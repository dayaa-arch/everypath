# 階層状態 `@state-parent`

## 目的
AI エージェントが「ログイン後のどの画面からもログアウトできる」を親の状態に 1 回だけ書けるようになり、レビューする人は図の枠でその範囲を読み、簡易検査と TLC は子のすべてに効いた遷移で経路を調べる。保守する人は、階層の意味が `src/core/hierarchy.ts`（木）と `src/core/flatten.ts`（平らにする 1 回）にしかなく、簡易検査と TLA+ 生成は型 `Flat` しか受け取らないと覚えればよい。
満たす: R-04（木の誤りは警告にしてスキャンを止めない）、R-05（子の座標は変わらず、枠は保存しない）、R-01

## 完了条件
- [x] 1. `npm run typecheck`、`npm run lint`、`npm test`、`npm run build` が exit 0（実行して確認）
- [x] 2. 互換。`@state-parent` の無いリポジトリでは、`graph.json`、`Model.tla`、`Model.cfg`、Mermaid、`relayout` と `place` の座標が変更前と 1 バイトも違わない。変更前の `example/` の出力を `test/fixtures/flat-example/` に保存し、変更後の出力と比べる。`entry` と never-reach の `target`・`avoid` に同じ名前を 2 度書いた性質ファイルでも、名前は書いたとおり 2 度出る（`test/fixtures/flat-example-duplicates/`。どれも `test/hierarchy-compat.test.ts`）
- [x] 3. 注釈。`@state-parent <状態>` は 1 ファイルに 1 回。値が無い、状態名でない、2 回目は `file`・`line` 付きの警告でそのタグを捨てる。`//`、`#`、`/* */`、`"""` で拾い、`@state-hidden` とテストのファイルでは何もしない（`test/hierarchy.test.ts`）
- [x] 4. 木の誤り（R-04）。自分を親にする、2 つと 3 つの輪、同じ状態の別ファイルが別の親を書く、`MAX_DEPTH`（3）より深い入れ子、どのファイルも名乗らない親は、どれも警告になり、`scan` は exit 0 で、ノードは 1 つも消えない。輪の上の親は外れ、輪にぶら下がる枝の親は残る。名乗るファイルの無い親は `container: true` のノードで、`planned` ではなく、`stats.planned` にも未テスト・未レビューにも数えない（同上。`everypath scan` を実行して exit 0 も確かめる）
- [x] 5. 継承。親の `@state-next` は親の中のすべての葉から出る遷移になる（認証済み の logout が Home と マイページ の両方から出る。同上）
- [x] 6. 内側が勝つ。内側の状態が同じ名前のイベントで遷移を持つとき、ガードが無ければ継いだ遷移はその葉から消え、ガードがあれば継いだ遷移のガードが `g && !(r1 || r2 …)` になる。`if:` を読めない（解釈できない、検査に通らない）内側の遷移は何も消さない。いつイベントを取るかが分からないので、継いだ遷移を残し（安全側）、その `if:` の警告が残した親を名指す。3 段でも一番内側が勝つ（同上）
- [x] 7. イベントの無い遷移は、他を消さず、他に消されない（同上）
- [x] 8. 入口。親への遷移は `@state-initial` の付いた子に入り、子が 1 つならその子に入る。印の無い子が 2 つ以上なら、すべての子に入り（安全側）、警告を出す。警告は、遷移か、振る舞いの始まり（`entry`、無ければ `model.initial`）がその親に入るときだけ出る。入れ子は葉まで同じ規則で降りる（同上）
- [x] 9. 性質。`state in {P}`、`target`、`avoid`、`except` は P とその下の葉、`dep-only-via` の `target` と `via` は P とその下のノード、`entry` と遷移先は P の入口になる。`no-dead-end` と `always-reach` は葉だけを調べ、親から遷移を継ぐ葉は行き止まりではない（同上）
- [x] 10. 恒等。階層の fixture と、それを手で平らにした fixture で、`modelKey` と `checkProperties` の結果（id、result、反例、探索数）が一致する（同上）
- [x] 11. 読みは 1 つ。`Model.tla` の各アクションから読み戻した（始点、終点、イベント）の列が、簡易検査の探す `flat.model.arcs` と一致する。継いだアクションの注釈に「（P から継承）」が付き、注釈は `modelKey` に入らない（同上）
- [x] 12. 実機の TLC。example の複製に 認証済み（Home と マイページ を持ち、logout を 1 回だけ宣言）を足し、`state == ログアウト => !authed` を置くと、`check --tlc` が継いだ logout を通る反例を返し、親の宣言に `set:authed=FALSE` を足すと成立する（手で実行し、出力を残す）
- [x] 13. Mermaid。親は `sN : 名前` と `state sN { … }` になり、中の `[*] -->` は入口の印があるときだけ、矢印は両端を含む一番内側のブロックに書く。印は葉だけに付く。手元の Mermaid 11 の `parse` と `render` に通る（`test/hierarchy.test.ts`。描画は以前の担当者が置いた `mermaid.min.js` で手で確かめる。依存は足さない）
- [x] 14. ビューア。親は中の箱と子の枠を囲む枠で、名前の帯を持つ。親を端に持つ遷移は枠から 1 本だけ出る。枠は `layout.json` に書かず、`place` は前の座標を 1 つも変えず、親には点を付けない。子を足すと兄弟の近くの、よその箱を枠に入れない位置に置く。名乗るファイルの無い親の枠は計画のみの点線で描かず、未レビュー一覧に入らず、承認ボタンを持たない。`relayout` は親を dagre の cluster にし、親が無ければ今と同じ座標（`test/hierarchy-viewer.test.ts`）
- [x] 15. 見張り。木のフィールド（`parent`、`initialChild`）と意味の問い（`enter`、`ambiguousEntries`、`within`、`subtree`）を読んでよいファイルを `test/hierarchy-boundaries.test.ts` が名指しし、違反を植えたソースで落ちる。`Graph` は `checkProperties` と `generateTla` に渡せない（`test/hierarchy.check.ts` の `@ts-expect-error`）
- [x] 16. 文書。`skill/SKILL.md` と `README.md` のタグに `@state-parent` があり、例が 1 つあり、例は警告なしでスキャンできる。規則は 11 項目のまま（`test/init.test.ts`）

## データの形
```ts
// types.ts。どれも値があるときだけ書くので、平らなリポジトリの graph.json は変わらない
type StateNode = { …; parent?: StateName; initialChild?: StateName; container?: true };
type Leaf = StateName & { readonly [leaf]: true }; // hierarchy.ts だけが作る
// hierarchy.ts: 木。within(P)=中の葉、enter(P)=入口の葉、subtree(P)=P と下のノード
declare function hierarchyOf(nodes: readonly TreeNode[]): Hierarchy;
declare function resolveHierarchy(claims: Claims): { nodes: TreeNode[]; rootInitial: StateName | null; problems: HierarchyProblem[] };
// flatten.ts: 平らにする 1 回。Flat と FlatModel はここでしか作れない（ブランド）
type FlatArc = { from: Leaf; to: Leaf; event: EventName | null; guard: GuardExpr | null; set: readonly Assignment[]; declared: FlowEdge };
declare function flatten(graph: ModelShape, file: PropertiesFile): Flat; // model, entry, properties, unknown, ambiguous
declare function checkProperties(flat: Flat, checkedAt: string): Checked;
declare function generateTla(flat: Flat): Generated;
```
表し方: 木（親へのリンクの森）とブランド付きの平らなモデル。理由: 遷移の継承、入口、性質の名前の意味を 1 か所で決め、簡易検査、TLA+、Mermaid、ビューアが別々に読み直せない形にするため。

## 非目標
- TLA+ に階層を持ち込むこと（葉だけ。継いだ遷移は葉ごとに 1 アクション）
- 履歴状態、入退場アクション、直交領域。dep と承認の親への寄せ集め
- 指示文（`prompt.ts`）が継いだ遷移を読むこと

## 決めたこと
ブリーフと synthesis（候補 2 を土台に 4 つの修正）で決まっていたこと以外。
- 名乗るファイルの無い親は、入れ物（`container: true`）として描いたうえで、最初にその名前を書いた `@state-parent` の行に警告を出す。ブリーフが「知らない親は警告」と決めたため。警告は直し方（そのファイルに `@state` を書く）を言う。
- 入口のあいまいさの警告は、遷移の先か、振る舞いの始まり（`entry`、無ければ `model.initial`）がその親に入るときだけ出す（候補 1 の接ぎ木）。入るかどうかは `flatten` が `Hierarchy.ambiguousEntries` で集め（`Flat.ambiguous`）、文面と場所は `scan` が決める。場所は親のファイル、無ければ親を名指した最初の `@state-parent` の行。
- 平らにした遷移は（始点、終点、イベント、宣言の文）の順に並べる。`scan` が flow を並べる順と同じなので、親の無いリポジトリでは並びが変わらず、親を使った fixture と手で平らにした fixture で `A<n>` の番号がそろう（条件 10 が `modelKey` の一致で確かめる）。
- 乖離は平らにした遷移で決める（レビューの指摘で、宣言の（始点、終点）の組で決めるのをやめた）。呼び出し元の中の葉から出る遷移のうち、宣言の始点が呼び出し元を含み、宣言の終点が呼び出し先を含むものがあれば、呼び出しは覆われる。だから内側の遷移に消された親の宣言は、その葉からの呼び出しを覆わない。呼び出し元がすでに宣言の終点の中にいる（親の自己遷移、先祖への遷移）ときは、遷移の着く葉が呼び出し先の中になければならない。入り直しは入口に着くので、親の自己遷移は入口でない子どうしの呼び出しを覆わない。外から親へ入る宣言は、入口でない子への呼び出しも覆う（候補 2。入口の子だけに絞る厳しい案は未決として残す）。宣言の `observed` も、その遷移が呼び出しを覆ったかで決める。
- 親の枠の色は、親自身のファイルの色（`toneOf`）にする。中の最悪の色にはしない。枠のボタンで承認するのは親のファイルだけなので、承認しても枠が緑にならない、というずれを避ける。中の色は子の箱が見せる。入れ物の枠は無色（インク色の実線）。
- 枠の寸法はグループ枠と同じ 1 つの関数（`layout.ts` の `enclose`、余白 16、名前の帯 24）で測る（`docs/plans/phase-2.md` 付録の問いへの答え）。親の枠は実線、グループ枠は灰色の破線で見分ける。
- 箱だった状態が親になったとき、その最初の子は前の箱の位置に入る。図の上で親の場所が動かない。前の点は `layout.json` に残り、上書きしない（R-05）。
- 枠はクリックで親を選ぶだけで、ドラッグしない。動かすのは中の箱。入れ物はダブルクリックでファイル一覧を開かない（ファイルが無く、「計画のみ」と出すと誤りになるため）。
- 見張りは 4 つ。`.parent` は `annotations.ts`、`hierarchy.ts`、`scan.ts`。`initialChild` は `hierarchy.ts`、`scan.ts`、`types.ts`。`enter` と `ambiguousEntries` は `hierarchy.ts` と `flatten.ts`。`within` と `subtree` はそれに `ui/layout.ts`（枠の中身と dagre の端点）を足したもの。`parentOf`、`childrenOf`、`contains` などの木の移動はどこで使ってもよい。`src/ui` が読める core に `hierarchy` を足した（Node を読まない）。
- `analyze` は `properties` の代わりに `flat` を返す。`checkProperties(flat, at)`、`generateTla(flat)`、`withTlcResults(flat, …)` に変わり、既存テストの呼び出し 4 ファイルを直した。期待値は 1 つも変えていない。
- TLA+ の大きさの上限（レビューの指摘）。平らにした遷移が 20,000 本（`MAX_ARCS`）を超えるか、`Model.tla` が 8 MB（`MAX_TLA_BYTES`）を超えるなら、`generateTla` は `Model.tla` を作らず `too-large` を返す。`scan` はその理由を警告にし、遷移を増やしている親（宣言の始点か終点が親である遷移の数の多い順、10 件まで）を名指す。スキャンと簡易検査は続く。上限の根拠は TLC 1.7.4 の実測で、親の自己遷移で 10,000 本が 5 秒、20,000 本が 8 秒（4 MB、565 状態）、30,000 本が 22 秒だった（既定の 120 秒に対して）。印の無い 1,000 の子を持つ親に自己遷移と入る遷移を 1 つずつ書くと 1,001,000 本、148 MB になり、2,000 の子では文字列が作れず `generateTla` が投げていた。8 MB は 20,000 本を実測の 1 本 200 バイトで書いた量の 2 倍で、長いガードだけが届く。バイト数は文を組み立てながら数え、超えたところで止める。`generateTla` は毎回のスキャンで呼ぶ（警告のため。以前は `result.json` があるときだけ）。親の無いリポジトリでも 20,000 本を超える宣言には警告が出る。
- 実機の確かめ（条件 12）。scratch の example の複製で `check --tlc` が `logout-clears-auth` に「ログイン →(login_ok) Home（authed=TRUE）→(logout) ログアウト（authed=TRUE）」を返した。`Model.tla` で logout は `A2`（Home から）と `A7`（マイページ から）の 2 つのアクションになり、注釈は「（認証済み から継承）」。親に `set:authed=FALSE` を足すと成立した。`state in {認証済み} => authed` は `P5 == (state \in {"S2_Home", "S4"} => v1_authed = TRUE)` になった。
- 実機の確かめ（条件 13）。scratch の example と 3 段の入れ子（入れ物を含む）の出力を、Mermaid 11 の `parse` と `render` に通し、認証済み、P、Q の枠が描かれた。

## 検証方法
`test/hierarchy.test.ts`、`test/hierarchy-compat.test.ts`、`test/hierarchy-viewer.test.ts`、`test/hierarchy-boundaries.test.ts`、`test/hierarchy.check.ts`（どれも実装より先に書いて失敗を確かめる）。条件 12 と 13 の描画は手で実行する。
