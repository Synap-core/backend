import { describe, it, expect } from "vitest";
import { deriveMcpScopes } from "../routers/mcp/http-handler.js";
import {
  SETUP_AGENT_HUB_SCOPES,
  INTEGRATION_HUB_SCOPES,
} from "../services/hub-integration-registration.js";
import { zeroclawEntry } from "../utils/agent-services/services/zeroclaw.js";
import { openclawEntry } from "../utils/agent-services/services/openclaw.js";

/**
 * TRIPWIRE — every real key-minting site must derive to a NON-EMPTY MCP scope.
 *
 * `deriveMcpScopes` (packages/api/src/routers/mcp/http-handler.ts) is the
 * single translation from a key's stored `scope` column (Hub Protocol /
 * data.* vocabulary) to the `mcp.read`/`mcp.write` vocabulary the MCP HTTP
 * door's `requireScope()` actually checks. Every in-repo constant that a real
 * mint site uses to populate `api_keys.scope` is enumerated below and passed
 * THROUGH `deriveMcpScopes` — never hand-copied — so that if a scope constant
 * changes (a scope renamed, an array trimmed) or `deriveMcpScopes` itself is
 * "cleaned up" to drop a clause it doesn't recognize, this test fails instead
 * of an integration silently going dark at the MCP door.
 *
 * If this test ever fails because a NEW mint site was added whose scopes
 * derive to `[]`: that integration is DEAD ON ARRIVAL — every one of its
 * tool calls will 401/-32603 at the /mcp endpoint even though the key itself
 * authenticates fine. Fix `deriveMcpScopes` to recognize the new scope
 * vocabulary (or fix the mint site to grant a recognized scope) — do not
 * relax this test.
 *
 * Also covers the three OUT-OF-REPO mint sites that predate `mcp.*` scopes
 * entirely and issue only `["hub-protocol.read","hub-protocol.write"]`:
 *   - synap-control-plane-api/src/lib/hub-key.ts:77
 *   - synap-cli/src/commands/agents.ts:582
 *   - packages/database/src/scripts/init-hub-keys.ts:97
 * Those files live in other repos/packages and can't be imported here, so the
 * literal scope array they mint is asserted directly (this is the one place
 * in this suite where a literal is intentional and unavoidable — the
 * out-of-repo files themselves are the source of truth for what they mint).
 */
describe("tripwire: no key-minting scope set derives to zero MCP access", () => {
  it("SETUP_AGENT_HUB_SCOPES (POST /api/hub/setup/agent) grants MCP access", () => {
    expect(deriveMcpScopes([...SETUP_AGENT_HUB_SCOPES]).length).toBeGreaterThan(
      0
    );
  });

  it.each(Object.entries(INTEGRATION_HUB_SCOPES))(
    "INTEGRATION_HUB_SCOPES.%s grants MCP access",
    (_name, scopes) => {
      expect(deriveMcpScopes(scopes).length).toBeGreaterThan(0);
    }
  );

  it("zeroclaw service defaultScopes grants MCP access", () => {
    expect(deriveMcpScopes(zeroclawEntry.defaultScopes).length).toBeGreaterThan(
      0
    );
  });

  it("openclaw service defaultScopes grants MCP access", () => {
    expect(deriveMcpScopes(openclawEntry.defaultScopes).length).toBeGreaterThan(
      0
    );
  });

  it("the out-of-repo mint sites' literal scope set grants MCP access", () => {
    // hub-key.ts, agents.ts (synap-cli), init-hub-keys.ts — see file header.
    const outOfRepoMintedScopes = ["hub-protocol.read", "hub-protocol.write"];
    expect(deriveMcpScopes(outOfRepoMintedScopes).length).toBeGreaterThan(0);
  });
});
