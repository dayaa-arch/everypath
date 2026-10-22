# everypath 仕様書（引き継ぎ用）

最終更新: 2026-10-21
状態: 設計確定・実装前（叩き台コードあり、後述）
上位仕様: `docs/REQUIREMENTS.md`（目的・不変条件・非目標・用語・決定記録）。本文書と食い違えば `docs/REQUIREMENTS.md` を優先し、本文書を直す。

---

## 0. この文書の使い方

この文書は、Claude Code で everypath を実装するための引き継ぎ書である。
「有能だが経緯を知らない開発者がこれだけ読んで着手できる」ことを目標に書いている。
判断を委ねている箇所は末尾「17. 未決事項」にまとめてあり、それ以外は決定事項として扱ってよい。

- **名前**: everypath。リポジトリ名・npm パッケージ名・CLI コマンド名・Claude Code スキル名をすべてこれに揃える。設定ファイルは `everypath.*.json`、作業ディレクトリは `.everypath/`。ソースに書くアノテーションだけはツール名から切り離して `@state-*` とする（§5）。
- **言語**: TypeScript（§4.2）。

### 0.1 原案図

構想の出発点になった手描きの画面遷移図（draw.io、画像は `docs/original-sketch.png`）。方眼の上に白地・黒枠の角丸矩形、黒の直交矢印。ビューアの見た目（§12.3）とサンプル（§16）の基準にする。

```
            ┌────────┐      ┌────────┐
     ┌────▶ │ ログイン │ ───▶ │ 新規登録 │
     │      └────────┘      └────────┘
     │           │
     │           └──────────┐
┌─────────┐                 ▼
│ ログアウト │（黄色の付箋）  ┌──────┐
└─────────┘               │ Home │
     ▲                    └──────┘
     │                        │
     │      ┌──────────┐      │
     └───── │ マイページ │ ◀────┘
            └──────────┘
```

---

## 1. 思想・目的・背景

### 1.0 思想（この一文がすべての判断基準）

> エージェントに自分のアプリの動きを**状態遷移図（ステートチャート）**に描かせて、それを **TLA+** という形式検証ツールで**全パターン調べる**と、テストでは見つからないバグが見つかるし、自分のコードの理解も深まる。

したがって everypath の中心は次の 3 つの結合である。

1. **エージェントがモデルを描く。** コードを書く AI 自身に、状態（画面・モード）と遷移（イベント・ガード）を宣言させる。人間が書くのではない。
2. **TLA+ で全探索する。** 宣言されたステートチャートから TLA+ 仕様を生成し、TLC で全状態を網羅的に検査する。テストは「試した入力」しか見ないが、モデル検査は「ありうる経路すべて」を見る。
3. **結果を図に戻す。** 反例（性質を破る経路）は、図の上の赤い経路として人間に返す。人間は TLA+ を読めなくてよい。図と反例を見て、エージェントに修正を指示する。

「理解も深まる」の部分は副産物ではなく目的である。図は常にコードから生成され、人間が自分のアプリの振る舞いを俯瞰する唯一の場所になる。

### 1.1 背景

AI がコードを書く時代になり、人間のレビューが生成速度に追いつかなくなった。
everypath は、開発中のシステムの振る舞いを**ステートチャートとしてリアルタイムに図解**し、その上に**検証・レビュー状態**（性質違反、脆弱性あり、未テスト、未レビュー、承認済み、検証済み）を色で重ねることで、人間が「今どこを見るべきか」を一目で把握できるようにするツールである。

本質は「図を描くツール」ではなく「**AI が書いたものを人間が検証・レビューするための地図**」である。図は画面であり、価値は状態のオーバーレイと反例にある。

### 1.2 解決したい具体的な問題

- 「ログイン失敗 → パスワードリセット → Home」のような、テストケースに書かれていない経路のバグを誰も踏んでいない
- AI が機能を追加するたびに、どこが増えてどこに依存が生えたかを人間が追えない
- どの機能がテストされていないか、スキャナが何を指摘しているかが散らばっている
- 一度確認した機能が AI に再変更されても気づけない
- AI への修正指示を書くとき、文脈（ファイル、指摘、期待する仕様）を集めるのが面倒

### 1.3 やらないこと（境界）

- **everypath はコードを書かない・変更しない。** 読み取り専用のビューアである。
  修正・承認後の対応は従来どおり Claude Code / Codex などのエージェントに人間が指示する。
- 特定のエージェント製品に依存しない。Claude Code 向けの連携は提供するが、データ（JSON）は中立に保つ。
- 本格的な IDE やダイアグラムエディタにはしない。手動でノードを置き直す機能は初期スコープ外。

---

## 2. 用語

| 用語 | 意味 |
|---|---|
| ノード（状態） | 図上の箱。ステートチャートの状態。人間の粒度の「画面・モード・機能」（例: ログイン、マイページ、DB 層）。1 ノード = 1 つ以上のソースファイル |
| 遷移エッジ (flow) | `@state-next` で宣言された状態遷移。**イベント**（何が起きたら）と**ガード**（どんな条件なら）を持てる。実線矢印 |
| 依存エッジ (dep) | import / require から抽出された依存。細い点線。モデル検査の対象外（構造の把握用） |
| 変数 | ステートチャートが持つ状態変数（例: `authed`, `cart_count`）。`@state-var` で宣言し、遷移の `set:` で更新、`if:` で参照する |
| 性質 (property) | モデルに対して成り立つべき条件。不変条件（常に〜）と時相的性質（いつか〜、〜の後は必ず〜）。例: 未認証で Home に到達しない |
| 反例 | 性質を破る具体的な経路（状態の列 + 各ステップの変数値） |
| 簡易検査 | everypath 内蔵の BFS によるグラフ到達性検査。速いが変数を扱わない |
| モデル検査 | 生成した TLA+ を TLC で全探索する検査。変数・ガード・時相的性質を扱う。遅い |
| 承認 | 人間がノードの仕様・状態を確認したという記録。ファイルハッシュと紐づく |
| findings | semgrep / bandit などの外部スキャナの出力 |

---

## 3. 設計原則

1. **見るだけ、書かない。** 対象リポジトリのソースを変更しない。everypath が書くのは `.everypath/` 配下のみ。
2. **真実は一つ、出口は二つ。** 状態の真実は `.everypath/graph.json`（と `review.json`）。ビューアは人間向けに描画し、エージェント用スキルは同じ JSON を読む。
3. **AI にモデルを描かせる。** 状態・遷移・イベント・ガード・変数はアノテーション（`@state-*`）でコードと同じ場所に書かせる。人間に書かせるのは無理でも、AI にはスキルで強制できる。モデルがコードの隣にあるので、コードが変われば図も変わる。
4. **全探索を日常にする。** 簡易検査（BFS）は保存のたびに、TLA+ によるモデル検査は手動または CI で走らせ、どちらの結果も同じ図に戻す。人間は TLA+ を読まなくてよい。
5. **レイアウトは安定させる。** ノードが増えるたびに全体が組み替わると人間の空間記憶が壊れる。既存ノードの座標は極力固定し、新ノードだけ空き地に置く。
6. **仕様をレビュー対象にする。** 人間が読むのは数行の仕様（性質、事前・事後条件）であって、コードや証明ではない。承認ボタンは仕様に対して押す。
7. **実行時の依存はゼロ、型は厳格に。** TypeScript（strict）で書き、公開物はコンパイル済み JS。`dependencies` は空に保ち、TypeScript・esbuild などは `devDependencies` のみ。ブラウザ側も dagre を含めてビルド時に `ui.html` へ同梱し、CDN にも依存しない（オフラインで動くこと）。TLC（`tla2tools.jar`）は任意の外部ツールとして扱い、無くても簡易検査は動く。理由: `npx everypath` を叩いた瞬間に動くこと、そしてコードの多くを AI が書くので型検査をガードレールにすること。

---

## 4. 全体アーキテクチャ

```
対象リポジトリ
 ├ src/**            ← AI が @state-* アノテーション付きで書く
 ├ everypath.config.json     （任意）
 ├ everypath.properties.json （任意・性質定義。人間が承認する）
 ├ everypath.findings.json   （任意・semgrep/bandit 出力）
 └ .everypath/
     ├ graph.json     ← scanner が毎回上書き（真実）
     ├ review.json    ← ビューアの承認操作で更新（人間の記録）
     ├ layout.json    ← ノード座標のキャッシュ（安定レイアウト用）
     ├ history.jsonl  ← 差分ログ（追記）
     └ tla/
         ├ Model.tla    ← ステートチャートから生成した TLA+ 仕様
         ├ Model.cfg    ← TLC 設定（INIT/NEXT/INVARIANT/PROPERTY）
         └ result.json  ← TLC の結果を正規化したもの（反例トレース含む）

[scanner] ─(保存のたび)→ graph.json ─┬→ [簡易検査 BFS] ─→ graph.json.properties
                                    ├→ [tla export] → Model.tla ─(手動/CI)→ [TLC] → result.json ─┐
                                    │                                                            │ 反例を graph.json に合流
                                    ├→ [server/SSE] → [viewer HTML]（人間向け: 図 + 反例 + 承認）  ←┘
                                    └→ [Claude Code skill / 他エージェント]（機械向け）
```

### 4.1 コンポーネント

| コンポーネント | 役割 | 実装 |
|---|---|---|
| `src/core/types.ts` | `Graph`, `StateNode`, `Edge`, `ModelVar`, `Property`, `Counterexample`, `Review` など全データ型。**サーバー・CLI・ビューアの唯一の型定義** | TS のみ |
| `src/core/expr.ts` | ガード・代入・性質式（§5.1）の字句解析・構文解析。判別共用体の AST を返す | TS のみ |
| `src/core/scan.ts` | ソース走査、アノテーション解析、import 解決、テスト検出、findings 取り込み、乖離チェック、graph.json 生成 | Node 標準のみ |
| `src/core/properties.ts` | properties を読み、遷移グラフに対して簡易検査（BFS）を行い、反例を graph.json に書き込む | Node 標準のみ |
| `src/core/tla/generate.ts` | ステートチャート + 性質（AST）から `Model.tla` / `Model.cfg` を生成 | TS のみ |
| `src/core/tla/run.ts` | TLC の子プロセス実行、タイムアウト、進捗通知 | Node 標準 + 外部 `java -jar tla2tools.jar` |
| `src/core/tla/parse.ts` | TLC 出力のパース（成否・反例トレース・状態数）→ `result.json` | TS のみ |
| `src/server/server.ts` | ファイル監視 → 再スキャン → SSE 配信。review / layout / TLC の API | `node:http`, `node:fs` |
| `src/ui/main.ts` ほか | ビューア。esbuild で 1 本にバンドルし、`src/ui/index.html` のテンプレートに埋め込んで `dist/ui.html` を生成 | dagre（バンドル同梱） |
| `src/cli.ts` | CLI エントリ。`dist/cli.js` が `bin` | Node 標準のみ（`node:util` の `parseArgs`） |
| `skill/SKILL.md` | Claude Code 用スキル（アノテーション規約の強制、graph.json の読み方） | Markdown |
| `templates/` | 指示生成テンプレート（§13）、`init` で配る雛形 | Markdown / JSON |

### 4.2 技術スタックとビルド

| 項目 | 決定 | 理由 |
|---|---|---|
| 言語 | TypeScript（`strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`） | graph.json のスキーマを四か所（scanner / server / UI / skill）で共有するため。式パーサと TLA+ 生成は判別共用体の網羅検査が効く |
| モジュール | ESM のみ（`"type": "module"`, `module: "NodeNext"`）。CommonJS 版は出さない | 依存ゼロの CLI なので二重配布の必要がない |
| 実行環境 | Node.js 22 以上（`engines` に明記） | `fs.watch` の `recursive`（Linux 含む）と `node:test` が揃う |
| サーバー側ビルド | `tsc -p tsconfig.json` → `dist/`（`.js` + `.d.ts` + source map） | 公開物はコンパイル済み JS。Node の型剥がし実行は `node_modules` 配下のファイルに効かないため、`.ts` のまま公開しない |
| ビューア側ビルド | `esbuild src/ui/main.ts --bundle --minify --format=iife` の出力を `index.html` の `<script>` に埋め込み `dist/ui.html` を作る小さなビルドスクリプト（`scripts/build-ui.ts`） | 単一 HTML・CDN 不要・オフライン動作 |
| 型の共有 | `src/ui/` は `src/core/types.ts` を `import type` のみで参照（実行時コードは共有しない） | ブラウザ用バンドルに Node API が紛れ込まないように |
| 開発時実行 | `tsx`（devDependency）で `tsx src/cli.ts serve example` | ビルド無しで試せる |
| テスト | `node:test` + `node:assert`。`tsx --test test/**/*.test.ts` | テストランナーも依存を増やさない |
| Lint / 整形 | Biome（devDependency 1 つで lint と format） | ESLint + Prettier より設定が少ない |
| devDependencies | `typescript`, `@types/node`, `esbuild`, `tsx`, `@biomejs/biome`, `@dagrejs/dagre` | `dependencies` は空 |
| 公開 | `package.json` の `files` は `dist/`, `skill/`, `templates/`, `README.md` のみ | |

npm スクリプト:

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json && tsx scripts/build-ui.ts",
    "dev": "tsx watch src/cli.ts serve example",
    "test": "tsx --test 'test/**/*.test.ts'",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "biome check .",
    "prepublishOnly": "npm run typecheck && npm run test && npm run build"
  }
}
```

### 4.3 リポジトリ構成

```
everypath/
├ package.json / tsconfig.json / biome.json
├ src/
│  ├ cli.ts
│  ├ core/
│  │  ├ types.ts
│  │  ├ expr.ts
│  │  ├ scan.ts
│  │  ├ properties.ts
│  │  ├ review.ts        （review.json / layout.json の読み書き）
│  │  └ tla/ generate.ts, run.ts, parse.ts
│  ├ server/ server.ts, sse.ts, watch.ts
│  └ ui/ index.html, main.ts, layout.ts, render.ts, panel.ts, prompt.ts（指示生成）
├ scripts/ build-ui.ts
├ skill/ SKILL.md
├ templates/ prompts/*.md, init/everypath.config.json, init/everypath.properties.json, init/settings.example.json
├ test/
│  ├ fixtures/ tlc-output-violation.txt, tlc-output-ok.txt, tlc-output-liveness.txt
│  └ *.test.ts
├ example/               （§16 のサンプルアプリ。それ自体も TS）
└ SPEC.md                （本文書）
```

---

## 5. アノテーション規約

ソースファイルの**先頭 60 行以内**のコメントに書く。言語を問わず文字列マッチで拾う（`//`, `#`, `/* */`, `"""` のいずれでもよい）。

| タグ | 意味 | 複数可 | 例 |
|---|---|---|---|
| `@state <名前>` | このファイルが属する機能ノード名。未指定ならファイル名（拡張子除く）がノード名。`index`/`__init__`/`main` はディレクトリ名 | 不可 | `@state ログイン` |
| `@state-next <状態> [on:<イベント>] [if:<ガード>] [set:<代入>]` | この状態から遷移できる先。`on:` は何が起きたら、`if:` は変数に対する条件、`set:` は遷移時の変数更新。実装前に宣言してよく、未実装なら「計画のみ」ノードが生える。1 行 1 遷移 | 可 | `@state-next Home on:login_ok set:authed=TRUE`<br>`@state-next マイページ if:authed`<br>`@state-next 新規登録`（イベント無し = 任意に遷移可） |
| `@state-var <名前>: <型> = <初期値>` | ステートチャートの変数。型は `BOOLEAN`, `0..N`, `{a,b,c}`（有限集合のみ。TLC で全探索するため） | 可 | `@state-var authed: BOOLEAN = FALSE`<br>`@state-var retries: 0..3 = 0` |
| `@state-initial` | 初期状態。無ければ `properties.entry` の先頭、それも無ければ入エッジの無い状態。印はその状態のいる階層の入口を指す: `@state-parent` のある状態に書けば、親に入ったときの子 | 不可 | |
| `@state-parent <状態>` | この状態を中に持つ親（階層状態。`docs/specs/hierarchy.md`）。親に書いた `@state-next` は中のすべての状態から出る遷移になり、中の状態が同じ名前のイベントで遷移を持てば内側が勝つ。親への遷移は印の付いた子（子が 1 つならその子、印が無ければすべての子と警告）に入る。性質の中の親の名前は中のすべての状態を指す。TLA+ と簡易検査は葉だけの平らなモデルを読む。輪、深すぎる入れ子（親 3 段まで）、名乗るファイルの無い親は警告にしてスキャンを続ける | 不可 | `@state-parent 認証済み` |
| `@state-event <名前>[, <名前>...]` | この状態で発生しうるイベントの宣言（省略可。`on:` で使ったものは自動登録） | 可 | `@state-event login_ok, login_fail` |
| `@state-group <名前>` | 表示上のグルーピング（画面 / API / データ層 など） | 不可 | `@state-group 画面` |
| `@state-desc <文>` | 1 行の説明。詳細パネルに表示 | 可（連結） | `@state-desc メール+パスワードで認証` |
| `@state-status wip\|draft` | 作業中。黄系の「WIP」表示 | 不可 | `@state-status wip` |
| `@state-risk <文>` | AI の自己申告リスク。スキャナ由来とは別マークで表示（信頼度が違うため） | 可 | `@state-risk トークン有効期限を未検証` |
| `@state-spec <文>` | 事前・事後条件や不変条件の 1 行。詳細パネルの「仕様」欄に表示。複数行はタグを繰り返す | 可 | `@state-spec requires token.valid && !token.expired` |
| `@state-require proof` | このノードは証明必須。証明が無い限り「完了」扱いにしない（スキルが参照） | 不可 | |
| `@state-tested` | テストの自動検出が効かない場合に手動でテスト済みを宣言 | 不可 | |
| `@state-hidden` | ノードとして表示しない（設定ファイル、型定義など） | 不可 | |

`@state` を省略してもノードはできるが、スキルは AI に `@state` と `@state-next` を必ず書かせる。

- 接頭辞をツール名（everypath）から切り離して `@state` にしているのは、ツール名が変わってもユーザーのコードを書き換えずに済むようにするため、そしてステートチャートを描くという思想を名前に出すため。
- パーサは `@state` の直後が空白・`:`・`：` のときだけノード名タグとみなす（`@state-next` 等と取り違えないため）。

### 5.1 ガードと代入の文法（TLA+ に落とせる範囲に限定）

```
guard  := expr
expr   := term (("&&" | "||") term)*
term   := ["!"] atom
atom   := VAR | VAR ("==" | "!=" | "<" | "<=" | ">" | ">=") VALUE | "(" expr ")"
set    := VAR "=" VALUE ("," VAR "=" VALUE)*       ; VALUE は TRUE/FALSE/整数/集合要素名、または VAR+1 / VAR-1
```

これ以上の式（文字列操作、関数呼び出し）は受け付けず、警告にしてその遷移を「ガード無し」として扱う。理由: モデルは有限で全探索できる範囲に閉じる必要があるため。

### 5.2 宣言の例（ログイン画面）

```ts
// @state ログイン
// @state-group 画面
// @state-initial
// @state-var authed: BOOLEAN = FALSE
// @state-var retries: 0..3 = 0
// @state-next Home on:login_ok set:authed=TRUE, retries=0
// @state-next ログイン on:login_fail if:retries<3 set:retries=retries+1
// @state-next ロック on:login_fail if:retries==3
// @state-next 新規登録
// @state-next パスワードリセット
// @state-spec ensures authed => session != none
```

エージェントが書くのはこれだけである。ここから §9 の簡易検査と §10 の TLA+ 生成が自動で行われる。

---

## 6. データモデル

### 6.1 `.everypath/graph.json`

`guard`・`set`・`model.vars` の実際の形と、まだ書かないフィールドは `docs/specs/scan.md` の「データの形」が優先する。

```jsonc
{
  "version": 1,
  "generatedAt": "2026-10-21T05:02:11.000Z",
  "root": "/abs/path/to/repo",
  "findingsSource": "everypath.findings.json",   // null なら未使用
  "stats": { "nodes": 7, "edges": 9, "tested": 3, "untested": 2, "vuln": 1, "wip": 0, "planned": 1, "unreviewed": 2, "proven": 2, "violations": 1 },
  "nodes": [
    {
      "id": "パスワードリセット",
      "label": "パスワードリセット",
      // "parent": "認証済み", "initialChild": "Home", "container": true は値があるときだけ書く（@state-parent）
      "group": "画面",
      "desc": "...",
      "files": ["src/auth/reset.ts"],
      "lines": 120,
      "hash": "sha1 of concatenated file contents",   // 承認との照合に使う
      "status": {
        "tested": false,
        "vuln": true,
        "wip": false,
        "planned": false,
        "requireProof": true,
        "proof": "none" | "pending" | "passed" | "failed",
        "reviewed": false,          // review.json の hash と一致すれば true
        "changedSinceReview": true  // review.json にあるが hash が違う
      },
      "spec": ["requires token.valid && !token.expired", "ensures session == none"],
      "risks": [{ "file": "src/auth/reset.ts", "message": "..." }],
      "findings": [{ "file": "...", "line": 42, "severity": "high", "rule": "...", "message": "..." }],
      "violations": ["no-unauth-home"],   // 違反した性質 id
      "lastChangedAt": "2026-10-21T05:00:00.000Z"
    }
  ],
  "model": {
    "initial": "ログイン",
    "vars": [{ "name": "authed", "type": "BOOLEAN", "init": "FALSE" }, { "name": "retries", "type": "0..3", "init": "0" }],
    "events": ["login_ok", "login_fail", "logout"]
  },
  "edges": [
    { "from": "ログイン", "to": "Home", "type": "flow", "event": "login_ok", "guard": null, "set": { "authed": "TRUE", "retries": "0" },
      "via": ["src/auth/login.ts"], "declared": true, "observed": true },
    { "from": "ログイン", "to": "ログイン", "type": "flow", "event": "login_fail", "guard": "retries<3", "set": { "retries": "retries+1" }, "via": ["src/auth/login.ts"], "declared": true, "observed": false },
    { "from": "Home", "to": "DB層", "type": "dep", "via": ["src/home.ts"] }
  ],
  "properties": [
    {
      "id": "no-unauth-home",
      "kind": "invariant",
      "description": "未認証で Home に到達しない",
      "checkedBy": "tlc" | "bfs" | "both",
      "result": "violated" | "ok" | "error" | "pending",
      "counterexamples": [
        { "path": ["ログイン", "パスワードリセット", "Home"],
          "steps": [
            { "state": "ログイン", "event": null, "vars": { "authed": "FALSE", "retries": "0" } },
            { "state": "パスワードリセット", "event": "forgot", "vars": { "authed": "FALSE", "retries": "0" } },
            { "state": "Home", "event": "reset_done", "vars": { "authed": "FALSE", "retries": "0" } }
          ] }
      ],
      "statesExplored": 48, "checkedAt": "…"
    }
  ],
  "drift": [   // 宣言と実コードの乖離
    { "from": "マイページ", "to": "DB層", "kind": "observed-not-declared", "via": ["src/mypage.ts"] }
  ]
}
```

### 6.2 `.everypath/review.json`（人間の記録。everypath のビューアだけが書く）

```json
{
  "version": 1,
  "approvals": {
    "ログイン": { "hash": "…", "at": "2026-10-21T04:50:00Z", "by": "taiga", "note": "仕様確認済み" }
  }
}
```

- `reviewed = approvals[id] が存在 && approvals[id].hash == node.hash`
- `changedSinceReview = approvals[id] が存在 && hash が不一致`
- `by` は `git config user.name` → 環境変数 `USER` → 空、の順で埋める。チーム利用時に「誰が見たか」が要るため残す。

### 6.3 `everypath.properties.json`（性質定義。AI が提案してよいが、人間が読んで承認する）

JSON のみ（YAML パーサを依存に入れないため）。性質には 2 系統ある。

- **グラフ性質**: 状態と遷移の形だけで判定できるもの。簡易検査（BFS）で保存のたびに即時判定。TLC でも検査できる。
- **モデル性質**: 変数・ガードを含む不変条件と時相的性質。TLC でのみ判定。

```json
{
  "entry": ["ログイン"],
  "properties": [
    { "id": "no-unauth-home", "kind": "invariant",
      "description": "未認証で Home・マイページにいない",
      "expr": "state in {Home, マイページ} => authed" },

    { "id": "lock-after-3", "kind": "invariant",
      "description": "4 回目の失敗は存在しない",
      "expr": "retries <= 3" },

    { "id": "logout-eventually-login", "kind": "leads-to",
      "description": "ログアウトしたら必ずログイン画面に戻る",
      "from": "state == ログアウト", "to": "state == ログイン" },

    { "id": "no-dead-end", "kind": "no-dead-end", "except": ["ロック"] },
    { "id": "logout-always", "kind": "always-reach", "target": ["ログアウト"] },
    { "id": "db-via-validation", "kind": "dep-only-via", "from_group": "画面", "target": ["DB層"], "via": ["検証層"] }
  ]
}
```

| kind | 系統 | 意味 | 判定 |
|---|---|---|---|
| `invariant` | モデル | `expr` がすべての到達可能状態で真 | TLC（`expr` に変数が無ければ BFS でも） |
| `leads-to` | モデル | `from` が真になったら、いつか `to` が真になる（`from ~> to`） | TLC（弱公平性つき） |
| `never-reach` | グラフ | `entry` から `avoid` を通らずに `target` へ到達しない | BFS / TLC |
| `always-reach` | グラフ | すべての状態から `target` のいずれかに到達できる | BFS |
| `no-dead-end` | グラフ | `except` 以外に出遷移が 1 本以上ある | BFS |
| `dep-only-via` | グラフ | `from_group` から `target` への dep 経路が `via` を通る | BFS |

`expr` の文法は §5.1 と同じに、`state`（現在の状態名）と `state in {…}` を加えたもの。`=>` は含意。

### 6.4 `everypath.config.json`（任意）

```json
{
  "aliases": { "@": "src", "~": "src" },
  "includeTests": false,
  "findings": "everypath.findings.json",
  "ignore": ["generated/**"],
  "colors": { "vuln": "red", "untested": "amber", "unreviewed": "gray", "approved": "green", "proven": "blue" }
}
```

### 6.5 findings 入力

`everypath.findings.json` / `.everypath/findings.json` / `semgrep.json` / `bandit.json` の順で探す。
semgrep 形式（`results[].path, extra.message, extra.severity, start.line, check_id`）と bandit 形式（`results[].filename, issue_text, issue_severity, line_number, test_id`）の両方を受け付け、共通形に正規化する。

---

## 7. 状態と色

### 7.1 状態の階層

弱い順に: 未テスト → テスト済み → 性質検証済み → 証明済み。これに直交して「人間が承認したか」がある。

### 7.2 表示色（優先順位つき。上から順に最初に当てはまったもので塗る）

| 優先 | 条件 | 色 | 意味 |
|---|---|---|---|
| 1 | `vuln` または `violations.length > 0` | 赤（塗り + 太枠） | 脆弱性・性質違反。最優先で見る |
| 2 | `planned` | 白・点線枠・薄文字 | AI が宣言したが未実装 |
| 3 | `wip` | 黄（淡） | 作業中 |
| 4 | `!tested` | 橙（amber） | 未テスト |
| 5 | `changedSinceReview` | グレー + 太枠 + パルス | 承認後に変更された（未読に戻った） |
| 6 | `!reviewed` | グレー | 未レビュー |
| 7 | `reviewed && proof == "passed"` | 青 | 証明済みかつ承認済み |
| 8 | `reviewed` | 緑 | 人間が承認 |

補足:
- 当初案の「未テスト = 緑」は直感に反する（緑 = OK と読まれる）ため採用しない。
- 証明済みでも未承認ならグレー（仕様が間違っていれば証明は無意味なので、人間の承認を最終とする）。
- `proof == "failed"` は赤扱いにし、詳細パネルに失敗した条件を出す。
- 直近 30 秒以内に追加・変更されたノードは、色に関わらず短いフェードイン/パルスを付ける。

### 7.3 エッジ

| 種類 | 描画 |
|---|---|
| flow（declared && observed） | 実線・黒・矢印 |
| flow（declared のみ） | 実線・グレー |
| flow（observed のみ = 乖離） | 実線・橙・「宣言なし」ラベル |
| dep | 細い点線・グレー。デフォルトで薄く、トグルで非表示可 |
| 反例経路 | 赤・太・破線。選択中の違反についてのみ描く |

---

## 8. スキャナ仕様（`src/core/scan.ts`）

1. **走査**: 対象ルート配下を再帰。無視: `node_modules .git dist build out .next __pycache__ venv .venv coverage target vendor .everypath` と `config.ignore`。対象拡張子: `.js .jsx .ts .tsx .mjs .cjs .py .go .rb .rs .java .kt`。
2. **テストファイル判定**: 相対パスが `/(^|[\/._-])(test|tests|spec|specs|__tests__)([\/._-]|$)/i` に一致。テストファイルはノードにしない（`includeTests` で変更可）が、その import 先を「テスト済み」とマークする。
3. **アノテーション解析**: §5 のタグを先頭 60 行から抽出。`@state-next` は `<状態> [on:…] [if:…] [set:…]` に分解し、`if:`/`set:` は §5.1 の文法でパースする。文法外なら警告（`graph.json.warnings[]`）に積み、その遷移はガード無し・代入無しとして扱う。`@state-var` の型が有限でなければ同様に警告してモデルから除く。
4. **import 解決**:
   - JS/TS: `import … from 'x'`, `import 'x'`, `require('x')`, `import('x')`。相対パスと `config.aliases` のみ解決し、拡張子補完（`.ts .tsx .js .jsx .mjs .cjs`）、`index.*`、`.js → .ts` の読み替えを行う。外部パッケージは無視。
   - Python: `from a.b import`, `import a.b`。ファイルのディレクトリ、ルート、`src/`, `app/` を基点に `a/b.py` または `a/b/__init__.py` を探す。
   - Ruby: `require_relative`。
   - Go: ルートと入れ子の `go.mod` の `module` パスで引く（`go.work` と `replace` は読まない）。`import "m/p"` と `import ( … )` は、パスに一致する最長のモジュールのディレクトリにある `_test.go` 以外の全 `.go` に解決する。`_test.go` は import 先に加えて、同じディレクトリの全ファイルもテスト済みにする。標準ライブラリと第三者のパスは無視。
   - Rust: `mod foo;` は宣言したファイルの隣の `foo.rs` か `foo/mod.rs`（2018 版の規則。入れ子の `mod a { mod b; }` と、入れ子の外の単純な `#[path = "…"]` を含む）。`use` は `crate::`、`self::`、`super::`、宣言済みの子モジュール、`Cargo.toml` の `[package] name`（`-` は `_`）か `[lib] name` のクレート名で始まるパスを、たどれる一番深いモジュールのファイルに解決する。外部クレートは無視。`tests/` のファイルはテスト。
   - Java/Kotlin: ソースルート `src/main/java`、`src/main/kotlin`、`src/test/java`、`src/test/kotlin`（`app/src/…` のような入れ子のモジュールを含む）とリポジトリのルートから、`import a.b.C` を `a/b/C.java` か `.kt` に解決する。入れ子クラスと静的メンバーは一番長く一致するクラスのファイル、`a.b.*` は `a/b/` 直下の全ファイル。自分のモジュールを先に探し、`src/main` のファイルは `src/test` を見ない。同じパッケージの参照（import なし）と Kotlin のトップレベル関数は解決しない。`src/test/…` のファイルはテスト。
   - Go/Rust/Java/Kotlin 共通: コメントと文字列の中の import は読まない。解決できない import と、候補が 2 つ以上あって決められない import（ファイルが重なる、`lib.rs` と `main.rs` のどちらの根か決まらない、同じ module パスの `go.mod` が 2 つ）は何も記録せず、警告も出さない。詳細は `docs/specs/imports-more.md`。
5. **観測遷移（observed flow）の抽出**（乖離チェック用、フェーズ 2）: JS/TS で `router.push('/x')`, `redirect('/x')`, `navigate('/x')`, `<Link href="/x">`, Next.js の `pages/`・`app/` パス、Express の `app.get('/x')` などからルートパス → ノードの対応を取る。対応づけには `@state-route /x` タグ（§17 で要検討）を使う。
6. **ノード集約**: ファイル → ノード id（`@state` またはファイル名）。`tested` は「ノード内の全ソースファイルがテスト済み」のときのみ true。
7. **ハッシュ**: ノードの全ファイル内容を相対パス順に連結して sha1。
8. **エッジ**: ファイル間 import をノード間 dep に集約（自己ループ除外）。`@state-next` を flow に（イベント・ガード・代入付き。flow は自己ループを許す）。未実装の遷移先は `planned` ノードを生成。
8b. **モデル**: 全ファイルの `@state-var` を集めて `graph.json.model.vars` に、`on:` に出たイベント名と `@state-event` を `model.events` に、`@state-initial` を `model.initial` に。同名変数の重複宣言は型が一致すれば許し、違えば警告。
9. **findings / risks** をノードに付与。
10. **性質チェック**（§9）を呼び、結果を `properties` と `nodes[].violations` に書く。
11. **review.json** を読み、`reviewed` / `changedSinceReview` を計算。
12. **lastChangedAt**: 前回 graph.json の同 id ノードと hash が違えば今、同じなら前回値を引き継ぐ。
13. `.everypath/graph.json` に書き、差分を `.everypath/history.jsonl` に追記（`{at, reason, added, removed, updated, addedEdges, removedEdges}`）。

性能目標: 1,000 ファイル規模で 1 秒以内。ファイル内容はスキャンごとに読み直してよい（まずは単純に）。

---

## 9. 簡易検査（`src/core/properties.ts`）— 保存のたびに走る速いレーン

対象は **flow エッジのみ**で構成した有向グラフ（dep は `dep-only-via` のときだけ使う）。親（`@state-parent`）があるときは、`src/core/flatten.ts` が葉だけに平らにした遷移を読み、TLA+ 生成も同じ遷移を読む。変数・ガードは無視する（ガードは常に真とみなす＝過大近似。したがって「到達しない」は保守的な判定になり、`never-reach` の反例は TLC の確認が必要なことがある。ビューアには `checkedBy: "bfs"` と表示して区別する）。

| kind | 判定 | 反例 |
|---|---|---|
| `never-reach` | `entry` から `avoid` を**通らずに** `target` へ到達する経路が存在しないこと | 見つかった最短経路 |
| `always-reach` | すべての状態（planned 除く）から `target` のいずれかに到達できること | 到達できない状態からの「行き止まりまでの経路」 |
| `no-dead-end` | `except` 以外の状態に flow の出エッジが 1 本以上あること | 該当状態 |
| `dep-only-via` | `from_group` から `target` への dep 経路が、必ず `via` のいずれかを通ること | 通らない経路 |
| `invariant`（変数を含まないもの） | `state in {…}` 形式なら到達可能集合で判定 | 到達経路 |

1 秒以内に終わること。結果は `graph.json.properties[]` に `checkedBy: "bfs"` で書く。TLC の結果は、簡易検査が判定できず保留にした性質だけを埋める。簡易検査が `ok` か `violated` を出した性質は、簡易検査の結果を残す（`docs/specs/server.md` の決定。保存された TLC の結果で、今のグラフ上の違反を消さないため）。

---

## 10. モデル検査（`src/core/tla/*.ts`）— TLA+ で全探索する本命レーン

### 10.1 生成する TLA+（`.everypath/tla/Model.tla`）

ステートチャート（状態、遷移、イベント、ガード、代入、変数）を 1 本の TLA+ モジュールに落とす。生成物は人間が読める形に整え、各アクションに由来ファイルをコメントで付ける（理解を深めるため、エージェントがこのファイルを読んで説明できるようにする）。

```tla
---- MODULE Model ----
EXTENDS Naturals
CONSTANTS States, Events
VARIABLES state, authed, retries, lastEvent

States == {"ログイン", "Home", "マイページ", "ログアウト", "新規登録", "パスワードリセット", "ロック"}
Events == {"login_ok", "login_fail", "logout", "forgot", "reset_done", "tau"}

Init == /\ state = "ログイン" /\ authed = FALSE /\ retries = 0 /\ lastEvent = "tau"

\* src/auth/login.ts: @state-next Home on:login_ok set:authed=TRUE, retries=0
Login_Home == /\ state = "ログイン" /\ state' = "Home" /\ authed' = TRUE /\ retries' = 0 /\ lastEvent' = "login_ok"
\* src/auth/login.ts: @state-next ログイン on:login_fail if:retries<3 set:retries=retries+1
Login_Login == /\ state = "ログイン" /\ retries < 3 /\ state' = "ログイン" /\ retries' = retries + 1 /\ UNCHANGED authed /\ lastEvent' = "login_fail"
...
Next == Login_Home \/ Login_Login \/ ...
Spec == Init /\ [][Next]_<<state, authed, retries, lastEvent>> /\ WF_<<state, authed, retries, lastEvent>>(Next)

TypeOK == state \in States /\ authed \in BOOLEAN /\ retries \in 0..3
\* everypath.properties.json: no-unauth-home
NoUnauthHome == (state \in {"Home", "マイページ"}) => authed
\* everypath.properties.json: logout-eventually-login
LogoutLeadsToLogin == (state = "ログアウト") ~> (state = "ログイン")
====
```

- 状態名に非 ASCII が混ざるため、識別子には連番（`S1_Login`）を使い、表示用の名前は文字列定数として持つ。生成時に対応表を `result.json` に残して逆引きする。
- 変数の型は有限集合に閉じている（§5）ので、TLC の状態空間は有限になる。
- `tau` は「イベント無しの任意遷移」。`@state-next 新規登録` のようにイベント無しの遷移はこれで表す。
- `set:` で更新されない変数は `UNCHANGED`。

### 10.2 `Model.cfg`

```
SPECIFICATION Spec
INVARIANTS TypeOK NoUnauthHome LockAfter3
PROPERTIES LogoutLeadsToLogin
```

### 10.3 実行

- `everypath check --tlc [dir]` または ビューアの `[全探索を実行]`。
- `config.tla.jar`（既定: `$EVERYPATH_TLA_JAR` → `~/.everypath/tla2tools.jar`）の `tla2tools.jar` を `java -XX:+UseParallelGC -jar tla2tools.jar -workers auto -config Model.cfg Model.tla` で実行。Java か jar が無ければ、入手方法（`everypath tla install` が GitHub Releases からダウンロードする）を案内して簡易検査のみで続行する。
- 実行は非同期。実行中は該当性質を `pending`、ビューアのヘッダに「全探索中…」を出す。監視→再スキャンのレーンとは独立させ、スキャンが TLC を待つことは無い。
- タイムアウト既定 120 秒。超えたら `error` と状態数を記録。

### 10.4 結果の正規化（`result.json`）

TLC の標準出力から次を抽出する。

- 各不変条件・性質の成否
- 反例トレース: `State 1: /\ state = "ログイン" /\ authed = FALSE ...` の列をパースし、`{state, event(lastEvent), vars}` の配列に変換。識別子は対応表で表示名に戻す
- 探索した状態数（`N distinct states found`）
- 時相的性質の反例はループ付きトレース（`Back to state N`）になる。`loopStart` を付けてビューアで「ここから無限に繰り返す」と描く

`graph.json.properties[].counterexamples` に合流させ、`checkedBy: "tlc"` にする。違反した性質に関わる状態（トレース上の状態）には `violations` を付けて赤くする。

### 10.5 証明（Dafny / Verus 等）との関係

TLA+ は「振る舞いのモデル」を検査する。関数単位の証明（Dafny / Verus / Kani / Lean）は別レーンとして §10.6 のアダプタで受けるが、**フェーズ 1 の対象は TLA+ のみ**。`@state-require proof` と `.everypath/proofs.json`（形式は下）はインターフェースだけ決めておく。

```json
{ "パスワードリセット": { "result": "failed", "tool": "verus", "message": "precondition token.valid not established", "at": "…" } }
```

### 10.6 「理解が深まる」ための補助

- 詳細パネルの「モデル」タブに、そのノードに関係する TLA+ のアクション定義をそのまま表示する（生成コメント付き）。人間が TLA+ を少しずつ読めるようになる導線。
- `[このモデルを説明させる]` ボタンは、`Model.tla` のパスと注目中の性質をクリップボードに入れる（§13 の指示生成の 1 種）。説明はエージェントに書かせる。
- 反例トレースはステップ送りで再生できる（§12）。

---

## 11. サーバー（`src/server/*.ts`）

| エンドポイント | 内容 |
|---|---|
| `GET /` | `dist/ui.html`（ビルド済み単一 HTML） |
| `GET /graph.json` | 現在のグラフ |
| `GET /history.json` | 直近 200 件の差分 |
| `GET /events` | SSE。接続時に `{type:"graph", graph, diff:null}`、変更のたびに `{type:"graph", graph, diff, reason}` |
| `POST /rescan` | 手動再スキャン |
| `POST /review/:id` | body `{ "note": "..." }`。review.json に承認を書き、再スキャンして配信 |
| `DELETE /review/:id` | 承認を取り消す |
| `GET /layout.json` / `PUT /layout.json` | 座標キャッシュ |
| `POST /check/tlc` | TLA+ 生成 + TLC を非同期で開始。すでに実行中なら 409。進捗は SSE の `{type:"tlc", status:"running"\|"done"\|"error", states, message}` で配信し、完了時に graph.json を再配信 |
| `GET /tla/Model.tla` | 生成した TLA+ をそのまま返す（詳細パネルの「モデル」タブ用） |
| `GET /templates.json` | 指示文のテンプレート 5 種類。`.everypath/templates/<種類>.md` があればそれ（`source: "override"`）、無ければ同梱の `templates/prompts/<種類>.md`（`source: "default"`）。ビューアが §13 の文面を作るのに使う |

- 監視: `fs.watch(root, {recursive:true})`。無視パターンはスキャナと同じ。250ms デバウンス。`recursive` 非対応環境は 1.5 秒ポーリングにフォールバック。
- `.everypath/` 配下の変更で再スキャンをトリガーしない（自己ループ防止）。ただし `review.json`、`proofs.json`、`tla/result.json` の変更は再配信する（CI や手動の `everypath check --tlc` の結果をビューアが拾うため）。
- TLC はスキャンのレーンと独立した子プロセス。スキャンが TLC の完了を待つことはなく、TLC 実行中にソースが変わったら結果は「古いモデルに対する結果」として `staleModel: true` を付ける。
- ポート既定 4747。`--open` でブラウザを開く。

---

## 12. ビューア UI（`src/ui/*.ts` → `dist/ui.html`）

モックアップ（会話で合意済み）の構成:

```
┌ ヘッダ: プロジェクト名 | ● live | ノード N · 未レビュー N · 脆弱性 N · 性質違反 N | 表示トグル ┐
├─────────────────────────────────────────┬───────────────────────────┤
│ キャンバス（draw.io 風: 方眼背景、角丸矩形、     │ 詳細パネル（選択ノード）        │
│ 直交矢印）。パン・ズーム可                        │ ・名前 / ファイル / 最終変更    │
│                                                  │ ・テスト / スキャン / 性質 / 証明│
│                                                  │ ・仕様（@state-spec）           │
│                                                  │ ・[仕様を承認] [指示を生成]     │
├─────────────────────────────────────────┴───────────────────────────┤
│ 凡例 ｜ 変更ログ（時系列）／ 未レビュー一覧（タブ切替）                               │
└───────────────────────────────────────────────────────────────────┘
```

### 12.1 挙動

- **初回**: dagre（rankdir=TB、ノード 180×64、ranksep 70、nodesep 40）でレイアウト。結果を `layout.json` に保存。
- **更新時（レイアウト安定）**: 既存ノードは `layout.json` の座標を維持。新ノードは、flow で繋がる既存ノードの近傍（親の下、兄弟の右）に空き矩形探索で置く。`[整列し直す]` ボタンで dagre を再実行（この時だけ全体が動く）。
- ノードの**ドラッグ移動**は可（座標は `layout.json` に保存）。これは「図を直す」ではなく「置き場所の記憶」なのでスコープ内。
- エッジは直交（水平→垂直→水平）で描く。dagre の points を使う場合も最後に直交化する。
- 新規/変更ノードはフェードイン + 2 秒のパルス。削除ノードはフェードアウト。
- エッジには `on:` のイベント名をラベルとして描く（`if:` があれば `[retries<3]` を続ける）。ラベルは 11px、重なりが多ければ hover で表示に切り替えるトグルを持つ。
- ノードクリックで詳細パネル。違反のあるノードを選ぶと、その反例経路を赤破線でハイライト。
- **反例の再生**: 詳細パネルの反例に `[◀] [▶] step 2/3` を置き、押すたびに現在状態のノードを強調し、その時点の変数値（`authed = FALSE, retries = 0`）を横に表示する。時相的性質の反例はループ区間を「↺ 繰り返し」と示す。テストでは見えない経路を人間が一歩ずつ追えることが、この画面の核心。
- ヘッダに `[全探索を実行]`（TLC）。実行中はスピナーと「全探索中… N 状態」、完了で「N 状態を探索、違反 M 件」。TLC 未導入なら押下時に導入手順を案内。
- グループ（`@state-group`）があれば、同グループを薄い枠で囲う（dagre の compound は使わず、座標の外接矩形で描く）。
- 親（`@state-parent`）は、子の箱と子の枠を囲む実線の枠で、上端に名前を持つ。枠は箱の座標から毎回測り、`layout.json` には書かない。親の遷移は枠から 1 本だけ出る。新しい子は兄弟の近くの、よその箱を枠に入れない位置に置く。`[整列し直す]` では親を dagre の cluster にする。名乗るファイルの無い親（入れ物）は無色の枠で、承認と未レビュー一覧の対象にしない。
- ダブルクリックでノード内ファイル一覧を展開（ファイル粒度へのズーム）。フェーズ 2。
- 「未レビュー一覧」タブ: 色が緑/青でないノードを優先度順（赤 → 橙 → グレー太枠 → グレー）に列挙。クリックでキャンバス上のノードへジャンプ。レビューが追いつかない状況ではこちらが主画面になる想定。
- `dep` エッジの表示/非表示トグル（既定: 表示・薄い）。
- 接続が切れたら「● offline」にし、再接続を試みる。

### 12.2 承認

- `[仕様を承認]` → `POST /review/:id`。即座に緑（または青）になる。
- 承認後にファイルが変わると `changedSinceReview` でグレー太枠に戻る。詳細パネルに「承認時からの変更あり（hash 不一致）」と前回承認日時を表示。

### 12.3 見た目

- 方眼背景、白地・黒枠の角丸矩形、黒の直交矢印（draw.io 風。§0.1 の原案図を参照）。
- 色は §7。文字は 13px 以上。ダークモードは初期スコープ外。
- フォント・色は CSS 変数にまとめ、`config.colors` で差し替え可能にする。

---

## 13. 指示生成（エージェントへの依頼文を組み立てる）

everypath は修正しない。代わりに、**今見えている文脈を貼れる形にまとめて**クリップボードに入れる。`[指示を生成]` を押すと種類を選ぶ。

| 種類 | 発動条件 | 含める内容 |
|---|---|---|
| 反例を直す | `violations` あり | ファイル、違反した性質の説明、反例経路、関連 findings、`@state-spec`、完了条件（性質が ok になる、既存テストが通る）、承認済み隣接ノードは変更しない旨 |
| テストを書く | `!tested` | ファイル、`@state-desc`/`@state-spec`、完了条件（テストファイルからの import で tested になる） |
| 仕様と証明を書く | `requireProof && proof != passed` | ファイル、現在の spec、使用する検証ツール名（config）、完了条件（proofs.json が passed） |
| 乖離を直す | `drift` あり | 宣言（`@state-next`）と観測された遷移の差、どちらが正しいかを人間が選ぶラジオ、完了条件（drift が消える） |
| モデルを描かせる | ノードに `@state-next` が無い / 変数・ガードが無い | 対象ファイル、§5.2 の記法例、完了条件（flow エッジが生え、簡易検査が通る）。既存コードに後からモデルを付けるときの入口 |
| 性質を提案させる | いつでも | 現在のモデル（状態・変数一覧）と既存の性質、完了条件（`everypath.properties.json` に追記案を出す。人間が承認するまで適用しない） |
| モデルを説明させる | いつでも | `Model.tla` のパス、注目中の性質と反例、「このモデルの振る舞いを日本語で説明し、反例が何を意味するか述べる」 |

複数ノードを選択（Shift+クリック）して「まとめて生成」できる。これがレビューが追いつかない状況での日常の使い方になる想定（例: 未テストの 3 ノードにまとめてテストを書かせる）。

生成例（反例を直す）:

```
src/auth/reset.ts（機能: パスワードリセット）を修正してください。

モデル検査（TLA+ / TLC、48 状態を全探索）で違反: 未認証で Home・マイページにいない (no-unauth-home)
反例:
  1. ログイン            authed=FALSE retries=0
  2. パスワードリセット   on:forgot      authed=FALSE retries=0
  3. Home               on:reset_done  authed=FALSE retries=0   ← ここで違反
スキャン指摘: リセットトークンの検証がない（reset.ts:42, semgrep: …）
想定仕様: requires token.valid && !token.expired / ensures session == none

考えられる修正: reset_done 遷移の先を ログイン にする、または遷移に set:authed=TRUE を付けるなら
トークン検証を通った場合に限る（if: を追加）。どちらが正しいかは実装を見て判断し、理由を報告してください。

完了条件: `everypath check --tlc` で no-unauth-home が ok になり、既存テストが通ること。
ログイン・Home は承認済みのため変更しないでください（必要なら理由を添えて報告）。
```

文面はテンプレートとして `templates/prompts/*.md` に置き、`{{NODE}}` 形式の変数で埋める。ユーザーが自分のテンプレを `.everypath/templates/` に置けば上書きできる。

---

## 14. Claude Code 連携

### 14.1 `skill/SKILL.md`（対象リポジトリの `.claude/skills/everypath/SKILL.md` にコピーして使う）

内容の要点:

- 新しい機能・画面・モジュールを作るときは、ファイル先頭に `@state` と `@state-next` を必ず書く。理由: 人間がレビューのために全体像を地図で追っているため。
- 遷移には可能な限り `on:`（イベント）を付け、条件分岐があるなら `if:` と `@state-var` で変数として表す。理由: この宣言から TLA+ が生成され、全パターンが検査される。イベントやガードが無い遷移は「いつでも起きうる」とみなされ、検査が粗くなる。
- 変数は有限（BOOLEAN、小さい範囲の整数、列挙）にする。理由: 全探索を有限時間で終えるため。文字列や無限の整数はモデルに入れない。
- 実装前に `@state-next` で遷移を宣言してよい（計画ノードとして可視化される）。
- 機能を作ったら `everypath check` を実行し、簡易検査の違反があれば修正してから完了報告する。`everypath check --tlc` は人間が指示したときに実行する（時間がかかるため）。
- 性質（`everypath.properties.json`）の追加は提案として報告に含め、自分で書き込まない。理由: 性質は人間が承認するレビュー対象のため。
- 認証・決済・権限に関わるノードには `@state-spec` を書き、`@state-require proof` を付ける。
- 外部に見せない設定・型定義には `@state-hidden`。
- 自分で気づいたリスクは `@state-risk` に正直に書く（スキャナとは別枠で表示されるので、書いて損はない）。
- 作業前に `.everypath/graph.json` を読み、`reviewed: true` のノードを変更する場合は、変更理由を最終報告に含める（人間側で承認が外れて再確認が必要になるため）。
- `.everypath/` 配下と `everypath.*.json|yml` は変更しない。

### 14.2 スラッシュコマンド `/everypath-fix <ノード名>`（任意）

`.everypath/graph.json` から該当ノードの文脈を読み、§13 と同じ内容を自分で組み立てて修正に入る。人間が貼る代わりにエージェントが地図を読む経路。ビューアの指示生成と同じテンプレを使う。

### 14.3 hooks（`.claude/settings.example.json`）

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Write|Edit|MultiEdit",
        "hooks": [{ "type": "command", "command": "npx everypath scan --quiet" }] }
    ]
  }
}
```

`everypath serve` の監視で十分なので hook は任意。hook を使うのは、サーバーを起動せず `graph.json` だけ最新にしたいとき、または CI で性質チェックを走らせたいとき。`serve` の稼働中は、`scan`、`check`、`check --tlc` は自分で書かず、`.everypath/serve.json` が指すサーバーに渡す（`docs/specs/serve-cli-guard.md`）。hook と `serve` を併用しても書き手は 1 つのまま。

---

## 15. CLI

| コマンド | 内容 |
|---|---|
| `everypath serve [dir] [--port 4747] [--open]` | 監視 + サーバー |
| `everypath scan [dir] [--json] [--quiet]` | 一回スキャンして `.everypath/graph.json` を書く。`--json` で標準出力にも出す |
| `everypath check [dir] [--tlc] [--timeout 120]` | 性質チェック。既定は簡易検査、`--tlc` で TLA+ を生成して TLC を実行。違反があれば exit 1（CI 用）。反例を標準出力に人間可読で出す |
| `everypath tla export [dir]` | `.everypath/tla/Model.tla` と `Model.cfg` を生成するだけ（人間が TLA+ Toolbox で開く用） |
| `everypath tla install` | `tla2tools.jar` を `~/.everypath/` にダウンロード |
| `everypath init [dir]` | `everypath.config.json`、`everypath.properties.json` の雛形、`.claude/skills/everypath/SKILL.md`、hooks 例をコピー。`.gitignore` に `.everypath/*` と `!.everypath/review.json` を追記（決定 0003） |
| `everypath export [dir] --mermaid` | グラフを Mermaid の stateDiagram-v2 に書き出す（README や PR に貼る用） |

パッケージ名: `everypath`（2026-10-21 時点で npm 未使用を確認済み。公開前に再確認し、取られていれば `@<scope>/everypath`）。`bin` は `{"everypath": "dist/cli.js"}` の 1 本（先頭に `#!/usr/bin/env node`）。実行時依存ゼロ。Node 22 以上。

型定義（`dist/core/types.d.ts`）も公開し、`exports` に `"./types"` を出す。他のツール（CI のレポーター、別エディタの拡張）が graph.json を型付きで読めるようにするため。

---

## 16. フェーズ分け

### フェーズ 1（MVP。思想の 3 要素が一周すること）

- scanner: 走査、アノテーション（§5 全タグ。`@state-next` の `on:/if:/set:`、`@state-var`、`@state-initial` を含む）、JS/TS/Python の import 解決、テスト検出、findings、hash、review 照合
- properties（簡易検査）: `never-reach`, `always-reach`, `no-dead-end`, 変数なし `invariant`
- **tla**: `Model.tla` / `Model.cfg` 生成、TLC 実行、反例パース、graph.json 合流。`invariant` と `leads-to`
- server: 監視、SSE、review API、layout API、`/check/tlc`（非同期実行と進捗）
- ui: キャンバス（安定レイアウト、ドラッグ、パン・ズーム、イベントラベル）、色、詳細パネル、承認、反例ハイライトと**ステップ再生**、未レビュー一覧、`[全探索を実行]`、指示生成（反例・テスト・モデルを描かせる・まとめて）
- skill / init / check / tla export / tla install
- example: §0.1 の原案図の構成（ログイン、新規登録、Home、マイページ、ログアウト）に「パスワードリセット」「ロック」「DB層」を足し、`authed` と `retries` を変数に持つサンプル。`no-unauth-home` が TLC で**実際に違反する**状態で同梱し、修正すると ok になる

### フェーズ 2

- 観測遷移の抽出と乖離チェック、`@state-route`
- `dep-only-via`、`never-reach` の TLC 側判定
- Mermaid エクスポート
- ファイル粒度へのズーム、グループ枠
- 階層状態（親状態・子状態）: `@state-parent <状態>`。TLA+ 上はフラット化する（`docs/specs/hierarchy.md`）

### フェーズ 3

- 関数単位の証明アダプタ（Dafny / Verus）、`@state-require proof`、「仕様と証明を書く」テンプレ
- Go/Rust/Java の import 解決
- チーム向け（承認者の表示、review.json の git 共有を前提にしたマージ）

---

## 17. 未決事項（実装者の判断に委ねる。決めたら本文書に追記）

1. **ルートとノードの対応づけ**: 観測遷移で `/reset` → 「パスワードリセット」を結ぶのに `@state-route /reset` を必須にするか、Next.js の `pages/` 構造から自動推定するか。推奨: タグ必須で始め、フレームワーク検出は後から足す。
2. ~~TLA+ の識別子~~ → 決定済み（`docs/specs/tla.md`）: 連番 + コメントで表示名。状態・変数・イベント・列挙値・性質を「接頭辞 + 位置 + ASCII 名なら `_名前`」（`S2_Home`、`v1_authed`）にし、対応表を `result.json` に残す。
3. ~~イベントの発生モデル~~ → 決定済み（`docs/specs/tla.md`）: 推奨どおり、すべてのイベントを環境が非決定的に選ぶ。元の状態とガードが真なら常に発火できる。必要になったら `@state-event` に `kind:` を足す。
4. ~~ノード id の衝突~~ → 決定済み（`docs/specs/scan.md`）: 衝突したファイルだけパス由来の id（`src/a/utils.ts` は `src_a_utils`）にする。`dir/name` は状態名の識別子規則に合わないため、区切りも `_` に置き換える。
5. **レイアウト安定の「空き地探索」アルゴリズム**: 親の直下 → 右 → 左 の順に 1 グリッド（20px）刻みで衝突判定、で十分か。
6. ~~review.json を git 管理させるか~~ → 決定済み（`docs/decisions/0003-review-json-in-git.md`）: 常に git 管理。`init` は `.gitignore` に `.everypath/*` と `!.everypath/review.json` を書き、聞かない。
7. ~~ダークモード~~ → 決定済み（`docs/REQUIREMENTS.md` 非目標）: やらない。色が意味を持つ UI なので配色を 2 系統維持しない。

---

## 18. 叩き台コードの状態

`reference/draft-scan.js` と `reference/draft-server.js` が同梱されている。これは**プロジェクト名と言語が決まる前（仮称 archviz、JavaScript）に書いた叩き台**であり、本仕様とは次の点で食い違う。

- JavaScript（CommonJS）で書かれている。本仕様は TypeScript（ESM）
- アノテーション接頭辞が旧仕様の `@arch-*`（`@arch-feature` = 現 `@state`）。出力先も `.archviz/`
- `@arch-next` は状態名のみで `on:/if:/set:` を解釈しない。`@state-var`、`@state-initial`、`@state-spec`、`@state-require` に相当するものは無い
- hash、review 照合、性質、history、観測遷移、TLA+ は未実装。server は SSE・監視・`/rescan` まで

**移植元のアイデア集として読み、コードはそのまま使わず `src/core/scan.ts` / `src/server/*.ts` として書き直すこと。** 使えるのは import 解決（拡張子補完、`index.*`、`.js → .ts` 読み替え、Python の基点探索）、findings の正規化、`fs.watch` のポーリングフォールバック、差分計算あたり。

---

## 19. 受け入れ基準（フェーズ 1 の完了条件）

1. `example/` に対して `everypath serve` を実行し、ブラウザで §0.1 の原案図を拡張した遷移図（ログイン・新規登録・Home・マイページ・ログアウトの 5 画面に、パスワードリセット・ロック・DB層を加えた 8 ノード）が描かれる。
2. `example/src/` に `@state 設定` `@state-next Home` を書いた新規ファイルを追加すると、**2 秒以内**に新ノードと矢印が現れ、既存ノードの位置は動かない。
3. そのファイルを import するテストを追加すると、ノードが橙からグレーに変わる。
4. 詳細パネルで「仕様を承認」を押すと緑になり、`review.json` に hash 付きで記録される。そのファイルを変更するとグレー太枠に戻る。
5. `everypath.findings.json` に `src/auth/reset.ts` の指摘を置くと、そのノードが赤になり、パネルに行番号つきで表示される。
6. `everypath.properties.json` の `never-reach` 違反があるとき、簡易検査でノードが赤になり、クリックで反例経路が赤破線で描かれ、`everypath check` が exit 1 で反例を出力する。
7. `everypath check --tlc` を example に対して実行すると、`Model.tla` が生成され、TLC が `no-unauth-home` の違反を見つけ、反例トレース（状態 + イベント + 変数値）が標準出力と graph.json に出る。ビューアで反例をステップ再生でき、各ステップで変数値が表示される。example の `reset.ts` を修正すると ok になる。
8. `retries` を `0..3` から `0..10` に変えた `lock-after-3` 違反のように、**グラフの形は同じで変数の値だけが違う**バグを TLC が見つけ、簡易検査では見つからない（`checkedBy` の違いが UI で分かる）。
9. 「指示を生成」で §13 の例と同等の文面（反例トレース付き）がクリップボードに入る。複数選択でまとめて生成できる。
10. `package.json` の `dependencies` が空で、`dist/ui.html` がネットワーク無しで表示できる（CDN 参照なし）。TLC が無い環境でも 1〜6 と 9 は動く。
11. `npm run typecheck`（strict）、`npm run lint`、`npm test` がすべて通る。テストは少なくとも scanner、expr（ガード・代入・性質式のパース、文法外入力の警告）、properties、tla（生成と TLC 出力パース。TLC 出力は `test/fixtures/` の固定文字列）を含む。
12. `npm pack` した tarball を空ディレクトリに入れ、`npx everypath serve <example のパス>` で 1 が再現できる（ビルド済み JS だけで動くことの確認）。
