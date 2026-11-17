/**
 * `synap_get_entity` without `entityId` says `entityId` (ticket 2d61ff7c).
 * Past the handler the id is the entities router's `id`, so a call with
 * `{ id }` failed on a field named `id` — read as "you passed nothing" —
 * while the tool's schema names `entityId`. REAL: the handler; it answers
 * before any read, so nothing is stubbed.
 */
import { describe, it, expect } from "vitest";
import { readHandlers } from "./read.js";

function call(args: Record<string, unknown>) {
  return readHandlers.synap_get_entity!({
    toolName: "synap_get_entity",
    args,
    userId: "u1",
    apiKeyScopes: ["mcp.read"],
  } as never);
}

describe("synap_get_entity — a missing entityId is named entityId", () => {
  it.each([
    { id: "0667d277-0000-4000-8000-000000000000" },
    {},
    { entityId: " " },
  ])("%j is refused naming `entityId`, never `id`", async (args) => {
    const res = await call(args);
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("`entityId`");
    expect(text).not.toMatch(/"path":\["id"\]/);
  });
});
