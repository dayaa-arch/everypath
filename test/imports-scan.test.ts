import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { analyze, scan } from "../src/core/scan.js";
import type { Graph } from "../src/core/types.js";
import { isScanInput } from "../src/core/workspace.js";
import { depPairs, deps, makeRepo, readGraph } from "./helpers/repo.js";

const T1 = new Date("2026-10-22T00:00:00.000Z");
const T2 = new Date("2026-10-22T01:00:00.000Z");
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));

const bulkRoots: string[] = [];

after(async () => {
  await Promise.all(bulkRoots.map((root) => rm(root, { recursive: true, force: true })));
});

/** `makeRepo` for a thousand files: the directories first, then the files in parallel, as a slow disk is idle between writes. */
async function bulkRepo(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "everypath-imports-"));
  bulkRoots.push(root);
  const entries = Object.entries(files);
  await Promise.all(
    [...new Set(entries.map(([path]) => dirname(join(root, path))))].map((dir) =>
      mkdir(dir, { recursive: true }),
    ),
  );
  for (let at = 0; at < entries.length; at += 64) {
    await Promise.all(
      entries.slice(at, at + 64).map(([path, content]) => writeFile(join(root, path), content)),
    );
  }
  return root;
}

const testedIds = (graph: Graph): string[] =>
  graph.nodes
    .filter((node) => node.status.tested)
    .map((node) => node.id)
    .sort();

describe("imports: fixtures", () => {
  const cases = [
    { dir: "imports-go", pairs: ["Main->Greet"], tested: ["Greet"] },
    { dir: "imports-rust", pairs: ["Lib->Greet"], tested: ["Greet"] },
    { dir: "imports-jvm", pairs: ["Main->Greeter"], tested: ["Greeter"] },
  ];
  for (const { dir, pairs, tested } of cases) {
    it(`${dir}: the small tree's dependencies and tested nodes`, async () => {
      const { graph } = await analyze(join(fixtures, dir), { now: T1 });

      assert.deepEqual(depPairs(graph), pairs);
      assert.deepEqual(testedIds(graph), tested);
      assert.deepEqual(graph.warnings, []);
    });
  }
});

describe("imports: a repository in all four languages", () => {
  const files = {
    "go/go.mod": "module example.com/svc\n\ngo 1.22\n",
    "go/main.go": '// @state GoMain\npackage main\n\nimport "example.com/svc/util"\n',
    "go/util/util.go": "// @state GoUtil\npackage util\n",
    "go/util/util_test.go": "package util\n",
    "rust/Cargo.toml": '[package]\nname = "svc"\n',
    "rust/src/lib.rs": "// @state RsLib\nmod util;\n",
    "rust/src/util.rs": "// @state RsUtil\n",
    "rust/tests/util.rs": "use svc::util::helper;\n",
    "jvm/src/main/java/svc/App.java": "// @state App\npackage svc;\n\nimport svc.util.Helper;\n",
    "jvm/src/main/kotlin/svc/util/Helper.kt": "// @state Helper\npackage svc.util\n",
    "jvm/src/test/kotlin/svc/AppTest.kt": "package svc\n\nimport svc.util.Helper\n",
  };

  it("writes the dependencies and tested marks to graph.json", async () => {
    const root = await makeRepo(files);

    await scan(root, { now: T1 });
    const graph = await readGraph(root);

    assert.deepEqual(depPairs(graph), ["App->Helper", "GoMain->GoUtil", "RsLib->RsUtil"]);
    assert.deepEqual(testedIds(graph), ["GoUtil", "Helper", "RsUtil"]);
  });

  it("changes nothing in the repository but .everypath (R-01)", async () => {
    const root = await makeRepo(files);
    const before = await hashTree(root);

    await scan(root, { now: T1 });

    assert.deepEqual(await hashTree(root), before);
  });
});

async function hashTree(root: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const path of (await readdir(root, { recursive: true })).sort()) {
    if (path === ".everypath" || path.startsWith(".everypath/")) continue;
    if (!(await stat(join(root, path))).isFile()) continue;
    hashes[path] = createHash("sha1")
      .update(await readFile(join(root, path)))
      .digest("hex");
  }
  return hashes;
}

describe("imports: manifests are scan inputs", () => {
  it("watches go.mod and Cargo.toml wherever the walk would read them", () => {
    const watched = ["go.mod", "svc/go.mod", "Cargo.toml", "crates/core/Cargo.toml"];
    const unwatched = [
      "node_modules/x/go.mod",
      "vendor/x/go.mod",
      "target/debug/Cargo.toml",
      "go.sum",
      "Cargo.lock",
      "go.mod.bak",
    ];
    for (const path of watched) assert.equal(isScanInput(path), true, path);
    for (const path of unwatched) assert.equal(isScanInput(path), false, path);
  });
});

/** One valid source per language, each with imports a mutation can damage. */
const CORPUS: readonly (readonly [string, string])[] = [
  [
    "go",
    `// @state Main
// import "example.com/m/ghost"
package main

import (
	"fmt"
	pay "example.com/m/pay" /* note */
	_ "example.com/m/metrics"
)

var s = \`import "example.com/m/ghost"\`
func main() { fmt.Println(pay.X, 'x', "}") }
`,
  ],
  [
    "rs",
    `// @state Lib
/* mod ghost; /* nested */ */
mod pay;
mod outer { fn f() { let c = '{'; } mod deep; }
#[path = "legacy/old.rs"]
mod old;
use crate::pay::{self, Money as M, *};
use super::super::util::Item;
const S: &str = r#"mod ghost; "x""#;
fn f<'a>(x: &'a str) -> &'a str { x }
`,
  ],
  [
    "java",
    `// @state Main
/* import m.ghost.G; */
package m.app;

import m.pay.Gateway;
import m.pay.*;
import static m.util.Money.cents;

class Main { String s = "import m.ghost.G;"; String t = """
  import m.ghost.G;
  """; }
`,
  ],
  [
    "kt",
    `// @state Main
@file:JvmName("MainKt")
package m.app

import m.pay.Gateway as G
import m.pay.*
/* outer /* inner */ import m.ghost.G */
val s = "import m.ghost.G"
`,
  ],
];

const INJECTIONS = ['"', "'", "`", "/*", "{", "(", 'r#"', "\\", "::", "@", "*/"];

function mutations(source: string): string[] {
  const out: string[] = [];
  const step = Math.max(1, Math.floor(source.length / 36));
  for (let at = 0; at < source.length; at += step) {
    out.push(source.slice(0, at));
    out.push(source.slice(0, at) + source.slice(at + 1));
    out.push(source.slice(0, at) + INJECTIONS[(at / step) % INJECTIONS.length] + source.slice(at));
  }
  return out;
}

describe("imports: damaged sources", () => {
  it("never throws, and reads the same thing twice, for 200+ truncated and corrupted files", async () => {
    const files: Record<string, string> = {
      "go.mod": "module example.com/m\n",
      "Cargo.toml": '[package]\nname = "m"\n',
      "src/main/java/m/pay/Gateway.java": "package m.pay;\nclass Gateway {}\n",
      "src/main/java/m/pay/Money.java": "package m.pay;\nclass Money {}\n",
      "pay/pay.go": "package pay\n",
      "metrics/metrics.go": "package metrics\n",
      "src/pay.rs": "",
    };
    let count = 0;
    for (const [extension, source] of CORPUS) {
      for (const mutated of mutations(source)) {
        files[`fuzz/${extension}/f${count}.${extension}`] = mutated;
        count += 1;
      }
    }
    assert.ok(count >= 200, `${count} variants`);
    const root = await bulkRepo(files);

    const first = await analyze(root, { now: T1 });
    const second = await analyze(root, { now: T1 });

    assert.ok(first.graph.nodes.length > 0);
    assert.deepEqual(first.graph.edges, second.graph.edges);
  });

  it("reads 300 KB of unterminated or deeply repeated syntax in linear time", async () => {
    const big = 300_000;
    const root = await makeRepo({
      "go.mod": "module example.com/m\n",
      "a.go": `package a\nimport (${'"x" '.repeat(big / 4)}`,
      "b.go": `package b\nimport "${"x".repeat(big)}`,
      "c.go": `package c\n/*${"/*".repeat(big / 2)}`,
      "a.rs": "{".repeat(big),
      "b.rs": "/*".repeat(big / 2),
      "c.rs": `use ${"a::{".repeat(big / 4)}`,
      "d.rs": `${"'a ".repeat(big / 3)}`,
      "e.rs": `r${"#".repeat(big)}"x`,
      "f.rs": `"${"x".repeat(big)}`,
      "A.java": `import ${"a.".repeat(big / 2)}`,
      "B.java": `${"@".repeat(big)}`,
      "C.java": `package p; ${"import a.B;\n".repeat(big / 12)}`,
      "D.kt": `${"@file:A(".repeat(big / 8)}`,
      "E.kt": `/*${"/*".repeat(big / 2)}`,
    });

    const started = performance.now();
    const { graph } = await analyze(root, { now: T1 });
    const elapsed = performance.now() - started;

    assert.equal(graph.nodes.flatMap((node) => node.files).length, 14);
    assert.ok(elapsed < 3000, `${elapsed.toFixed(0)} ms`);
  });
});

/** Runs a warmed scan three times and returns the CPU milliseconds of each. */
async function cpuRuns(root: string): Promise<number[]> {
  await scan(root, { now: T1 });
  const runs: number[] = [];
  for (let run = 0; run < 3; run += 1) {
    const started = process.cpuUsage();
    await scan(root, { now: T2 });
    const { user, system } = process.cpuUsage(started);
    runs.push((user + system) / 1000);
  }
  return runs;
}

const filler = (count: number, line: (k: number) => string): string =>
  Array.from({ length: count }, (_, k) => line(k)).join("\n");

describe("imports: the 1,000-file budget", () => {
  const within = (runs: number[]): string =>
    `runs took ${runs.map((ms) => ms.toFixed(0)).join(", ")} ms of CPU`;

  it("scans 1,000 Go files in 250 packages", async () => {
    const packages = 250;
    const files: Record<string, string> = { "go.mod": "module example.com/big\n\ngo 1.22\n" };
    for (let p = 0; p < packages; p += 1) {
      for (let f = 0; f < 4; f += 1) {
        files[`p${p}/f${f}.go`] =
          `// @state G${p}_${f}\npackage p${p}\n\nimport (\n\t"fmt"\n\t"example.com/big/p${(p + 1) % packages}"\n\t"example.com/big/p${(p + 2) % packages}"\n\t"github.com/x/y"\n)\n\n${filler(40, (k) => `func f${k}() int { return ${k} }`)}\n`;
      }
    }
    const root = await bulkRepo(files);

    const runs = await cpuRuns(root);

    const graph = await readGraph(root);
    assert.equal(graph.nodes.length, 1000);
    assert.equal(deps(graph).length, 8000);
    assert.ok(Math.min(...runs) < 1000, within(runs));
  });

  it("scans 1,000 Rust files in one crate", async () => {
    const modules = 999;
    const files: Record<string, string> = {
      "Cargo.toml": '[package]\nname = "big"\nversion = "0.1.0"\n',
      "src/lib.rs": `// @state Lib\n${filler(modules, (i) => `mod m${i};`)}\n`,
    };
    for (let i = 0; i < modules; i += 1) {
      files[`src/m${i}.rs`] =
        `// @state M${i}\n${filler(3, (k) => `use crate::m${(i + k + 1) % modules}::Item;`)}\n\n${filler(40, (k) => `pub fn f${k}() -> u32 { ${k} }`)}\n`;
    }
    const root = await bulkRepo(files);

    const runs = await cpuRuns(root);

    const graph = await readGraph(root);
    assert.equal(graph.nodes.length, 1000);
    assert.equal(deps(graph).length, 999 + 999 * 3);
    assert.ok(Math.min(...runs) < 1000, within(runs));
  });

  it("scans 1,000 Java files in 100 packages", async () => {
    const packages = 100;
    const files: Record<string, string> = {};
    for (let a = 0; a < packages; a += 1) {
      for (let b = 0; b < 10; b += 1) {
        const singles = filler(
          5,
          (k) => `import p${(a + 1) % packages}.C${(a + 1) % packages}_${(b + k) % 10};`,
        );
        files[`src/main/java/p${a}/C${a}_${b}.java`] =
          `// @state C${a}_${b}\npackage p${a};\n\nimport java.util.List;\n${singles}\nimport p${(a + 2) % packages}.*;\n\npublic class C${a}_${b} {\n${filler(40, (k) => `  int f${k}() { return ${k}; }`)}\n}\n`;
      }
    }
    const root = await bulkRepo(files);

    const runs = await cpuRuns(root);

    const graph = await readGraph(root);
    assert.equal(graph.nodes.length, 1000);
    assert.equal(deps(graph).length, 15_000);
    assert.ok(Math.min(...runs) < 1000, within(runs));
  });

  it("scans 1,000 Kotlin files in 100 packages", async () => {
    const packages = 100;
    const files: Record<string, string> = {};
    for (let a = 0; a < packages; a += 1) {
      for (let b = 0; b < 10; b += 1) {
        const singles = filler(
          5,
          (k) => `import p${(a + 1) % packages}.C${(a + 1) % packages}_${(b + k) % 10}`,
        );
        files[`src/main/kotlin/p${a}/C${a}_${b}.kt`] =
          `// @state C${a}_${b}\npackage p${a}\n\nimport kotlin.collections.List\n${singles}\nimport p${(a + 2) % packages}.*\n\nclass C${a}_${b} {\n${filler(40, (k) => `  fun f${k}() = ${k}`)}\n}\n`;
      }
    }
    const root = await bulkRepo(files);

    const runs = await cpuRuns(root);

    const graph = await readGraph(root);
    assert.equal(graph.nodes.length, 1000);
    assert.equal(deps(graph).length, 15_000);
    assert.ok(Math.min(...runs) < 1000, within(runs));
  });
});
