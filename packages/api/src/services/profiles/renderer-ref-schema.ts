/**
 * The ONE zod schema for a `RendererRef` (and its `DeclarativeBlock`), shared by
 * every api door that accepts the FULL renderer union: `profiles.update`,
 * `profiles.setProfileRendererOverride` and capability renderer pages.
 *
 * It had forked into two hand copies (profiles.ts was missing `declarative`, so
 * the stale copy was the only thing refusing a declarative profile renderer).
 * The compile-time check below fails the typecheck if a kind is added to, or
 * dropped from, the type without the schema (and the reverse).
 *
 * Deliberate NARROWINGS stay where they are, as strict as before:
 * `ViewRendererRefSchema` (views.ts) and `EntityRendererRefSchema`
 * (entities/helpers.ts, a security narrowing). Where a ref may be PERSISTED is
 * `renderer-ref-scope.ts`, not this schema.
 */

import { z } from "zod";
import type { RendererRef } from "@synap-core/types/renderer-ref";

/**
 * The MINIMAL, bounded declarative-block schema — the zod mirror of
 * `DeclarativeBlock` (`@synap-core/types/renderer-ref`). Five block kinds, Block-Kit style.
 */
export const DeclarativeBlockSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("heading"),
    text: z.string(),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  }),
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("stat"),
    label: z.string(),
    value: z.union([z.string(), z.number()]),
    hint: z.string().optional(),
  }),
  z.object({
    type: z.literal("list"),
    items: z.array(z.string()),
    ordered: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("button"),
    label: z.string(),
    action: z.string(),
    params: z.record(z.string(), z.unknown()).optional(),
  }),
]);

/** zod mirror of `RendererRef` (`@synap-core/types/renderer-ref`) — the polymorphic renderer union. */
export const RendererRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cell"),
    cellKey: z.string(),
    props: z.record(z.string(), z.unknown()),
    title: z.string().optional(),
    displayMode: z.string().optional(),
    rendererHint: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    kind: z.literal("view"),
    viewId: z.string(),
    title: z.string().optional(),
    displayMode: z.string().optional(),
  }),
  z.object({
    kind: z.literal("iframe-srcdoc"),
    appId: z.string(),
    srcdoc: z.string(),
    title: z.string().optional(),
    props: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    kind: z.literal("external-app"),
    appId: z.string(),
    url: z.string(),
    title: z.string().optional(),
    props: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    kind: z.literal("url"),
    url: z.string(),
    external: z.boolean().optional(),
    title: z.string().optional(),
  }),
  z.object({
    kind: z.literal("view-adapter"),
    adapterKey: z.string(),
    props: z.record(z.string(), z.unknown()).optional(),
    title: z.string().optional(),
  }),
  z.object({
    kind: z.literal("declarative"),
    schema: z.array(DeclarativeBlockSchema),
    title: z.string().optional(),
    props: z.record(z.string(), z.unknown()).optional(),
    displayMode: z.string().optional(),
  }),
  z.object({
    kind: z.literal("source-app"),
    title: z.string().optional(),
  }),
]);

/** Mutual assignability: schema output and the type must be the same set. */
type SchemaRef = z.infer<typeof RendererRefSchema>;
type IsEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _rendererRefSchemaMatchesType: IsEqual<SchemaRef, RendererRef> = true;
void _rendererRefSchemaMatchesType;
