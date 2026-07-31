import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";
import { fileURLToPath } from "url";

/**
 * GUARD — every EXTERNAL send reaches the audit spine (Wave 2, universal sink).
 *
 * Before this wave, an outbound messaging send (Unipile/Stalwart/Discord via
 * `sendExternalMessage`) or a provider proxy call (Nango/vault/mcp via
 * `triggerProviderAction`) left NO run, NO event — `diagnose(id)` dead-ended
 * even though real money/side-effects left the pod. The fix funnels EVERY
 * connector send through the ONE chokepoint (`connectors/external-dispatch.ts`
 * — see its own "ONE implementation, two entry doors" docstring) and stamps a
 * `{channel}.send.completed` / `{scheme}.action.completed` audit event via
 * `recordExternalAction` on every confirmed dispatch.
 *
 * Two guards:
 *
 *   Part A (runtime, real code path): `recordExternalAction` really calls the
 *     underlying `recordDomainMutation` door with `throwOnError: true` — the
 *     un-audited-send guarantee (a send can never be reported without its
 *     audit row landing; a failed append THROWS rather than swallowing).
 *
 *   Part B (drift reachability): a NEW caller that resolves a connector and
 *     invokes its send method DIRECTLY — bypassing `sendExternalMessage`/
 *     `triggerProviderAction` — would silently reopen the un-audited-send gap.
 *     Scan the whole api `src` tree for the connector-level send signatures
 *     (`.proxyRequest(`, the 3-arg `sendMessage(accountId, …)` shape, `.enrich(`)
 *     outside the audited chokepoint; every match must be on the ALLOWLIST
 *     below (each entry is either the chokepoint itself, a connector's own
 *     method DEFINITION — which never matches the call-site regex — or
 *     documented, tracked debt). A new, un-allowlisted match fails CI.
 */

// ── Part A ───────────────────────────────────────────────────────────────────

const recordDomainMutationMock = vi.fn().mockResolvedValue({ id: "evt" });

vi.mock("../utils/domain-mutation.js", () => ({
  recordDomainMutation: (...args: unknown[]) =>
    recordDomainMutationMock(...args),
}));

const { recordExternalAction, EXTERNAL_DISPATCH_SOURCE } = await import(
  "../connectors/external-dispatch.js"
);

describe("guard: recordExternalAction fires the domain-mutation door (real code path)", () => {
  beforeEach(() => {
    recordDomainMutationMock.mockClear();
  });

  it("records a {channel}.{action}.completed audit event with throwOnError: true", async () => {
    await recordExternalAction({
      channel: "gmail",
      action: "send",
      userId: "u1",
      workspaceId: "w1",
      correlationId: "corr-1",
      target: "thread-1",
      status: "sent",
      data: { accountId: "acc-1" },
    });

    expect(recordDomainMutationMock).toHaveBeenCalledTimes(1);
    const arg = recordDomainMutationMock.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(arg.subjectType).toBe("gmail");
    expect(arg.action).toBe("send");
    expect(arg.subjectId).toBe("corr-1");
    expect(arg.correlationId).toBe("corr-1");
    expect(arg.source).toBe(EXTERNAL_DISPATCH_SOURCE);
    // The un-audited-send guarantee: a failed append must THROW, not swallow.
    expect(arg.throwOnError).toBe(true);
    expect(arg.data).toMatchObject({
      target: "thread-1",
      status: "sent",
      accountId: "acc-1",
    });
  });

  it("propagates a failed append as a throw (never a silent un-audited success)", async () => {
    recordDomainMutationMock.mockRejectedValueOnce(new Error("append failed"));
    await expect(
      recordExternalAction({
        channel: "discord",
        action: "message",
        userId: "u1",
        correlationId: "corr-2",
        target: "thread-2",
        status: "sent",
      })
    ).rejects.toThrow("append failed");
  });
});

// ── Part B ───────────────────────────────────────────────────────────────────

/**
 * Files where the connector-send call-site regexes below are EXPECTED to
 * match, and are NOT a new bypass:
 *   - `external-dispatch.ts`: the audited chokepoint itself (source of truth).
 *   - `ConnectorRegistry.ts`: `.enrich(` here is the `Readable.read()` seam's
 *     enrichment branch — a READ (Apollo/Apify person/company lookup), not an
 *     irreversible send. No `userId` is threaded to this layer today (the
 *     `ReadRequest`/`Readable` seam is user-agnostic), so it cannot call
 *     `recordExternalAction` without a wider plumbing change. TRACKED DEBT —
 *     do not silently close; wire it once `ReadRequest` carries an actor id.
 *   - `connectors-trpc.ts`: `provider.enrich(...)` — the direct-REST enrichment
 *     door, same gap as above (a second, un-audited enrichment call site).
 *     TRACKED DEBT — this is the same "enrichment reads leave no run" gap
 *     `ConnectorRegistry.ts` carries, not yet unified onto one door.
 *
 * Do NOT add a new file here to silence this guard — either route the send
 * through `sendExternalMessage`/`triggerProviderAction`, or add
 * `recordExternalAction` at the new call site directly.
 */
const ALLOWLIST = new Set<string>([
  join("connectors", "external-dispatch.ts"),
  join("connectors", "ConnectorRegistry.ts"), // TODO: enrichment reads need an actor id threaded through ReadRequest
  join("routers", "connectors-trpc.ts"), // TODO: same enrichment gap, un-unified with ConnectorRegistry's read seam
]);

/** Call-site signatures unique to a connector's SEND/PROXY methods (verified
 * against the current tree — no other homonym collides: the IS chat client's
 * `sendMessage({...})` is a single-object-arg call and never matches the
 * 3-arg positional `sendMessage(accountId, ...)` shape below). */
const SEND_CALL_PATTERNS: RegExp[] = [
  /\.proxyRequest\(/,
  /\bsendMessage\(\s*[a-zA-Z_$][\w$]*\s*,/,
  /\.triggerAction\(/,
  /\.enrich\(/,
];

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

describe("guard: no new caller bypasses the audited external-dispatch chokepoint", () => {
  it("every connector-send call site is the chokepoint or an allowlisted read", () => {
    // Resolve relative to THIS test file, not process.cwd() — mirrors
    // domain-mutation-one-door.test.ts's cwd-independence fix.
    const srcRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
    const offenders = tsFiles(srcRoot)
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return SEND_CALL_PATTERNS.some((re) => re.test(src));
      })
      .map((f) => relative(srcRoot, f))
      .filter((rel) => !ALLOWLIST.has(rel));

    expect(offenders).toEqual([]);
  });
});
