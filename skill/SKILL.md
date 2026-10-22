---
name: everypath
description: このリポジトリの機能・画面・モジュールを作る、変える、消すときに使う。ファイル先頭のコメントに `@state` で状態と遷移を宣言し、`npx everypath check` で検査してから報告する。
---

# everypath

everypath は、ソースファイルの先頭 60 行にあるコメントの `@state` タグからステートチャートを作る。人間はそれを図でレビューし、TLA+ のモデル検査（TLC）がありうる経路をすべて調べる。コメントは `//`、`#`、`/* */`、`"""` のどれでもよい。

## 守ること

1. 新しい機能・画面・モジュールを作るときは、ファイル先頭に `@state` と `@state-next` を必ず書く。URL で開く画面には `@state-route <パス>` も書く（`/users/:id` の `:id` は任意の 1 セグメントに当たる）。
   理由: 人間がレビューのために、全体像を図で追っているため。`@state-route` があると、コードの `router.push('/x')` や `<Link href="/x">` が宣言と突き合わされ、`@state-next` に無い遷移が `graph.json` の `drift` に出る。
2. 遷移にはできるだけ `on:`（イベント）を付ける。条件分岐があるなら `if:` と `@state-var` で変数として表す。
   理由: この宣言から TLA+ が生成され、全パターンが検査される。イベントもガードも無い遷移は「いつでも起きうる」とみなされ、検査が粗くなる。
3. 変数の型は `BOOLEAN`、小さい範囲の整数（`0..3`）、列挙（`{guest,member,admin}`）のどれかにする。文字列や上限の無い整数はモデルに入れない。
   理由: 全探索を有限時間で終えるため。
4. 実装する前に `@state-next` で遷移を宣言してよい。
   理由: まだファイルの無い遷移先は計画ノードとして図に出るので、人間が着手前に経路を確かめられる。
5. 機能を作ったら `npx everypath check` を実行し、違反を直してから完了を報告する。`npx everypath check --tlc` は人間に言われたときだけ実行する。
   理由: 簡易検査はすぐ終わるが、TLC は全探索なので時間がかかる。
6. 性質（`everypath.properties.json`）を足したいときは、報告に提案として書く。自分では書き込まない。
   理由: 性質は人間が承認するレビュー対象のため。
7. 認証・決済・権限に関わる状態には、`@state-spec` で条件を書き、`@state-require proof` を付ける。
   理由: 壊れたときの被害が大きく、証明が付くまで完了扱いにしないことを図に示すため。
8. 外部に見せない設定や型定義のファイルには `@state-hidden` を書く。
   理由: 状態でないファイルが箱として並ぶと、図が読みにくくなるため。
9. 自分で気づいたリスクは `@state-risk` に正直に書く。
   理由: スキャナの指摘とは別の印で表示されるので、書いて損はない。
10. 作業の前に `.everypath/graph.json` を読む。`nodes[].status.reviewed` が `true` の状態のファイル（`nodes[].files`）を変えたら、変えた理由を最終報告に書く。
    理由: ファイルが変わると人間の承認が外れ、もう一度確認してもらう必要があるため。
11. `.everypath/` の中と `everypath.*.json` は変更しない。
    理由: `.everypath/` は everypath が書く生成物と承認の記録で、`everypath.*.json` は人間が決める設定と性質のため。

## タグ

| タグ | 意味 |
|---|---|
| `@state <名前>` | このファイルが属する状態。省略するとファイル名（拡張子を除く）。`index`、`__init__`、`main` はディレクトリ名 |
| `@state-next <状態> [on:<イベント>] [if:<ガード>] [set:<代入>]` | 遷移先。1 行に 1 本 |
| `@state-route <パス>` | この状態を開く URL パス。1 行に 1 つで、何行でも書ける。`:名前` は任意の 1 セグメント |
| `@state-var <名前>: <型> = <初期値>` | 変数。どのファイルで宣言してもモデル全体で 1 つ |
| `@state-initial` | 初期状態 |
| `@state-event <名前>, <名前>` | この状態で起きうるイベント。`on:` に書いたものは不要 |
| `@state-group <名前>` | 図の上のまとまり（画面、API、データ層など） |
| `@state-desc <文>` | 1 行の説明 |
| `@state-status wip` | 作業中 |
| `@state-spec <文>` | 事前条件・事後条件・不変条件。1 行に 1 つ |
| `@state-require proof` | 証明が要る状態 |
| `@state-risk <文>` | 自分で気づいたリスク |
| `@state-tested` | テストの自動検出が効かないときに、テスト済みと宣言する |
| `@state-hidden` | 図に出さない |

`if:` に書けるのは、変数、変数と値の比較（`==`、`!=`、`<`、`<=`、`>`、`>=`）、`!`、`&&`、`||`、括弧だけ。`set:` は `名前=値` をカンマで並べ、値は `TRUE`、`FALSE`、整数、列挙の要素、`名前+1`、`名前-1` のどれか。これ以外の式は警告になり、その遷移はガード無しとして扱われる。

## 例

ログイン画面。

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

パスワードリセット。遷移で変数が変わるなら `set:` に書く。`set:authed=TRUE` が無いと、未認証のまま Home に入る経路が TLC の反例になる。

```ts
// @state パスワードリセット
// @state-group 画面
// @state-desc 登録メールに届いた確認コードで新しいパスワードを設定する
// @state-next Home on:reset_done set:authed=TRUE
// @state-next パスワードリセット on:code_invalid
// @state-next ログイン on:cancel
// @state-spec requires code.valid && !code.expired
// @state-require proof
// @state-risk 確認コードの試行回数に上限が無い
```

状態ではないファイル。

```ts
// @state-hidden
// 画面遷移の土台。状態ではないので図には出さない。
```

## check の読み方

`npx everypath check` は性質ごとに `成立`、`違反`、`保留`、`エラー` のどれかを 1 行で出す。違反には `ログイン →(forgot) パスワードリセット →(reset_done) Home` の形で反例の経路が付く。違反があるか、`everypath.properties.json` に読めない性質があると、終了コードは 1 になる。`保留` は TLC でしか決まらない性質で、直す対象ではない。

## 性質を提案するとき

報告には、`everypath.properties.json` の `properties` に足す形で書く。

```json
{ "id": "no-unauth-home", "kind": "invariant", "description": "未認証で Home・マイページにいない", "expr": "state in {Home, マイページ} => authed" }
```

| kind | 意味 | 項目 |
|---|---|---|
| `invariant` | `expr` が到達できるすべての状態で真 | `expr` |
| `leads-to` | `from` が真になったら、いつか `to` が真になる | `from`、`to` |
| `never-reach` | 入口から `avoid` を通らずに `target` へ行けない | `target`、`avoid` |
| `always-reach` | どの状態からも `target` のどれかへ行ける | `target` |
| `no-dead-end` | `except` 以外のすべての状態に出ていく遷移がある | `except` |

`expr`、`from`、`to` は `if:` と同じ式に、`state == 名前`、`state in {名前, 名前}`、含意の `=>` を加えたもの。
