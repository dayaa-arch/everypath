# ビューアの乖離表示、乖離を直す、グループ枠、ファイル粒度へのズーム

## 目的
レビューする開発者が、AI が宣言せずに足した画面遷移を図の橙の矢印で見つけ、宣言とコードのどちらが正しいかをパネルで選んで「乖離を直す」指示をエージェントに渡せるようになる。あわせて、`@state-group` の枠で層を見分け、箱のダブルクリックで中のファイルを確かめられる。`check` とビューアは「ガードを無視したときだけの経路」を本物の違反と分けて扱う。保守する人は、ガードの文字列化が `src/core/expr.ts` の 1 か所に、数える違反の条件が `src/core/verdict.ts` の 1 か所にあり、CLI の終了コード、ビューアの赤、Mermaid の印が同じ関数を読むと覚えればよい。
満たす: R-02（`dist/ui.html` は単一ファイルでネットワーク参照なし）、R-01（書く場所は `.everypath/` のまま）、R-05（ズームと枠は `layout.json` の座標を変えない）

## 完了条件
- [x] 1. `npm run typecheck`、`npm run lint`、`npm test`、`npm run build` が exit 0 で、`scripts/verify-requirements.ts` の R-02 が ok（実行して確認）
- [x] 2. 乖離の辺。`type: "observed"` のエッジは橙の線（`look: "observed"`）になり、ラベルは「宣言なし」。flow の線は `observed` が `true` でも `false` でも同じ `look: "flow"` の黒のまま（`test/viewer-drift-scene.test.ts` の `sceneOf`）
- [x] 3. 乖離を直す。example のコピーの Home に `router.push("/reset")` を足すと、「乖離を直す」は Home にだけ当たる。乖離ごとに「宣言が正しい（呼び出しを消す）」か「コードが正しい（`@state-next` を足す）」を選ぶまで指示は作れず、理由の文が返る。選ぶと、宣言済みの `@state-next` の行、呼び出しのあるファイル（`src/home.ts`）、行き先とそのファイル、選んだ側の直し方、完了条件（`drift` から消える）が入り、`{{` は残らない。もう一方を選ぶと直し方の文だけが変わる（`test/viewer-drift-prompt.test.ts`。`buildPrompt` と `templates/prompts/fix-drift.md`）
- [x] 4. グループ枠。同じ `@state-group` を持つ箱が 2 つ以上あるグループごとに枠が 1 つ出る。枠は全員の箱を余白つきで囲み、左上に名前を持つ。箱が 1 つのグループと、グループの無い箱には枠が無い。枠を描いても `layout` は変わらない（`test/viewer-drift-scene.test.ts`）
- [x] 5. ズーム。`zoom` で、その箱の左上を起点にファイル一覧が開く。他の箱と線の描画データは開く前と完全に一致し、`layout` も変わらない。同じ箱にもう一度 `zoom` するか `escape` で閉じる。`escape` は、一覧が閉じているときだけ選択を外す。各ファイルのテスト状況は、ノードがテスト済みなら全部テスト済み、未テストでファイルが 1 つならそれが未テスト、それ以外は出さない。箱が消えたら一覧も閉じる（同上。`reduce` と `sceneOf`）
- [x] 6. ガードの文字列化は 1 つ。`printGuard` と `edgeLabel` は `src/core/expr.ts` にだけあり、`src/ui/view.ts` と `src/core/mermaid.ts` はそれを import する。`SPEC.md` §5.1 の全演算子で、印字した文字列を `parseGuard` で読み直すと元の式に戻る。重複を守っていた `test/mermaid.test.ts` の一致テストは消す。`src/ui` が読む core は `types`、`prompts`、`expr`、`verdict` だけで、後の 3 つは `types` の型しか読まない（`test/guard-printer.test.ts` と `test/ui-boundaries.test.ts`）
- [x] 7. CLI。`scan` の要約は `依存` を `type === "dep"` だけで数え、`乖離` の件数を足す（乖離 1 件の example のコピーで「依存 5、乖離 1」）。`check` は `tlc` 欄を出す。同じモデルに対する TLC の `ok` は、簡易検査の経路を「ガードを無視したときだけの経路」と出し、終了コードに数えない。古いモデルに対する `ok`、および `violated`、`error` は終了コードを変えない。届かない「簡易検査はまだありません」の分岐は消す（`test/viewer-drift-cli.test.ts`。偽の `java`）
- [x] 8. ビューア。7 で数えない性質は、箱を赤くせず、ヘッダの性質違反に数えず、反例として再生せず、Mermaid の `violated` の印も付けない。詳細パネルには TLC の判定と「ガードを無視したときだけの経路」を出す（`test/viewer-drift-verdict.test.ts`）
- [x] 9. 実機。scratch の example のコピーに `router.push` の乖離 1 件と `@state-group` の組を足し、`scan`、`check`、実物の TLC で `check --tlc` を走らせて出力を返答に貼る。ブラウザでの確認はリーダーが行う（手で実行）

## データの形
```ts
// src/core/expr.ts
export declare function printGuard(expr: GuardExpr): string;
export declare function edgeLabel(edge: Pick<FlowEdge, "event" | "guard">): string;
// src/core/verdict.ts。types の型だけを読む
export declare function isGuardOnly(p: PropertyResult): boolean; // 簡易検査の violated に、同じモデルの TLC の ok
export declare function isLiveViolation(p: PropertyResult): boolean; // violated で、staleModel でも isGuardOnly でもない
// src/core/prompts.ts: PROMPT_KINDS に "fix-drift" を足す
// src/ui/state.ts
type DriftFix = "remove-call" | "add-next";
type DriftDecision = { readonly from: StateName; readonly to: StateName; readonly fix: DriftFix };
type ViewState = … & { zoom: StateName | null; decisions: readonly DriftDecision[] };
type Action = … | { kind: "zoom"; id: StateName } | { kind: "escape" } | ({ kind: "decide-drift" } & DriftDecision);
// src/ui/view.ts
type SceneItem = … | { kind: "group"; name: string; box: Box; label: Box } // label は名前の矩形
  | { kind: "files"; id: StateName; box: Box; rows: readonly { file: string; tested: boolean | null }[] };
// line の look は "flow" | "dep" | "observed" | "trail"
```
表し方: 数える違反の条件は述語 1 つ（`isLiveViolation`）にして、終了コード、赤、Mermaid の印の 3 か所が読む。指示を作れない理由は、指示の種類の表（`KINDS`）の列に置く。理由: 条件が 3 か所に散ると、`check` は通るのに箱が赤い、というずれが起きるため。

## 決めたこと
- 乖離の向きは人間が必ず選ぶ。選ぶまで指示を作れない。エージェントに選ばせる案は捨てた。乖離は AI が宣言せずに足した遷移を見つけるための仕組みで、AI に選ばせると `@state-next` を足して自分の遷移を追認する道になる。選択は乖離（`from`、`to`）ごとに持ち、グラフから消えた乖離の選択は捨てる。
- 乖離は呼び出し元のノードのものとする。直す場所（呼び出しと `@state-next`）がどちらも呼び出し元のファイルにあるため。
- 呼び出しの URL のパスと行番号は `graph.json` に無い（`drift` は `from`、`to`、`via` だけ）。`src/core/scan.ts` を変えないために、指示には呼び出しのファイルと、行き先の `@state-route` があるファイルを入れる。
- `SPEC.md` §7.3 の「宣言のみ = グレー」には従わない。`docs/specs/drift.md` のとおり、呼び出しが無いことは証拠にならない。
- グループ枠は箱が 2 つ以上のグループだけに描く。1 つの箱の枠は箱の線を二重にするだけなので、グループ名は詳細パネルに出す。枠の名前のラベルは辺のラベルが避ける場所に入れる。
- 数えない扱いは `never-reach` に限らず、`tlc` 欄を持つ性質すべて（今は `never-reach` と変数の無い `invariant`）に当てる。`tlc.result: "ok"` の意味（ガードどおりの振る舞いではその経路を通れない）は種類によらないため。
- `docs/specs/phase2-properties.md` の「`check` の終了コードは簡易検査のまま」を改める。`graph.json` の `result`、`counterexamples`、ノードの `violations` は簡易検査のままにする。そのため `docs/specs/server.md` の「TLC の判定は簡易検査の判定を上書きしない」は守られる。代わりに、モデルのキーが合う `result.json` は簡易検査の違反を終了コードから外せる。`result.json` は TLC だけが判定する性質（変数を含む `invariant`、`leads-to`）では元から信頼している。また、決定 0003 で git の外にあるので、CI は自分の `check --tlc` で作り直す。
- ズームの各ファイルのテスト状況は、`graph.json` がノード単位の `tested` しか持たないので、そこから導けるときだけ出す。

実装中に決めたこと、分かったこと。
- テストは単位ごとに 5 つのファイルに分けた（`test/guard-printer.test.ts`、`test/viewer-drift-{scene,prompt,verdict,cli}.test.ts`）。1 ファイルにすると、まだ無い export の読み込みで全体が落ち続け、単位ごとに緑を確かめられないため。
- CLI は数えない性質の見出しを「成立」にし、要約の件数も成立に数えて「（ガードを無視したときだけの経路 N 件）」を添える。TLC の判定の行は `TLC: 成立（46 状態）。…`、`TLC: 違反（47 状態）` と手順、`TLC: エラー（判定できませんでした）`、古いモデルなら `TLC: 成立（古いモデルに対する結果、46 状態。…）` の 4 通り。
- 実物の TLC 2.19 で確かめた数字。ロックのガードを `retries==4` にした版の `no-lock` は 46 状態で成立。元のガードでは 47 状態で、`retries` が 0 から 3 へ進む 5 歩の反例になった。
- ダブルクリックの箱は、`event.target` ではなくポインタの下の要素から探す。押した時点でキャンバスがポインタをつかむため、`dblclick` の対象がキャンバスになるブラウザがある。
- 矢印キーは、入力欄にフォーカスがあるときは反例の再生を動かさない。乖離のラジオボタンの矢印で選択と再生が同時に動くのを避けるため。
- 初回の全体表示（fit）は箱に加えてグループ枠も収める。枠の名前が画面の上端で切れないようにするため。
- ラベルの幅の見積もりは `layout.ts` の `labelWidth` 1 つにし、辺のラベル、枠の名前、ファイル一覧の幅が使う。
- 「性質を提案させる」などの `PROPERTIES` には、数えない性質に「（ガードを無視したときだけの経路。TLC では成立）」を添える。
- 指示の種類の並び（ボタンの並び）は、反例を直す、乖離を直す、テストを書く、の順にした。

## 非目標
- 宣言はあるのに観測の無い flow を灰色にすること
- 呼び出しの行番号と URL のパスを `graph.json` に載せること（`scan.ts` と `routes.ts` の変更になる）
- ヘッダに乖離の件数を出すこと、階層状態の枠（P2-5 で枠の描き方を共通にするか決める）

## 検証方法
`test/guard-printer.test.ts`、`test/viewer-drift-scene.test.ts`、`test/viewer-drift-prompt.test.ts`、`test/viewer-drift-verdict.test.ts`、`test/viewer-drift-cli.test.ts`（どれも実装より先に書いて失敗を確かめた）、`test/ui-boundaries.test.ts`、`test/mermaid.test.ts`、`test/tla.test.ts`（終了コードの決定を改めた 2 件）、`test/server.test.ts`（テンプレートの種類が 6 つになる）。条件 9 は手で実行した。
