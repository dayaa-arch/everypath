# everypath

AI エージェントがソースファイルの先頭に書いた `@state` アノテーションからステートチャートを作り、TLA+ のモデル検査（TLC）でありうる経路をすべて調べて、レビュー用の図に描く CLI です。性質を破る経路は、図の上の赤い経路として返ります。

## 必要なもの

- Node.js 22 以上
- `check --tlc` を使うときだけ、Java 11 以降

## インストール

```bash
npm install -D everypath
```

## リポジトリに入れる

対象リポジトリのルートで実行します。

```bash
npx everypath init
```

次の 5 つができます。既にあるファイルは上書きしないので、何度実行しても結果は同じです。

| ファイル | 中身 |
|---|---|
| `everypath.config.json` | 任意の設定。import の別名（`aliases`）、テストファイルを状態に含めるか（`includeTests`）、無視するパス（`ignore`） |
| `everypath.properties.json` | 性質の定義。最初は空 |
| `.claude/skills/everypath/SKILL.md` | Claude Code のスキル。エージェントにアノテーションの書き方と守ることを伝える |
| `.claude/settings.example.json` | Claude Code がファイルを書くたびに `npx everypath scan --quiet` を走らせる hook の例 |
| `.gitignore` | `.everypath/*` と `!.everypath/review.json` を末尾に足す。承認の記録だけを git で管理する |

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

## 図を開く

```bash
npx everypath serve --open
```

ブラウザで `http://localhost:4747` が開きます。ファイルを保存するたびに図が変わり、既存の箱は動きません。ポートは `--port` で変えられます。

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

`tla install` は `tla2tools.jar` を `~/.everypath/` に置きます。`check --tlc` は変数とガードを含めてすべての経路を調べ、反例を状態、イベント、変数の値の列で出します。簡易検査の違反の経路を TLC がガードどおりには通れないと確かめた場合は、その性質を「ガードを無視したときだけの経路」として出し、終了コードに数えません。タイムアウトは既定で 120 秒で、`--timeout 300` のように秒で変えられます。

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
| `everypath init [dir]` | 設定、性質、スキル、hook の例を置き、`.gitignore` に追記する |
| `everypath scan [dir] [--json] [--quiet]` | 一回スキャンして `.everypath/graph.json` を書く |
| `everypath check [dir] [--tlc [--timeout 秒]]` | 性質を検査する。違反があれば終了コード 1 |
| `everypath export [dir] --mermaid` | 状態と遷移を Mermaid の `stateDiagram-v2` にして標準出力に出す。README や PR に貼れる。何も書かない |
| `everypath tla export [dir]` | `.everypath/tla/Model.tla` と `Model.cfg` を書く |
| `everypath tla install` | `tla2tools.jar` を `~/.everypath/` に置く |
| `everypath serve [dir] [--port 4747] [--open]` | 監視して図を配るサーバーを起動する |
