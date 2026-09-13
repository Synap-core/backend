/**
 * `tool.request` — the agent door for tool demand. Demand is forwarded to the
 * Control Plane, so this door must accept a tool NAME (and where the demand
 * came from) and nothing else: a provider key or any free text an agent adds is
 * refused at the params schema, never stored.
 *
 * Driven through the REAL registered schema (`BUILTIN_VERB_PARAM_SCHEMAS`), the
 * same object `executeCapability` validates against — not a copy.
 *
 * NOT covered here: the handler's governed write (see
 * `tool-demand/record-tool-demand.test.ts`, which pins the exact stored
 * property set).
 */

import { describe, it, expect } from "vitest";
import type { ZodTypeAny } from "zod";
import { BUILTIN_VERB_PARAM_SCHEMAS } from "./builtin-verbs.js";

// The map is statically typed by its `shape` only; at runtime every entry is
// the zod schema `executeCapability` parses with — the same object tested here.
const schema = BUILTIN_VERB_PARAM_SCHEMAS["tool.request"] as unknown as
  ZodTypeAny | undefined;

describe("tool.request params", () => {
  it("is registered", () => {
    expect(schema).toBeTruthy();
  });

  it("accepts a tool name, optionally with a known source", () => {
    expect(schema!.safeParse({ toolName: "Notion" }).success).toBe(true);
    expect(
      schema!.safeParse({ toolName: "Notion", source: "blocked_agent" }).success
    ).toBe(true);
  });

  it("refuses a provider key — free text must never ride along to the Control Plane", () => {
    expect(
      schema!.safeParse({
        toolName: "Notion",
        providerKey: "Jane Doe oncology intake",
      }).success
    ).toBe(false);
  });

  it("refuses any other extra field and an unknown source", () => {
    expect(
      schema!.safeParse({ toolName: "Notion", note: "anything" }).success
    ).toBe(false);
    expect(
      schema!.safeParse({ toolName: "Notion", source: "onboarding" }).success
    ).toBe(false);
  });
});
