import type {
  Assignment,
  GuardExpr,
  ModelVar,
  NonEmpty,
  ParseResult,
  PropertyExpr,
  StateName,
} from "./types.js";

/** The text after `if:`. SPEC §5.1 with precedence `||` < `&&` < `!`. */
export function parseGuard(input: string): ParseResult<GuardExpr> {
  throw new Error(`not implemented: ${input}`);
}

/** The text after `set:`: `VAR = RHS ("," VAR = RHS)*`, RHS a value or `VAR+1` / `VAR-1`. */
export function parseAssignments(input: string): ParseResult<NonEmpty<Assignment>> {
  throw new Error(`not implemented: ${input}`);
}

/** The text after `@state-var`: `NAME ":" TYPE "=" INIT`, TYPE `BOOLEAN`, `N..M` or `{a,b,c}`. */
export function parseVarDecl(input: string): ParseResult<ModelVar> {
  throw new Error(`not implemented: ${input}`);
}

/** A property expression: the guard grammar plus `state ==|!=|in` and right-associative `=>`. */
export function parseProperty(input: string): ParseResult<PropertyExpr> {
  throw new Error(`not implemented: ${input}`);
}

/** A state name from `@state`, `@state-next` or a file name. Same identifier rules as expressions. */
export function parseStateName(input: string): ParseResult<StateName> {
  throw new Error(`not implemented: ${input}`);
}
