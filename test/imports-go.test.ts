import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyze } from "../src/core/scan.js";
import type { Graph } from "../src/core/types.js";
import { depPairs, makeRepo } from "./helpers/repo.js";

const NOW = new Date("2026-10-22T00:00:00.000Z");

/** A Go source that becomes the node `name`: the tag comment, the package clause, then `rest`. */
const go = (name: string, pkg: string, rest = ""): string =>
  `// @state ${name}\npackage ${pkg}\n\n${rest}`;

const graphOf = async (files: Record<string, string>): Promise<Graph> => {
  const { graph } = await analyze(await makeRepo(files), { now: NOW });
  return graph;
};

const testedIds = (graph: Graph): string[] =>
  graph.nodes
    .filter((node) => node.status.tested)
    .map((node) => node.id)
    .sort();

const MODULE = "module example.com/shop\n\ngo 1.22\n\nrequire github.com/google/uuid v1.6.0\n";

describe("imports: Go module", () => {
  const files = {
    "go.mod": MODULE,
    "cmd/shop/main.go": go(
      "Shop",
      "main",
      `import (
	"fmt"
	"net/http"

	"example.com/shop/internal/cart"
	pay "example.com/shop/internal/payment"
	_ "example.com/shop/internal/metrics"
	. "example.com/shop/internal/dot"
	"github.com/google/uuid"
)

func main() { fmt.Println(http.StatusOK, cart.Total, pay.Charge, uuid.New()) }
`,
    ),
    "internal/cart/cart.go": go(
      "Cart",
      "cart",
      'import "example.com/shop/internal/store"\n\nvar _ = store.Open\n',
    ),
    "internal/cart/totals.go": go("Totals", "cart"),
    "internal/cart/cart_test.go":
      'package cart\n\nimport "testing"\n\nfunc TestTotal(t *testing.T) {}\n',
    "internal/payment/pay.go": go("Pay", "payment"),
    "internal/payment/pay_test.go": `package payment_test

import (
	"testing"

	"example.com/shop/internal/payment"
)

func TestCharge(t *testing.T) { _ = payment.Charge }
`,
    "internal/metrics/metrics.go": go("Metrics", "metrics"),
    "internal/dot/dot.go": go("Dot", "dot"),
    "internal/store/store.go": go("Store", "store"),
  };

  it("links a file to every non-test file of each package it imports, and nothing else", async () => {
    const graph = await graphOf(files);

    assert.deepEqual(depPairs(graph), [
      "Cart->Store",
      "Shop->Cart",
      "Shop->Dot",
      "Shop->Metrics",
      "Shop->Pay",
      "Shop->Totals",
    ]);
    assert.deepEqual(graph.warnings, []);
  });

  it("marks the files a _test.go imports, and its own package, as tested", async () => {
    const graph = await graphOf(files);

    assert.deepEqual(testedIds(graph), ["Cart", "Pay", "Totals"]);
  });

  it("keeps a node untested until every one of its files is tested", async () => {
    const withSub = { ...files, "internal/payment/sub/sub.go": go("Pay", "sub") };

    const partial = await graphOf(withSub);
    const whole = await graphOf({
      ...withSub,
      "internal/payment/sub/sub_test.go": "package sub\n",
    });

    const status = (graph: Graph) => graph.nodes.find((node) => node.id === "Pay")?.status.tested;
    assert.deepEqual(partial.nodes.find((node) => node.id === "Pay")?.files, [
      "internal/payment/pay.go",
      "internal/payment/sub/sub.go",
    ]);
    assert.equal(status(partial), false);
    assert.equal(status(whole), true);
  });

  it("turns a test file under includeTests into a node that depends on its own package", async () => {
    const graph = await graphOf({
      ...files,
      "everypath.config.json": JSON.stringify({ includeTests: true }),
    });

    assert.deepEqual(
      depPairs(graph).filter((pair) => pair.startsWith("cart_test") || pair.startsWith("pay_test")),
      ["cart_test->Cart", "cart_test->Totals", "pay_test->Pay"],
    );
  });
});

describe("imports: Go import forms", () => {
  it("reads single, grouped, aliased, blank, dot, raw-string and semicolon-separated imports", async () => {
    const graph = await graphOf({
      "go.mod": MODULE,
      "main.go": go(
        "Main",
        "main",
        `import "example.com/shop/p/one"
import two "example.com/shop/p/two"
import _ "example.com/shop/p/three"
import . "example.com/shop/p/four"
import \`example.com/shop/p/five\`
import ("example.com/shop/p/six"; "example.com/shop/p/seven")
import (
)
import (
	eight "example.com/shop/p/eight"
)
`,
      ),
      "p/one/a.go": go("One", "one"),
      "p/two/a.go": go("Two", "two"),
      "p/three/a.go": go("Three", "three"),
      "p/four/a.go": go("Four", "four"),
      "p/five/a.go": go("Five", "five"),
      "p/six/a.go": go("Six", "six"),
      "p/seven/a.go": go("Seven", "seven"),
      "p/eight/a.go": go("Eight", "eight"),
    });

    assert.deepEqual(depPairs(graph), [
      "Main->Eight",
      "Main->Five",
      "Main->Four",
      "Main->One",
      "Main->Seven",
      "Main->Six",
      "Main->Three",
      "Main->Two",
    ]);
  });

  it("resolves the module's own path to the files at its root", async () => {
    const graph = await graphOf({
      "go.mod": MODULE,
      "lib.go": go("Lib", "shop"),
      "cmd/x/main.go": go("X", "main", 'import "example.com/shop"\n'),
    });

    assert.deepEqual(depPairs(graph), ["X->Lib"]);
  });

  it("reads only the import section, so a later string that looks like an import is nothing", async () => {
    const graph = await graphOf({
      "go.mod": MODULE,
      "main.go": go(
        "Main",
        "main",
        `import "example.com/shop/p/real"

var doc = \`import "example.com/shop/p/ghost5"\`
var s = "import \\"example.com/shop/p/ghost6\\""

func f() {}
`,
      ),
      "p/real/a.go": go("Real", "real"),
      "p/ghost5/a.go": go("Ghost5", "ghost5"),
      "p/ghost6/a.go": go("Ghost6", "ghost6"),
    });

    assert.deepEqual(depPairs(graph), ["Main->Real"]);
  });
});

describe("imports: Go comments", () => {
  it("never reads an import from a line comment, a block comment, or one inside a group", async () => {
    const graph = await graphOf({
      "go.mod": MODULE,
      "main.go": `// @state Main
// import "example.com/shop/p/ghost1"
/* import "example.com/shop/p/ghost2" */
package main

// import "example.com/shop/p/ghost3"
/* import "example.com/shop/p/ghost4" */
import (
	// "example.com/shop/p/ghost5"
	"example.com/shop/p/real" /* "example.com/shop/p/ghost6" */
	/* alias */ r2 "example.com/shop/p/real2" // "example.com/shop/p/ghost7"
	/*
	"example.com/shop/p/ghost8"
	*/
)
`,
      "p/real/a.go": go("Real", "real"),
      "p/real2/a.go": go("Real2", "real2"),
      ...Object.fromEntries(
        [1, 2, 3, 4, 5, 6, 7, 8].map((n) => [`p/ghost${n}/a.go`, go(`Ghost${n}`, `ghost${n}`)]),
      ),
    });

    assert.deepEqual(depPairs(graph), ["Main->Real", "Main->Real2"]);
  });
});

describe("imports: Go modules", () => {
  it("resolves by the longest module path and keeps a nested module out of its parent", async () => {
    const graph = await graphOf({
      "go.mod": MODULE,
      "tools/go.mod": "module example.org/tools\n\ngo 1.22\n",
      "tools/lint/lint.go": go("Lint", "lint", 'import "example.com/shop/internal/cart"\n'),
      "tools/other/other.go": go("Other", "other"),
      "internal/cart/cart.go": go("Cart", "cart"),
      "main.go": go(
        "Main",
        "main",
        `import (
	"example.org/tools/lint"
	"example.com/shop/tools/other"
)
`,
      ),
    });

    assert.deepEqual(depPairs(graph), ["Lint->Cart", "Main->Lint"]);
    const main = graph.edges.find((edge) => edge.type === "dep" && edge.from === "Main");
    assert.deepEqual(main?.via, ["main.go"]);
  });

  it("reads quoted, block, commented and byte-order-marked CRLF module lines", async () => {
    const graph = await graphOf({
      "a/go.mod": '// the first module\nmodule "example.com/quoted" // trailing\n\ngo 1.22\n',
      "a/q/q.go": go("Q", "q"),
      "b/go.mod": "module (\n\texample.com/blocky\n)\n",
      "b/k/k.go": go("K", "k"),
      "d/go.mod": "\uFEFFmodule example.com/windows\r\n\r\ngo 1.22\r\n",
      "d/w/w.go": go("W", "w"),
      "c/go.mod": "module example.com/user\n",
      "c/main.go": go(
        "User",
        "main",
        'import (\n\t"example.com/quoted/q"\n\t"example.com/blocky/k"\n\t"example.com/windows/w"\n)\n',
      ),
    });

    assert.deepEqual(depPairs(graph), ["User->K", "User->Q", "User->W"]);
  });

  it("records nothing for a module path two go.mod files both claim", async () => {
    const graph = await graphOf({
      "a/go.mod": "module example.com/dup\n",
      "a/x/x.go": go("AX", "x"),
      "b/go.mod": "module example.com/dup\n",
      "b/x/x.go": go("BX", "x"),
      "c/go.mod": "module example.com/user\n",
      "c/main.go": go("User", "main", 'import "example.com/dup/x"\n'),
    });

    assert.deepEqual(depPairs(graph), []);
  });

  it("records nothing without a go.mod, but a _test.go still tests its own directory", async () => {
    const graph = await graphOf({
      "main.go": go("Main", "main", 'import "example.com/shop/p/real"\n'),
      "p/real/a.go": go("Real", "real"),
      "p/real/a_test.go": "package real\n",
    });

    assert.deepEqual(depPairs(graph), []);
    assert.deepEqual(testedIds(graph), ["Real"]);
  });

  it("does not map a standard-library path onto a directory of the same name", async () => {
    const graph = await graphOf({
      "go.mod": "module fmt\n",
      "main.go": go("Main", "main", 'import (\n\t"os"\n\t"net/http"\n\t"C"\n)\n'),
      "net/http/h.go": go("H", "http"),
    });

    assert.deepEqual(depPairs(graph), []);
  });
});
