# everypath サンプル: ログイン画面

`SPEC.md` §0.1 の原案図（ログイン・新規登録・Home・マイページ・ログアウト）に、パスワードリセット・ロック・DB層 を足した 8 状態の小さなアプリです。変数は `authed`（ログイン済みか）と `retries`（ログイン失敗回数、0..3）の 2 つです。

このサンプルには、わざとバグを 1 つ入れてあります。

## 動かし方

リポジトリのルートで実行します。

```bash
npx tsx src/cli.ts scan example
```

`example/.everypath/graph.json` に状態 8、遷移 13、依存 5 のグラフが書かれます。`everypath serve example` で図を、`everypath check --tlc example` で全探索の結果を見られます。

## 入れてあるバグ

`src/auth/reset.ts` は、パスワードリセットが終わると Home へ進みます。ところがセッションを発行せず、注釈にも `authed` の更新がありません。

```ts
// @state-next Home on:reset_done
```

そのため「ログイン → パスワードリセット → Home」と進むと、`authed = FALSE` のまま Home に入れます。`everypath.properties.json` の `no-unauth-home`（未認証で Home・マイページにいない）が違反になり、TLC はこの 3 ステップを反例として返します。

## 直し方

`src/auth/reset.ts` の注釈とコードを両方直します。

1. 4 行目の注釈に `set:authed=TRUE` を足します。

   ```ts
   // @state-next Home on:reset_done set:authed=TRUE
   ```

2. 42 行目の `return navigate("Home");` の前でセッションを発行します。

   ```ts
   import { createSession, findUser, saveUser } from "../db.js";
   // ...
   pending.delete(email);
   createSession(email);
   return navigate("Home");
   ```

もう一度 `everypath check --tlc example` を実行すると、`no-unauth-home` が ok になります。

リセット後はログイン画面に戻す、という直し方でもかまいません。その場合は注釈を `@state-next ログイン on:reset_done` に、コードを `return navigate("ログイン");` に変えます。

## 性質

| id | 中身 | 出荷時の結果 |
|---|---|---|
| `no-unauth-home` | `authed` が偽のまま Home・マイページにいない | 違反（上のバグ） |
| `lock-after-3` | `retries` は 3 を超えない | ok |
| `logout-eventually-login` | ログアウトしたら、いつかログイン画面に戻る | ok |
| `no-dead-end` | ロックと DB層 のほかに出口の無い状態が無い | ok |

DB層 は画面から import されるデータ層で、遷移を持ちません。そのため `no-dead-end` の除外に入れています。

## テスト済みの印

`test/auth.test.ts` はログイン・新規登録・Home を import しているので、この 3 状態がテスト済みになります。残りの 5 状態は未テストのままです。
