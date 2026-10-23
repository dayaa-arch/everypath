# everypath

AI エージェントがソースファイルの先頭に書いた `@state` アノテーションからステートチャートを作り、TLA+ のモデル検査（TLC）でありうる経路をすべて調べて、レビュー用の図に描く CLI です。性質を破る経路は、図の上の赤い経路として返ります。

## 必要なもの

- Node.js 22 以上
- `check --tlc` を使うときだけ、Java 11 以降
- `prove` を使うときだけ、設定した検証ツール（Dafny、Verus など）

## インストール

```bash
npm install -D everypath
```

## リポジトリに入れる

対象リポジトリのルートで実行します。

```bash
npx everypath init
```

次の 6 つができます。既にあるファイルは上書きしないので、何度実行しても結果は同じです。

| ファイル | 中身 |
|---|---|
| `everypath.config.json` | 任意の設定。import の別名（`aliases`）、テストファイルを状態に含めるか（`includeTests`）、無視するパス（`ignore`）、`prove` が使う検証ツール（`proof`）、TLC の Java のヒープの上限（`tla.maxHeap`） |
| `everypath.properties.json` | 性質の定義。最初は空 |
| `.claude/skills/everypath/SKILL.md` | Claude Code のスキル。エージェントにアノテーションの書き方と守ることを伝える |
| `.claude/settings.example.json` | Claude Code がファイルを書くたびに `npx everypath scan --quiet` を走らせる hook の例 |
| `.gitignore` | `.everypath/*` と `!.everypath/review.json` を末尾に足す。承認の記録だけを git で管理する |
| `.everypath/.gitignore` | `!review/` と `review/*.tmp`。承認の記録（`.everypath/review/`）を git で管理に戻す |

hook を使うときは、`settings.example.json` の `hooks` を `.claude/settings.json` に写します。`serve` を起動しているなら hook は要りません。

## アノテーションを書く

ファイル先頭 60 行以内のコメントに書きます。ふだんはスキルを読んだエージェントが書きます。

`src/login.ts`

```ts
// @state ログイン
// @state-initial
// @state-var authed: BOOLEAN = FALSE
// @state-next Home on:login_ok set:authed=TRUE
```

`src/home.ts`

```ts
// @state Home
// @state-next ログイン on:logout set:authed=FALSE
```

`@state` が状態の名前、`@state-next` が遷移先です。`on:` はイベント、`if:` は条件、`set:` は遷移で変わる変数を書きます。タグの一覧は `.claude/skills/everypath/SKILL.md` にあります。

画面をまとめるときは、子のファイルに `@state-parent <親の状態>` を書きます。親に書いた `@state-next` は中のすべての状態から出る遷移になり、図では親が子を囲む枠になります。

`src/authed.ts`

```ts
// @state 認証済み
// @state-next ログイン on:logout set:authed=FALSE
```

`src/mypage.ts`

```ts
// @state マイページ
// @state-parent 認証済み
// @state-next Home on:back
```

## 依存を読む言語

ファイル間の `import` は、図の点線の依存と、テスト済みの印になります。読める言語は次のとおりです。解決できない `import` と、候補が複数あって 1 つに決められない `import` は、何も記録しません。

| 言語 | 解決する `import` |
|---|---|
| JavaScript / TypeScript | 相対パスと、`everypath.config.json` の `aliases`。外部パッケージは無視します |
| Python | `from a.b import`、`import a.b`、相対 `import`。ファイルのディレクトリ、ルート、`src/`、`app/` から探します |
| Go | `go.mod`（入れ子も）の `module` パス。`import` は、そのパッケージのディレクトリにある `_test.go` 以外の全ファイルに当たります |
| Rust | `mod foo;`、`use crate::…`、`self::`、`super::`、`Cargo.toml` のクレート名。外部クレートは無視します |
| Java / Kotlin | `src/main/java`、`src/main/kotlin`、`src/test/java`、`src/test/kotlin`（入れ子のモジュール可）とルートから `a/b/C.java` か `.kt` を探します。`a.b.*` はそのパッケージの直下の全ファイルです |

Go の `_test.go`、Rust の `tests/`、Java と Kotlin の `src/test/` はテストファイルで、`import` 先をテスト済みにします。Java と Kotlin の同じパッケージのクラスは `import` なしで使えるので、`import` を書かないテストはテスト済みの印になりません。Ruby は `import` を読みません。

## 図を開く

```bash
npx everypath serve --open
```

ブラウザで `http://localhost:4747` が開きます。ファイルを保存するたびに図が変わり、既存の箱は動きません。ポートは `--port` で変えられます。

## チームで承認を共有する

詳細パネルの「仕様を承認」と「承認を取り消す」は、`.everypath/review/` にファイルを 1 つずつ足します。ファイルは書き換えも削除もしないので、別々のブランチで承認しても、`git merge` でも、ホスティングサービスが使うサーバー側の合流（`git merge-tree`）でも衝突しません。承認したファイルを commit して共有します。パネルには承認者（`git config user.name`）と承認日時が出ます。

同じ状態を 2 人が違う内容で承認したブランチ、または承認と取り消しのブランチを合流すると、その状態は「承認が食い違っています」になります。どちらかが勝つことはなく、未レビューのまま残り、`scan` と `check` が警告を出し、パネルに記録ごとの承認者、時刻、版が並びます。内容を確かめて承認し直すか取り消すと解けます。

以前の `.everypath/review.json` は読み続け、書き換えません。`init` をやり直さなくても、最初の承認で `.everypath/.gitignore` に `!review/` が足され、新しいファイルも git で管理されます。

## 検査する

性質は `everypath.properties.json` に書きます。

```json
{
  "properties": [
    {
      "id": "no-unauth-home",
      "kind": "invariant",
      "description": "未認証で Home にいない",
      "expr": "state == Home => authed"
    }
  ]
}
```

```bash
npx everypath check
```

状態と遷移の形だけを見る簡易検査です。違反があると反例の経路を出し、終了コード 1 で終わるので、CI にも使えます。`leads-to` と、変数を含む `invariant` は、TLC を待つ「保留」になります。

## TLC で全探索する

```bash
npx everypath tla install
npx everypath check --tlc
```

`tla install` は `tla2tools.jar` を `~/.everypath/` に置きます。`check --tlc` は変数とガードを含めてすべての経路を調べ、反例を状態、イベント、変数の値の列で出します。簡易検査の違反の経路を TLC がガードどおりには通れないと確かめた場合は、その性質を「ガードを無視したときだけの経路」として出し、終了コードに数えません。タイムアウトは既定で 120 秒で、`--timeout 300` のように秒で変えられます。TLC の Java のヒープの上限は既定で 3 GB で、メモリが足りないと日本語のエラーで止まります。`everypath.config.json` の `{ "tla": { "maxHeap": "6g" } }` で変えられます。

## 関数単位の証明

`@state-require proof` を付けた状態は、検証ツールの証明が通るまで「証明必須」と表示されます。ツールは `everypath.config.json` の `proof` で決めます。

```json
{ "proof": { "tool": "dafny" } }
```

| `tool` | 既定の `command` | `{files}` に入るファイル | 結果の読み方 |
|---|---|---|---|
| `dafny` | `dafny verify {files}` | その状態の `.dfy` | `Error:` と `Related location:` の行を失敗した条件として残す |
| `verus` | `verus {files}` | その状態の `.rs` | `error:` の見出し、場所、`failed …` の印が指すコードを残す |
| `command` | なし（必須） | その状態のすべてのファイル | 終了コード 0 なら成功 |

`dafny` と `verus` の読み方は、各ツールの公式リポジトリにある出力例でだけ確かめたもので、実物のツールでは確かめていません。結果がおかしいと感じたら、`command` に切り替えて終了コードだけで判定してください。

```bash
npx everypath prove
npx everypath check --require-proof
```

`prove` は状態ごとに `command` を走らせ、結果を `.everypath/proofs.json` に書きます。リポジトリの中で書くのはこのファイルだけで、ツールの作業ディレクトリは毎回消す一時ディレクトリです。命令はシェルを通さずに空白で区切り、1 語目が `./` のような相対パスならリポジトリのルートから探します。命令はリポジトリの設定が決めるので、信頼できるリポジトリでだけ実行してください。1 状態あたり既定で 120 秒で止め、`--timeout 300` のように秒で変えられます。

Dafny の証明は `.dfy` ファイルに書き、先頭に対象と同じ `@state <名前>` を書くとその状態のファイルになります。証明の後にその状態のファイルが変わると、結果は古いものとして扱われ、もう一度 `prove` を走らせるまで「検証待ち」になります。図では、承認済みで証明が通った状態が青、証明が失敗した状態が赤になります。`check` は証明の通っていない状態を一覧に出しますが、終了コードに数えるのは `--require-proof` を付けたときだけです。

## サンプルを動かす

`example/` はログイン画面の小さなアプリで、`no-unauth-home` が違反するバグをわざと入れてあります。このリポジトリを clone して実行します。

```bash
git clone https://github.com/dayaa-arch/everypath.git
cd everypath
npm install
npm run build
node dist/cli.js serve example --open
node dist/cli.js check example --tlc
```

`check --tlc` が「ログイン → パスワードリセット → Home」を反例として返します。直し方は `example/README.md` にあります。

## コマンド

`dir` を省くと、今いるディレクトリが対象です。

| コマンド | 内容 |
|---|---|
| `everypath init [dir]` | 設定、性質、スキル、hook の例、`.everypath/.gitignore` を置き、`.gitignore` に追記する |
| `everypath scan [dir] [--json] [--quiet]` | 一回スキャンして `.everypath/graph.json` を書く |
| `everypath check [dir] [--tlc [--timeout 秒]] [--require-proof]` | 性質を検査する。違反があれば終了コード 1。`--require-proof` なら、証明の通っていない状態があっても 1 |
| `everypath prove [dir] [--timeout 秒]` | `@state-require proof` の状態ごとに検証ツールを走らせ、`.everypath/proofs.json` を書く。すべて通れば終了コード 0 |
| `everypath export [dir] --mermaid` | 状態と遷移を Mermaid の `stateDiagram-v2` にして標準出力に出す。README や PR に貼れる。何も書かない |
| `everypath tla export [dir]` | `.everypath/tla/Model.tla` と `Model.cfg` を書く |
| `everypath tla install` | `tla2tools.jar` を `~/.everypath/` に置く |
| `everypath serve [dir] [--port 4747] [--open]` | 監視して図を配るサーバーを起動する |

## 動作環境

Node.js 22 以上の macOS と Linux で動きます。0.1.0 では Windows には対応していません（`docs/decisions/0005-no-windows-in-0-1.md`）。全探索（`check --tlc`）を使うときだけ Java が要ります。

## ライセンス

MIT ライセンスです。全文は [LICENSE](LICENSE) にあります。
