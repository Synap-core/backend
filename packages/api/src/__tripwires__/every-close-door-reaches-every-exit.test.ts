import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TERMINAL_SESSION_STATUSES } from "@synap-core/types/focus-sessions";

/**
 * TRIPWIRE — every close DOOR can express every lifecycle EXIT.
 *
 * `completeFocusSession` has accepted `terminalStatus` since it was written:
 * `closed` (finished), `cancelled` (abandoned), `failed` (could not complete).
 * All three run the identical close — review pack, playbook_run close,
 * session-bound ephemeral expiry, both halves of the close event — and differ
 * only in the outcome they record.
 *
 * ── WHAT WAS ACTUALLY BROKEN ────────────────────────────────────────────────
 * Found by dogfooding the deployed pod, NOT by any test. Three of the four
 * doors never forwarded the parameter:
 *
 *   tRPC focusSessions.update  — all three  ✅ (funnels on isTerminalSessionStatus)
 *   Hub REST PATCH             — all three  ✅
 *   Hub REST POST …/complete   — hardcoded `closed`           ❌
 *   MCP synap_complete_session — no such field at all         ❌
 *   CLI `session close`        — closes through the route above ❌
 *
 * So an agent — on the PRIMARY agent door — could record "I finished this"
 * and never "I abandoned this" or "I could not do this". Every agent-aborted
 * session was written to the graph as a successful close. That is not a
 * missing nicety: it is the pod's record of its own work being wrong in the
 * one direction that flatters the agent.
 *
 * ── WHY A TRIPWIRE, AND WHY AGAINST THE MANIFEST ────────────────────────────
 * A parameter that exists on the service with no producer on the doors is the
 * built-but-severed defect this codebase keeps paying for, and nothing typed
 * can see it: every door compiled fine while omitting an OPTIONAL field.
 *
 * The MCP assertion reads the generated MANIFEST, not `tools/index.ts`. The
 * manifest is the contract actually served to clients; a source-reading check
 * passes on an edit that was never regenerated. (A CP drift test read source
 * instead of the manifest here once already, and certified a lie.)
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const API_SRC = join(HERE, "..");
const MANIFEST = join(API_SRC, "routers/mcp/tools/mcp-tools.manifest.json");
const HUB_REST = join(API_SRC, "routers/hub-protocol/rest/focus-sessions.ts");

describe("tripwire: every close door reaches every lifecycle exit", () => {
  it("the terminal vocabulary is non-trivial", () => {
    // NON-VACUITY. If the SSOT ever collapses to a single value, every
    // assertion below becomes trivially true and this file stops testing
    // anything — that must fail loudly rather than read green.
    expect(TERMINAL_SESSION_STATUSES.length).toBeGreaterThan(1);
    expect([...TERMINAL_SESSION_STATUSES]).toContain("closed");
  });

  it("scan targets exist", () => {
    expect(existsSync(MANIFEST), `missing manifest: ${MANIFEST}`).toBe(true);
    expect(existsSync(HUB_REST), `missing hub route: ${HUB_REST}`).toBe(true);
  });

  it("the MCP close tool offers every terminal status (read from the MANIFEST)", () => {
    const raw = JSON.parse(readFileSync(MANIFEST, "utf8"));
    const tools = Array.isArray(raw) ? raw : raw.tools;
    const tool = tools.find(
      (t: { name?: string }) => t?.name === "synap_complete_session"
    );
    expect(
      tool,
      "synap_complete_session is absent from the manifest"
    ).toBeTruthy();

    const schema = tool.inputSchema ?? tool.input_schema ?? {};
    const offered: unknown = schema?.properties?.terminalStatus?.enum;
    expect(
      offered,
      "synap_complete_session exposes no `terminalStatus`. The agent door can " +
        "then only ever record a session as finished — never abandoned, never " +
        "failed — while the tRPC and Hub PATCH doors can. Regenerate the " +
        "manifest (`pnpm gen:mcp-manifest`) if you added the field in source."
    ).toBeDefined();

    expect(
      [...(offered as string[])].sort(),
      "the MCP door's terminal set has drifted from the SSOT"
    ).toEqual([...TERMINAL_SESSION_STATUSES].sort());
  });

  it("the Hub REST complete route accepts terminalStatus and does not hardcode the response", () => {
    const src = readFileSync(HUB_REST, "utf8");

    expect(
      /terminalStatus:\s*z\.enum\(TERMINAL_SESSION_STATUSES\)/.test(src),
      "POST /focus-sessions/:id/complete does not accept `terminalStatus` from " +
        "the SSOT enum. The CLI and the MCP door both close through this route, " +
        "so hardcoding `closed` here severs BOTH of them at once."
    ).toBe(true);

    // The response must report the row, not a literal. `status: "closed" as
    // const` sat here while the route could already have closed as something
    // else — a caller that cancelled would have been told it succeeded.
    expect(
      /status:\s*"closed"\s+as\s+const/.test(src),
      'the complete route reports a hardcoded `status: "closed"`. Report ' +
        "`result.session.status` — the status the row actually holds."
    ).toBe(false);
  });
});
