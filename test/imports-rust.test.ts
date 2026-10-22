import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyze } from "../src/core/scan.js";
import type { Graph } from "../src/core/types.js";
import { depPairs, makeRepo } from "./helpers/repo.js";

const NOW = new Date("2026-10-22T00:00:00.000Z");

/** A Rust source that becomes the node `name`. */
const rs = (name: string, rest = ""): string => `// @state ${name}\n${rest}`;

const graphOf = async (files: Record<string, string>): Promise<Graph> => {
  const { graph } = await analyze(await makeRepo(files), { now: NOW });
  return graph;
};

const testedIds = (graph: Graph): string[] =>
  graph.nodes
    .filter((node) => node.status.tested)
    .map((node) => node.id)
    .sort();

const cargo = (name: string, extra = ""): string =>
  `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n\n${extra}`;

describe("imports: a Cargo crate", () => {
  const files = {
    "Cargo.toml": cargo("shop-core", '[dependencies]\nserde = "1"\n'),
    "src/lib.rs": rs(
      "Lib",
      `pub mod cart;
pub mod pay;
pub mod util;

use crate::util::money::Money;
use serde::Serialize;
use std::collections::HashMap;
use ghost::Thing;
`,
    ),
    "src/ghost.rs": rs("Ghost", "pub struct Thing;\n"),
    "src/items.rs": rs("Decoy"),
    "src/cart.rs": rs(
      "Cart",
      `mod items;
use crate::pay::Gateway;
use std::fmt;

pub struct Cart;

#[cfg(test)]
mod tests;
`,
    ),
    "src/cart/items.rs": rs("Items", "use super::Cart;\n"),
    "src/cart/tests.rs": "use super::*;\n\n#[test]\nfn totals() {}\n",
    "src/pay/mod.rs": rs("Pay", "mod gateway;\npub use self::gateway::Gateway;\n"),
    "src/pay/gateway.rs": rs(
      "Gateway",
      `use crate::util::{self, money::{Money as M, Cents}};
use super::super::util::money::Money;

pub struct Gateway;
`,
    ),
    "src/util.rs": rs("Util", "pub mod money;\n"),
    "src/util/money.rs": rs("Money", "pub struct Money;\npub struct Cents;\n"),
    "src/main.rs": rs(
      "Main",
      "use shop_core::cart::Cart;\nuse shop_core::{pay::Gateway, util};\n\nfn main() {}\n",
    ),
    "tests/checkout.rs": `use shop_core::cart::Cart;
use shop_core::pay::Gateway;
use shop_core::util::money::Money;

mod common;

#[test]
fn pays() {}
`,
    "tests/common/mod.rs": "pub fn setup() {}\n",
  };

  it("follows mod declarations, crate:: self:: super:: paths and the crate's own name", async () => {
    const graph = await graphOf(files);

    assert.deepEqual(depPairs(graph), [
      "Cart->Items",
      "Cart->Pay",
      "Gateway->Money",
      "Gateway->Util",
      "Items->Cart",
      "Lib->Cart",
      "Lib->Money",
      "Lib->Pay",
      "Lib->Util",
      "Main->Cart",
      "Main->Pay",
      "Main->Util",
      "Pay->Gateway",
      "Util->Money",
    ]);
    assert.deepEqual(graph.warnings, []);
  });

  it("marks what tests/ and a tests.rs module import as tested", async () => {
    const graph = await graphOf(files);

    assert.deepEqual(testedIds(graph), ["Cart", "Money", "Pay"]);
  });
});

describe("imports: Rust mod declarations", () => {
  it("looks beside mod.rs and crate roots, under the stem for other files, and inside inline modules", async () => {
    const graph = await graphOf({
      "Cargo.toml": cargo("m"),
      "src/lib.rs": rs(
        "Lib",
        `mod plain;
mod dir;
mod both;
mod missing;
mod outer {
    fn f() { let c = '{'; let s = "}"; /* } */ }
    mod deep;
}
#[path = "legacy/old_impl.rs"]
mod old;
mod p {
    #[path = "inner.rs"]
    mod q;
}
`,
      ),
      "src/plain.rs": rs("Plain"),
      "src/dir/mod.rs": rs("Dir"),
      "src/both.rs": rs("BothFile"),
      "src/both/mod.rs": rs("BothDir"),
      "src/outer/deep.rs": rs("Deep"),
      "src/legacy/old_impl.rs": rs("Old"),
      "src/p/q.rs": rs("Q"),
      "src/p/inner.rs": rs("Inner"),
    });

    assert.deepEqual(depPairs(graph), ["Lib->Deep", "Lib->Dir", "Lib->Old", "Lib->Plain"]);
  });

  it("treats src/bin and tests/ files as crate roots that look beside themselves", async () => {
    const graph = await graphOf({
      "Cargo.toml": cargo("m"),
      "everypath.config.json": JSON.stringify({ includeTests: true }),
      "src/bin/tool.rs": rs("Tool", "mod helper;\n"),
      "src/bin/helper.rs": rs("Helper"),
      "src/bin/multi/main.rs": rs("Multi", "mod util;\n"),
      "src/bin/multi/util.rs": rs("MultiUtil"),
      "tests/it.rs": rs("It", "mod support;\n"),
      "tests/support/mod.rs": rs("Support"),
    });

    assert.deepEqual(depPairs(graph), ["It->Support", "Multi->MultiUtil", "Tool->Helper"]);
  });
});

describe("imports: Rust use paths", () => {
  it("expands braces, as and globs, and starts from crate, self, super or a declared child", async () => {
    const graph = await graphOf({
      "Cargo.toml": cargo("m"),
      "src/lib.rs": rs(
        "Lib",
        `mod a;
mod b;
mod local;
use local::thing;
use ghost::Thing;
use ::std::io;
use std::collections::HashMap;
use core::fmt;
use alloc::vec::Vec;
use serde::{Serialize, Deserialize};
`,
      ),
      "src/ghost.rs": rs("Ghost"),
      "src/local.rs": rs("Local"),
      "src/a.rs": rs(
        "A",
        `mod sub;
use self::sub::X;
use self::sub as alias;
use super::b::{self, Y as Z};
use crate::b::*;
`,
      ),
      "src/a/sub.rs": rs(
        "Sub",
        "use super::super::b::Y;\nuse super::super::super::b::Y as Beyond;\n",
      ),
      "src/b.rs": rs("B"),
    });

    assert.deepEqual(depPairs(graph), [
      "A->B",
      "A->Sub",
      "Lib->A",
      "Lib->B",
      "Lib->Local",
      "Sub->B",
    ]);
  });

  it("knows crate::Item only when the crate has one root file", async () => {
    const graph = await graphOf({
      "crates/one/Cargo.toml": cargo("one"),
      "crates/one/src/lib.rs": rs("One"),
      "crates/one/src/a.rs": rs("A", "use crate::Thing;\n"),
      "crates/two/Cargo.toml": cargo("two"),
      "crates/two/src/lib.rs": rs("TwoLib"),
      "crates/two/src/main.rs": rs("TwoMain"),
      "crates/two/src/b.rs": rs("B", "use crate::Thing;\nuse super::Other;\n"),
      "crates/two/src/c.rs": rs("C", "use crate::sub::Thing;\n"),
      "crates/two/src/sub.rs": rs("Sub"),
    });

    assert.deepEqual(depPairs(graph), ["A->One", "C->Sub"]);
  });

  it("resolves workspace crates by [package] name or [lib] name, and nothing else", async () => {
    const graph = await graphOf({
      "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n',
      "crates/core/Cargo.toml": cargo("shop-core"),
      "crates/core/src/lib.rs": rs("Core", "pub mod model;\n"),
      "crates/core/src/model.rs": rs("Model"),
      "crates/api/Cargo.toml": cargo(
        "shop-api",
        '[lib]\nname = "api_lib"\n\n[dependencies]\nshop-core = { path = "../core" }\n',
      ),
      "crates/api/src/lib.rs": rs(
        "Api",
        "pub mod routes;\npub mod legacy;\nuse shop_core::model::Order;\nuse crate::routes::list;\n",
      ),
      "crates/api/src/routes.rs": rs("Routes"),
      "crates/api/src/legacy.rs": rs("Legacy"),
      "crates/api/tests/routes.rs": "use api_lib::routes::list;\n",
      "crates/api/tests/legacy.rs": "use shop_api::legacy::old;\n",
    });

    assert.deepEqual(depPairs(graph), ["Api->Legacy", "Api->Model", "Api->Routes", "Core->Model"]);
    assert.deepEqual(testedIds(graph), ["Routes"]);
  });

  it("records nothing for a crate name that no Cargo.toml in the repository owns", async () => {
    const graph = await graphOf({
      "src/lib.rs": rs("Lib", "use shop_core::cart::Cart;\n"),
      "src/cart.rs": rs("Cart"),
    });

    assert.deepEqual(depPairs(graph), []);
  });
});

describe("imports: Rust comments, strings and literals", () => {
  it("never reads a mod or use from a comment or a string, and keeps reading after them", async () => {
    const graph = await graphOf({
      "Cargo.toml": cargo("m"),
      "src/lib.rs": rs(
        "Lib",
        `// mod ghost;
/// use crate::ghost::Doc;
//! use crate::ghost::Inner;
/* mod ghost; */
/* outer /* nested */ mod ghost; */
/** use crate::ghost::BlockDoc; */
const A: &str = "mod ghost;";
const B: &str = "say \\"hi\\"; mod ghost;";
const C: &str = r#"use crate::ghost; "quoted" mod ghost;"#;
const D: &str = r##"mod ghost; "# still inside"##;
const E: char = '"';
const F: char = '\\'';
const G: &[u8] = b"mod ghost;";
const H: u8 = b'"';
fn lifetimes<'a>(x: &'a str) -> &'a str { x }
mod outer {
    fn f() { let c = '{'; let s = "}"; /* } */ }
    mod deep;
}
mod real;
`,
      ),
      "src/ghost.rs": rs("Ghost"),
      "src/real.rs": rs("Real"),
      "src/outer/deep.rs": rs("Deep"),
    });

    assert.deepEqual(depPairs(graph), ["Lib->Deep", "Lib->Real"]);
  });
});
