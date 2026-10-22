# サーバー（everypath serve）

## 目的
開発者が `everypath serve` を起動しておくと、保存のたびに図の元データ（`graph.json`）がブラウザへ届き、承認と全探索をブラウザから実行できる。後に作るビューアは、このサーバーの HTTP と SSE だけを読む。保守する人は、ディスクへの書き込みがサーバー内の 1 本の列を通ることだけを覚えればよい。
満たす: R-01（サーバーが書くのは `.everypath/` 配下だけ）、R-03（TLC が無くても動く）、R-05（保存から 2 秒以内に配信。座標の安定はビューアの仕様で満たす）

## 完了条件
- [x] 1. `npm run typecheck`、`npm run lint`、`npm test` がすべて exit 0（実行して確認）
- [x] 2. `everypath serve <dir> --port 0` が待ち受け URL を 1 行出す。`GET /graph.json` が同じ時点の `everypath scan --json` と同じノードとエッジを返す（`test/server.test.ts`）
- [x] 3. `GET /events` は接続直後に `{type:"graph", diff:null}` を送る。`@state 設定` と `@state-next Home` を書いたファイルを足すと、新ノードと遷移を含む `graph` イベントが届く。10 回計測した最大が 2,000 ms 未満（`scripts/verify-requirements.ts` の R-05 の行。`npm test` からも呼ぶ）
- [x] 4. `POST /review/:id`（本文 `{note}`）が `review.json` にそのノードの hash、`at`、`by` を書き、続く `graph` イベントで `reviewed: true` になる。ファイルを変えると `changedSinceReview: true`。`DELETE /review/:id` で承認が消える。無いノードは 404、本文が不正なら 400（`test/server.test.ts`）。決定 0004 で、承認も取り消しも `.everypath/review/` に記録を 1 件足す形に変わった（`docs/specs/team-review.md`）
- [x] 5. `PUT /layout.json` が正しい本文を `.everypath/layout.json` に保存し、`GET` で同じものを返す。不正な本文は 400。再スキャンは `layout.json` を変えない（`test/server.test.ts`）
- [x] 6. `POST /check/tlc` は 202 を返し、SSE で `tlc` の `running`、続いて `done` か `error` を送り、完了後に `graph` を再配信する。実行中の 2 回目は 409。Java が無い環境では `error` に導入手順を載せ、他の API は動き続ける（`test/server.test.ts`。TLC はスタブの jar ではなく `PATH` の差し替えで無しを作る。実物の TLC は jar があるときだけ走る 1 件）
- [x] 7. TLC の結果は、その後の再スキャンでも消えない。モデル（状態、遷移、変数、性質）が TLC 実行時と同じなら結果をそのまま残し、違えば `staleModel: true` を付けて残す（`test/server.test.ts`）
- [x] 8. サーバーの稼働中にディスクへ書くのは `.everypath/` 配下だけ（`test/requirements.test.ts` の R-01 に serve の場合を足す）
- [x] 9. `.everypath/graph.json` や一時ファイルの変化では再スキャンしない。`.everypath/review.json` と `.everypath/findings.json`、`everypath.*.json` の変化では再スキャンして配信する（`test/server.test.ts`）。決定 0004 の後は `.everypath/review/` の記録も同じ（`test/server.test.ts`）
- [x] 10. `GET /` は `dist/ui.html` があれば返し、無ければ 503 と日本語の案内を返す。`GET /tla/Model.tla` は生成前なら 404。使用中のポートを指定すると日本語のエラーで exit 1（`test/server.test.ts`）

## データの形
```ts
type ServerEvent =
  | { type: "graph"; graph: Graph; diff: HistoryEntry | null; reason: string }
  | { type: "tlc"; status: "running" | "done" | "error"; states: number | null; message: string | null };
// 書き込みはすべてこの列を 1 件ずつ通る。待っている rescan は後から来た rescan を吸収する
type Job = { kind: "rescan"; reason: string } | { kind: "approve"; id: StateName; note: string; hash: string | null }
  | { kind: "revoke"; id: StateName } | { kind: "layout"; body: Layout } | { kind: "tlc-commit"; run: TlcRecord; landed: (outcome) => void }; // 取り込み後に done/error を送る
type TlcLane = { kind: "idle" } | { kind: "running"; startedAt: string; abort: AbortController };
// .everypath/tla/result.json。scan の入力。key は生成した Model.tla からコメント行を除いた sha1
type TlcRecord = { version: 1; checkedAt: string; key: string; tla: string; cfg: string;
  names: TlaNames; properties: PropertyResult[]; states: number | null; error: string | null };
declare function startServer(o: { root: string; port: number; uiPath?: string; env?: NodeJS.ProcessEnv }):
  Promise<{ url: string; close(): Promise<void> }>; // close は監視、SSE、TLC の子プロセスを止める
```
表し方: 書き込みは判別可能なユニオンの `Job` を 1 本の列で直列に処理する。`graph.json` を書くのは、新しい `analyze` に続く `writeWorkspace` だけにする。TLC は一時ディレクトリで走らせ、結果は `TlcRecord` として返す。`.everypath/tla/` の 3 ファイルを書くのは、列の中の `tlc-commit` ジョブだけで、書いたあとに再スキャンする。`analyze` は `result.json` を読み、簡易検査が TLC 待ちの `pending` にした、同じ id と同じ種類の性質だけに結果を重ねる。今のモデルのキーと同じならそのまま、違えば `staleModel: true` を付ける。簡易検査の `ok` と `violated` は、キーが同じでも上書きしない。理由: 説明役の調査で、コアはロックを持たず、`history.jsonl` の二重書きと古い解析での上書きが起きると分かったため。古い解析の `Graph` を渡す経路が無いので、上書きは構造上起きない。

設計は architect の 2 案（最小変更、構造の作り直し）から合成した。最小変更案を土台にした。コア側の試作で既存の 263 件が無変更で通ったためである。作り直し案からは 5 点を接ぎ木した。TLC を一時ディレクトリで走らせること、`.everypath/tla/` を列の中だけで書くこと、コメントを除いたキー、古い結果は `pending` の枠だけを埋めること、書き込み元を固定する構造テスト（`test/single-writer.test.ts`）である。作り直し案の入力表と、ダイジェストによる重複の抑止は取らなかった。余分な再スキャンを減らすだけで、正しさは変えないためである。

決めたこと。
- 古い（`staleModel: true`）違反は `nodes[].violations` に入れず、`everypath check` の終了コードにも数えない。表示はして「古いモデルに対する結果」と添える。モデルが変わった後の違反を直させると、もう無いバグを追わせるため。
- `everypath scan` と `check` も `result.json` を読む。CLI とサーバーで同じグラフになる（条件 2）。`docs/specs/tla.md` の非目標を取り消した。
- 承認の本文には任意で `hash` を付けられ、今のノードの hash と違えば 409 を返す。画面に出ていない版を承認しないため。
- 監視の判定は `workspace.ts` の `isScanInput` 1 つにする。`.everypath/` の中では `review.json`、`findings.json`、`tla/result.json` だけを入力とする。250 ms の窓は最初のイベントで開く。macOS と Windows は `recursive` の監視、Linux は無視規則で絞ったディレクトリごとの監視にする（Linux の `recursive` は `node_modules` まで張り、上限超えを黙って捨てるため）。監視が失敗したら日本語で警告し、1.5 秒のポーリングに替える。
- 状態を変える要求は `Content-Type: application/json` と、`Host` が `localhost` か `127.0.0.1` であることを求める。`Origin` があれば自分自身でなければ 403。本文は 1 MiB まで（超えたら 413）、`note` は 2,000 文字まで、座標は今あるノードの id ごとの有限の数だけ。`review.json` は git で管理する記録なので、他のページから書かせないため。
- 全応答に `X-Content-Type-Options: nosniff`、`GET /` には `frame-ancestors 'none'` と `X-Frame-Options: DENY` を付ける。ビューアはリポジトリ由来の文字列を承認 API と同じ origin で描くため。
- 再スキャンの結果が前回とタイムスタンプ以外同じなら、書き込みも配信もしない。サーバー自身の `review.json` と `result.json` の書き込みが監視に返ってきても、配信は 1 回で済む。
- `.everypath` か `.everypath/tla` がシンボリックリンクなら書き込みを拒む。悪意あるリポジトリにリポジトリの外を書かせないため（R-01）。
- `GET /history.json` は `history.jsonl` の最新 200 件を古い順の配列で返す（`SPEC.md` §11。ビューアの変更ログ用）。

敵対的レビュー（正しさ、保守性、性能、セキュリティの 4 視点）を経た。直した 12 件は上の決定に反映した。直さずに残したもの: サーバー稼働中の CLI の `scan` は列の外から書く（`docs/specs/serve-cli-guard.md` で直した。CLI は書かずにサーバーへ渡す）、TypeOK の違反は `result.json` に残すがグラフには出ない（`docs/specs/typeok.md` で直した。組み込みの性質 `TypeOK` としてグラフに出る）、監視の判定は `config.ignore` を見ない（余分なスキャンだけで、配信はしない）、TLC の `-Xmx` と worker 数の上限、Windows での実行ファイル探索。

## 非目標
- ビューアの画面（`dist/ui.html` の中身）。`GET /` は配るだけ
- `--open` 以外のブラウザ操作、認証、`localhost` 以外での待ち受け
- TLC の途中経過（状態数の逐次配信）。`checkTlc` は終了後にまとめて返すため、`running` と終了時の状態数だけを送る

## 検証方法
`test/server.test.ts`（一時ディレクトリに作ったリポジトリに `everypath serve` を子プロセスで起動し、実際に HTTP と SSE で接続する）、`test/single-writer.test.ts`、`test/requirements.test.ts`、`scripts/verify-requirements.ts`（R-05 の行を足す）。作る。
