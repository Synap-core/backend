import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * INVARIANT LOCK — an agent-user NEVER carries a Kratos identity.
 *
 * `users.kratos_identity_id IS NULL` is the canonical human↔agent discriminator
 * (agents authenticate on the Hub-key rail, not Kratos self-service). The
 * federated user-sign-in rework classifies a NON-null kratos_identity_id as "a
 * Kratos human", so any agent-user create-door that stamps a sentinel like
 * `agent:${uuid}` would silently mis-classify the agent as a human.
 *
 * This scans the two agent-user create-doors and fails if either assigns a
 * string/template beginning with `agent:` to kratosIdentityId. If it fails: an
 * agent insert reintroduced the sentinel — write `kratosIdentityId: null` and
 * (for existing rows) add a normalizing data migration like 0203.
 */

// ALL agent-user create-doors — a sentinel in ANY of them defeats the invariant.
// (This list was originally 2 files and went false-green while two more doors —
// intelligence-registry + intelligence — still stamped `agent:${id}`. If you add
// a new agent-user insert site, add it here.)
const SOURCES = [
  "./agent-identity-service.ts",
  "../routers/hub-protocol/rest/setup.ts",
  "../routers/intelligence-registry.ts",
  "../routers/intelligence.ts",
].map((rel) => ({
  rel,
  src: readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"),
}));

// kratosIdentityId assigned a string/template literal starting with "agent:"
const SENTINEL = /kratosIdentityId:\s*[`"']agent:/;

describe("agent-user kratos-identity invariant", () => {
  for (const { rel, src } of SOURCES) {
    it(`${rel} never stamps an 'agent:' sentinel into kratosIdentityId`, () => {
      expect(SENTINEL.test(src)).toBe(false);
    });
  }
});
