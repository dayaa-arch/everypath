# serve 稼働中の CLI（書き込みの一本化）

## 目的
`everypath serve` を起動したまま `SPEC.md` §14.3 の hook（`npx everypath scan --quiet`）や `check`、`check --tlc` を走らせても、`.everypath/` を書くのはサーバーの列だけになる。利用者は `history.jsonl` の二重行と、古い解析による `graph.json` の上書きを見なくなる。保守する人は「サーバーが動いている間、CLI は書かずにサーバーへ渡す」の 1 つだけを覚えればよい。
満たす: R-01（`serve.json` も `.everypath/` 配下）、R-03（Java が無くても渡した先で案内して続行する）

## 完了条件
- [ ] 1. `npm run typecheck`、`npm run lint`、`npm test` がすべて exit 0（実行して確認）
- [ ] 2. `serve` の稼働中に、新しい状態を書いたファイルの追加と `scan --quiet` の同時 2 回を 5 周くり返す。追加した状態はそれぞれ `history.jsonl` のちょうど 1 行の `added` に載る。サーバーが落ち着いたあと、`.everypath/graph.json` は `GET /graph.json` とバイト単位で同じ（`test/serve-cli-guard.test.ts`。修正前は失敗する）
- [ ] 3. `serve` が URL を出した時点で `.everypath/serve.json` は `{version:1, pid, port}` を持ち、pid は生きていて port は URL と同じ。SIGTERM で止めると消える（同上）
- [ ] 4. 稼働中のサーバーがあると、`scan --json` は `GET /graph.json` と同じ文字列を出し、`check` はサーバー無しのときと同じ標準出力と終了コードを返す。どちらも `graph.json` を書き換えない（同上）
- [ ] 5. 稼働中のサーバーがあると、`check --tlc` の TLC はサーバーで走る。`/events` の購読者に `tlc` の `running` と `done` が届き、CLI はサーバー無しのときと同じ反例を出して exit 1。`--timeout` もサーバーでの実行に効く（同上）
- [ ] 6. サーバーの環境に Java が無いとき、`check --tlc` は導入手順を出し、簡易検査の結果で exit 0 か 1 になる（同上。R-03）
- [ ] 7. `serve.json` の pid が終了済みか、port が接続を拒むとき、CLI は今までどおり自分で書いて exit 0（同上）
- [ ] 8. 同じディレクトリで 2 つ目の `serve` を起動すると、1 つ目の URL を含む日本語のエラーで exit 1。1 つ目の `serve.json` は変わらない。終了済みの pid の `serve.json` は起動を妨げない（同上）
- [ ] 9. `single-writer.test.ts` が `remove` で始まる `workspace.ts` の関数も書き手として数え、`src/server/` からは `writer.ts` だけが呼べる（`test/single-writer.test.ts`）

## データの形
```ts
// .everypath/serve.json。サーバーの列が開く前に排他作成し、列を閉じたあとに消す
type ServeRecord = { version: 1; pid: number; port: number };
// CLI の書き込み先。サーバーが生きていれば渡す、いなければ自分で書く
type Route = { kind: "direct" } | { kind: "server"; url: string };
// POST /check/tlc の任意の本文。wait なら実行中のものが終わるのを待ってから自分の実行を始め、
// 結果が列で取り込まれたあとに 200 で TlcSummary を返す。wait 無しは今までどおり 202 か 409
type CheckTlcBody = { wait?: true; timeoutMs?: number };
// check --tlc が表示に使うもの。CLI が走らせてもサーバーが走らせても同じ形
type TlcSummary =
  | { kind: "missing"; guide: string[] }
  | { kind: "unmodeled"; reason: string }
  | { kind: "checked"; rejected: string[]; typeOk: Counterexample | null; error: string | null };
```
表し方: 判別可能なユニオンの `Route` を CLI の入口で 1 回だけ決め、`scan`、`check`、`check --tlc` はそれで分岐する。`serve.json` の作成と削除は `workspace.ts` に置き、サーバー側で呼ぶのは `writer.ts` の `openWriter` と `close` だけにする。理由: 書き込み元を固定する構造テストをそのまま使えるため。

決めたこと。
- 生きているかは、pid に `kill(pid, 0)` が通ること（`EPERM` も生きている）と、port に接続できることの 2 つで判定する。接続を拒まれたら pid の使い回しか停止中とみなし、自分で書く。接続できたあとの 4xx と 5xx はエラーとして exit 1 にし、自分では書かない。
- `check --tlc` を渡したとき、Java と jar はサーバーの環境で探す。TLC を 1 本に保ち、ビューアにも実行中が見えるため。
- CLI からの要求は `node:http` で送り、待ち時間の上限を置かない。TLC の待ちは数分になりうるため。
- `POST /rescan` は今のまま本文を見ない。渡した再スキャンの履歴は `reason: "rescan"` になる。サーバーの監視がほぼ先に同じ変更を拾うので、`scan` や `check` と書き分けても見える違いが無い。

## 非目標
- `tla export` の受け渡し。書くのは `Model.tla` と `Model.cfg` の置き換えだけで、`graph.json` と履歴には触れない
- サーバー無しで同時に走る CLI どうしの排他
- サーバーの起動直前と停止中（HTTP を閉じてから `serve.json` を消すまで）に CLI が自分で書く窓

## 検証方法
`test/serve-cli-guard.test.ts`（作る。`everypath serve` を子プロセスで起動し、CLI も子プロセスで走らせる）、`test/single-writer.test.ts`。
