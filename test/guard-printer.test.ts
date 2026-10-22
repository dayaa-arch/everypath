import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { edgeLabel, parseGuard, printGuard } from "../src/core/expr.js";
import type { GuardExpr } from "../src/core/types.js";
import { eventName } from "./helpers/ui-fixtures.js";

function guard(text: string): GuardExpr {
  const parsed = parseGuard(text);
  assert.ok(parsed.ok, `${text}: ${parsed.ok ? "" : parsed.warning.message}`);
  return parsed.value;
}

/**
 * Every operator of SPEC §5.1, and each place the precedence `||` < `&&` < `!` needs brackets or not.
 * The right column is what a reader of SPEC §5.1 writes for the left one with the fewest brackets.
 */
const PRINTED: readonly (readonly [string, string])[] = [
  ["a", "a"],
  ["a==TRUE", "a"],
  ["a==FALSE", "a==FALSE"],
  ["!a", "!a"],
  ["!(!a)", "!!a"],
  ["n<3", "n<3"],
  ["n<=3 && n>=1", "n<=3 && n>=1"],
  ["n>0 || n!=2", "n>0 || n!=2"],
  ["mode==busy", "mode==busy"],
  ["mode!=done && !b", "mode!=done && !b"],
  ["(a || b) && !(n==2)", "(a || b) && !(n==2)"],
  ["(a && b) || c", "a && b || c"],
  ["a && (b || c) && d", "a && (b || c) && d"],
  ["!(a && b)", "!(a && b)"],
  ["!(a || b)", "!(a || b)"],
  ["!(n<3)", "!(n<3)"],
];

describe("printGuard (docs/specs/viewer-drift.md condition 6)", () => {
  for (const [input, printed] of PRINTED) {
    it(`prints ${input} as ${printed}, which parses back to the same guard`, () => {
      const expr = guard(input);

      assert.equal(printGuard(expr), printed);
      assert.deepEqual(guard(printGuard(expr)), expr);
    });
  }
});

describe("edgeLabel", () => {
  it("is the event, then the guard in brackets, with either left out when absent", () => {
    const loginFail = eventName("login_fail");

    assert.equal(
      edgeLabel({ event: loginFail, guard: guard("retries<3") }),
      "login_fail [retries<3]",
    );
    assert.equal(edgeLabel({ event: loginFail, guard: null }), "login_fail");
    assert.equal(edgeLabel({ event: null, guard: guard("!authed") }), "[!authed]");
    assert.equal(edgeLabel({ event: null, guard: null }), "");
  });
});

const srcDir = fileURLToPath(new URL("../src", import.meta.url));

describe("one guard printer", () => {
  it("defines printGuard and edgeLabel in src/core/expr.ts and nowhere else under src", async () => {
    const entries = await readdir(srcDir, { recursive: true, withFileTypes: true });
    const defining: string[] = [];
    for (const entry of entries.filter((e) => e.isFile() && e.name.endsWith(".ts"))) {
      const path = join(entry.parentPath, entry.name);
      const text = await readFile(path, "utf8");
      if (/\bfunction\s+(?:printGuard|edgeLabel)\s*\(/.test(text)) {
        defining.push(relative(srcDir, path));
      }
    }

    assert.deepEqual(defining, [join("core", "expr.ts")]);
  });
});
