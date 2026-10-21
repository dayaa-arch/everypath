import { parseProperty, parseStateName } from "./expr.js";
import { asItems, isRecord } from "./json.js";
import type { Problem } from "./model.js";
import type {
  NonEmpty,
  PropertiesFile,
  PropertyDef,
  PropertyExpr,
  PropertyId,
  ScanWarning,
  StateName,
} from "./types.js";

export const PROPERTIES_FILE = "everypath.properties.json";

export const NO_PROPERTIES: PropertiesFile = { entry: null, properties: [] };

type Kind = PropertyDef["kind"];
/** A definition without the fields every kind shares. */
type BodyOf<K extends Kind> =
  Extract<PropertyDef, { readonly kind: K }> extends infer D
    ? D extends unknown
      ? Omit<D, "id" | "description">
      : never
    : never;

type Failure = { readonly ok: false; readonly problem: Problem };
type Parsed<T> = { readonly ok: true; readonly value: T } | Failure;

function ok<T>(value: T): Parsed<T> {
  return { ok: true, value };
}

function fail(message: string, detail: Problem["detail"] = null): Failure {
  return { ok: false, problem: { message, detail } };
}

function show(value: unknown): string {
  return JSON.stringify(value);
}

function stateNames(raw: unknown, field: string): Parsed<readonly StateName[]> {
  if (!Array.isArray(raw)) return fail(`${field} は状態名の配列にしてください`);
  const names: StateName[] = [];
  for (const item of asItems(raw)) {
    const name = typeof item === "string" ? parseStateName(item) : null;
    if (name === null || !name.ok)
      return fail(`${field} に状態名でない値があります: ${show(item)}`);
    names.push(name.value);
  }
  return ok(names);
}

function nonEmptyStateNames(raw: unknown, field: string): Parsed<NonEmpty<StateName>> {
  const names = stateNames(raw, field);
  if (!names.ok) return names;
  const [first, ...rest] = names.value;
  return first === undefined
    ? fail(`${field} には状態名を 1 つ以上書いてください`)
    : ok([first, ...rest]);
}

function optionalStateNames(raw: unknown, field: string): Parsed<readonly StateName[]> {
  return raw == null ? ok([]) : stateNames(raw, field);
}

function expression(raw: unknown, field: string): Parsed<PropertyExpr> {
  if (typeof raw !== "string") return fail(`${field} は式の文字列にしてください`);
  const parsed = parseProperty(raw);
  if (parsed.ok) return ok(parsed.value);
  return fail(`${field} を解釈できません: ${parsed.warning.message}`, parsed.warning);
}

type Fields = Readonly<Record<string, unknown>>;
type BodyParsers = { readonly [K in Kind]: (raw: Fields) => Parsed<BodyOf<K>> };

/** One parser per `kind`. The table is the list of kinds the file may use. */
const BODY_PARSERS = {
  invariant: (raw) => {
    const expr = expression(raw.expr, "expr");
    return expr.ok ? ok({ kind: "invariant", expr: expr.value }) : expr;
  },
  "leads-to": (raw) => {
    const from = expression(raw.from, "from");
    if (!from.ok) return from;
    const to = expression(raw.to, "to");
    return to.ok ? ok({ kind: "leads-to", from: from.value, to: to.value }) : to;
  },
  "never-reach": (raw) => {
    const target = nonEmptyStateNames(raw.target, "target");
    if (!target.ok) return target;
    const avoid = optionalStateNames(raw.avoid, "avoid");
    return avoid.ok ? ok({ kind: "never-reach", target: target.value, avoid: avoid.value }) : avoid;
  },
  "always-reach": (raw) => {
    const target = nonEmptyStateNames(raw.target, "target");
    return target.ok ? ok({ kind: "always-reach", target: target.value }) : target;
  },
  "no-dead-end": (raw) => {
    const except = optionalStateNames(raw.except, "except");
    return except.ok ? ok({ kind: "no-dead-end", except: except.value }) : except;
  },
  "dep-only-via": () => ok({ kind: "dep-only-via" }),
} satisfies BodyParsers;

function isKind(value: unknown): value is Kind {
  return typeof value === "string" && Object.hasOwn(BODY_PARSERS, value);
}

/** The only place a `PropertyId` is made. */
function propertyId(raw: unknown): PropertyId | null {
  return typeof raw === "string" && raw.trim() !== "" ? (raw as PropertyId) : null;
}

function parseDefinition(
  raw: unknown,
  id: PropertyId | null,
  taken: ReadonlySet<PropertyId>,
): Parsed<PropertyDef> {
  if (!isRecord(raw)) return fail("定義が JSON オブジェクトではありません");
  if (id === null) return fail("id がありません。空でない文字列を書いてください");
  if (taken.has(id)) return fail("id が先の定義と重複しています");
  if (!isKind(raw.kind)) {
    const kinds = Object.keys(BODY_PARSERS).join("、");
    return fail(`kind ${show(raw.kind)} は未知です（${kinds} のどれか）`);
  }
  if (raw.description != null && typeof raw.description !== "string") {
    return fail("description は文字列にしてください");
  }
  const body = BODY_PARSERS[raw.kind](raw);
  if (!body.ok) return body;
  return ok({ id, description: raw.description ?? null, ...body.value });
}

function warn(message: string, detail: ScanWarning["detail"] = null): ScanWarning {
  return { file: PROPERTIES_FILE, line: null, message, detail };
}

/**
 * The properties file is a boundary. A definition outside the grammar is dropped with one warning that
 * names its first problem, so a property that cannot be checked never passes silently.
 */
export function parseProperties(raw: unknown): {
  file: PropertiesFile;
  warnings: ScanWarning[];
} {
  const unusable = (reason: string) => ({
    file: NO_PROPERTIES,
    warnings: [warn(`${PROPERTIES_FILE} ${reason}。性質を読み込みません`)],
  });
  if (!isRecord(raw)) return unusable("は JSON オブジェクトにしてください");
  if (!Array.isArray(raw.properties)) return unusable("に properties 配列がありません");

  const warnings: ScanWarning[] = [];
  let entry: NonEmpty<StateName> | null = null;
  if (raw.entry != null) {
    const parsed = nonEmptyStateNames(raw.entry, "entry");
    if (parsed.ok) entry = parsed.value;
    else {
      warnings.push(warn(`${PROPERTIES_FILE} の ${parsed.problem.message}。入口は自動で決めます`));
    }
  }

  const properties: PropertyDef[] = [];
  const taken = new Set<PropertyId>();
  for (const [index, definition] of asItems(raw.properties).entries()) {
    const id = isRecord(definition) ? propertyId(definition.id) : null;
    const parsed = parseDefinition(definition, id, taken);
    if (parsed.ok) {
      taken.add(parsed.value.id);
      properties.push(parsed.value);
      continue;
    }
    const subject = id === null ? `${index + 1} 番目の性質の` : `性質 ${id} の`;
    warnings.push(
      warn(`${subject}${parsed.problem.message}。この性質は読み込みません`, parsed.problem.detail),
    );
  }
  return { file: { entry, properties }, warnings };
}
