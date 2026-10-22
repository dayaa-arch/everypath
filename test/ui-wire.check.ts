import type { Layout as CoreLayout } from "../src/core/types.js";
import type { ServerEvent as ServerSideEvent } from "../src/server/server.js";
import type { Layout, ServerEvent } from "../src/ui/wire.js";

// Type-level only: `npm run typecheck` compiles this file and `npm test` never loads it.
// src/ui cannot import src/server (it pulls in node:http), so wire.ts holds copies. Adding, removing
// or changing a field of `ServerEvent` in server.ts, or of `Layout` in core/types.ts, breaks a line below.

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

export type WireChecks = [
  Expect<Equal<ServerEvent, ServerSideEvent>>,
  Expect<Equal<Layout, CoreLayout>>,
];

// The check can fail: a union with one more member, or one more field, is not the same type.
type WithMember = ServerEvent | { readonly type: "history" };
type WithField = Readonly<Record<string, { x: number; y: number; z: number }>>;
type Mutable = Record<string, { x: number; y: number }>;

// @ts-expect-error a ServerEvent with another member differs
export type ExtraMember = Expect<Equal<ServerEvent, WithMember>>;
// @ts-expect-error a field the server does not send differs
export type ExtraField = Expect<Equal<Layout, WithField>>;
// @ts-expect-error a readonly field differs from a mutable one
export type MutableField = Expect<Equal<Layout, Mutable>>;
