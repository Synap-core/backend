import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";

/**
 * A CP-brokered pod must never take a LOCAL Nango key: a vaulted
 * key would bypass the broker's per-pod namespace.
 *
 * Behaviour of the predicate (`isControlPlaneBrokered`) and of
 * `migrateNangoEnvToVault`'s refusal is tested in `connectors/resolve-broker.test.ts`.
 * This pins the tRPC door that WRITES the vault key: `saveNangoConfig` must refuse
 * before any vault write. Source-level because the procedure needs a full
 * pod-admin tRPC context.
 *
 * CANNOT SEE: a second vault-writing door for `nango-connector` in another file.
 */

const src = readFileSync(
  new URL("../routers/connectors-trpc.ts", import.meta.url),
  "utf-8"
);

describe("tripwire: saveNangoConfig refuses on a CP-brokered pod", () => {
  it("the refusal runs before the vault write, inside the procedure body", () => {
    const start = src.indexOf("  saveNangoConfig: podAdminProcedure");
    const end = src.indexOf("  migrateNangoToVault: podAdminProcedure", start);
    expect(start, "saveNangoConfig not found").toBeGreaterThan(-1);
    expect(end, "end of saveNangoConfig not found").toBeGreaterThan(start);
    const body = src.slice(start, end);
    const refusal = body.indexOf("refuseOnBrokeredPod()");
    const write = body.indexOf("upsertServiceSecret(");
    expect(refusal, "refuseOnBrokeredPod() missing").toBeGreaterThan(-1);
    expect(write, "vault write missing (scan vacuous)").toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(write);
  });

  it("the refusal is keyed on the server-env predicate", () => {
    const helper = src.slice(src.indexOf("function refuseOnBrokeredPod("));
    expect(helper.slice(0, 400)).toContain("isControlPlaneBrokered()");
  });
});
