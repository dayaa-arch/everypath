import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Box, type Point, route } from "../src/ui/layout.js";

/** docs/specs/viewer.md condition 5: every box is 180×64 (SPEC §12.1). */
const WIDTH = 180;
const HEIGHT = 64;
const MIN_GAP = 20;

type Segment = readonly [Point, Point];

function boxAt(x: number, y: number): Box {
  return { x, y, width: WIDTH, height: HEIGHT };
}

function segmentsOf(points: readonly Point[]): Segment[] {
  return points.slice(1).map((end, index): Segment => [points[index] ?? end, end]);
}

function isHorizontal([a, b]: Segment): boolean {
  return a.y === b.y && a.x !== b.x;
}

function isVertical([a, b]: Segment): boolean {
  return a.x === b.x && a.y !== b.y;
}

function onBorder(point: Point, box: Box): boolean {
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  const withinX = point.x >= box.x && point.x <= right;
  const withinY = point.y >= box.y && point.y <= bottom;
  return (
    ((point.x === box.x || point.x === right) && withinY) ||
    ((point.y === box.y || point.y === bottom) && withinX)
  );
}

function insideOrOn(point: Point, box: Box): boolean {
  return (
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  );
}

function crossesInterior([a, b]: Segment, box: Box): boolean {
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  if (a.y === b.y) {
    return a.y > box.y && a.y < bottom && Math.max(a.x, b.x) > box.x && Math.min(a.x, b.x) < right;
  }
  return a.x > box.x && a.x < right && Math.max(a.y, b.y) > box.y && Math.min(a.y, b.y) < bottom;
}

function sharedLength([a, b]: Segment, [c, d]: Segment): number {
  if (a.y === b.y && c.y === d.y && a.y === c.y) {
    return (
      Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) -
      Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x))
    );
  }
  if (a.x === b.x && c.x === d.x && a.x === c.x) {
    return (
      Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) -
      Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y))
    );
  }
  return 0;
}

function shareASegment(one: readonly Point[], other: readonly Point[]): boolean {
  return segmentsOf(one).some((a) => segmentsOf(other).some((b) => sharedLength(a, b) > 0));
}

const DX = [-400, -220, -200, -180, -160, -100, -20, 0, 20, 100, 160, 180, 200, 220, 400];
const DY = [-300, -134, -84, -64, -60, -20, 0, 20, 60, 64, 84, 134, 300];
const ORIGIN = boxAt(0, 0);

/** Every offset of a second box from the first, the same box excluded: that one is a self-loop. */
const OFFSETS = DX.flatMap((dx) => DY.map((dy) => [dx, dy] as const)).filter(
  ([dx, dy]) => dx !== 0 || dy !== 0,
);
/** Offsets with a gap of at least 20 px on one axis, where a line has room beside the boxes. */
const APART = OFFSETS.filter(
  ([dx, dy]) => Math.abs(dx) >= WIDTH + MIN_GAP || Math.abs(dy) >= HEIGHT + MIN_GAP,
);

function failing(
  offsets: readonly (readonly [number, number])[],
  holds: (other: Box) => boolean,
): string[] {
  return offsets.filter(([dx, dy]) => !holds(boxAt(dx, dy))).map(([dx, dy]) => `(${dx}, ${dy})`);
}

describe("route between two boxes", () => {
  for (const lane of [0, 1, 2]) {
    it(`draws only horizontal and vertical segments, from one border to the other, in lane ${lane}`, () => {
      const wrong = failing(OFFSETS, (other) => {
        const points = route(ORIGIN, other, lane);
        const [first] = points;
        const last = points.at(-1);
        return (
          points.length >= 2 &&
          first !== undefined &&
          last !== undefined &&
          onBorder(first, ORIGIN) &&
          onBorder(last, other) &&
          segmentsOf(points).every((s) => isHorizontal(s) || isVertical(s))
        );
      });
      assert.deepEqual(wrong, []);
    });
  }

  it("does not run through the two boxes it joins when there is a gap beside them", () => {
    const wrong = failing(APART, (other) =>
      [0, 1].every((lane) =>
        [route(ORIGIN, other, lane), route(other, ORIGIN, lane)].every((points) =>
          segmentsOf(points).every(
            (s) => !crossesInterior(s, ORIGIN) && !crossesInterior(s, other),
          ),
        ),
      ),
    );
    assert.deepEqual(wrong, []);
  });

  it("shares no segment between A to B and B to A", () => {
    const wrong = failing(
      OFFSETS,
      (other) => !shareASegment(route(ORIGIN, other), route(other, ORIGIN)),
    );
    assert.deepEqual(wrong, []);
  });

  it("shares no segment between the lanes of one ordered pair", () => {
    const wrong = failing(APART, (other) => {
      const lanes = [0, 1, 2].map((lane) => route(ORIGIN, other, lane));
      return lanes.every((one, index) =>
        lanes.slice(index + 1).every((next) => !shareASegment(one, next)),
      );
    });
    assert.deepEqual(wrong, []);
  });
});

describe("route from a box to itself", () => {
  const loops = () => [0, 1, 2].map((lane) => route(ORIGIN, ORIGIN, lane));

  it("is a loop of horizontal and vertical segments that leaves the box and returns to its border", () => {
    for (const points of loops()) {
      const [first] = points;
      const last = points.at(-1);
      assert.ok(first !== undefined && last !== undefined);
      assert.ok(onBorder(first, ORIGIN), "starts on the border");
      assert.ok(onBorder(last, ORIGIN), "ends on the border");
      assert.ok(segmentsOf(points).every((s) => isHorizontal(s) || isVertical(s)));
      assert.ok(
        points.some((point) => !insideOrOn(point, ORIGIN)),
        "goes outside the box",
      );
    }
  });

  it("gives each lane its own loop", () => {
    const all = loops();
    for (const [index, one] of all.entries()) {
      for (const next of all.slice(index + 1)) assert.equal(shareASegment(one, next), false);
    }
  });
});
