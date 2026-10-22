# 関数単位の証明（proofs.json、everypath prove、仕様と証明を書く）

## 目的
認証・決済・権限の状態に `@state-require proof` を付けた開発者が、`everypath prove` で Dafny、Verus、任意のコマンドを状態ごとに走らせ、その結果を地図の色とパネル、`check`、指示文「仕様と証明を書く」で見られるようになる。保守する人は、証明の記録は `.everypath/proofs.json` の 1 つだけで、書くのは `prove`、読むのはスキャン、とだけ覚えればよい。
満たす: R-01（`prove` がリポジトリに書くのは `.everypath/proofs.json` だけ）、R-03（検証ツールが無くても scan、check、serve は動き、prove は案内して終わる）、R-05（proofs.json の保存も監視が拾い、ビューアに届く）

## 完了条件
- [x] 1. `npm run typecheck`、`npm run lint`、`npm test`、`npm run build` がすべて exit 0。`skill/SKILL.md` に `everypath prove` の決まりがある（実行して確認。`test/init.test.ts` の言及リスト）
- [x] 2. 読み込み。項目の `hash` がノードの hash と同じなら `status.proof` はその `result` になり、`nodes[].proof` に `result`、`tool`、`message`、`at`、`stale: false` が載る。hash が違えば `status.proof` は `pending`、`proof.stale` は `true` で、前の結果を残す。形の違う項目は id 付きの警告にして捨て、他の項目は使う。JSON でないファイルとオブジェクトでないファイルは警告 1 件。proofs.json が無く設定に `proof` も無ければ、graph.json に `proof` と `prover` のキーは出ない（`test/proofs.test.ts`）
- [x] 3. 設定。`proof: {tool: "dafny"}` は `prover: {tool: "dafny", command: "dafny verify {files}"}` に、`verus` は `verus {files}` になる。`command` を書けばそれを使う。`tool: "command"` で `command` が無いもの、未知の `tool`、文字列でない `command` は警告にして `prover` を出さない（`test/proofs.test.ts`）
- [x] 4. 出力の読み手。`test/fixtures/proofs/` の引用（各ファイルの頭に出典 URL）について、通った出力は `passed`、通らない出力は `failed` になる。`failed` の `message` には失敗した義務が入る。Dafny は `Error:` と `Related location:` と「N resolution/type errors detected」の行、Verus は見出し、場所、`failed …` の印が指すコードの行。`command` は終了コードだけで決める（`test/prove-readers.test.ts`）
- [x] 5. `everypath prove [dir] [--timeout 秒]`。requireProof の状態ごとに 1 回、一時ディレクトリを作業ディレクトリにし、`{files}` をその状態のファイルの絶対パスに置き換えて走らせる。通れば `passed`、通らなければ終了コードと出力の末尾を付けて `failed`、時間切れは止めて `failed` を、`hash` と `at` 付きで proofs.json に書く。他の id の項目は残す。全部 `passed` なら exit 0、それ以外は 1。ツールが見つからない、または `proof` の設定が無いときは、案内を出して exit 1 で何も書かない。`dafny` の名前で置いた偽物が引用の出力を返すと、その `message` が proofs.json に入る（`test/prove.test.ts`）
- [x] 6. R-01。`prove` の前後で `.everypath/` 以外の全ファイルの sha1 が一致し、`.everypath/` に増えるのは `proofs.json` だけ。ツールが作業ディレクトリに書いたファイルはリポジトリに残らない（`test/requirements.test.ts`）
- [x] 7. `check` は requireProof で `passed` でない状態を標準出力に並べ、終了コードは変えない。`--require-proof` を付けると、その状態が 1 つでもあれば exit 1、無ければ今までどおり（`test/prove.test.ts`）
- [x] 8. serve。`.everypath/proofs.json` を書くと再スキャンして配信する。サーバーは proofs.json を書かず、`src/server/` は `prove` を import できない（`test/server.test.ts`、`test/single-writer.test.ts`）
- [x] 9. ビューア。承認済みで `passed` は青（proven）、今の `failed` は赤（danger）、古い結果は色を変えない。パネルの「証明」に結果、ツール、時刻、古い結果である旨、`message` が出る。「仕様と証明を書く」は requireProof で `passed` でない状態にだけ出て、ファイル、`@state-spec`、ツール名と command、完了条件（`everypath prove` の後に proofs.json で `passed`）が入る（`test/proofs-viewer.test.ts`）
- [x] 10. 実物。`example/` の写しに `@state-require proof` と偽の検証コマンドを足して `prove`、`scan`、`check --require-proof` を走らせ、ビューアで青と赤とパネルを確かめる（手で実行し、返答に出力を貼る）

## データの形
```ts
// src/core/types.ts。`.everypath/proofs.json` は { [node id]: ProofEntry }。SPEC §10.5 の形に hash を足した
type ProofTool = "dafny" | "verus" | "command";
type ProofEntry = { result: "passed" | "failed" | "pending"; tool: string; message: string; at: string;
  hash: string };                       // ツールを走らせた時点のノードの hash
type NodeProof = Omit<ProofEntry, "hash"> & { stale: boolean };
type StateNode = … & { proof?: NodeProof };            // 項目があるときだけ書く
type Prover = { tool: ProofTool; command: string };  // 設定の proof。command は既定を埋めたもの
type Graph = … & { prover?: Prover };                // 設定に使える proof があるときだけ書く
// status.proof: 項目が無ければ "none"、stale なら "pending"、それ以外は項目の result（src/core/proofs.ts の proofOf）
// src/core/prove.ts。ツールごとの表。既定の命令は src/core/config.ts の DEFAULT_COMMANDS
type Verdict = { result: "passed" | "failed"; message: string };
const TOOLS: Record<ProofTool, { extension: string | null; read: (run: { output: string; code: number }) => Verdict }>;
type NodeRun = { kind: "proved"; id: StateName; entry: ProofEntry } | { kind: "skipped"; id: StateName; reason: string };
type ProveOutcome = { kind: "unconfigured"; warnings: ScanWarning[] }
  | { kind: "missing"; program: string; reason: string } | { kind: "ran"; prover: Prover; runs: NodeRun[] };
```
表し方: ツールの違い（拾う拡張子、出力の読み方、既定の命令）は `ProofTool` を鍵にした表に置く。ノードの証明の状態は、項目の有無と hash の一致の 2 つから `proofOf` 1 か所で決める。理由: 色、パネル、check、指示文がそれぞれ hash を比べると、古い結果の扱いがずれるため。

決めたこと。
- `hash` を必須にした。hash の無い記録はコードが変わっても `passed` のまま残り、承認と同じ「変わったら外れる」が効かないため。外部のツールが書くときも graph.json の `nodes[].hash` を写す。
- 古い結果は `pending` に数え、色を変えない。TLC の古い違反と同じく、もう無い失敗を直させないため。パネルには前回の結果を出す。
- 時間切れは `failed` にする。Dafny 自身も時間切れを検証エラーとして数える。ツールが見つからないときは結果ではないので何も書かない。`pending` は外部のツールが書くための値で、`prove` は書かない。
- `{files}` は、Dafny は `.dfy`、Verus は `.rs`、`command` は全部のファイルに絞る。`.dfy` を走査の拡張子に足した（`.dfy` に `@state` を書いてノードに入れるため）。命令行に `{files}` があり絞った結果が空のノードは「対象外」として走らせない。
- 命令行は空白で区切り、シェルを通さない。ファイル名はリポジトリ由来で、シェルに渡すと名前の中の `$(…)` が動くため。1 語目が `/` を含む相対パスならリポジトリのルートから解く。設定の命令はリポジトリが決めるので、信頼できるリポジトリでだけ `prove` を走らせる（npm scripts と同じ）。
- 作業ディレクトリは毎回作って消す一時ディレクトリ。ツールが作業ディレクトリに書くものはリポジトリに残らない。時間切れはプロセスグループごと SIGKILL で止める（Dafny が起こす Z3 も止めるため）。既定は 1 状態 120 秒。
- `check` の終了コードは既定で変えない。`check` は保存のたびにエージェントが走らせる速いレーンで、検証ツールの無い環境では必ず失敗してしまうため。CI で証明まで求めるときは `prove` の後に `check --require-proof` を走らせる。
- `prove` はサーバーに渡さない。proofs.json の書き手は `prove` だけで、サーバーは読むだけなので、列で直列にする共有の書き込みが無い。graph.json は書かないので、反映は次の scan か serve の監視が行う。
- 「仕様と証明を書く」に要るツール名はブラウザから設定を読めないので、`graph.prover` で渡す。

実装中に決めたこと。
- `.dfy` のファイルは、ノードの `tested` の判定から外す。テストは `.dfy` を import できず、証明を足しただけでノードが「未テスト」に戻ってしまうため。`.dfy` だけのノードはテスト済みとみなし、証明の結果は `status.proof` が示す。
- 読み手は終了コードと出力の両方で決める。0 で終わり、失敗した義務の行が 1 つも無いときだけ `passed`。0 以外で義務の行が無いときは、終了コードと出力の末尾 10 行を `message` にする。Dafny の終了コードは UserGuide 13.6.3（0 成功、2 解決エラー、4 検証エラー）に合う。Verus の終了コードは引用元に無いので、この規則で値に頼らない。
- Verus の「`failed …` の印が指すコード」は、印の行の直前にある引用されたコードの行。印にラベルがあるものだけを拾う（`^^^^` だけの行と `|_^` の複数行の印は拾わない）。`error: aborting due to …` は義務ではないので捨てる。
- `message` は 4,000 文字、読む出力は 1,000,000 文字で切る。`prove` は失敗したノードの下に `message` の先頭 5 行を出し、`check` は 1 行目だけを出す。proofs.json とパネルには全部を残す。
- `prove` は状態ごとに終わった順で 1 行ずつ出す。1 状態に最大 120 秒かかるので、最後まで黙らないため。
- ツールはプロセスグループの頭として起こし、時間切れでグループごと止める。`prove` が SIGINT か SIGTERM を受けたときもグループを止めてから自分が終わる。グループにしないと、時間切れでも孫（`sleep` や Z3）がパイプを持ったまま残る。`test/prove.test.ts` の時間切れの件（`sleep 30`、`--timeout 1`）は、グループを外すと 33.6 秒かかって落ち、グループありなら通る（計測）。
- 凡例と未レビュー一覧の赤の名前を「脆弱性・性質違反・証明失敗」にした。証明の失敗も同じ赤で塗るため。
- 引用した出力は `test/fixtures/proofs/` に置き、取り直す手順を `test/fixtures/proofs/fetch.sh` に残した（Dafny は dafny-lang/dafny の `5f717bf`、Verus は verus-lang/verus の `920ee00` に固定）。終了コードが引用元に無いものは、その旨を各ファイルの `note:` に書いた。

## 非目標
- サーバーからの証明の実行（ビューアのボタン）、状態ごとの並列実行、`prove` どうしの排他
- Kani、Lean など、表に無いツールの出力の読み手（`command` で終了コードだけなら使える）
- proofs.json の git 管理と `stats.proven`（`.gitignore` は `init` のまま）

## 検証方法
`test/proofs.test.ts`（スキャンと設定）、`test/prove-readers.test.ts`（引用した出力）、`test/prove.test.ts`（偽のコマンドで CLI を走らせる）、`test/proofs-viewer.test.ts`（色、パネル、指示文）、`test/requirements.test.ts`、`test/server.test.ts`、`test/single-writer.test.ts` に足す。作る。Dafny と Verus は手元に無いので、読み手は引用した出力だけで確かめる。作者の判断（2026-10-23）で、実物での確認は Dafny か Verus を実際に使う時まで行わない。それまでは README に「実物では未確認」と書き、確かめ済みの経路は `command` とする。
