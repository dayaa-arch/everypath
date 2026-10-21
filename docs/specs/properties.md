# 簡易検査

## 目的
`everypath.properties.json` に書いた性質を、スキャンのたびに flow エッジだけのグラフで BFS 検査し、違反を `graph.json` の `properties[]` と `nodes[].violations` に書く。利用者は TLC 無しで `everypath check` を CI に入れ、違反すれば exit 1 と最短の反例経路を日本語で受け取る。保守する人は、性質ファイルの読み取りと全種類の判定を `src/core/properties.ts` の 1 か所で追える。TLA+ のレーンは同じ性質の型を再利用する。
満たす: R-03（`check` の部分）、R-01（`check` も `.everypath/` 以外を書かない）

## 完了条件
- [ ] 1. `npm run typecheck`、`npm run lint`、`npm test` がすべて exit 0（実行して確認）
- [ ] 2. 読み取り。6 種類の `kind` を並べた性質ファイルで、`properties[]` がファイル順に並ぶ。変数を含まない `invariant`、`never-reach`、`always-reach`、`no-dead-end` は `checkedBy: "bfs"` で `ok` か `violated` になる。変数を含む `invariant` と `leads-to` は `checkedBy: "tlc"`、`dep-only-via` は `checkedBy: "bfs"` で、どれも `result: "pending"`、`counterexamples: []`、`statesExplored: null` になり、ノードに `violations` を付けない（`test/properties.test.ts`）
- [ ] 3. 文法外の定義 7 件（`id` 無し、`id` の重複、未知の `kind`、`expr` の構文誤り、`target` が配列でない、`target` が空、`avoid` に状態名でない値）が、`file: "everypath.properties.json"` の警告になってその性質だけ捨てられる。`expr` の誤りは `detail` に `parseProperty` の警告を持つ。壊れた JSON と `properties` 配列の無いファイルも警告 1 件になり、スキャンは exit 0 で終わる（`test/properties.test.ts`）
- [ ] 4. `entry`・`target`・`avoid`・`except` と式の `state` にある名前がノードに無いと警告する。その性質は警告したうえで判定する（`test/properties.test.ts`）
- [ ] 5. 入口。`entry` があればそれ、無ければ `model.initial`、それも無ければ自己ループ以外の入エッジが無い planned 以外のノード（id 順）を使う。入口を使う性質（`never-reach` と変数を含まない `invariant`）があるのに入口が 1 つも無ければ警告する（`test/properties.test.ts`）
- [ ] 6. `never-reach`。`avoid` のノードを取り除いたグラフで、入口から `target` に着く最短経路があれば `violated` で反例 1 件。`steps[0].event` は `null`、以降は辿ったエッジの `event`。無ければ `ok`。経路上のノードの `violations` に性質 id が入る（`test/properties.test.ts`）
- [ ] 7. `always-reach`。`target` に辿り着けない planned 以外のノードごとに、id 順で反例を 1 件作る。経路はそのノードから最も近い行き止まり（出エッジの無いノード）まで。行き止まりが無ければそのノード 1 つだけ（`test/properties.test.ts`）
- [ ] 8. `no-dead-end`。`except` と planned 以外で出エッジの無いノードごとに、id 順で 1 件の反例（そのノードだけの経路）を作る。自己ループは出エッジに数える（`test/properties.test.ts`）
- [ ] 9. 変数を含まない `invariant`。入口から到達できるノードで式が偽になるものへの最短経路を反例 1 件にする。`=>`、`!`、`&&`、`||`、`state in {…}` を評価する（`test/properties.test.ts`）
- [ ] 10. ノード 1,000、flow エッジ 5,000 のグラフで 4 種類の BFS 性質を `checkProperties` が 1 秒以内に終える（`test/properties.test.ts` で計測）
- [ ] 11. `everypath check [dir]` は違反か性質ファイルの警告があれば exit 1、無ければ exit 0。違反した性質ごとに `ログイン →(forgot) パスワードリセット →(reset_done) Home` の形で（`event` の無いエッジは `→` だけ）経路を標準出力に出す。性質ファイルが無ければ「性質がありません」と出して exit 0。存在しないディレクトリは exit 2（`test/cli.test.ts`）
- [ ] 12. R-03 と R-01。`java` の無い `PATH` で `check` が exit 0 か 1 で終わり、`.everypath/` 以外の全ファイルの sha1 が前後で一致する（`test/requirements.test.ts`）
- [ ] 13. `never-reach` 違反のある fixture で `npx tsx src/cli.ts check` を実行し、exit 1 と経路の出力を確かめる（手で実行し、返答に貼る）

## データの形
`src/core/types.ts` に足す。`Graph` に `properties`、`StateNode.violations` を `PropertyId[]` にする。
```ts
type PropertyId = Brand<string, "PropertyId">; // properties.ts の読み取りだけが作る
type PropertyDef = { id: PropertyId; description: string | null } & (
  | { kind: "invariant"; expr: PropertyExpr }
  | { kind: "leads-to"; from: PropertyExpr; to: PropertyExpr }
  | { kind: "never-reach"; target: NonEmpty<StateName>; avoid: StateName[] }
  | { kind: "always-reach"; target: NonEmpty<StateName> }
  | { kind: "no-dead-end"; except: StateName[] }
  | { kind: "dep-only-via" }); // フェーズ 2 で from_group・target・via を足す
type PropertiesFile = { entry: NonEmpty<StateName> | null; properties: PropertyDef[] };
type Step = { state: StateName; event: EventName | null; vars: Record<VarName, string> }; // BFS は {}
type Counterexample = { path: NonEmpty<StateName>; steps: NonEmpty<Step> }; // path は steps の state
type PropertyResult = { id: PropertyId; kind: PropertyDef["kind"]; description: string | null;
  checkedBy: "bfs" | "tlc" | "both"; result: "ok" | "violated" | "error" | "pending";
  counterexamples: Counterexample[]; statesExplored: number | null; checkedAt: string };
declare function parseProperties(raw: unknown): { file: PropertiesFile; warnings: ScanWarning[] };
declare function checkProperties(graph: Pick<Graph, "nodes" | "edges" | "model">, file: PropertiesFile,
  checkedAt: string): { properties: PropertyResult[]; violations: Map<StateName, PropertyId[]>; warnings: ScanWarning[] };
```
表し方: 性質の定義は `kind` の判別可能なユニオン、判定は `kind` から関数への表。理由: TLA+ のレーンが同じユニオンを網羅検査で読める。

読み取りは `readWorkspace` が `readJsonFile` で行い、`parseProperties` に渡す。`scan()` の `fold` が `checkProperties` を呼び、警告を他の警告と同じ順に並べる。`check` は `scan(root, { reason: "check" })` を呼んで結果を表示するだけで、`scan` も `properties[]` を書く（保存のたびに走る、`SPEC.md` §9）。BFS はエッジを `graph.edges` の順に辿るので、同じ入力から同じ反例が出る。`statesExplored` は探索で訪れたノードの数、`checkedAt` は `generatedAt` と同じ時刻にする。`always-reach` と `no-dead-end` が planned を起点にしないのは、planned のノードにはまだ出エッジを書くコードが無いため。性質ファイルの警告で exit 1 にするのは、検査できなかった性質を CI で黙って通さないため。

## 非目標
- TLA+ と TLC、`check --tlc`、`leads-to` の評価。`PropertyResult` の `both` と `error` は TLA+ のレーンが使う
- `dep-only-via` の判定（フェーズ 2）。`pending` で書くだけにする
- サーバーとビューアでの表示

## 検証方法
`test/properties.test.ts` を作る。`test/cli.test.ts` と `test/requirements.test.ts` に `check` を足す。どれも実装より先に作り、失敗を確かめる。
