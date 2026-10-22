# スキャナ

## 目的
`everypath scan` が対象リポジトリの `@state-*` アノテーションと import を読み、`.everypath/graph.json` に状態・遷移・依存・変数・検査状態を書く。利用者は 1 コマンドで図の元データを得る。後続の簡易検査、TLA+ 生成、サーバーは文字列を読み直さず、この JSON の AST だけを読む。保守する人は `SPEC.md` §8 の手順を `src/core/scan.ts` から順に追える。
満たす: R-01、R-04（スキャンの部分。式の部分は `docs/specs/core-model.md`）

## 完了条件
- [x] 1. `npm run typecheck`、`npm run lint`、`npm test` がすべて exit 0（実行して確認）
- [x] 2. R-01。fixture リポジトリに `everypath scan` を実行すると、`.everypath/` 以外の全ファイルのパス集合と sha1 が前後で一致し、`.everypath/graph.json` と `.everypath/history.jsonl` ができる（`test/requirements.test.ts`）
- [x] 3. R-04。文法外のアノテーション 10 件（`if:` 6、`set:` 2、`@state-var` 2）を含む fixture で `scan` が exit 0 になる。`warnings[]` に `file` と `line` 付きで 10 件が載る。`if:` が文法外の遷移は `guard: null`、`set:` が文法外の遷移は `set: []` で残り、文法外の `@state-var` は `model.vars` に入らない（`test/requirements.test.ts`）
- [x] 4. 走査。`node_modules` など §8.1 の 13 ディレクトリ、`config.ignore` の glob、対象外の拡張子、シンボリックリンクを読まない（`test/scan.test.ts`）
- [x] 5. ノード id。`@state` があればその名前、無ければ拡張子を除くファイル名、`index`・`__init__`・`main` はディレクトリ名になる。識別子でないファイル名は置換する（`login-form.ts` は `login_form`、`2fa.ts` は `_2fa`、`state.ts` は `state_`）。`@state` の無いファイルが別ディレクトリで同じ id になったら、それらだけパス由来の id（`src/a/utils.ts` は `src_a_utils`）にする。識別子でない `@state` は警告してファイル名由来の id に戻す（`test/scan.test.ts`）
- [x] 6. 抽出。タグは先頭 60 行だけから拾い、61 行目以降は無視する。`//`、`#`、`/* */`、`"""` のどれでも拾う。`@state:` と `@state：` もノード名タグになる。未知の `@state-xxx` は警告になる。`SPEC.md` §5.2 の例は flow 5 本になり、`on:`・`if:`・`set:` がそれぞれ `event`・`guard`・`set` の AST になる（`test/scan.test.ts`）
- [x] 7. テスト検出。§8.2 の正規表現に合うファイルはノードにならず、その import 先のファイルがテスト済みになる。ノードの `tested` は全ファイルがテスト済みのときだけ true。`@state-tested` はそのファイルをテスト済みにする。`includeTests: true` ならテストファイルもノードになる（`test/scan.test.ts`）
- [x] 8. import 解決。JS/TS は `import … from`、`export … from`、`import 'x'`、`require`、`import()` を、相対パスと `config.aliases` だけ解決する。拡張子補完、`index.*`、`.js` から `.ts` への読み替えを行い、外部パッケージは無視する。Python は `from a.b import`、`import a.b`、`from .m import` を、ファイルのディレクトリ、ルート、`src/`、`app/` の順に `a/b.py` と `a/b/__init__.py` で探す（`test/scan.test.ts`）
- [x] 9. エッジ。ファイル間 import をノード間の dep に集約し、自己ループを除く。flow は自己ループを許す。from・to・宣言文が同じ flow は 1 本にまとめ、`via` を合わせる。存在しない遷移先は `status.planned: true` のノードになる（`test/scan.test.ts`）
- [x] 10. モデル。全ファイルの `@state-var` を `model.vars` に集める。同じ宣言の重複は 1 つにまとめ、食い違えば警告して先のファイルを採る。未宣言の変数や型の合わない値を使う `if:`・`set:` は警告して、ガード無し・代入無しにする。`model.events` は `on:` と `@state-event` の和集合、`model.initial` は `@state-initial` のノードで、2 つ以上なら警告して先のファイルを採る（`test/scan.test.ts`）
- [x] 11. `hash` は、ノードのファイル内容を相対パス順に連結した sha1 になる（`test/scan.test.ts` で `node:crypto` から期待値を計算）
- [x] 12. findings と risks。semgrep 形式と bandit 形式を共通形にしてファイルのノードに付け（semgrep の `ERROR`・`WARNING`・`INFO` は `high`・`medium`・`low`、パス先頭の `./` と絶対パスはルート相対に直す）、`status.vuln` を true にする。探す順は `config.findings`、`everypath.findings.json`、`.everypath/findings.json`、`semgrep.json`、`bandit.json`。`@state-risk` は `risks[]` になる（`test/scan.test.ts`）
- [x] 13. `review.json` の hash が一致すれば `reviewed: true`、不一致なら `changedSinceReview: true` になる（`test/scan.test.ts`）
- [x] 14. 2 回目のスキャンで hash が同じノードは前回の `lastChangedAt` を引き継ぎ、変わったノードは今の時刻になる。`history.jsonl` には差分のあるスキャンだけが 1 行追記される。`reason` の既定値は `scan`（`test/scan.test.ts`）
- [x] 15. CLI。`everypath scan [dir] [--json] [--quiet]` は警告があっても exit 0 で、`--json` の標準出力は graph.json と同じ JSON になる。`--quiet` は要約と警告を出さない（`--json` の JSON は出す）。`dir` の既定はカレントディレクトリ。存在しないディレクトリと未知のコマンドは exit 2（`test/cli.test.ts`）
- [x] 16. 小さな fixture リポジトリで `npx tsx src/cli.ts scan` を実行し、出力の `graph.json` を読んで中身を確かめる（手で実行し、返答に要点を貼る）

## データの形
型は `src/core/types.ts` に足す。`SPEC.md` §6.1 との違いは 3 点。`guard`・`set`・`model.vars` は文字列ではなく `docs/specs/core-model.md` の AST を持つ。`label` は id と同じなので持たない。`properties`・`drift`・`observed` は §9 とフェーズ 2 の仕様で足す。
```ts
type EventName = Brand<string, "EventName">; // parseEventName だけが作る。識別子規則は状態名と同じ
type ScanWarning = { file: string | null; line: number | null; message: string; detail: ParseWarning | null };
type NodeStatus = { tested: boolean; vuln: boolean; wip: boolean; planned: boolean; requireProof: boolean;
  proof: "none" | "pending" | "passed" | "failed"; reviewed: boolean; changedSinceReview: boolean };
type Finding = { file: string; line: number | null; severity: "high" | "medium" | "low"; rule: string; message: string };
type StateNode = { id: StateName; group: string | null; desc: string | null; files: string[]; lines: number;
  hash: string; status: NodeStatus; spec: string[]; risks: { file: string; message: string }[];
  findings: Finding[]; violations: string[]; lastChangedAt: string };
type FlowEdge = { type: "flow"; from: StateName; to: StateName; event: EventName | null;
  guard: GuardExpr | null; set: Assignment[]; text: string; via: string[] }; // text は @state-next の後ろ全体
type DepEdge = { type: "dep"; from: StateName; to: StateName; via: string[] };
type Graph = { version: 1; generatedAt: string; root: string; findingsSource: string | null;
  stats: { nodes: number; edges: number; tested: number; untested: number; vuln: number; wip: number;
    planned: number; unreviewed: number };
  nodes: StateNode[]; edges: (FlowEdge | DepEdge)[];
  model: { initial: StateName | null; vars: ModelVar[]; events: EventName[] }; warnings: ScanWarning[] };
type HistoryEntry = { at: string; reason: string; added: StateName[]; removed: StateName[]; updated: StateName[];
  addedEdges: EdgeRef[]; removedEdges: EdgeRef[] }; // EdgeRef = { type, from, to, event }
declare function scan(root: string, options?: { now?: Date; reason?: string }): Promise<Graph>;
```
表し方: ファイルごとの抽出結果（`FileFacts`）を作る段と、それをノード・エッジ・モデルに畳む純粋な段の 2 段のパイプライン。理由: §8 の手順がそのまま関数の並びになり、読み書きは `scan()` の入口と出口に集まる。

パスはルートからの相対で `/` 区切り。`nodes` は id 順、`edges` は type・from・to・event・text 順、`warnings` は file・line 順、`model.vars` は最初に宣言したファイルと行の順、`model.events` は名前順に並べ、同じ入力から同じ JSON を出す（`generatedAt` と `lastChangedAt` を除く）。`model.initial` は `@state-initial` だけから決める。`properties.entry` と「入エッジの無い状態」への後退は、§9 と TLA+ 生成が読む側で行う。`@state-hidden` のファイルは何も出さない。`lines` は末尾の改行を数えない行数の和。ファイル名の置換は、識別子に使えない文字を `_` に、数字で始まれば先頭に `_` を、予約語なら末尾に `_` を付ける（`SPEC.md` §17.4 もこの規則で決める）。

実装中に決めたこと。`stats` の `tested`・`untested`・`unreviewed` は planned を数えない。警告は注釈 1 行に 1 件で、`on:`・`if:`・`set:` は節ごとに独立して捨てる（`if:` が壊れていても `set:` は残る）。findings は最初に見つかったファイルだけを使い、壊れていれば警告して次の候補へは進まない。`config.ignore` の glob はルート基準で、`/` を含まないパターンはルート直下だけに当たる（深い階層は `**/*.gen.ts` と書く）。テストファイルと `@state-hidden` のファイルは、ノード・エッジ・変数・イベントを出さないが、注釈の文法警告は出す。

## 非目標
- §9 の簡易検査と `properties`・`violations` の計算。`violations` は常に `[]` を書く
- §8.5 の観測遷移と、Ruby・Go・Rust・Java・Kotlin の import 解決（ファイルはノードになる）。観測遷移は `docs/specs/drift.md`、Go・Rust・Java・Kotlin は `docs/specs/imports-more.md` で後から足した
- `everypath.properties.json` の読み込みと、`serve` からの再スキャン

## 検証方法
`test/scan.test.ts`、`test/requirements.test.ts`、`test/cli.test.ts` を実装より先に作る。fixture はテスト内で一時ディレクトリに書く。
