# Mermaid エクスポート

## 目的
開発者が `everypath export [dir] --mermaid` を叩くと、ステートチャートが Mermaid の `stateDiagram-v2` として標準出力に出て、README や PR の説明にそのまま貼れる。日本語の状態名も崩れず、同じコードからは同じ文字列が出るので、図を再生成しても git の差分に余計な行が出ない。保守する人は、変換が `Graph` を文字列にする純関数 `toMermaid` 1 つで、CLI は読み取り専用の `analyze` の結果を渡して出すだけだと覚えればよい（`SPEC.md` §15）。
満たす: R-01（`analyze` だけを呼ぶ。`.everypath/` も作らず、`serve` が動いていても書かない）

## 完了条件
- [x] 1. `npm run typecheck`、`npm run lint`、`npm test` がすべて exit 0（実行して確認）
- [x] 2. 1 行目は `stateDiagram-v2`。出す行は 6 種類（ヘッダ、`classDef`、`sN : 表示名`、`[*] --> sN`、`sA --> sB` と任意の ` : ラベル`、`class sN,… 印`）だけで、末尾は改行 1 つ。flow だけを出し、dep は出さない（`test/mermaid.test.ts`）
- [x] 3. 状態の id は `graph.nodes` の順に `s1`、`s2`、…（ASCII）。各状態は `sN : 状態名` の 1 行で宣言し、状態名は宣言行にしか現れない。`end`、`note`、`class` などの予約語の状態名も崩れない（同上）
- [x] 4. `model.initial` があれば `[*] --> sN` を 1 行、無ければ出さない（同上）
- [x] 5. flow 1 本が 1 行になり、ラベルはビューアの `edgeLabel` と同じ（イベント、空白、`[ガード]`）。イベントもガードも無い遷移は ` : ` ごと省く。ガードの全演算子を含む repo で、全 flow がビューアの文字列と一致する（同上。ビューアの `edgeLabel` を import して比べる）
- [x] 6. `status.planned` の状態は `planned`、いま有効な性質違反（`violated` で `staleModel` でない）の経路上の状態は `violated` の印を受ける。1 状態に 1 つで、両方なら `violated`（`SPEC.md` §7.2 の優先順）。`classDef` の色はビューアの `danger` と `planned` の `TONES` と一致する（同上）
- [x] 7. 決定的。`now` が違う 2 回の `analyze`、別の場所に置いた同じソースのどちらからも同じ文字列が出て、絶対パスと時刻を含まない（同上）
- [x] 8. `export [dir] --mermaid` は標準出力に図だけを出して exit 0。`scan` の警告は標準エラーに `check` と同じ形で出す。`--mermaid` が無い、他の option がある、ディレクトリが無いは exit 2。`dir` の既定はカレントディレクトリ。状態が 0 個なら標準出力に何も出さず exit 1。`--help` に載る（`test/mermaid.test.ts`）
- [x] 9. R-01。`.everypath/` が無い repo は実行後も無いまま、あれば中の全ファイルのバイトが前後で一致する。`serve` を動かしたままでも同じ（同上）
- [x] 10. 実物の Mermaid で解釈できる。`example/` の複製の出力を、手元の Mermaid 11 の `parse` と `render` に通して SVG が出て、描画を目で確かめる（手で実行し、結果を返答に残す。依存には足さない）

## データの形
```ts
// src/core/mermaid.ts。読み書きをしない純関数
declare function toMermaid(graph: Graph): string;
type Mark = "violated" | "planned"; // 印の表は 1 つ。行の並びが優先順で、先に当たった 1 つだけを使う
```
表し方: 印は `MARKS`（名前、色、当てはまる条件）の表 1 つ。`classDef` の行も `class` の行もこの表から作る。理由: 優先順と色が 2 か所に散ると、図の色と凡例がずれるため。

## 非目標
- dep エッジ（点線）を出すこと。出す option も作らない（要るときに足す）
- `set:` の代入、変数、性質の本文を図に載せること（ビューアのラベルも載せない）
- 階層状態（`state X { }`）、`direction`、README への自動挿入

## 検証方法
`test/mermaid.test.ts`（`analyze` の実物に `toMermaid` を通す。出力の各行を文法の形に照らして解釈し直してから確かめる）。条件 10 は手で確かめる。

## 決めたこと
- id は `graph.nodes`（名前順）の位置から振る。状態を足すと後ろの id がずれるが、1 状態 1 行なので差分は読める。名前から作る id は、`end` のような予約語や文字種で Mermaid が壊れるので取らない。
- 印は 1 状態に 1 つで、`violated` が `planned` に勝つ。スキャナの指摘（`vuln`）、未テスト、WIP、未レビューの色は載せない。図が色だらけになり、貼った先で「違反」の赤が目立たなくなるため。
- `[*]` は `model.initial` だけから作る。`properties.entry` や入エッジの無い状態への後退はしない（ビューアと同じ）。
- 状態が 0 個なら exit 1 で何も出さない。空の図を出すと、貼った先が空の枠かエラーになるため。
- 同じ 2 状態を結ぶ遷移は 1 本ずつ 1 行にする（ビューアは ` / ` で 1 本にまとめる）。Mermaid は同じ組の複数の矢印を描ける。
- ガードの文字列は `src/ui/view.ts` の `printGuard` と二重に持つ。`view.ts` は dagre（devDependency）に届くので CLI から import できず、`src/ui` は触らない。`test/mermaid.test.ts` が全演算子で一致を確かめる。共通の core モジュールに寄せるのは、`src/ui` を触れる別の変更で。
- 条件 10 は、手元の別プロジェクトにある mermaid 11.17.2 の `dist/mermaid.min.js` を内蔵ブラウザで読んで確かめた。TLC の違反（`example/` の `no-unauth-home`）で `violated` の 3 状態と、`planned` を含む repo の出力の両方で `parse` と `render` が通り、日本語の状態名と `[retries<3]` のガードが欠けなかった。`@mermaid-js/mermaid-cli` は使っていない。
- 残る端（直さない）。同じ 2 状態を結ぶ矢印が多いと、Mermaid の自動配置でラベルが重なる（`example/` の `ログイン` 周り）。配置は Mermaid 側が決める。
