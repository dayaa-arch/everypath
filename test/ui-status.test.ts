import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NodeStatus } from "../src/core/types.js";
import { TONES, type Tone, toneOf } from "../src/ui/view.js";
import { counterexample, node, property } from "./helpers/ui-fixtures.js";

/**
 * SPEC §7.2, top row first. `status` is what makes this row match on a node whose other fields leave
 * every row above it off. Rows 6 to 8 read `reviewed`, so each names it.
 */
const ROWS: readonly { readonly tone: Tone; readonly status: Partial<NodeStatus> }[] = [
  { tone: "danger", status: { vuln: true } },
  { tone: "planned", status: { planned: true } },
  { tone: "wip", status: { wip: true } },
  { tone: "untested", status: { tested: false } },
  { tone: "changed", status: { changedSinceReview: true, reviewed: false } },
  { tone: "unreviewed", status: { reviewed: false } },
  { tone: "proven", status: { reviewed: true, proof: "passed" } },
  { tone: "approved", status: { reviewed: true } },
];

function conflicts(a: Partial<NodeStatus>, b: Partial<NodeStatus>): boolean {
  const other = new Map(Object.entries(b));
  return Object.entries(a).some(([key, value]) => other.has(key) && other.get(key) !== value);
}

describe("SPEC §7.2 priority", () => {
  it("lists the eight tones in priority order", () => {
    assert.deepEqual(
      TONES.map((row) => row.tone),
      ROWS.map((row) => row.tone),
    );
  });

  for (const { tone, status } of ROWS) {
    it(`paints ${tone} when that row is the first to match`, () => {
      assert.equal(toneOf(node("N", { status }), []), tone);
    });
  }

  for (const [index, higher] of ROWS.entries()) {
    for (const lower of ROWS.slice(index + 1)) {
      if (conflicts(higher.status, lower.status)) continue;
      it(`paints ${higher.tone} when ${lower.tone} matches too`, () => {
        const both = node("N", { status: { ...higher.status, ...lower.status } });
        assert.equal(toneOf(both, []), higher.tone);
      });
    }
  }

  it("paints a proven node grey until a person approves it", () => {
    assert.equal(
      toneOf(node("N", { status: { proof: "passed", reviewed: false } }), []),
      "unreviewed",
    );
  });

  it("paints proof pending or none like a node without a proof", () => {
    for (const proof of ["none", "pending"] as const) {
      assert.equal(toneOf(node("N", { status: { reviewed: true, proof } }), []), "approved");
    }
  });
});

describe("danger", () => {
  it("is what proof: failed paints, even for an approved node", () => {
    assert.equal(toneOf(node("N", { status: { proof: "failed" } }), []), "danger");
    assert.equal(toneOf(node("N", { status: { proof: "failed", reviewed: true } }), []), "danger");
  });

  const trace = counterexample(["N", "M"]);

  it("is what a violated property that lists the node paints", () => {
    const violated = property("p", "violated", [trace]);
    const lowerRows = { planned: true, wip: true, tested: false };
    assert.equal(toneOf(node("N", { violations: [violated.id] }), [violated]), "danger");
    assert.equal(
      toneOf(node("N", { status: lowerRows, violations: [violated.id] }), [violated]),
      "danger",
    );
  });

  it("is not what a violation of a stale model alone paints", () => {
    const stale = property("p", "violated", [trace], { stale: true });
    assert.equal(toneOf(node("N"), [stale]), "unreviewed");
    assert.equal(toneOf(node("N", { violations: [stale.id] }), [stale]), "unreviewed");
    assert.equal(
      toneOf(node("N", { status: { reviewed: true }, violations: [stale.id] }), [stale]),
      "approved",
    );
  });

  it("is what a live violation paints beside a stale one", () => {
    const stale = property("old", "violated", [trace], { stale: true });
    const live = property("new", "violated", [trace]);
    assert.equal(toneOf(node("N", { violations: [stale.id, live.id] }), [stale, live]), "danger");
  });
});

describe("how each tone looks", () => {
  const byTone = new Map(TONES.map((row) => [row.tone, row]));

  function row(tone: Tone) {
    const found = byTone.get(tone);
    assert.ok(found !== undefined, `${tone} has a row in TONES`);
    return found;
  }

  function hsl(color: string): { hue: number; saturation: number; lightness: number } {
    const digits = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1];
    assert.ok(digits !== undefined, `${color} is a #rgb or #rrggbb color`);
    const full = digits.length === 3 ? [...digits].map((d) => d + d).join("") : digits;
    const [r = 0, g = 0, b = 0] = [0, 2, 4].map(
      (at) => Number.parseInt(full.slice(at, at + 2), 16) / 255,
    );
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const lightness = (max + min) / 2;
    const chroma = max - min;
    if (chroma === 0) return { hue: 0, saturation: 0, lightness };
    const saturation = chroma / (1 - Math.abs(2 * lightness - 1));
    const sector =
      max === r
        ? ((g - b) / chroma + 6) % 6
        : max === g
          ? (b - r) / chroma + 2
          : (r - g) / chroma + 4;
    return { hue: sector * 60, saturation, lightness };
  }

  const inHue = (color: string, from: number, to: number): boolean => {
    const { hue, saturation } = hsl(color);
    return saturation >= 0.3 && hue >= from && hue <= to;
  };

  it("gives every tone a label and colors", () => {
    assert.equal(TONES.length, ROWS.length);
    for (const { tone } of ROWS) {
      const { label, fill, stroke, width } = row(tone);
      assert.notEqual(label.trim(), "", `${tone} label`);
      hsl(fill);
      hsl(stroke);
      assert.ok(width > 0, `${tone} border width`);
    }
  });

  it("tells the eight tones apart", () => {
    assert.equal(TONES.length, ROWS.length);
    const looks = TONES.map((r) => JSON.stringify([r.fill, r.stroke, r.width, r.dash]));
    assert.equal(new Set(looks).size, TONES.length);
    assert.equal(new Set(TONES.map((r) => r.label)).size, TONES.length);
  });

  it("paints danger red, wip yellow, untested orange, proven blue and approved green", () => {
    assert.ok(
      inHue(row("danger").fill, 345, 360) || inHue(row("danger").fill, 0, 15),
      "danger fill",
    );
    assert.ok(
      inHue(row("danger").stroke, 345, 360) || inHue(row("danger").stroke, 0, 15),
      "danger stroke",
    );
    assert.ok(inHue(row("wip").fill, 48, 70), "wip fill");
    assert.ok(inHue(row("untested").fill, 20, 46), "untested fill");
    assert.ok(inHue(row("proven").fill, 190, 250), "proven fill");
    assert.ok(inHue(row("approved").fill, 90, 160), "approved fill");
  });

  it("paints planned white and both unreviewed tones grey", () => {
    assert.ok(hsl(row("planned").fill).lightness >= 0.97, "planned fill is white");
    for (const tone of ["changed", "unreviewed"] as const) {
      const { saturation, lightness } = hsl(row(tone).fill);
      assert.ok(saturation <= 0.2 && lightness > 0.3 && lightness < 0.97, `${tone} fill is grey`);
    }
  });

  it("draws only planned with a dotted border, and danger and changed with a thick one", () => {
    assert.notEqual(row("planned").dash, null);
    for (const { tone, dash } of TONES) if (tone !== "planned") assert.equal(dash, null, tone);
    assert.ok(row("danger").width > row("approved").width, "danger border is thicker");
    assert.ok(row("changed").width > row("unreviewed").width, "changed border is thicker");
  });

  it("settles only the proven and approved tones", () => {
    assert.deepEqual(
      TONES.filter((r) => r.settled).map((r) => r.tone),
      ["proven", "approved"],
    );
  });
});
