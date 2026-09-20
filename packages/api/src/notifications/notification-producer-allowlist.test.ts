/**
 * S3 registry cleanup — a declared `NOTIFICATION_REGISTRY` entry with ZERO
 * producers is a silent trap: `getNotificationDef()` will happily resolve it,
 * a proposal handler or a future caller can reference the type and believe it
 * fires, and nothing ever tells them it doesn't. This is a SOURCE-SCAN
 * tripwire (same idiom as `capability-drift.projection-parity.tripwire.test.ts`)
 * rather than a runtime test, because "has zero producers" is a claim about
 * the whole `packages/api` source tree, not about one function's behaviour.
 *
 * Deliberately conservative: a type counts as "produced" if its literal string
 * appears ANYWHERE in a non-test, non-registry source file next to `type:` or
 * `notificationType`. That is broader than "is a direct
 * `NotificationService.create()` argument" on purpose — it also matches an
 * indirect producer like `notify-service-unhealthy.ts`, which passes
 * `notificationType: "system.intelligence_degraded"` as an OVERRIDE into
 * `notifyConnectorUnhealthy()` rather than calling `NotificationService.create`
 * itself.
 *
 * If this test fails because the FOUND-set no longer equals the allowlist:
 *   - a type gained a producer → remove its row from the allowlist below
 *     (and consider whether it should be promoted via
 *     `notification-event-map.ts`, S3's mechanism for a real alert to also
 *     reach the event spine).
 *   - a brand-new type was declared with no producer → either wire a real
 *     producer, delete the dead registry row, or add it here with a
 *     "declared, unproduced — remove or produce by <date>" comment; never
 *     let this test silently widen.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { NOTIFICATION_REGISTRY } from "./registry.js";
import { PRODUCERLESS_NOTIFICATION_TYPES } from "./catalogue.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_SRC = join(HERE, "..", "..");

/**
 * The explicit, human-reviewed allowlist of registry types with NO producer
 * anywhere in `packages/api/src` as of 2026-09-04 (S3). Every row's rationale
 * ("declared, unproduced — remove or produce by 2026-10-01") is kept with the
 * list itself.
 *
 * ⚠️ THE LIST IS NOT DECLARED HERE. It moved to `./catalogue.ts` as
 * `PRODUCERLESS_NOTIFICATION_TYPES`, because the settings catalogue must
 * exclude these types at RUNTIME and this file's mechanism — a `readdirSync`
 * scan of the `.ts` source tree — cannot run in a deployed pod. One list,
 * imported by both; this test remains the tripwire that pins it to the scan.
 * Edit the list THERE; this test going red is what tells you to.
 */
const PRODUCERLESS_ALLOWLIST = PRODUCERLESS_NOTIFICATION_TYPES;

/** Every `.ts` file under `dir`, skipping node_modules/dist/tests/this file. */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...collectSourceFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts")) continue;
    if (full === join(HERE, "registry.ts")) continue; // the declarations themselves
    out.push(full);
  }
  return out;
}

/**
 * Prefixes a producer builds with a template literal (`` `ai.proactive.${t}` ``).
 * Derived from the emitters, not hand-guessed: each entry must appear in source
 * as that exact backtick prefix, which the scan below asserts.
 */
const COMPOSED_TYPE_PREFIXES = ["ai.proactive."] as const;

function findProducerlessTypes(): Set<string> {
  const files = collectSourceFiles(API_SRC);
  const contents = files.map((f) => readFileSync(f, "utf8"));

  const producerless = new Set<string>();
  for (const def of NOTIFICATION_REGISTRY) {
    const literal = `"${def.type}"`;
    const hasProducer = contents.some((src) => {
      // Check EVERY occurrence, not just the first — a file can reference the
      // same type literal once as a read-side comparison (`eq(notifications.type,
      // "…")`) and again as the actual producer's `type: "…"` a few lines later
      // (`scan-stale-proposals.ts` does exactly this for `governance.proposal_stale`).
      let idx = src.indexOf(literal);
      while (idx !== -1) {
        const windowStart = Math.max(0, idx - 40);
        const before = src.slice(windowStart, idx);
        if (/(type|notificationType)\s*[:=?]/.test(before)) return true;
        idx = src.indexOf(literal, idx + 1);
      }
      return false;
    });
    // A producer may COMPOSE the type instead of writing it whole:
    // `delivery-router.ts` emits `ai.proactive.${proactiveType}`. A literal
    // scan cannot see that, and the four types it hides were real, delivered
    // notifications the settings screen refused to list — a switch missing for
    // something the founder actually receives. Treat a template-literal
    // prefix as a producer for every registry type under that prefix.
    const composed =
      !hasProducer &&
      contents.some((src) =>
        COMPOSED_TYPE_PREFIXES.some(
          (prefix) =>
            def.type.startsWith(prefix) && src.includes(`\`${prefix}$\{`)
        )
      );
    if (!hasProducer && !composed) producerless.add(def.type);
  }
  return producerless;
}

describe("notification registry — producer-less types stay an explicit, honest allowlist", () => {
  it("the FOUND producer-less set equals the reviewed allowlist exactly", () => {
    const found = findProducerlessTypes();

    const missingFromAllowlist = [...found].filter(
      (t) => !PRODUCERLESS_ALLOWLIST.has(t)
    );
    const staleInAllowlist = [...PRODUCERLESS_ALLOWLIST].filter(
      (t) => !found.has(t)
    );

    expect(
      missingFromAllowlist,
      "A registry type has NO producer but is missing from the allowlist. " +
        "Either wire a producer, delete the dead row, or add it here with a " +
        "'declared, unproduced — remove or produce by <date>' comment."
    ).toEqual([]);

    expect(
      staleInAllowlist,
      "A type in the allowlist now HAS a producer (or was deleted from the " +
        "registry). Remove its row from PRODUCERLESS_ALLOWLIST — and if it is " +
        "one of the six alerts this task promoted, wire it into " +
        "notification-event-map.ts instead of leaving it here."
    ).toEqual([]);
  });

  it("the four S3-promoted alert types are NOT in the allowlist (they have real producers)", () => {
    for (const promoted of [
      "connector.auth.expired",
      "system.intelligence_degraded",
      "system.capability_update_available",
      "system.issuer_pending_approval",
    ]) {
      expect(PRODUCERLESS_ALLOWLIST.has(promoted)).toBe(false);
    }
  });
});
