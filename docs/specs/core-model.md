# モデルの型と式パーサ

## 目的
アノテーションの `if:`・`set:`・`@state-var` と性質の `expr` を、型付きの AST に変える。後続のスキャナと TLA+ 生成は、文字列ではなくこの AST だけを読む。保守する人は、式の文法を `src/core/expr.ts` の 1 か所で直せばよい。
満たす: R-02、R-04（式と変数宣言の部分。「スキャンを止めない」はスキャナの仕様で満たす）

## 完了条件
- [ ] 1. `npm run typecheck`、`npm run lint`、`npm test` がすべて exit 0（実行して確認）
- [ ] 2. `scripts/verify-requirements.ts` が `dependencies` の空を確かめて exit 0。`dependencies` に 1 件足した `package.json` を渡すと exit 1（`test/verify-requirements.test.ts`）
- [ ] 3. `SPEC.md` §5.2 と §6.3 に出てくる式 11 件（ガード 3、代入 2、変数宣言 2、性質 4）が、期待した AST になる（`test/expr.test.ts`）
- [ ] 4. 文法外の入力 10 件（関数呼び出し、文字列リテラル、未知の演算子、括弧の不一致、空、`=` だけの比較、ガード中の `=>`、ガード中の `state`、代入の右辺の式、`VAR+2`）が例外を投げず、位置つきの警告を返す（`test/expr.test.ts`）
- [ ] 5. 変数型 `BOOLEAN`、`0..3`、`{a,b,c}` を受け付け、`string`、`number`、`3..1`、`{}`、型の範囲外の初期値を警告にする（`test/expr.test.ts`）
- [ ] 6. 固定シードで生成した任意の文字列 1,000 件を 4 つのパーサに渡しても例外を投げない（`test/expr.test.ts`）

## データの形
```ts
type Value = { kind: "bool"; value: boolean } | { kind: "int"; value: number } | { kind: "name"; name: string };
type CmpOp = "==" | "!=" | "<" | "<=" | ">" | ">=";
type VarType = { kind: "boolean" } | { kind: "range"; min: number; max: number } | { kind: "enum"; members: readonly [string, ...string[]] };
type VarDecl = { name: string; type: VarType; init: Value };
type Assignment = { target: string; value: Value | { kind: "offset"; name: string; delta: 1 | -1 } };
type ParseResult<T> = { ok: true; value: T } | { ok: false; warning: { message: string; input: string; column: number } };
// Expr の形（ガードと性質を型で分けるか、1 つの型を方言で分けるか）は architect で決める。
```
表し方: 判別可能なユニオン。理由: TLA+ 生成が `kind` の網羅検査で全種類を扱ったと保証できる。

`&&` は `||` より強く結合し、`=>` は最も弱く右結合とする。`SPEC.md` §5.1 の文法は優先順位を書いていないため、JavaScript と TLA+ の慣習に合わせた。

## 非目標
- 名前の解決（未宣言の変数、変数と状態名の区別、型の不一致）。スキャナの仕様で、宣言全体を見て行う。
- `@state-next` 行の `on:`・`if:`・`set:` への分割。スキャナの仕様で行う。
- `graph.json` 全体の型（ノード、検査状態、findings）。スキャナの仕様で足す。

## 検証方法
`test/expr.test.ts`、`test/verify-requirements.test.ts`、`scripts/verify-requirements.ts`。作る。
