# ビューア（描画、安定レイアウト、承認、反例の再生）

## 目的
開発者が `everypath serve` の URL を開くと、ステートチャートが draw.io 風の図で描かれ、保存のたびに既存の箱を動かさずに更新される。色で「今どこを見るべきか」が分かり、箱を選べば仕様を承認でき、違反を選べば反例の経路を 1 歩ずつ変数の値つきで追える。保守する人は、画面の状態が 1 つの reducer にあり、描画はその状態だけから作られることを覚えればよい。
満たす: R-02（`dist/ui.html` は単一ファイルでネットワーク参照なし）、R-05（座標の安定。配信の 2 秒はサーバーが満たす）

## 完了条件
- [ ] 1. `npm run typecheck`、`npm run lint`、`npm test` がすべて exit 0（実行して確認）
- [ ] 2. `npm run build` が `dist/ui.html` を 1 ファイルで作り、`scripts/verify-requirements.ts` の R-02 が ok になる。SVG の `xmlns` の名前空間 URI は取得ではないので違反にしない（`test/verify-requirements.test.ts`）
- [ ] 3. 配置関数は、前回の `layout.json` にあるノードの座標を 1 つも変えない。新しいノードは、遷移でつながる既存ノードの下、右、左の順に 20px 刻みで空きを探し、どの箱とも重ならない位置に置く。`layout.json` が空なら dagre（TB、180×64、ranksep 70、nodesep 40）で全体を置く。整列し直すときだけ全体を dagre で置き直す（`test/ui-layout.test.ts`）
- [ ] 4. 色は `SPEC.md` §7.2 の優先順位を 1 つの表で決める。8 段階それぞれと、`proof: "failed"` が赤、`staleModel` の違反だけでは赤にならないことを確かめる（`test/ui-status.test.ts`）
- [ ] 5. エッジの経路は、すべての線分が水平か垂直で、両端が箱の辺に接する（`test/ui-route.test.ts`）
- [ ] 6. 画面の状態は 1 つの reducer が持つ。`graph` イベント、選択、反例のステップ送り、接続の切断と再接続、全探索の開始と終了を、操作の列として与えると期待した状態になる。ステップは 0 から最後までで止まり、ループのある反例はループの開始位置を持つ（`test/ui-state.test.ts`）
- [ ] 7. 実物のブラウザで `everypath serve example` を開くと、8 状態が描かれる。`no-unauth-home` の違反に関わる箱が赤く、選ぶと反例経路が赤い破線で描かれ、◀ ▶ で 1 歩ずつ現在の状態と `authed`・`retries` の値が出る（内蔵ブラウザで確認し、画面写しを残す）
- [ ] 8. 実物のブラウザで、`example/src/` に `@state 設定` と `@state-next Home` のファイルを足すと新しい箱と矢印が現れる。前後の `layout.json` で既存ノードの座標が一致する。「仕様を承認」で箱が緑になり、ファイルを変えるとグレーの太枠に戻る。「全探索を実行」で実行中の表示と、終了後の状態数と違反数が出る。サーバーを止めると「● offline」になり、起動し直すと戻る（内蔵ブラウザで確認。足したファイルと `review.json` は後で消す）

## データの形
```ts
// src/ui/state.ts。画面の状態はこれだけ。描画は ViewState から作る純関数
type ViewState = {
  graph: Graph | null; layout: Layout; connection: "connecting" | "live" | "offline";
  tlc: { kind: "idle" } | { kind: "running" } | { kind: "finished"; states: number | null; message: string | null };
  // 反例の再生はノードの選択の中にある。再生だけがあってノードが無い状態は作れない
  selection: { kind: "none" } | { kind: "node"; id: StateName;
    replay: { property: PropertyId; index: number; step: number } | null };
  showDeps: boolean; // パルスは node.lastChangedAt から導くので状態に持たない
};
type Action = { kind: "graph"; event: GraphEvent; now: number } | { kind: "connection"; state: ViewState["connection"] }
  | { kind: "tlc"; event: TlcEvent } | { kind: "select"; selection: ViewState["selection"] }
  | { kind: "step"; delta: 1 | -1 } | { kind: "move"; id: StateName; at: Point } | { kind: "relayout" } | { kind: "toggle-deps" };
declare function reduce(state: ViewState, action: Action): ViewState;
type Tone = "danger" | "planned" | "wip" | "untested" | "changed" | "unreviewed" | "proven" | "approved";
declare function toneOf(node: StateNode, properties: readonly PropertyResult[]): Tone; // §7.2 の表
declare function place(previous: Layout, graph: Graph): Layout;   // 既存の座標を保つ
declare function relayout(graph: Graph): Layout;                   // dagre で全体を置く
declare function route(from: Box, to: Box): readonly Point[];      // 直交の折れ線
```
表し方: 画面の状態は判別可能なユニオンを持つ 1 つの reducer。色は `Tone` を返す 1 つの表。理由: 描画、パネル、ヘッダの 3 か所が同じ条件を別々に判定すると、色と一覧の順がずれるため。

設計は architect の 2 案（最小構成、次の機能が載る構造）から合成した。採点役と同じく最小構成案を土台にした。純関数の `layout.ts`、`state.ts`、`view.ts` と、DOM を触る `render.ts`、`main.ts` の 5 つである。接ぎ木は 4 点。DOM 側の型検査に Node の型が入らないよう tsconfig を分け、サーバーのイベント型を `src/ui/wire.ts` に写してコンパイル時に一致を確かめる。色は表から属性として出し、CSS に色の一覧を持たない。`innerHTML` などの文字列からの DOM 生成を禁じるテストを置く（ページは承認 API と同じ origin でリポジトリ由来の文字列を描くため）。経路は自己ループ、往復、同じ組の複数本を描き分ける。

決めたこと。
- 状態が変わるたびに、基の SVG、ヘッダ、パネルを 1 フレームにまとめて作り直す。差分の適用はしない。200 ノードで 6〜10 ms の推定で、SSE のイベントはまれなため。ドラッグ中はつかんだ箱とその辺だけを別の層で描き直し、パンとズームは変換を 1 つ変えるだけにする。
- `layout.json` を書くのは `main.ts` の `persist()` 1 か所だけ。新しいノードを置いた後、ドラッグを離した後、整列し直した後に書く。消えたノードの座標は画面の記憶に残し、戻れば同じ場所に置く。ただし、消えている間に別の書き込みがあると、ファイルからは消える（サーバーが今のノードの id しか受け付けないため）。
- 反例のあるノードを選ぶと、最初の反例の再生が 0 歩目から始まる。

## 非目標
- 未レビュー一覧、変更ログのタブ、指示生成、モデルタブ、グループ枠、複数選択、ファイル粒度へのズーム。次の仕様で扱う
- ダークモード（要件定義書の非目標）
- `src/server/` と `src/cli.ts` の変更。別のブランチ（`feat/serve-cli-guard`）が作業中のため、ビューアはサーバーの今の API だけを使う。そのため、詳細パネルに「前回承認日時」は出さない（`Graph` に承認時刻が無い）

## 検証方法
`test/ui-layout.test.ts`、`test/ui-status.test.ts`、`test/ui-route.test.ts`、`test/ui-state.test.ts`（DOM を使わない純関数）、`test/ui-boundaries.test.ts`（`innerHTML` などの禁止）、`test/ui-wire.check.ts`（型の一致）、`test/verify-requirements.test.ts`、`scripts/build-ui.ts`。条件 7 と 8 は内蔵ブラウザで実物を確かめる。作る。
