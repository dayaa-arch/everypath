// @state ログアウト
// @state-group 画面
// @state-status wip
// @state-desc ログアウトしたことを伝えてログイン画面に戻す
// @state-next ログイン
// @state-route /logout

import { navigate, type Transition } from "../router.js";

export function finishLogout(): Transition {
  return navigate("ログイン");
}
