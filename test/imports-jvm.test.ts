import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyze } from "../src/core/scan.js";
import type { Graph } from "../src/core/types.js";
import { depPairs, makeRepo } from "./helpers/repo.js";

const NOW = new Date("2026-10-22T00:00:00.000Z");

/** A Java source that becomes the node `name`. */
const java = (name: string, pkg: string, ...imports: string[]): string =>
  `// @state ${name}\npackage ${pkg};\n\n${imports.map((i) => `import ${i};`).join("\n")}\n\npublic class ${name} {}\n`;

/** A Kotlin source that becomes the node `name`. */
const kotlin = (name: string, pkg: string, ...imports: string[]): string =>
  `// @state ${name}\npackage ${pkg}\n\n${imports.map((i) => `import ${i}`).join("\n")}\n\nclass ${name}\n`;

const graphOf = async (files: Record<string, string>): Promise<Graph> => {
  const { graph } = await analyze(await makeRepo(files), { now: NOW });
  return graph;
};

const testedIds = (graph: Graph): string[] =>
  graph.nodes
    .filter((node) => node.status.tested)
    .map((node) => node.id)
    .sort();

describe("imports: a Gradle-style tree", () => {
  const files = {
    "settings.gradle.kts": 'rootProject.name = "shop"\ninclude("app", "core")\n',
    "app/src/main/java/com/shop/app/Main.java": `// @state Main
package com.shop.app;

import com.shop.core.Cart;
import com.shop.core.Cart.Item;
import com.shop.core.pay.*;
import static com.shop.core.util.Money.cents;
import java.util.List;

public class Main {
    String ghost = "import com.shop.core.Ghost;";
}
`,
    "app/src/main/kotlin/com/shop/app/Checkout.kt": `// @state Checkout
@file:JvmName("CheckoutKt")

package com.shop.app

import com.shop.core.Cart as C
import com.shop.core.pay.Gateway
import com.shop.core.pay.Gateway.Companion.create
import com.shop.core.util.cents
import kotlin.collections.List

class Checkout
`,
    "app/src/test/kotlin/com/shop/app/MainTest.kt": kotlin(
      "MainTest",
      "com.shop.app",
      "com.shop.app.Main",
      "org.junit.Test",
    ),
    "core/src/main/java/com/shop/core/Cart.java": java(
      "Cart",
      "com.shop.core",
      "com.shop.core.util.Money",
    ),
    "core/src/main/java/com/shop/core/pay/Gateway.java": java(
      "Gateway",
      "com.shop.core.pay",
      "com.shop.core.Cart",
    ),
    "core/src/main/java/com/shop/core/pay/Receipt.java": java("Receipt", "com.shop.core.pay"),
    "core/src/main/kotlin/com/shop/core/util/Money.kt": kotlin("Money", "com.shop.core.util"),
    "core/src/test/java/com/shop/core/CartTest.java": java(
      "CartTest",
      "com.shop.core",
      "com.shop.core.pay.Gateway",
      "com.shop.core.fixtures.Fixture",
      "org.junit.Test",
    ),
    "core/src/test/java/com/shop/core/fixtures/Fixture.java": java(
      "Fixture",
      "com.shop.core.fixtures",
    ),
  };

  it("links Java and Kotlin files by import, wherever the module and source set", async () => {
    const graph = await graphOf(files);

    assert.deepEqual(depPairs(graph), [
      "Cart->Money",
      "Checkout->Cart",
      "Checkout->Gateway",
      "Gateway->Cart",
      "Main->Cart",
      "Main->Gateway",
      "Main->Money",
      "Main->Receipt",
    ]);
    assert.deepEqual(graph.warnings, []);
  });

  it("marks what src/test files import as tested, but not a same-package class they use without an import", async () => {
    const graph = await graphOf(files);

    assert.deepEqual(testedIds(graph), ["Gateway", "Main"]);
  });

  it("lets a test see its own module's test sources, and nothing else see them", async () => {
    const graph = await graphOf({
      ...files,
      "everypath.config.json": JSON.stringify({ includeTests: true }),
      "app/src/main/java/com/shop/app/UsesFixture.java": java(
        "UsesFixture",
        "com.shop.app",
        "com.shop.core.fixtures.Fixture",
      ),
      "app/src/test/kotlin/com/shop/app/AppFixtureTest.kt": kotlin(
        "AppFixtureTest",
        "com.shop.app",
        "com.shop.core.fixtures.Fixture",
      ),
    });

    const pairs = depPairs(graph);
    assert.ok(pairs.includes("CartTest->Fixture"), pairs.join(" "));
    assert.ok(pairs.includes("CartTest->Gateway"), pairs.join(" "));
    assert.ok(pairs.includes("MainTest->Main"), pairs.join(" "));
    assert.ok(!pairs.includes("UsesFixture->Fixture"), pairs.join(" "));
    assert.ok(!pairs.includes("AppFixtureTest->Fixture"), pairs.join(" "));
  });
});

describe("imports: Java and Kotlin import forms", () => {
  const sources = {
    "src/main/java/p/Outer.java": java("Outer", "p"),
    "src/main/java/p/Util.java": java("Util", "p"),
    "src/main/java/p/sub/Inner.java": java("Inner", "p.sub"),
    "src/main/java/p/sub/Other.kt": kotlin("Other", "p.sub"),
    "src/main/java/p/sub/deep/Deep.java": java("Deep", "p.sub.deep"),
  };

  it("resolves the longest class prefix for nested classes and static members", async () => {
    const graph = await graphOf({
      ...sources,
      "src/main/java/q/A.java": java(
        "A",
        "q",
        "p.Outer.Nested",
        "p.Outer.Nested.Kind",
        "static p.Util.helper",
      ),
      "src/main/java/q/B.java": java("B", "q", "static p.Util.*", "p.Outer.*"),
      "src/main/kotlin/q/C.kt": kotlin("C", "q", "p.Outer.Nested as N", "p.Util.Companion.make"),
    });

    assert.deepEqual(depPairs(graph), [
      "A->Outer",
      "A->Util",
      "B->Outer",
      "B->Util",
      "C->Outer",
      "C->Util",
    ]);
  });

  it("resolves a wildcard to the files directly in the package, not its subpackages", async () => {
    const graph = await graphOf({
      ...sources,
      "src/main/java/q/A.java": java("A", "q", "p.sub.*"),
      "src/main/kotlin/q/B.kt": kotlin("B", "q", "p.sub.deep.*"),
    });

    assert.deepEqual(depPairs(graph), ["A->Inner", "A->Other", "B->Deep"]);
  });

  it("accepts semicolons and aliases in Kotlin and ignores the packages of the JDK and libraries", async () => {
    const graph = await graphOf({
      ...sources,
      "src/main/kotlin/q/A.kt": `// @state A
package q;

import p.Outer;
import p.Util as U;
import java.util.List
import kotlinx.coroutines.flow.Flow
import org.junit.Test
`,
    });

    assert.deepEqual(depPairs(graph), ["A->Outer", "A->Util"]);
  });

  it("does not resolve a Kotlin top-level function, which no file name says", async () => {
    const graph = await graphOf({
      "src/main/kotlin/p/Helpers.kt": kotlin("Helpers", "p"),
      "src/main/kotlin/q/A.kt": kotlin("A", "q", "p.helper"),
    });

    assert.deepEqual(depPairs(graph), []);
  });

  it("uses the repository root as a source root, so a layout without src/main works", async () => {
    const graph = await graphOf({
      "com/shop/Root.java": java("Root", "com.shop"),
      "com/shop/other/Other.java": java("Other", "com.shop.other", "com.shop.Root"),
    });

    assert.deepEqual(depPairs(graph), ["Other->Root"]);
  });
});

describe("imports: Java and Kotlin modules", () => {
  it("prefers the importing module's own class and records nothing when two other modules both define it", async () => {
    const graph = await graphOf({
      "a/src/main/java/com/dup/Thing.java": java("ThingA", "com.dup"),
      "b/src/main/java/com/dup/Thing.java": java("ThingB", "com.dup"),
      "a/src/main/java/com/shop/UsesOwn.java": java("UsesOwn", "com.shop", "com.dup.Thing"),
      "c/src/main/java/com/shop/UsesEither.java": java("UsesEither", "com.shop", "com.dup.Thing"),
      "c/src/main/java/com/shop/UsesBoth.java": java("UsesBoth", "com.shop", "com.dup.*"),
    });

    assert.deepEqual(depPairs(graph), ["UsesBoth->ThingA", "UsesBoth->ThingB", "UsesOwn->ThingA"]);
  });

  it("keeps main files out of test sources, and records nothing for a test file that sees two classes of one name", async () => {
    const graph = await graphOf({
      "src/main/java/com/x/Config.java": java("Config", "com.x"),
      "src/test/java/com/x/Config.java": java("TestConfig", "com.x"),
      "src/test/java/com/y/UsesConfig.java": java("UsesConfig", "com.y", "com.x.Config"),
      "src/main/java/com/y/Plain.java": java("Plain", "com.y", "com.x.Config"),
      "everypath.config.json": JSON.stringify({ includeTests: true }),
    });

    assert.deepEqual(depPairs(graph), ["Plain->Config"]);
  });
});

describe("imports: Java and Kotlin comments and strings", () => {
  const ghosts = Object.fromEntries(
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [
      `src/main/java/ghost/G${n}.java`,
      java(`G${n}`, "ghost"),
    ]),
  );
  const reals = {
    "src/main/java/real/Real.java": java("Real", "real"),
    "src/main/java/real/Real2.java": java("Real2", "real"),
  };

  it("never reads an import from a comment or a string in Java", async () => {
    const graph = await graphOf({
      ...ghosts,
      ...reals,
      "src/main/java/q/A.java": `// @state A
/* import ghost.G1; */
package q;

// import ghost.G2;
/** import ghost.G3; */
import real.Real;   // import ghost.G4;
/* import ghost.G5; */ import real.Real2;

class A {
    String s = "import ghost.G6;";
    String t = """
        import ghost.G7;
        """;
}
`,
    });

    assert.deepEqual(depPairs(graph), ["A->Real", "A->Real2"]);
  });

  it("never reads an import from a comment or a string in Kotlin, with nested block comments", async () => {
    const graph = await graphOf({
      ...ghosts,
      ...reals,
      "src/main/kotlin/q/A.kt": `// @state A
@file:Suppress("import ghost.G9")
/* outer /* inner */ import ghost.G1 */
package q

// import ghost.G2
/** import ghost.G3 */
import real.Real // import ghost.G4
/* import ghost.G5 */ import real.Real2

val s = "import ghost.G6"
`,
    });

    assert.deepEqual(depPairs(graph), ["A->Real", "A->Real2"]);
  });
});
