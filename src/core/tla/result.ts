import { parseEventName, parseStateName, parseVarName } from "../expr.js";
import { asInteger, asItems, asText, isRecord } from "../json.js";
import { PROPERTIES_FILE } from "../properties.js";
import type {
  Counterexample,
  Graph,
  PropertiesFile,
  PropertyResult,
  ScanWarning,
  StateName,
  Step,
  VarName,
} from "../types.js";
import { generateTla, modelKey, type TlaModel, type TlaNames } from "./generate.js";

/**
 * `.everypath/tla/result.json`: what one TLC run decided, and about which model. A run returns it and
 * writes nothing in the repository; `commitTlc` writes it, and every scan reads it back.
 */
export type TlcRecord = {
  readonly version: 1;
  readonly checkedAt: string;
  /** `modelKey` of the model TLC checked. */
  readonly key: string;
  /** Model.tla and Model.cfg as TLC read them. */
  readonly tla: string;
  readonly cfg: string;
  readonly names: TlaNames;
  /** Every property TLC decided, `checkedBy` "tlc" or "both", in file order. */
  readonly properties: readonly PropertyResult[];
  /** The variables left their declared ranges. */
  readonly typeOk: Counterexample | null;
  /** Distinct states in the last TLC output that gave a count. */
  readonly states: number | null;
  /** The first TLC error or timeout. Any non-null value fails `check --tlc`. */
  readonly error: string | null;
};

/** The part of `result.json` a scan uses, parsed at the workspace boundary. */
export type StoredVerdicts = {
  readonly key: string;
  readonly byId: ReadonlyMap<string, StoredVerdict>;
};

type StoredVerdict = Pick<
  PropertyResult,
  "checkedBy" | "result" | "counterexamples" | "statesExplored" | "checkedAt"
>;

const RESULTS = ["ok", "violated", "error", "pending"] as const;

function parseStep(raw: unknown): Step | null {
  if (!isRecord(raw) || !isRecord(raw.vars)) return null;
  const state = parseStateName(asText(raw.state) ?? "");
  const event = raw.event === null ? null : parseEventName(asText(raw.event) ?? "");
  if (!state.ok || (event !== null && !event.ok)) return null;
  const vars: Record<VarName, string> = {};
  for (const [key, value] of Object.entries(raw.vars)) {
    const name = parseVarName(key);
    if (!name.ok || typeof value !== "string") return null;
    vars[name.value] = value;
  }
  return { state: state.value, event: event?.value ?? null, vars };
}

function parseCounterexample(raw: unknown): Counterexample | null {
  if (!isRecord(raw)) return null;
  const path: StateName[] = [];
  for (const item of asItems(raw.path)) {
    const state = parseStateName(asText(item) ?? "");
    if (!state.ok) return null;
    path.push(state.value);
  }
  const steps: Step[] = [];
  for (const item of asItems(raw.steps)) {
    const step = parseStep(item);
    if (step === null) return null;
    steps.push(step);
  }
  const [firstState, ...restStates] = path;
  const [firstStep, ...restSteps] = steps;
  const loopStart = raw.loopStart === null ? null : asInteger(raw.loopStart);
  if (firstState === undefined || firstStep === undefined) return null;
  if (
    raw.loopStart !== null &&
    (loopStart === null || loopStart < 0 || loopStart >= steps.length)
  ) {
    return null;
  }
  return { path: [firstState, ...restStates], steps: [firstStep, ...restSteps], loopStart };
}

function parseVerdict(raw: unknown): (StoredVerdict & { readonly id: string }) | null {
  if (!isRecord(raw)) return null;
  const id = asText(raw.id);
  const result = RESULTS.find((known) => known === raw.result);
  const checkedAt = asText(raw.checkedAt);
  const statesExplored = raw.statesExplored === null ? null : asInteger(raw.statesExplored);
  const checkedBy = raw.checkedBy === "tlc" || raw.checkedBy === "both" ? raw.checkedBy : null;
  if (id === null || result === undefined || checkedAt === null || checkedBy === null) return null;
  if (raw.statesExplored !== null && statesExplored === null) return null;
  const counterexamples: Counterexample[] = [];
  for (const item of asItems(raw.counterexamples)) {
    const example = parseCounterexample(item);
    if (example === null) return null;
    counterexamples.push(example);
  }
  return { id, checkedBy, result, counterexamples, statesExplored, checkedAt };
}

/** `result.json` to what a scan needs, or `null` when any part of it does not read as a record. */
export function parseStoredVerdicts(raw: unknown): StoredVerdicts | null {
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.properties)) return null;
  const key = asText(raw.key);
  if (key === null) return null;
  const byId = new Map<string, StoredVerdict>();
  for (const item of raw.properties) {
    const verdict = parseVerdict(item);
    if (verdict === null) return null;
    const { id, ...rest } = verdict;
    byId.set(id, rest);
  }
  return { key, byId };
}

/** One properties-file warning per definition the model leaves out; a warning there fails the check. */
export function rejectionWarnings({ rejected }: Pick<TlaModel, "rejected">): ScanWarning[] {
  return rejected.map(({ reason }) => ({
    file: PROPERTIES_FILE,
    line: null,
    message: reason,
    detail: null,
  }));
}

/**
 * Lays TLC's stored verdicts over the quick lane's, by property id, on every scan, so they outlive
 * rescans. When the current model has the key TLC checked, a stored verdict replaces the quick one.
 * Otherwise it only fills a result the quick lane left `pending`, marked `staleModel`: a verdict about
 * an older model never hides one the quick lane reached on this model. While a record exists, the
 * definitions the current model leaves out are warned about, as `check --tlc` does.
 */
export function withTlcResults(
  graph: Pick<Graph, "nodes" | "edges" | "model">,
  file: PropertiesFile,
  quick: readonly PropertyResult[],
  stored: StoredVerdicts | null,
): { readonly properties: readonly PropertyResult[]; readonly warnings: readonly ScanWarning[] } {
  if (stored === null) return { properties: quick, warnings: [] };
  const generated = generateTla(graph, file);
  const fresh = generated.ok && modelKey(generated.model) === stored.key;
  const properties = quick.map((result): PropertyResult => {
    const verdict = stored.byId.get(result.id);
    if (verdict === undefined) return result;
    if (fresh) return { ...result, ...verdict };
    return result.result === "pending" ? { ...result, ...verdict, staleModel: true } : result;
  });
  return { properties, warnings: generated.ok ? rejectionWarnings(generated.model) : [] };
}
