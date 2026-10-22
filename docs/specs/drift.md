# 観測遷移と乖離チェック

## 目的
`everypath scan` が JS/TS のコードにある画面遷移の呼び出し（`router.push('/reset')` など）を読み、`@state-route` でパスを状態に結び、`@state-next` に無い遷移を `graph.json` の `edges[]` と `drift[]` に出す。利用者は、AI が宣言せずに足した画面遷移をスキャンだけで見つけられる。保守する人は、抽出と照合を `src/core/routes.ts` の 1 か所で追え、BFS と TLC のモデルが宣言だけから作られることを型で確かめられる。
満たす: R-04（文法外の `@state-route` は警告にしてスキャンを続ける）、R-01（書くのは `.everypath/` だけのまま）

## 完了条件
- [ ] 1. `npm run typecheck`、`npm run lint`、`npm test` がすべて exit 0（実行して確認）
- [ ] 2. `@state-route <パス>` は 1 ファイルに何度でも書け、`/`、`/reset`、`/users/:id` を受け付け、末尾の `/` を落とす。`/` で始まらない、`?`・`#`・空白を含む、空のセグメント、`:` の後が識別子でない、の 4 種類は `file` と `line` 付きの警告になり、スキャンは exit 0 で続く。同じパス（`:名前` の名前は区別しない）を別の状態が持つと、後のファイルに警告して先のファイルを採る（`test/drift.test.ts`）
- [ ] 3. 抽出。JS/TS のファイルで、文字列リテラル 1 つを引数にした `router.push`、`router.replace`、`redirect`（`res.redirect(301, '/x')` を含む）、`navigate` と、属性の `href="/x"`・`href={"/x"}` を観測遷移として拾う。`?` と `#` から後は落とす。テンプレートリテラル、変数、連結、三項演算子、`https://` や `//` で始まる URL、`//`・`/*`・`*` で始まるコメント行、JS/TS 以外のファイルからは何も拾わない（`test/drift.test.ts`）
- [ ] 4. 照合。`:名前` の無いルートとの完全一致を先に探し、無ければ `:名前` が 1 セグメントに当たるルートを探す。当たる状態が 0 か 2 つ以上なら何も記録せず、警告も出さない。呼び出し元の状態は、そのファイルのノード id（`@state` が無ければファイル名由来）（`test/drift.test.ts`）
- [ ] 5. エッジ。flow はすべて `declared: true` を持ち、呼び出し元から遷移先への観測遷移があれば `observed: true`、無ければ `false`。宣言の無い観測遷移は `type: "observed"` のエッジと `drift[]` の `observed-not-declared` になり、`via` は呼び出しのあるファイル。観測の無い宣言は乖離にしない。dep は変わらない（`test/drift.test.ts`）
- [ ] 6. 乖離はモデルを変えない。観測遷移を足す前と後で、`properties[]` と `generateTla` の `Model.tla` が一致する（`test/drift.test.ts`）
- [ ] 7. 乖離のあるリポジトリを変えずに 2 回スキャンすると、2 回目は `history.jsonl` に行を足さない。履歴の `addedEdges` に `observed` のエッジは入らない（`test/drift.test.ts`）
- [ ] 8. `example/` の 7 画面に `@state-route` があり、スキャンは警告 0 件・`drift: []` のまま。コピーの `src/home.ts` に `router.push("/reset")` を足すと、`drift` は Home から パスワードリセット への 1 件になる（`test/drift.test.ts`。CLI でも実行して返答に貼る）
- [ ] 9. `@state-route` と遷移呼び出しを持つ 1,000 ファイルの fixture で `scan` が 1 秒以内に終わる（`test/drift.test.ts` で計測し、数字を返答に書く）

## データの形
```ts
// src/core/types.ts
type FlowEdge = { type: "flow"; /* 既存の項目 */ declared: true; observed: boolean };
type ObservedEdge = { type: "observed"; from: StateName; to: StateName; declared: false; observed: true; via: string[] };
type Edge = FlowEdge | DepEdge | ObservedEdge;
type Drift = { kind: "observed-not-declared"; from: StateName; to: StateName; via: string[] };
type Graph = { /* 既存の項目 */ drift: Drift[] };
type EdgeRef = { type: "flow" | "dep"; from: StateName; to: StateName; event: EventName | null };
// src/core/routes.ts
type Route = { path: string; segments: ({ kind: "literal"; text: string } | { kind: "param" })[] };
declare function parseRoute(text: string): ParseResult<Route>;
declare function navigationPaths(path: string, content: string): string[]; // 正規化したパス
declare function routeTable(claims: RouteClaim[]): { table: RouteTable; warnings: ScanWarning[] };
declare function resolveRoute(table: RouteTable, path: string): StateName | null;
```
表し方: エッジは `type` の判別可能なユニオンにし、観測だけの遷移を `flow` と別の型にする。理由: BFS（`properties.ts`）と TLA+ 生成（`tla/generate.ts`）は `type: "flow"` だけを読むので、乖離がモデルに入る道が型の上で無くなる。モデルは宣言そのもの。

`drift` は from・to 順、`edges` は今までどおり type・from・to・event・text 順に並べる。1 つの `(from, to)` に宣言が何本あっても、観測があればすべて `observed: true` にする。照合は `(from, to)` だけで、`on:` や `if:` は見ない（コードからイベントは分からない）。

## 非目標
- Next.js の `pages/`・`app/` や Express の `app.get('/x')` からのルート推定。`SPEC.md` §17.1 の推奨どおりタグ必須で始め、フレームワーク検出は後で足す
- 宣言はあるのに観測の無い遷移を乖離にすること。呼び出しが無いことは証拠にならない。JS/TS 以外の言語も対象外
- ビューアの橙の描画と、CLI 要約の乖離件数（`src/ui/` と `src/cli.ts` で扱う）

## 検証方法
`test/drift.test.ts` を実装より先に作り、失敗を確かめる。fixture はテスト内で一時ディレクトリに書く。`example/` はコピーに対してだけ書き換える。
