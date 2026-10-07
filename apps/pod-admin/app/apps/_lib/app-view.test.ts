import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONNECTION_STATES,
  connectionView,
  resolveAppConnection,
} from "@synap-core/types/membrane";
import { chipColor, revokeConsequence, type AppRow } from "./app-view";

const NOW = Date.parse("2026-10-08T00:00:00Z");
const row = (over: Partial<AppRow> = {}): AppRow =>
  ({
    id: "a1",
    public_id: "app_1",
    name: "synap.live",
    mode: "specific",
    created_at: "2026-10-07T00:00:00.000Z",
    last_used_at: "2026-10-07T00:00:00.000Z",
    revoked_at: null,
    pending_request: null,
    grants: [{ permissions: ["entity.person.create"], workspaceIds: ["w1"] }],
    ...over,
  }) as AppRow;

describe("pod-admin reads an app's standing from the membrane", () => {
  it("every membrane state's tone maps to a real chip colour", () => {
    for (const s of CONNECTION_STATES) {
      expect(chipColor(connectionView("app", s).tone), s).toMatch(
        /^(default|primary|success|warning|danger)$/
      );
    }
  });

  it("an asking app reads Asking — not 'Has access' or 'No access yet'", () => {
    const v = resolveAppConnection(
      row({
        pending_request: {
          proposal_id: "p1",
          requests: [{ permission: "entity.person.create", workspaceId: "w1" }],
          requested_at: "2026-10-07T00:00:00.000Z",
        } as AppRow["pending_request"],
      }),
      { now: NOW }
    );
    expect(v.state).toBe("asking");
    expect(v.label).not.toMatch(/Has access|No access yet/);
  });

  it("revoke says what it does in each state — asking cancels the request", () => {
    expect(revokeConsequence("asking")).toMatch(/^Cancels the request/);
    expect(revokeConsequence("setting_up")).toMatch(/no access yet/);
    expect(revokeConsequence("ready")).not.toMatch(/request/);
  });

  it("no app page derives standing locally any more", () => {
    const root = join(__dirname, "..", "..");
    for (const f of ["apps/[publicId]/page.tsx", "my-connections/page.tsx"]) {
      const src = readFileSync(join(root, f), "utf8");
      expect(src, f).toMatch(/resolveAppConnection\(/);
      expect(src, f).not.toMatch(/appState\(|appStateFacts|"Has access"/);
    }
  });
});
