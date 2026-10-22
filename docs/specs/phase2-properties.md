# 性質のフェーズ 2（dep-only-via と never-reach の TLC 判定）

## 目的
利用者は、層の約束（画面から DB層 へは検証層を通る）を `dep-only-via` で保存のたびに確かめられる。簡易検査がガードを無視して出した `never-reach` の反例も、`check --tlc` で本物の違反か「ガードを無視したときだけ通れる経路」かを TLC に判定させられる。保守する人が覚える規則は 1 つだけになる。TLC の判定は簡易検査の判定を上書きせず、`tlc` 欄に並べる。
満たす: R-03（`dep-only-via` は TLC 無しで判定する）、R-04（履歴変数も `BOOLEAN` で、モデルは有限のまま）、R-01（書く場所は変えない）

## 完了条件
- [ ] 1. `npm run typecheck`、`npm run lint`、`npm test` がすべて exit 0（実行して確認）
- [ ] 2. `dep-only-via` の読み取り。`from_group` は空でない文字列、`target` と `via` は状態名の空でない配列。欠けたものや型の違うものは、その性質だけを警告にして捨てる（`test/properties.test.ts`）
- [ ] 3. `dep-only-via` の判定。dep エッジだけを辿り、`via` のノードを取り除いたグラフで、`from_group` のノード（id 順）から幅優先で探す。`target` に着けば `violated` になり、最短の dep 経路を反例 1 件にする（各ステップの `event` は `null`）。経路上のノードには `violations` が付く。着かなければ `ok`。flow エッジは辿らない。`from_group` に当たるノードが無いとき、`target` か `via` の名前が状態に無いときは警告し、そのうえで判定する（`test/properties.test.ts`）
- [ ] 4. `never-reach` の TLA+。`avoid` に状態が無ければ `P<n> == ~(state \in {target})` を生成する。あれば履歴変数 `H<n>` を `VARIABLES`、`vars`、`TypeOK` に足す。`Init` は `H<n> = (state \in {avoid})`、`Next` は全遷移に `H<n>' = (H<n> \/ state' \in {avoid})` を重ね、`P<n> == (state \in {target} => H<n>)` を不変条件の回で調べる。`never-reach` の無いモデルの `Model.tla` は 1 文字も変わらない（`test/tla.test.ts`）
- [ ] 5. 実物の TLC 2.19 が生成した `Model.tla` を受け付ける。ガードどおりに動いて着くなら違反と変数つきの反例を返し、ガードでしか塞がれていないなら成立を返す。その出力を `test/fixtures/tlc-output-never-reach.txt` に置き、パースは履歴変数の行を `vars` に入れない（手で実行し、`test/tla.test.ts` でパース）
- [ ] 6. 合流。簡易検査が `violated` にした性質に、同じ id と同じ種類の TLC の判定を `tlc` 欄として足す。`result`、`counterexamples`、`checkedBy`、ノードの `violations`、`check` の終了コードは簡易検査のまま残る。`tlc.result: "ok"` が「ガードを無視したときだけ到達する」を表す。モデルのキーが違えば `tlc.staleModel: true` を付ける。簡易検査の `ok` には足さない（偽の `java` で `test/tla.test.ts`）
- [ ] 7. 実機。scratch の example に `never-reach` を足して `check --tlc` を走らせる。`graph.json` の `tlc` 欄に、本物の違反（ロック。`retries` が 0 から 3 へ）と、ガードでしか塞がれていない経路（ロックのガードを `retries==4` にした版）の `ok` が入る（手で実行し、返答に貼る）

## データの形
```ts
type PropertyDef = { id: PropertyId; description: string | null } & (/* 既存の 5 種類 */
  | { kind: "dep-only-via"; fromGroup: string; target: NonEmpty<StateName>; via: NonEmpty<StateName> });
// 簡易検査の violated に TLC が出した判定。PropertyResult と同じ語彙で、pending は無い
type TlcVerdict = { result: "ok" | "violated" | "error"; counterexamples: readonly Counterexample[];
  statesExplored: number | null; checkedAt: string; staleModel?: true };
type PropertyResult = { /* 既存の欄 */ tlc?: TlcVerdict }; // checkedBy が bfs で result が violated のときだけ
const TLC_KINDS = ["invariant", "leads-to", "never-reach"] as const; // generate.ts と result.ts が共有する
```
表し方: レーンの重ね方を 2 つの規則にする。簡易検査が TLC 待ちの `pending` にした結果は TLC の判定で埋める（既存）。簡易検査が `violated` にした結果には `tlc` 欄を足す（新規）。理由: 種類ごとの分岐を増やさずに、変数を含まない `invariant` も同じ過大近似の問題を同じ欄で解ける。

## 決めたこと
- 簡易検査の `violated` は TLC の `ok` でも消さない。`check` の終了コードも変えない。`docs/specs/server.md` の規則（保存された TLC の判定は簡易検査の `ok` と `violated` を上書きしない）はそのまま守るので、決定記録は書かない。偽造した `result.json` でも CI の判定は変えられない。簡易検査はソースから毎回作り直すが、`result.json` は保存物にすぎないため。
- 履歴変数を選び、`avoid` を取り除いた別の仕様を性質ごとに作る案は捨てた。別の仕様は `SPECIFICATION` が性質ごとに違う。そのため 1 つの `Model.cfg` に入らず、`tla export` の cfg から `never-reach` が抜ける。TLC の起動も性質の数だけ増える。履歴変数なら不変条件の回にそのまま入る。状態は 1 変数あたり最大 2 倍になる。example に `avoid` 付きを 1 つ足すと 47 から 64 に増えた（実物の TLC で計測）。
- `H<n>` の n は性質の `P<n>` と同じ位置にする。`avoid` の名前がどれも状態に無ければ、`avoid` が空と同じに扱う。
- `dep-only-via` は `never-reach` と同じ探索を dep エッジに使う。`from_group` のノード自身が `target` なら、そのノードだけの経路を反例にする。`via` は必須にする。種類の名前が経由を約束しているので、`via` の欠けは書き漏らしとみなす。
- TLC は `dep-only-via`、`always-reach`、`no-dead-end` を調べない。dep は振る舞いではなく、残り 2 つは簡易検査で正確に決まるため。

## 非目標
- CLI とビューアで `tlc` 欄を表示すること。この変更で触れるファイルの外にあるので、`graph.json` に載せるところまでにする
- 簡易検査の `violated` を TLC の `ok` で終了コードから外すこと
- `SPEC.md`、`skill/SKILL.md`、指示文テンプレートへの `dep-only-via` の追記

## 検証方法
`test/properties.test.ts`（条件 2、3）、`test/tla.test.ts`（条件 4、5、6。偽の `java` と `test/fixtures/tlc-output-never-reach.txt`）。どれも実装より先に作り、失敗を確かめる。条件 5 と 7 は手で実行する。
