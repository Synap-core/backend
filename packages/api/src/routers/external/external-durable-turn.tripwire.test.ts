/**
 * Tripwire: external streaming doors reserve + finish durable chat_turns.
 *
 * Founder locked full ledger for external AI (not ephemeral-only).
 * If either door drops create/finish, this fails.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("external durable chat_turns wiring (tripwire)", () => {
  const chatSource = readFileSync(
    new URL("./chat.ts", import.meta.url),
    "utf8"
  );
  const oaiSource = readFileSync(
    new URL("./openai-compat.ts", import.meta.url),
    "utf8"
  );
  const helperSource = readFileSync(
    new URL(
      "../../services/chat-turns/external-durable-turn.ts",
      import.meta.url
    ),
    "utf8"
  );

  it("helper reuses createOrGet + finishChatTurn", () => {
    expect(helperSource).toContain("createOrGetChatTurnWithUserMessage");
    expect(helperSource).toContain("finishChatTurn");
    expect(helperSource).toContain("resolveExternalRequestId");
    expect(helperSource).toContain("X-Synap-Turn-Id");
  });

  it("external /chat/stream creates turn before IS and finishes on drain", () => {
    expect(chatSource).toContain("beginExternalDurableTurn");
    expect(chatSource).toContain("wrapUpstreamStreamWithTurnLifecycle");
    expect(chatSource).toContain("safeFinishExternalTurn");
    expect(chatSource).toContain("SYNAP_TURN_ID_HEADER");
    expect(chatSource).toContain("resolveExternalRequestId");
    // Create happens after channel resolve, before IS fetch
    const beginIdx = chatSource.indexOf("beginExternalDurableTurn");
    const fetchIdx = chatSource.indexOf("fetch(`${isUrl}/api/chat/stream`");
    expect(beginIdx).toBeGreaterThan(0);
    expect(fetchIdx).toBeGreaterThan(beginIdx);
  });

  it("external doors reopen failed turns under same requestId (D5)", () => {
    expect(chatSource).toContain("decideChatTurnClaimAction");
    expect(chatSource).toContain("reopenChatTurn");
    expect(chatSource).toContain("reopen_and_run");
    expect(oaiSource).toContain("decideChatTurnClaimAction");
    expect(oaiSource).toContain("reopenChatTurn");
    expect(oaiSource).toContain("reopen_and_run");
  });

  it("openai-compat returns turnId and wires finish on all paths", () => {
    expect(oaiSource).toContain("beginExternalDurableTurn");
    expect(oaiSource).toContain("safeFinishExternalTurn");
    expect(oaiSource).toContain("SYNAP_TURN_ID_HEADER");
    expect(oaiSource).toContain("turnId: durableTurn.id");
    // Non-stream JSON includes turnId; stream uses header only (OAI wire).
    expect(oaiSource).toContain("resolveExternalRequestId");
    const beginIdx = oaiSource.indexOf("beginExternalDurableTurn");
    const fetchIdx = oaiSource.indexOf("fetch(`${isUrl}/api/chat/stream`");
    expect(beginIdx).toBeGreaterThan(0);
    expect(fetchIdx).toBeGreaterThan(beginIdx);
  });
});

describe("resolveExternalRequestId", () => {
  it("prefers body UUID, then header UUID, else generates", async () => {
    const { resolveExternalRequestId } =
      await import("../../services/chat-turns/external-durable-turn.js");
    const body = "11111111-1111-4111-8111-111111111111";
    const header = "22222222-2222-4222-8222-222222222222";
    expect(resolveExternalRequestId(header, body)).toBe(body);
    expect(resolveExternalRequestId(header, undefined)).toBe(header);
    expect(resolveExternalRequestId("not-a-uuid", "also-bad")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });
});
