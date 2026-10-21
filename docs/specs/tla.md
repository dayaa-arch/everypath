# TLA+ 生成と TLC 実行

## 目的
`everypath check --tlc` が `graph.json` のモデルから `.everypath/tla/Model.tla` と `Model.cfg` を生成し、TLC で変数と時相の性質（簡易検査が保留にした `invariant` と `leads-to`）を全探索して、反例を状態・イベント・変数値つきで日本語で出し、`graph.json` に書く。利用者はガードと変数の値で起きるバグを CI で受け取り、生成された TLA+ を読んで学べる。保守する人は、生成・実行・出力の読み取りを `src/core/tla/` の 3 ファイルで追える。
満たす: R-01（`check --tlc` も `.everypath/` 以外を書かない）、R-03（Java と jar が無くても動く）、R-04（有限モデルを TLA+ に落とす部分）

## 完了条件
- [x] 1. `npm run typecheck`、`npm run lint`、`npm test` がすべて exit 0（実行して確認）
- [x] 2. 生成。example のグラフから作った `Model.tla` は、識別子を「接頭辞 + 1 始まりの位置 + ASCII 名なら `_名前`」で作り（状態 `S3`・`S2_Home`、変数 `v1_authed`、イベント `e8_reset_done`、性質 `P1_no_unauth_home`、アクション `A1`…`A13`）、表示名をコメントに持つ。flow エッジ 1 本につきアクション 1 つで、直前のコメントに由来ファイルと `@state-next` の本文がある。イベント無しの遷移は `lastEvent' = "tau"`、代入の無い変数は `UNCHANGED` に入る。`Init`、`Next`、`Spec`（`WF_vars(Next)` つき）、`TypeOK`、性質ごとの定義を持つ。`Model.cfg` は `SPECIFICATION Spec` と `INVARIANT`・`PROPERTY` を並べる。非 ASCII の変数・イベント・列挙値も ASCII の識別子になり、対応表が `names` に入る。`TlaModel.invariants` は利用者の不変条件のあとに `TypeOK` を持ち、`TypeOK` を含まない実行の cfg には `CONSTRAINT TypeOK` が入る。未宣言の変数や型の合わない値を使う性質は `rejected` に入り、ほかの性質の検査を止めない（`test/tla.test.ts`）
- [x] 3. 式の翻訳。`GuardExpr` と `PropExpr` の全 `kind`（`cmp` の 6 演算子、`state-in`、`not`、`and`、`or`、`implies`）を `kind` の網羅 `switch` で TLA+ に落とす。ノードに無い状態名は集合から外す（`test/tla.test.ts`、網羅は `npm run typecheck`）
- [x] 4. パース。`test/fixtures/` の実際の TLC 2.19（v1.7.4）の出力 5 件を読む。`tlc-output-violation.txt` から不変条件の名前と 3 ステップの反例（状態・イベント・変数値を表示名で）、`tlc-output-ok.txt` から成功と状態数 47、`tlc-output-liveness.txt` から時相性質の違反と `Back to state 6` のループ位置（`loopStart: 5`）、`tlc-output-stuttering.txt` から `Stuttering` で終わる反例（`loopStart` は最後のステップ）、`tlc-output-parse-error.txt` から `error` を読む。どの入力でも例外を投げない（`test/tla.test.ts`）
- [x] 5. 実行。違反した不変条件を外して再実行し、時相性質は 1 つずつ実行して、性質ごとに成否を決める。タイムアウト（既定 120 秒、`--timeout` で秒指定）を超えたら残りの性質は `error` になり、最後に分かった状態数を持つ（偽の `java` を `PATH` に置いて `test/tla.test.ts`）
- [x] 6. 合流。`rejected` の性質は `error` になり、性質ファイルの警告を 1 件足す。TLC の結果は `graph.json.properties` の同じ id を置き換え、変数を含む性質と `leads-to` は `checkedBy: "tlc"`、変数を含まない `invariant` は `"both"` になる。反例の通るノードの `violations` に id が入る。`result.json` に結果と対応表を書く（偽の `java` で `test/tla.test.ts`）
- [x] 7. CLI。`check --tlc` は違反ごとに `1. ログイン（authed=FALSE, retries=0）` `2. →(reset_done) Home（…）` の形で各ステップを出し、ループは `→ 2 に戻って繰り返す` と出す。違反、型の範囲外（`TypeOK`）、TLC の `error` のどれかで exit 1。`tla export [dir]` は `Model.tla` と `Model.cfg` だけを書き、`graph.json` も TLC も触らない（`test/cli.test.ts`）
- [x] 8. R-03。`java` の無い `PATH`、または jar の無い `EVERYPATH_TLA_JAR` で `check --tlc` が導入手順（`everypath tla install`）を出し、簡易検査の結果で exit 0 か 1 になる。入口の無いリポジトリや翻訳できない性質があっても、案内が先に出る。`.everypath/` 以外のファイルは変わらない（`test/requirements.test.ts`）
- [x] 9. `tla install` は `EVERYPATH_TLA_URL` と `EVERYPATH_TLA_SHA256`（片方だけなら exit 2）で指したローカルの HTTP サーバーから jar を受け取り、`EVERYPATH_TLA_JAR` の場所へ一時ファイル経由で置く。既定の URL は v1.7.4 に固定し、sha256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88` を照合する。照合に失敗したら置かずに exit 1（`test/cli.test.ts`）
- [x] 10. 実機。jar を入れたうえで `npx tsx src/cli.ts check --tlc example` が `no-unauth-home` の違反と `ログイン → パスワードリセット → Home` の反例を出す（SPEC §19 の 7）。`retries` を `0..10` に、ガードを `retries<10`・`retries==10` に変えると、TLC だけが `lock-after-3` の違反を見つける（§19 の 8。手で実行し、返答に貼って example を戻す）

## データの形
```ts
// src/core/types.ts の変更。BFS は loopStart: null を書く
// loopStart は steps の 0 始まりの位置。Back to state N は N-1、Stuttering は最後のステップ
type Counterexample = { path: NonEmpty<StateName>; steps: NonEmpty<Step>; loopStart: number | null };
// ASCII 識別子から表示名へ。TLC の出力はこの識別子で出る
type TlaNames = { states: Record<string, StateName>; vars: Record<string, VarName>;
  events: Record<string, EventName | null>; members: Record<string, MemberName>;
  checks: Record<string, PropertyId | "TypeOK"> };
type TlaModel = { tla: string; cfg: (checks: readonly string[]) => string; names: TlaNames;
  invariants: readonly string[]; temporal: readonly string[]; // invariants の最後は "TypeOK"
  rejected: readonly { id: PropertyId; reason: string }[] };
declare function generateTla(graph: Pick<Graph, "nodes" | "edges" | "model">, file: PropertiesFile):
  { ok: true; model: TlaModel } | { ok: false; reason: string }; // 入口が無いときなど
type TlcRun = { kind: "missing"; what: "java" | "jar"; jar: string }
  | { kind: "exited"; output: string } | { kind: "timeout"; output: string };
type TlcReport = { kind: "ok"; distinctStates: number }
  | { kind: "violated"; check: string | null; trace: Counterexample; distinctStates: number | null }
  | { kind: "error"; message: string; distinctStates: number | null }; // check null は時相性質
declare function parseTlcOutput(output: string, names: TlaNames): TlcReport;
type ResultFile = { version: 1; checkedAt: string; names: TlaNames; // run.ts の外には出さない
  properties: PropertyResult[]; typeOk: Counterexample | null; error: string | null };
// CLI が受け取る結末。graph は合流済みで、graph.json に書いたもの
type TlcCheck = { kind: "missing"; what: "java" | "jar"; jar: string; graph: Graph }
  | { kind: "checked"; graph: Graph; typeOk: Counterexample | null; error: string | null };
declare function analyze(root: string, options?: ScanOptions): Promise<{ graph: Graph;
  properties: PropertiesFile; history: HistoryEntry | null }>; // scan.ts。書かない。scan = analyze + 書き込み
declare function checkTlc(root: string, options: { timeoutMs: number }): Promise<TlcCheck>; // run.ts
declare function exportTla(root: string): Promise<{ ok: true; directory: string;
  rejected: TlaModel["rejected"] } | { ok: false; reason: string }>;
declare function installTla(source: { url: string; sha256: string } | null): // null は固定の v1.7.4
  Promise<{ ok: true; path: string } | { ok: false; reason: string }>;
```
表し方: 出力 1 回分を `TlcReport`、プロセスの結末を `TlcRun`、CLI への結末を `TlcCheck` の判別可能なユニオンにする。理由: 合流と CLI が `kind` の網羅で全結末を扱える。設計は architect の 2 案（最小変更、構造の作り直し）から合成した。最小変更案を土台に、`tla install` の環境変数と「可否の判定を生成より先に行う」を接ぎ木した。CLI は `run.ts` の 3 関数と `TlcCheck` だけを読み、入口は `entryOf`、`violations` は `violationsOf` を BFS と共有する。

決めたこと。`SPEC.md` §17.2 は推奨どおり連番 + コメントの表示名にする（非 ASCII の文字列を TLC に渡さない）。§17.3 はイベントを環境が非決定的に選ぶものとして、元の状態とガードが真なら常に発火できるとする。TLC は `java -XX:+UseParallelGC -jar <jar> -workers auto -deadlock -config Model.cfg -metadir <一時> Model.tla` で `.everypath/tla/` を作業ディレクトリにして動かす（`-deadlock` は出口の無い状態を誤りにしないため）。jar は `$EVERYPATH_TLA_JAR`、無ければ `~/.everypath/tla2tools.jar`。`set:` が型の範囲を外す遷移は止めず、`TypeOK` の違反として報告する（`retries=retries+1` の上限越えはバグなので隠さない）。cfg では利用者の不変条件を `TypeOK` より先に並べる。

Prototype で確かめたこと（手書きの example モデルを TLC 2.19 で実行）。終了コードは成功 0、不変条件の違反 12、時相性質の違反 13、パースエラー 150。不変条件の違反は `Error: Invariant <名前> is violated.` で名前が出るが、時相性質の違反は `Error: Temporal properties were violated.` だけで名前が出ない。各ステップは `State N: <アクション …>` と `/\ 変数 = 値` の行。ループは `Back to state N: <…>`、止まり続ける反例は `State N: Stuttering`。状態数は `… distinct states found` の行で、途中経過の `Progress(…)` 行にも出る。コメントの日本語はそのまま読める。`-metadir` の外にファイルを書かない。

実装中に決めたこと。`installTla` は取得元を引数で受け、`EVERYPATH_TLA_URL` と `EVERYPATH_TLA_SHA256` の読み取りと片方だけのときの exit 2 は CLI の境界で行う。`exportTla` も `rejected` を返し、CLI が警告として出す。`java -version` が exit 0 以外なら Java が無いと扱う（macOS の JDK 無しのスタブのため）。初期状態が性質を破るときの TLC は状態数を出さないので、その結果の `statesExplored` は `null`。`SPEC.md` §19 の 8 は、`retries` の宣言だけを `0..10` に変えても `lock-after-3` は成立する（ガード `retries<3` が上限を抑えるため。実機で確認）。違反を出すにはガードも `retries<10` と `retries==10` に変える。

## 非目標
- サーバーとビューア（`/check/tlc`、ステップ再生）、`never-reach` の TLC 検査、`dep-only-via`
- `everypath.config.json` の `tla.jar`。環境変数と既定の場所だけを読む
- `scan` での `result.json` の再利用。次の `scan` は TLC の結果を `pending` に戻す

## 検証方法
`test/tla.test.ts`（生成、パース、偽の `java` での実行と合流）、`test/fixtures/tlc-output-*.txt`、`test/cli.test.ts`、`test/requirements.test.ts` を実装より先に作る。完了条件 10 は手で実行する。
