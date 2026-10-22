// @state 新規登録
// @state-group 画面
// @state-desc メールとパスワードでアカウントを作り、ログイン画面に戻す
// @state-next ログイン on:signup_done
// @state-route /signup

import { saveUser } from "../db.js";
import { navigate, type Transition } from "../router.js";

export function signup(email: string, password: string): Transition {
  saveUser({ email, password });
  return navigate("ログイン");
}
