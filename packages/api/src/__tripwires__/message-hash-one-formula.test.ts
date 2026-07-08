import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";

/**
 * TRIPWIRE — the channel-message tamper hash has ONE formula.
 *
 * A message row's `hash` (and its `previousHash` chain link) is an integrity
 * value. There is exactly one definition of how it is computed:
 * `computeMessageHash(id, content, previousHash="")` in
 * `@synap/database` (`database/src/utils/message-hash.ts`). Every writer that
 * inserts a `messages` row derives its `hash`/`previousHash` from that helper,
 * so the chain can never silently drift between producers (a prior wave
 * consolidated 17 value-identical sites + converted 6 non-canonical writers
 * that were hashing `JSON.stringify({channelId,content,role})` /
 * `outbound:${threadId}:…` — different values for the "same" message).
 *
 * INVARIANT: no file outside the allowlist may build a raw `createHash(…)`
 * digest AND insert into the `messages` table. If a file does both, it is
 * populating `messages.hash`/`previousHash` with an ad-hoc formula instead of
 * `computeMessageHash`. If this fails: import `computeMessageHash` from
 * `@synap/database`, generate the row `id` up front, and set
 * `hash: computeMessageHash(id, content[, previousHash])`. Do NOT add your file
 * to the allowlist.
 *
 * SCOPE: scans the three packages that write channel messages — `api/src`,
 * `database/src`, `jobs/src`. The detector binds `createHash(` to a `messages`
 * write (drizzle `.insert(messages)` OR raw SQL `INSERT INTO messages`); it does
 * NOT fire on the legitimate non-message hashes that also live here — file/share
 * tokens (`share-token.ts`), api-key hashes (`api-keys.ts`), request idempotency
 * (`idempotency.ts`), service-key crypto (`service-key-crypto.ts`), or the
 * deterministic document-id derivation (`materializer.ts`) — because none of
 * those insert into `messages`.
 *
 * ALLOWLIST (shrink-only — never add):
 *  - `database/src/utils/message-hash.ts` — the SSOT: the ONE place the formula
 *    is defined. (Does not insert `messages`; listed for clarity.)
 *  - `database/src/repositories/conversation-repository.ts` — a SEPARATE tamper
 *    scheme backed by its own `verify_hash_chain()` verifier (deliberately not
 *    the channel-message chain; owner decision to leave it).
 *  - `jobs/src/workers/proposal-reviewed-notifier.ts` — the `hash` here is an
 *    idempotency/dedup key READ BACK via `WHERE messages.hash = …` to skip
 *    duplicate notifications on pg-boss retry, NOT a tamper hash.
 *  - `api/src/services/connectors/inbound-recorder.ts` — same: the `hash` is a
 *    dedup key (`provider:idempotencySeed`) READ BACK via `WHERE messages.hash`
 *    to drop already-recorded inbound messages.
 */

// Paths are relative to the backend `packages/` dir.
const ALLOWLIST = new Set<string>([
  "database/src/utils/message-hash.ts",
  "database/src/repositories/conversation-repository.ts",
  "jobs/src/workers/proposal-reviewed-notifier.ts",
  "api/src/services/connectors/inbound-recorder.ts",
]);

// A raw hash construction (createHash("sha256")… or any createHash(…)).
const CREATE_HASH = /createHash\s*\(/;
// A write into the `messages` table — drizzle builder OR raw SQL.
const MESSAGES_WRITE = /\.insert\(\s*messages\s*\)|INSERT\s+INTO\s+messages/i;

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      tsFiles(p, acc);
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      acc.push(p);
    }
  }
  return acc;
}

describe("tripwire: message tamper hash has one formula (computeMessageHash)", () => {
  const packagesRoot = join(process.cwd(), "..");
  const scanRoots = [
    join(packagesRoot, "api", "src"),
    join(packagesRoot, "database", "src"),
    join(packagesRoot, "jobs", "src"),
  ];

  it("no scanned file builds a raw message-hash digest outside the SSOT", () => {
    const offenders = scanRoots
      .flatMap((root) => tsFiles(root))
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return CREATE_HASH.test(src) && MESSAGES_WRITE.test(src);
      })
      .map((f) => relative(packagesRoot, f))
      .filter((rel) => !ALLOWLIST.has(rel));
    expect(offenders).toEqual([]);
  });

  it("sanity: the detector's createHash regex matches the SSOT itself", () => {
    // Proves the banned pattern is real (not a no-op regex): the ONE canonical
    // formula in message-hash.ts is exactly the createHash construction we ban
    // everywhere else.
    const ssot = readFileSync(
      join(packagesRoot, "database", "src", "utils", "message-hash.ts"),
      "utf8"
    );
    expect(CREATE_HASH.test(ssot)).toBe(true);
    expect(ssot.includes("export function computeMessageHash")).toBe(true);
  });
});
