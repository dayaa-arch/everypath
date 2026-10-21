// @state-hidden
// 画面遷移の土台。状態ではないので図には出さない。

export type Screen =
  | "ログイン"
  | "新規登録"
  | "Home"
  | "マイページ"
  | "ログアウト"
  | "パスワードリセット"
  | "ロック";

export type Transition = { readonly to: Screen };

export function navigate(to: Screen): Transition {
  return { to };
}
