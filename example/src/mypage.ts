// @state マイページ
// @state-group 画面
// @state-desc 登録メールの確認とログアウト
// @state-next Home on:back
// @state-next ログアウト on:logout set:authed=FALSE

import { clearSession, currentSession } from "./db.js";
import { navigate, type Transition } from "./router.js";

export function profileEmail(): string | null {
  return currentSession()?.email ?? null;
}

export function back(): Transition {
  return navigate("Home");
}

export function logout(): Transition {
  clearSession();
  return navigate("ログアウト");
}
