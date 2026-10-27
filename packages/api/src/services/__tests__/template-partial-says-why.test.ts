/**
 * A `partial` template apply records WHY each item did not land, and health
 * says it.
 *
 * Founder pod, 27 Oct 2026: the CRM row read `partial` with failures
 * ["capabilities:unipile-linkedin", "capabilities:nango-google",
 * "automations:LinkedIn conversation ingest"], and every door served "part of
 * crm did not apply. Run `synap templates update crm` to retry." The reason
 * each item gave was dropped by the finisher (`notLanded` kept `<layer>:<name>`
 * only), so no one could tell a crash from a key nobody had given, and the
 * advice (retry) could not help the second.
 *
 * Pinned here, through the real finisher, the real state merge and the real
 * sentence: each line keeps its reason; items that wait on the person go to
 * `needsSetup`; the sentence names them and says "set it up", never "retry",
 * when nothing else is left; a converged apply clears both.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ patch: null as Record<string, unknown> | null }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    getDb: async () => ({}),
    // The ONE writer: decide against no current record, keep what it writes.
    writeTemplateState: vi.fn(
      async (_db: unknown, _ws: string, patch: unknown) => {
        h.patch =
          typeof patch === "function"
            ? (patch as (c: null) => Record<string, unknown>)(null)
            : (patch as Record<string, unknown>);
        return { at: "2026-10-27T18:00:00.000Z" };
      }
    ),
  };
});

import { mergeTemplateState, type TemplateStatePatch } from "@synap/database";
import { finishTemplateApply } from "../template-apply-finisher.js";
import { templateApplyWarning } from "../template-health.js";

const WS = "11111111-1111-4111-8111-111111111111";
const USER = "33333333-3333-4333-8333-333333333333";

/** The CRM bag of 27 Oct, as the applier now reports it. */
const SETUP_ONLY = {
  capabilities: [
    { key: "apify", status: "created", created: true },
    {
      key: "unipile-linkedin",
      status: "error",
      message: "Needs setup: Unipile v2 API key.",
      needsSetup: true,
    },
    {
      key: "nango-google",
      status: "error",
      message: "Needs setup: connect google.",
      needsSetup: true,
    },
  ],
  automations: [
    {
      name: "LinkedIn conversation ingest",
      status: "error",
      message: "Waits on unipile-linkedin: Needs setup: Unipile v2 API key.",
      needsSetup: true,
    },
  ],
};

async function finish(post: Record<string, unknown>) {
  const result = await finishTemplateApply({
    workspaceId: WS,
    userId: USER,
    built: false,
    pendingVersionStamp: "h-new",
    post,
  });
  const settings = {
    template: mergeTemplateState(
      { slug: "crm", version: "h-old", state: "active", at: "t" },
      h.patch as TemplateStatePatch,
      "2026-10-27T18:00:00.000Z"
    ),
  };
  return { result, settings };
}

beforeEach(() => {
  h.patch = null;
});

describe("a partial apply records each item's reason", () => {
  it("setup left only: recorded under needsSetup, and health says set it up", async () => {
    const { result, settings } = await finish(SETUP_ONLY);
    expect(result.state).toBe("partial");
    expect(result.versionStamped).toBe(false);
    expect(h.patch).toMatchObject({
      state: "partial",
      failures: null,
      needsSetup: [
        "capabilities:unipile-linkedin: Needs setup: Unipile v2 API key.",
        "capabilities:nango-google: Needs setup: connect google.",
        "automations:LinkedIn conversation ingest: Waits on unipile-linkedin: Needs setup: Unipile v2 API key.",
      ],
    });
    expect(templateApplyWarning("crm", settings, [])).toBe(
      "Not finished: part of crm waits on your setup (capabilities:unipile-linkedin: Needs setup: Unipile v2 API key; capabilities:nango-google: Needs setup: connect google; automations:LinkedIn conversation ingest: Waits on unipile-linkedin: Needs setup: Unipile v2 API key). Set it up, then run `synap templates update crm`."
    );
  });

  it("a real error keeps its reason, and the sentence says retry", async () => {
    const { settings } = await finish({
      capabilities: [
        ...SETUP_ONLY.capabilities,
        { key: "broken", status: "error", message: "boom." },
      ],
    });
    expect(h.patch).toMatchObject({
      failures: ["capabilities:broken: boom."],
    });
    expect(templateApplyWarning("crm", settings, [])).toBe(
      "Not finished: part of crm did not apply (capabilities:broken: boom; capabilities:unipile-linkedin: Needs setup: Unipile v2 API key; capabilities:nango-google: Needs setup: connect google). Run `synap templates update crm` to retry."
    );
  });

  it("a long list is cut after three reasons", () => {
    const settings = {
      template: {
        slug: "crm",
        version: null,
        state: "partial",
        at: "t",
        failures: ["a: 1", "b: 2", "c: 3", "d: 4", "e: 5"],
      },
    };
    expect(templateApplyWarning("crm", settings, [])).toBe(
      "Not finished: part of crm did not apply (a: 1; b: 2; c: 3; and 2 more). Run `synap templates update crm` to retry."
    );
  });

  it("the next converged apply clears the record", async () => {
    const { settings } = await finish(SETUP_ONLY);
    const after = mergeTemplateState(
      settings.template,
      { state: "active", version: "h-new" },
      "2026-10-27T19:00:00.000Z"
    );
    expect(after.needsSetup).toBeUndefined();
    expect(after.failures).toBeUndefined();
  });
});
