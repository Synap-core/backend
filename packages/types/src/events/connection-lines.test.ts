/**
 * Every connection lifecycle family → the line a person reads. One row per
 * family (and per branch that words differently), then a scan of EVERY row's
 * output for a leaked machine token.
 */
import { describe, expect, it } from "vitest";
import { parseConnectionEvent } from "./connection-lines.js";

type Row = [type: string, data: Record<string, unknown> | undefined, text: string, failed?: boolean];

const ROWS: Row[] = [
  // API keys — never "Deleted API key" / "Updated API key".
  ["apiKey.revoke.completed", { keyName: "Vercel production" }, 'Revoked API key "Vercel production"'],
  ["apiKey.revoke.completed", { reason: "leaked" }, "Revoked API key"],
  ["apiKey.rotate.completed", { rotatedFromId: "k1" }, "Replaced API key"],
  // App Connect lifecycle (app-connect.ts).
  ["app.request.completed", { name: "synap.live", requests: [] }, "Asked for access"],
  ["app.approve.completed", { name: "synap.live" }, "Approved by you"],
  ["app.issue_key.completed", { name: "synap.live", keyId: "k" }, "Issued key"],
  ["app.revoke.completed", { name: "synap.live" }, "Access removed"],
  ["app.rename.completed", { from: "Landing", to: "synap.live" }, 'Renamed to "synap.live"'],
  ["app.rename.completed", undefined, "Renamed app"],
  ["app.remove_for_good.completed", { name: "synap.live" }, "Removed for good"],
  // Messaging accounts.
  ["messaging_account.created.completed", { provider: "whatsapp" }, "Connected WhatsApp"],
  ["messaging_account.created.completed", undefined, "Connected messaging account"],
  ["messaging_account.disconnected.completed", { provider: "telegram" }, "Disconnected Telegram"],
  ["messaging_account.reconnection_required.completed", { provider: "whatsapp" }, "Sign-in expired · WhatsApp", true],
  ["messaging_account.updated.completed", { provider: "whatsapp", status: "connected" }, "Reconnected WhatsApp"],
  // Channels and messages.
  ["external_channel.created.completed", { provider: "telegram" }, "Created channel on Telegram"],
  ["external_message.received.completed", { participantName: "Ada", provider: "telegram" }, "Message from Ada on Telegram"],
  ["external_message.received", { participantName: "Ada", provider: "telegram" }, "Message from Ada on Telegram"],
  ["external_message.received.completed", undefined, "Received message"],
  ["channel_message.created.completed", { channelId: "c1", messageRole: "user" }, "Posted message"],
  ["channel_message.created", undefined, "Posted message"],
  // Syncs and sign-ins.
  ["connector_sync.complete.completed", { provider: "gmail", syncStatus: "success", counts: { created: 42 } }, "Synced Gmail · 42 new"],
  ["connector_sync.complete.completed", { provider: "gmail", syncStatus: "success", counts: { created: 0 } }, "Synced Gmail"],
  ["connector_sync.complete.completed", { provider: "gmail", syncStatus: "error" }, "Failed to sync Gmail", true],
  ["connector_sync.complete.completed", undefined, "Synced connection"],
  ["connection_sync.progress", { provider: "google-mail", phase: "synced", counts: { created: 3 } }, "Synced Gmail · 3 new"],
  ["connection_sync.progress", { provider: "gmail", phase: "review_ready" }, "Synced Gmail · Ready to review"],
  ["connection_sync.progress", { provider: "gmail", phase: "failed" }, "Failed to sync Gmail", true],
  ["connector.auth_expire.completed", { provider: "gmail" }, "Sign-in expired · Gmail", true],
  ["connector.auth_expire.completed", undefined, "Sign-in expired", true],
  // Webhook deliveries.
  ["webhooks.deliver.requested", { url: "https://hooks.zapier.com/x", status: "success" }, "Sent to Zapier"],
  ["webhooks.deliver.requested", { url: "https://hooks.zapier.com/x", status: "failed" }, "Failed to send to Zapier", true],
  ["webhooks.deliver.requested", undefined, "Sending webhook"],
  // Sessions and tracks — the domain verb is the VERB, never the noun.
  ["focus_session.stage_changed.completed", { toStage: "review" }, 'Moved session to "Review"'],
  ["focus_session.slot_asked.completed", { label: "Budget" }, 'Asked question "Budget"'],
  ["focus_session.slot_answered.completed", { label: "Budget" }, 'Answered question "Budget"'],
  ["focus_session.slot_answered.completed", undefined, "Answered question"],
  ["focus_session.slot_attested.completed", { label: "Deck" }, 'Marked done "Deck"'],
  ["focus_session.closed.completed", undefined, "Closed session"],
  ["track.stage_changed.completed", { toStage: "Launch prep" }, 'Moved track to "Launch prep"'],
];

describe("parseConnectionEvent — every family reads as words", () => {
  for (const [type, data, text, failed] of ROWS) {
    it(`${type} ${data ? JSON.stringify(data).slice(0, 40) : "(no data)"} → ${text}`, () => {
      const line = parseConnectionEvent(type, data);
      expect(line?.text).toBe(text);
      expect(line?.failed).toBe(failed ?? false);
    });
  }

  it("no line ever leaks a machine token (no `_`, no dotted segment)", () => {
    // Non-vacuity: the scan sees every row, and it can still see a leak.
    expect(ROWS.length).toBeGreaterThanOrEqual(40);
    const leak = (s: string) => /_|[a-z]\.[a-z]/i.test(s.replace(/"[^"]*"/g, ""));
    expect(leak("Slot_answered focus session")).toBe(true);
    expect(leak("Synced connector.sync")).toBe(true);
    const leaked = ROWS.map(([type, data]) => parseConnectionEvent(type, data))
      .filter((l) => !l || leak(l.text))
      .map((l) => l?.text ?? "(null)");
    expect(leaked).toEqual([]);
  });

  it("carries the name and detail apart from the words", () => {
    const l = parseConnectionEvent("external_message.received.completed", {
      participantName: "Ada",
      provider: "telegram",
      messagePreview: "See you at 3",
    });
    expect(l).toMatchObject({ action: "receive", objectKind: "message", name: "Ada", detail: "See you at 3" });
  });

  it("null for what is not a lifecycle fact", () => {
    for (const t of [
      "entity.create.completed", // a record change — parseRecordChange's
      "apiKey.revoke.requested", // a governance phase of the same act
      "app.approve.denied",
      "unknown_family.thing.completed",
      "focus_session",
    ]) {
      expect(parseConnectionEvent(t)).toBeNull();
    }
    // An in-flight sync tick is not a fact; the run's completion line is.
    expect(parseConnectionEvent("connection_sync.progress", { phase: "fetching" })).toBeNull();
  });
});
