import assert from "node:assert/strict";
import { it } from "node:test";
import { login } from "../src/auth/login.js";
import { signup } from "../src/auth/signup.js";
import { greeting } from "../src/home.js";

it("登録したパスワードでログインすると Home に進む", () => {
  assert.deepEqual(signup("a@example.com", "pw"), { to: "ログイン" });
  assert.deepEqual(login("a@example.com", "pw"), { to: "Home" });
  assert.equal(greeting(), "ようこそ、a@example.com さん");
});

it("4 回目の失敗でロックする", () => {
  for (let i = 0; i < 3; i++) assert.deepEqual(login("b@example.com", "x"), { to: "ログイン" });
  assert.deepEqual(login("b@example.com", "x"), { to: "ロック" });
});
