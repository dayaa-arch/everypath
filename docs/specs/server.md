# サーバー（everypath serve）

## 目的
開発者が `everypath serve` を起動しておくと、保存のたびに図の元データ（`graph.json`）がブラウザへ届き、承認と全探索をブラウザから実行できる。後に作るビューアは、このサーバーの HTTP と SSE だけを読む。保守する人は、ディスクへの書き込みがサーバー内の 1 本の列を通ることだけを覚えればよい。
満たす: R-01（サーバーが書くのは `.everypath/` 配下だけ）、R-03（TLC が無くても動く）、R-05（保存から 2 秒以内に配信。座標の安定はビューアの仕様で満たす）

## 完了条件
- [ ] 1. `npm run typecheck`、`npm run lint`、`npm test` がすべて exit 0（実行して確認）
- [ ] 2. `everypath serve <dir> --port 0` が待ち受け URL を 1 行出す。`GET /graph.json` が同じ時点の `everypath scan --json` と同じノードとエッジを返す（`test/server.test.ts`）
- [ ] 3. `GET /events` は接続直後に `{type:"graph", diff:null}` を送る。`@state 設定` と `@state-next Home` を書いたファイルを足すと、新ノードと遷移を含む `graph` イベントが届く。10 回計測した最大が 2,000 ms 未満（`scripts/verify-requirements.ts` の R-05 の行。`npm test` からも呼ぶ）
- [ ] 4. `POST /review/:id`（本文 `{note}`）が `review.json` にそのノードの hash、`at`、`by` を書き、続く `graph` イベントで `reviewed: true` になる。ファイルを変えると `changedSinceReview: true`。`DELETE /review/:id` で承認が消える。無いノードは 404、本文が不正なら 400（`test/server.test.ts`）
- [ ] 5. `PUT /layout.json` が正しい本文を `.everypath/layout.json` に保存し、`GET` で同じものを返す。不正な本文は 400。再スキャンは `layout.json` を変えない（`test/server.test.ts`）
- [ ] 6. `POST /check/tlc` は 202 を返し、SSE で `tlc` の `running`、続いて `done` か `error` を送り、完了後に `graph` を再配信する。実行中の 2 回目は 409。Java が無い環境では `error` に導入手順を載せ、他の API は動き続ける（`test/server.test.ts`。TLC はスタブの jar ではなく `PATH` の差し替えで無しを作る。実物の TLC は jar があるときだけ走る 1 件）
- [ ] 7. TLC の結果は、その後の再スキャンでも消えない。モデル（状態、遷移、変数、性質）が TLC 実行時と同じなら結果をそのまま残し、違えば `staleModel: true` を付けて残す（`test/server.test.ts`）
- [ ] 8. サーバーの稼働中にディスクへ書くのは `.everypath/` 配下だけ（`test/requirements.test.ts` の R-01 に serve の場合を足す）
- [ ] 9. `.everypath/graph.json` や一時ファイルの変化では再スキャンしない。`.everypath/review.json` と `.everypath/findings.json`、`everypath.*.json` の変化では再スキャンして配信する（`test/server.test.ts`）
- [ ] 10. `GET /` は `dist/ui.html` があれば返し、無ければ 503 と日本語の案内を返す。`GET /tla/Model.tla` は生成前なら 404。使用中のポートを指定すると日本語のエラーで exit 1（`test/server.test.ts`）

## データの形
```ts
type ServerEvent =
  | { type: "graph"; graph: Graph; diff: HistoryEntry | null; reason: string }
  | { type: "tlc"; status: "running" | "done" | "error"; states: number | null; message: string | null };
// 書き込みはすべてこの列を 1 件ずつ通る。同時に 2 件は走らない
type Job = { kind: "rescan"; reason: string } | { kind: "approve"; id: StateName; note: string }
  | { kind: "revoke"; id: StateName } | { kind: "layout"; body: Layout } | { kind: "tlc-merge"; /* TLC の結果 */ };
type TlcLane = { kind: "idle" } | { kind: "running"; startedAt: string };
```
表し方: 書き込みは判別可能なユニオンの `Job` を 1 本の列で直列に処理する。TLC の実行は列の外で走らせ、終わったら結果の取り込みだけを `Job` として列に入れる。理由: 説明役の調査で、コアはロックを持たず、`history.jsonl` の二重書きと古い解析での上書きが起きると分かったため。TLC の結果を再スキャンに残す仕組み（条件 7）の置き場所と、モデルの同一性の判定方法は architect で決める。

## 非目標
- ビューアの画面（`dist/ui.html` の中身）。`GET /` は配るだけ
- `--open` 以外のブラウザ操作、認証、`localhost` 以外での待ち受け
- TLC の途中経過（状態数の逐次配信）。`checkTlc` は終了後にまとめて返すため、`running` と終了時の状態数だけを送る

## 検証方法
`test/server.test.ts`（一時ディレクトリに作ったリポジトリへ実際に HTTP と SSE で接続する）、`test/requirements.test.ts`、`scripts/verify-requirements.ts`（R-05 の行を足す）。作る。
