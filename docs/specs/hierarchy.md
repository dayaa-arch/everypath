# 階層状態 `@state-parent`

## 目的
AI エージェントが「ログイン後のどの画面からもログアウトできる」を親の状態に 1 回だけ書けるようになり、レビューする人は図の枠でその範囲を読み、簡易検査と TLC は子のすべてに効いた遷移で経路を調べる。保守する人は、階層の意味が `src/core/hierarchy.ts`（木）と `src/core/flatten.ts`（平らにする 1 回）にしかなく、簡易検査と TLA+ 生成は型 `Flat` しか受け取らないと覚えればよい。
満たす: R-04（木の誤りは警告にしてスキャンを止めない）、R-05（子の座標は変わらず、枠は保存しない）、R-01

## 完了条件
- [ ] 1. `npm run typecheck`、`npm run lint`、`npm test`、`npm run build` が exit 0（実行して確認）
- [ ] 2. 互換。`@state-parent` の無いリポジトリでは、`graph.json`、`Model.tla`、`Model.cfg`、Mermaid、`relayout` と `place` の座標が変更前と 1 バイトも違わない。変更前の `example/` の出力を `test/fixtures/flat-example/` に保存し、変更後の出力と比べる（`test/hierarchy-compat.test.ts`）
- [ ] 3. 注釈。`@state-parent <状態>` は 1 ファイルに 1 回。値が無い、状態名でない、2 回目は `file`・`line` 付きの警告でそのタグを捨てる。`//`、`#`、`/* */`、`"""` で拾い、`@state-hidden` とテストのファイルでは何もしない（`test/hierarchy.test.ts`）
- [ ] 4. 木の誤り（R-04）。自分を親にする、2 つと 3 つの輪、同じ状態の別ファイルが別の親を書く、`MAX_DEPTH`（3）より深い入れ子、どのファイルも名乗らない親は、どれも警告になり、`scan` は exit 0 で、ノードは 1 つも消えない。輪の上の親は外れ、輪にぶら下がる枝の親は残る。名乗るファイルの無い親は `container: true` のノードで、`planned` ではなく、`stats.planned` にも未テスト・未レビューにも数えない（同上と `test/cli.test.ts` の `scan` の exit）
- [ ] 5. 継承。親の `@state-next` は親の中のすべての葉から出る遷移になる（認証済み の logout が Home と マイページ の両方から出る。同上）
- [ ] 6. 内側が勝つ。内側の状態が同じ名前のイベントで遷移を持つとき、ガードが無ければ継いだ遷移はその葉から消え、ガードがあれば継いだ遷移のガードが `g && !(r1 || r2 …)` になる。3 段でも一番内側が勝つ（同上）
- [ ] 7. イベントの無い遷移は、他を消さず、他に消されない（同上）
- [ ] 8. 入口。親への遷移は `@state-initial` の付いた子に入り、子が 1 つならその子に入る。印の無い子が 2 つ以上なら、すべての子に入り（安全側）、警告を出す。警告は、遷移・`model.initial`・`entry` のどれかがその親に入るときだけ出る。入れ子は葉まで同じ規則で降りる（同上）
- [ ] 9. 性質。`state in {P}`、`target`、`avoid`、`except` は P とその下の葉、`dep-only-via` の `target` と `via` は P とその下のノード、`entry` と遷移先は P の入口になる。`no-dead-end` と `always-reach` は葉だけを調べ、親から遷移を継ぐ葉は行き止まりではない（同上）
- [ ] 10. 恒等。階層の fixture と、それを手で平らにした fixture で、`modelKey` と `checkProperties` の結果（id、result、反例、探索数）が一致する（同上）
- [ ] 11. 読みは 1 つ。`Model.tla` の各アクションから読み戻した（始点、終点、イベント）の列が、簡易検査の探す `flat.model.arcs` と一致する。継いだアクションの注釈に「（P から継承）」が付き、注釈は `modelKey` に入らない（同上）
- [ ] 12. 実機の TLC。example の複製に 認証済み（Home と マイページ を持ち、logout を 1 回だけ宣言）を足し、`state == ログアウト => !authed` を置くと、`check --tlc` が継いだ logout を通る反例を返し、親の宣言に `set:authed=FALSE` を足すと成立する（手で実行し、出力を残す）
- [ ] 13. Mermaid。親は `sN : 名前` と `state sN { … }` になり、中の `[*] -->` は入口の印があるときだけ、矢印は両端を含む一番内側のブロックに書く。印は葉だけに付く。手元の Mermaid 11 の `parse` と `render` に通る（`test/mermaid.test.ts`、描画は手で確かめる。依存は足さない）
- [ ] 14. ビューア。親は中の箱と子の枠を囲む枠で、名前の帯を持つ。親を端に持つ遷移は枠から 1 本だけ出る。枠は `layout.json` に書かず、`place` は前の座標を 1 つも変えず、親には点を付けない。子を足すと兄弟の近くの、よその箱を枠に入れない位置に置く。名乗るファイルの無い親の枠は計画のみの点線で描かず、未レビュー一覧に入らず、承認ボタンを持たない。`relayout` は親を dagre の cluster にし、親が無ければ今と同じ座標（`test/hierarchy-viewer.test.ts`）
- [ ] 15. 見張り。木のフィールド（`parent`、`initialChild`）と意味の問い（`enter`、`within`、`subtree`）を読んでよいファイルを `test/hierarchy-boundaries.test.ts` が名指しし、違反を植えたソースで落ちる。`Graph` は `checkProperties` と `generateTla` に渡せない（`test/hierarchy.check.ts` の `@ts-expect-error`）
- [ ] 16. 文書。`skill/SKILL.md` と `README.md` のタグに `@state-parent` があり、例が 1 つあり、例は警告なしでスキャンできる。規則は 11 項目のまま（`test/init.test.ts`）

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

## 検証方法
`test/hierarchy.test.ts`、`test/hierarchy-compat.test.ts`、`test/hierarchy-viewer.test.ts`、`test/hierarchy-boundaries.test.ts`、`test/hierarchy.check.ts`（どれも実装より先に書いて失敗を確かめる）。条件 12 と 13 の描画は手で実行する。
