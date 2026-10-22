// @state パスワードリセット
// @state-group 画面
// @state-desc 登録メールに届いた確認コードで新しいパスワードを設定する
// @state-next Home on:reset_done
// @state-next パスワードリセット on:code_invalid
// @state-next ログイン on:cancel
// @state-risk リセット完了後にセッションを発行しているか未確認
// @state-route /reset
import { findUser, saveUser } from "../db.js";
import { navigate, type Transition } from "../router.js";

const CODE_TTL_MS = 10 * 60 * 1000;

type PendingReset = { readonly code: string; readonly expiresAt: number };

const pending = new Map<string, PendingReset>();

/** 確認コードを発行する。実際のアプリではここでメールを送る。 */
export function requestReset(email: string, now = Date.now()): string | null {
  if (findUser(email) === undefined) return null;
  const code = String(Math.floor(100000 + Math.random() * 900000));
  pending.set(email, { code, expiresAt: now + CODE_TTL_MS });
  return code;
}

function verifyCode(email: string, code: string, now: number): boolean {
  const entry = pending.get(email);
  if (entry === undefined || entry.expiresAt < now) return false;
  return entry.code === code;
}

/** コードが合えば新しいパスワードを保存して Home へ進む。 */
export function completeReset(
  email: string,
  code: string,
  newPassword: string,
  now = Date.now(),
): Transition {
  if (!verifyCode(email, code, now)) return navigate("パスワードリセット");
  saveUser({ email, password: newPassword });
  pending.delete(email);
  return navigate("Home");
}

export function cancelReset(): Transition {
  return navigate("ログイン");
}
