// @state Home
// @state-group 画面
// @state-desc ログイン後の最初の画面
// @state-next マイページ on:open_mypage

import { currentSession } from "./db.js";
import { navigate, type Transition } from "./router.js";

export function greeting(): string {
  const session = currentSession();
  return session === null ? "ようこそ" : `ようこそ、${session.email} さん`;
}

export function openMypage(): Transition {
  return navigate("マイページ");
}
