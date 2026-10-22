# TypeOK を組み込みの性質にする

## 目的
`check --tlc` が見つけた「変数が宣言した範囲を外れた」（TLC の `TypeOK` の違反、例: `retries: 0..3` で `set:retries=retries+1` が 4 になる）を、利用者がほかの性質と同じ場所で受け取れるようにする。ビューアは反例の箱を赤くして再生でき、「反例を直す」の指示を作れ、TLC の後の素の `check` も CI で落ちる。保守する人は、`TypeOK` が `graph.properties` の 1 件にすぎず、赤、再生、`staleModel`、終了コード、Mermaid の印、指示の規則をすべて既存のまま受けると覚えればよい。
満たす: R-01（書くのは `.everypath/` のまま）、R-03（TLC が無い環境は今と同じ）、R-04（有限の範囲を外れる遷移を隠さず報告する）

## 完了条件
- [ ] 1. `npm run typecheck`、`npm run lint`、`npm test`、`npm run build` が exit 0 で、`scripts/verify-requirements.ts` が ok（実行して確認）
- [ ] 2. 予約。`everypath.properties.json` で id が `TypeOK` の定義は読み込まず、予約済みと書いた警告を 1 件出す。ほかの定義は読み込む（`test/typeok.test.ts`）
- [ ] 3. 記録。`TypeOK` が破れた `check --tlc`（偽の `java`）の後、`result.json` の `properties` の最後が `{id: "TypeOK", kind: "invariant", description: "変数が宣言した範囲に収まる", checkedBy: "tlc", result: "violated"}` で、3 歩の反例を持つ。`typeOk` の欄は無い。全部成り立つ実行では同じ 1 件が `ok` になる（同上）
- [ ] 4. グラフと CLI。3 の `graph.json` は `properties` の最後に同じ `TypeOK` を持ち、反例の通る箱の `violations` に `TypeOK` が入る。`check --tlc` と、その後の素の `check` は `違反 TypeOK [invariant] 変数が宣言した範囲に収まる` と各ステップを出して exit 1。`TypeOK` だけが破れた場合も素の `check` は exit 1（同上）
- [ ] 5. 古いモデル。3 の後に遷移を 1 本足すと、`TypeOK` は `staleModel: true` になり、どの箱の `violations` にも入らず、素の `check` は exit 0 で「古いモデルに対する結果」と出す（同上）
- [ ] 6. ビューアと Mermaid。4 の `graph.json` で、反例の箱の色は `danger`、ヘッダの性質違反は 1、箱を選ぶと `TypeOK` の反例を変数の値つきで再生し、「反例を直す」の指示は `TypeOK`、`変数が宣言した範囲に収まる`、`everypath check --tlc` と `retries` の値を含む。`export --mermaid` は反例の状態に `violated` の印を付ける。5 の古い結果ではどれも起きない（同上）
- [ ] 7. TLC の結果が無いリポジトリは変わらない。`result.json` の無い `example/` のコピーで、`graph.json`（時刻とパスを伏せる）と `export --mermaid` の出力が main と 1 バイトも違わない（手で実行し、`cmp` の結果を返答に貼る。`graph.json` に `TypeOK` が無いことは `test/typeok.test.ts`）
- [ ] 8. 実機。`example/` のコピーで `set:retries=retries+1` のガードを外し、実物の TLC で `check --tlc` を走らせると、`TypeOK` が `retries=4` で終わる 5 歩の反例で違反になり、`graph.json` と素の `check` と `export --mermaid` が同じ違反を示す（手で実行し、返答に貼る）

## データの形
```ts
// src/core/properties.ts。id はここで 1 度だけ作る。利用者の定義はこの id を取れない
export const TYPE_OK_PROPERTY: Pick<PropertyResult, "id" | "kind" | "description" | "checkedBy"> =
  { id: "TypeOK", kind: "invariant", description: "変数が宣言した範囲に収まる", checkedBy: "tlc" };
// src/core/tla/generate.ts。TLA+ の検査名から性質の id へ。"TypeOK" → TYPE_OK_PROPERTY.id
type TlaNames = { …; readonly checks: Readonly<Record<string, PropertyId>> };
// src/core/tla/result.ts。typeOk を消し、TypeOK の判定は properties の最後に入る
type TlcRecord = { version: 1; checkedAt; key; tla; cfg; names; properties: PropertyResult[];
  states: number | null; error: string | null };
// src/core/tla/run.ts。CLI とサーバーの間を渡る要約からも typeOk を消す
type TlcSummary = … | { kind: "checked"; rejected: readonly string[]; error: string | null };
```
表し方: 組み込みの性質は、`graph.properties` の 1 件として表す。理由: 赤、再生、`staleModel`、終了コード、Mermaid、指示は `PropertyResult` と `isLiveViolation` だけを読むので、別の欄にすると 6 か所に分岐が増えるため。

## 決めたこと
- 予約する id は `TypeOK`。`Model.tla` の定義名と、これまで `check --tlc` が出していた行の名前に合わせる。利用者の id は空でない文字列なら何でも通るので、衝突は構造で防げない。パーサーで `TypeOK` を拒む。
- `kind` は `invariant`。`TypeOK` は TLA+ の不変条件そのもので、新しい `kind` を足すと公開している `./types` の型が変わるため。
- `TypeOK` は、TLC がその実行で判定したとき（`ok`、`violated`、`error`）だけ `graph.properties` の最後に入る。`result.json` の無いリポジトリには出ない。
- 簡易検査には `TypeOK` が無いので、簡易検査の結果を上書きする道も、終了コードから消す道も無い。保存済みの違反は数え、モデルが変われば `staleModel` で数えない（ほかの TLC だけの性質と同じ）。
- サーバーの `tlc` の `done` は `TypeOK` の文を載せない。ヘッダの違反数が `TypeOK` を数えるため。

## 非目標
- どの変数が範囲を外れたかの特定（TLC は `TypeOK` の連言のどれが偽かを言わない。反例の最後の値で読める）
- 以前の版の `result.json` の `typeOk` の読み取り。次の `check --tlc` までは `TypeOK` が出ない
- 「反例を直す」の文面の変更

## 検証方法
`test/typeok.test.ts`（偽の `java` で `check --tlc` と素の `check` を走らせ、`result.json`、`graph.json`、CLI、ビューアの純関数、Mermaid を確かめる）を実装より先に作る。`test/tla.test.ts` と `test/cli.test.ts` の `typeOk` の欄を前提にした 3 件は新しい形に直す。条件 7 と 8 は手で実行する。
