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
// @state-desc メールとパスワードで認証する。4 回目の失敗でロックする

import { createSession, findUser } from "../db.js";
import { navigate, type Transition } from "../router.js";

export const MAX_RETRIES = 3;

let retries = 0;

export function login(email: string, password: string): Transition {
  const user = findUser(email);
  if (user !== undefined && user.password === password) {
    createSession(email);
    retries = 0;
    return navigate("Home");
  }
  if (retries < MAX_RETRIES) {
    retries += 1;
    return navigate("ログイン");
  }
  return navigate("ロック");
}

export function openSignup(): Transition {
  return navigate("新規登録");
}

export function forgotPassword(): Transition {
  return navigate("パスワードリセット");
}
