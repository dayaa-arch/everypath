import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { readProofOutput } from "../src/core/prove.js";
import type { ProofTool } from "../src/core/types.js";

// docs/specs/proofs.md condition 4. Dafny and Verus are not installed here: every Dafny and Verus
// output below is a quotation from the tool's own repository, with its URL in the fixture's header.

const FIXTURES = fileURLToPath(new URL("./fixtures/proofs/", import.meta.url));

/** A fixture: `source:`, `exit:` and `note:` lines, a `---` line, then the quoted output as it is. */
async function quoted(path: string): Promise<{ output: string; code: number }> {
  const text = await readFile(`${FIXTURES}${path}`, "utf8");
  const split = text.indexOf("\n---\n");
  assert.ok(split > 0, `${path} has a --- line after its header`);
  const header = text.slice(0, split);
  const exit = /^exit: (\d+)$/m.exec(header)?.[1];
  assert.ok(/^source: https:\/\/github\.com\//m.test(header), `${path} cites its source`);
  assert.ok(exit !== undefined, `${path} gives the exit code`);
  return { output: text.slice(split + "\n---\n".length), code: Number(exit) };
}

async function read(tool: ProofTool, path: string) {
  return readProofOutput(tool, await quoted(path));
}

describe("prove: the Dafny reader, on dafny verify output from dafny-lang/dafny", () => {
  it("passes a run that verified everything, with the verifier's summary", async () => {
    assert.deepEqual(await read("dafny", "dafny/verified.txt"), {
      result: "passed",
      message: "Dafny program verifier finished with 1 verified, 0 errors",
    });
  });

  it("fails on assertions, with each Error line", async () => {
    assert.deepEqual(await read("dafny", "dafny/assertions.txt"), {
      result: "failed",
      message: [
        "Bug73.dfy(7,13): Error: assertion could not be proved",
        "Bug73.dfy(13,13): Error: assertion could not be proved",
      ].join("\n"),
    });
  });

  it("keeps the Related location that names the postcondition", async () => {
    assert.deepEqual(await read("dafny", "dafny/postcondition.txt"), {
      result: "failed",
      message: [
        "text.dfy(6,4): Error: a postcondition could not be proved on this return path",
        "text.dfy(2,12): Related location: this is the postcondition that could not be proved",
      ].join("\n"),
    });
  });

  it("fails on a verification time-out, without the source snippet", async () => {
    assert.deepEqual(await read("dafny", "dafny/timeout.txt"), {
      result: "failed",
      message:
        "defaultTimeLimit.dfy(5,7): Error: Verification of 'Foo' timed out after <redacted> seconds. (the limit can be increased using --verification-time-limit)",
    });
  });

  it("fails on a resolution error, with the count line", async () => {
    assert.deepEqual(await read("dafny", "dafny/resolution.txt"), {
      result: "failed",
      message: [
        "text.dfy(4,14): Error: literal (25) is too large for the bitvector type bv4",
        "1 resolution/type errors detected in text.dfy",
      ].join("\n"),
    });
  });

  it("fails a run that exits non-zero even when no line reads as an error", async () => {
    const { output } = await quoted("dafny/verified.txt");

    const verdict = readProofOutput("dafny", { output, code: 1 });

    assert.equal(verdict.result, "failed");
    assert.match(verdict.message, /終了コード 1/);
  });
});

describe("prove: the Verus reader, on output from verus-lang/verus", () => {
  it("passes a run that verified everything, with the results line in both of its forms", async () => {
    assert.deepEqual(await read("verus", "verus/verified.txt"), {
      result: "passed",
      message: "verification results:: 1 verified, 0 errors",
    });
    assert.deepEqual(await read("verus", "verus/verified-legacy.txt"), {
      result: "passed",
      message: "verification results:: verified: 1 errors: 0",
    });
  });

  it("fails on an assertion, with where it is and the code the label points at", async () => {
    assert.deepEqual(await read("verus", "verus/assertion.txt"), {
      result: "failed",
      message: [
        "getting_started.rs:19:12: assertion failed",
        "  assertion failed: assert(forall|i: int, j: int| min(i, j) == min(i, i));",
      ].join("\n"),
    });
  });

  it("names the precondition that failed, not only the call", async () => {
    assert.deepEqual(await read("verus", "verus/precondition.txt"), {
      result: "failed",
      message: [
        "filename.rs:18:5: precondition not satisfied",
        "  failed precondition: requires(b);",
      ].join("\n"),
    });
  });

  it("reads a diagnostic that has no --> line", async () => {
    assert.deepEqual(await read("verus", "verus/postcondition.txt"), {
      result: "failed",
      message: [
        "postcondition not satisfied",
        "  failed this postcondition: s1.intersect(s2).len() <= s1.len(),",
      ].join("\n"),
    });
  });
});

describe("prove: the command reader decides by the exit code alone", () => {
  it("passes exit 0 whatever the output says", () => {
    assert.deepEqual(readProofOutput("command", { output: "error: everything\n", code: 0 }), {
      result: "passed",
      message: "",
    });
  });

  it("fails any other exit code, with the code and the last lines of the output", () => {
    const output = `${Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;

    const verdict = readProofOutput("command", { output, code: 3 });

    assert.equal(verdict.result, "failed");
    const lines = verdict.message.split("\n");
    assert.equal(lines[0], "終了コード 3");
    assert.equal(lines.at(-1), "line 30");
    assert.ok(!lines.includes("line 1"), "only the end of a long output is kept");
  });
});
