import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { toMermaid } from "../../src/core/mermaid.js";
import { scan } from "../../src/core/scan.js";
import { exportTla } from "../../src/core/tla/run.js";
import { place, relayout } from "../../src/ui/layout.js";

const example = fileURLToPath(new URL("../../example", import.meta.url));
const ROOT = "<root>";

/**
 * What a repository with no `@state-parent` hands every reader, from a copy of `example/` scanned at a
 * pinned instant: `graph.json` as `scan` writes it (the copy's path replaced by `<root>`), `Model.tla`
 * and `Model.cfg` as `tla export` writes them, the Mermaid text, and the viewer's coordinates from
 * `relayout` and from `place` with every other point missing. `test/fixtures/flat-example/` holds the
 * output of the code before `@state-parent` existed.
 */
export async function flatExampleOutputs(): Promise<Readonly<Record<string, string>>> {
  const root = await mkdtemp(join(tmpdir(), "everypath-flat-example-"));
  try {
    await cp(example, root, { recursive: true });
    await rm(join(root, ".everypath"), { recursive: true, force: true });
    const graph = await scan(root, { now: new Date("2026-10-22T00:00:00.000Z") });
    const written = await readFile(join(root, ".everypath/graph.json"), "utf8");
    const exported = await exportTla(root);
    if (!exported.ok) throw new Error(exported.reason);
    const full = relayout(graph);
    const half = Object.fromEntries(Object.entries(full).filter((_, index) => index % 2 === 0));
    return {
      "graph.json": written.replaceAll(JSON.stringify(root), JSON.stringify(ROOT)),
      "Model.tla": await readFile(join(root, ".everypath/tla/Model.tla"), "utf8"),
      "Model.cfg": await readFile(join(root, ".everypath/tla/Model.cfg"), "utf8"),
      "mermaid.mmd": toMermaid(graph),
      "layout.json": `${JSON.stringify({ relayout: full, place: place(half, graph) }, null, 2)}\n`,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
