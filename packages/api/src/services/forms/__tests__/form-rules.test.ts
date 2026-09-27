/**
 * Pure rules of the public-form door: the fail-closed mode floor, the strict
 * field builder (with the string encodings a browser posts), the stored-row
 * parser, the reply contract and the captcha verifier. Each fixture row names
 * the rule it would rule OUT.
 */

import { describe, it, expect, vi } from "vitest";
import {
  FormConfigSchema,
  buildPropertiesFromFields,
  isFormToolMetadata,
  parseStoredForm,
  wantsDirect,
  publicFormView,
} from "../form-definition.js";
import { verifyCaptcha, captchaConfigFromEnv } from "../captcha.js";
import { guestProvenanceFor, proposalActorKind } from "../guest-provenance.js";
import {
  planGuestWrite,
  planCarriesSignal,
  guestFormReply,
  type GuestOutcome,
} from "../guest-submit.js";

const CONFIG = FormConfigSchema.parse({
  name: "Contact",
  kind: "person",
  fields: [
    { key: "name", label: "Name", type: "text", required: true },
    { key: "email", label: "Email", type: "email" },
    {
      key: "age",
      label: "Age",
      type: "number",
      constraints: { min: 0, max: 150 },
    },
    {
      key: "plan",
      label: "Plan",
      type: "enum",
      constraints: { enum: ["a", "b"] },
    },
    { key: "subscribe", label: "Subscribe", type: "boolean" },
  ],
  titleField: "name",
});

describe("wantsDirect — proposal unless BOTH stores say direct and nothing degraded", () => {
  it.each([
    // [storedMode, rule, degraded, expected] — the row it rules out
    ["direct", "auto", false, true], // positive control
    ["direct", "propose", false, false], // rules out "config alone decides"
    ["direct", null, false, false], // rules out "missing rule = allow"
    ["proposal", "auto", false, false], // rules out "rule alone decides"
    [undefined, "auto", false, false], // rules out "absent mode = direct"
    ["Direct", "auto", false, false], // rules out a loose match
    ["direct", "auto", true, false], // rules out "captcha outage keeps direct"
  ] as const)(
    "mode=%s rule=%s degraded=%s → %s",
    (storedMode, rule, degraded, expected) => {
      expect(
        wantsDirect({ storedMode, ruleVerdict: rule as never, degraded })
      ).toBe(expected);
    }
  );

  it("a config with no mode parses as proposal", () => {
    expect(CONFIG.mode).toBe("proposal");
  });
});

describe("buildPropertiesFromFields — allowlist only, strict types", () => {
  it("drops undeclared keys and keeps declared ones", () => {
    expect(
      buildPropertiesFromFields(CONFIG.fields, {
        name: "Ada",
        workspaceId: "x",
        profileSlug: "workspace",
        __proto__: { polluted: true },
      })
    ).toEqual({ ok: true, properties: { name: "Ada" } });
  });

  it.each([
    [{ name: { $ne: 1 } }, ["name"], "object for text"],
    [{ name: ["a"] }, ["name"], "array for text"],
    [{ name: "A", email: "nope" }, ["email"], "bad email"],
    [{ name: "A", age: "twelve" }, ["age"], "a word for a number"],
    [{ name: "A", age: "12abc" }, ["age"], "trailing junk after a number"],
    [{ name: "A", age: "1e3" }, ["age"], "exponent notation"],
    [{ name: "A", age: "999" }, ["age"], "a string number over max"],
    [{ name: "A", age: 999 }, ["age"], "number over max"],
    [{ name: "A", plan: "c" }, ["plan"], "enum outside options"],
    [{ name: "A", subscribe: "maybe" }, ["subscribe"], "a word for a checkbox"],
    [{ name: "A", subscribe: 1 }, ["subscribe"], "a number for a checkbox"],
    [{ email: "a@b.io" }, ["name"], "required missing"],
    [{ email: "no", age: "x" }, ["name", "email", "age"], "every failing key"],
  ] as Array<[Record<string, unknown>, string[], string]>)(
    "rejects the whole submission: %j ⇒ invalid %j (%s)",
    (fields, invalid) => {
      expect(buildPropertiesFromFields(CONFIG.fields, fields)).toEqual({
        ok: false,
        invalid,
      });
    }
  );

  it.each([
    // [posted, read as] — the encodings an HTML form or the embed snippet send
    [{ age: "3" }, { age: 3 }],
    [{ age: " 3.5 " }, { age: 3.5 }],
    [{ age: ".5" }, { age: 0.5 }],
    [{ age: "0" }, { age: 0 }],
    [{ age: 42 }, { age: 42 }],
    [{ subscribe: "on" }, { subscribe: true }],
    [{ subscribe: "true" }, { subscribe: true }],
    [{ subscribe: "TRUE" }, { subscribe: true }],
    [{ subscribe: "1" }, { subscribe: true }],
    [{ subscribe: "off" }, { subscribe: false }],
    [{ subscribe: "false" }, { subscribe: false }],
    [{ subscribe: "0" }, { subscribe: false }],
    [{ subscribe: false }, { subscribe: false }],
  ] as Array<[Record<string, unknown>, Record<string, unknown>]>)(
    "reads the browser encoding %j as %j (rules out: typeof-only)",
    (posted, read) => {
      expect(
        buildPropertiesFromFields(CONFIG.fields, { name: "A", ...posted })
      ).toEqual({ ok: true, properties: { name: "A", ...read } });
    }
  );

  it("reserved property keys cannot be declared", () => {
    for (const key of [
      "userId",
      "workspaceId",
      "profileSlug",
      "id",
      "content",
    ]) {
      expect(
        FormConfigSchema.safeParse({
          ...CONFIG,
          fields: [{ key, label: "x", type: "text" }],
          titleField: key,
        }).success,
        key
      ).toBe(false);
    }
  });

  it("the kind is a code allowlist", () => {
    for (const kind of ["workspace", "project", "agent", "file", "skill"]) {
      expect(
        FormConfigSchema.safeParse({ ...CONFIG, kind }).success,
        kind
      ).toBe(false);
    }
  });
});

describe("stored row parsing fails closed", () => {
  it("any deviation parses to null; isFormToolMetadata still flags the row", () => {
    expect(
      parseStoredForm({ form: { version: 1, config: CONFIG } })
    ).toBeNull();
    expect(isFormToolMetadata({ form: null })).toBe(true);
    expect(isFormToolMetadata({ other: 1 })).toBe(false);
  });

  it("the public view leaks no kind, secret or id", () => {
    const text = JSON.stringify(publicFormView(CONFIG));
    expect(text).not.toMatch(/person|tokenHash|ticketSecret|actor/);
  });

  it("the public view carries minSubmitMs so a client can hold its submit", () => {
    expect(publicFormView(CONFIG).minSubmitMs).toBe(3_000);
    const fast = FormConfigSchema.parse({
      ...CONFIG,
      limits: { pendingCap: 25, minSubmitMs: 0 },
    });
    expect(publicFormView(fast).minSubmitMs).toBe(0);
  });
});

describe("guestFormReply — the public wire contract", () => {
  const RECEIVED = { status: 202, body: { received: true } };
  it.each([
    // Outcomes a caller must not learn from: one constant reply.
    ["proposed", RECEIVED],
    ["honeypot", RECEIVED],
    ["unknown_form", RECEIVED],
    ["captcha_failed", RECEIVED],
    ["denied", RECEIVED],
    // The submitter's own payload: visible.
    ["bad_envelope", { status: 422, body: { received: false, invalid: [] } }],
    ["too_large", { status: 422, body: { received: false, invalid: [] } }],
    ["ticket", { status: 422, body: { received: false, retry: true } }],
    // Server faults: never the success reply.
    ["error", { status: 503, body: { received: false } }],
    ["actor_refused", { status: 503, body: { received: false } }],
  ] as Array<[GuestOutcome, unknown]>)("%s ⇒ %j", (outcome, reply) => {
    expect(guestFormReply({ outcome })).toEqual(reply);
  });

  it("invalid_fields names the keys", () => {
    expect(
      guestFormReply({ outcome: "invalid_fields", invalid: ["email", "age"] })
    ).toEqual({
      status: 422,
      body: { received: false, invalid: ["email", "age"] },
    });
  });
});

describe("the submission note never carries an identity signal key", () => {
  it("match ⇒ note with submitterEmail; no match ⇒ the configured kind", () => {
    const props = { name: "Ada", email: "a@b.io" };
    const note = planGuestWrite({
      formId: "f",
      config: CONFIG,
      properties: props,
      matchedEntityId: "e1",
      facetSlug: "lead",
      idempotencyKey: "k",
      now: new Date(0),
    });
    expect(note.branch).toBe("note");
    expect(note.profileSlug).toBe("note");
    expect(note.properties).toMatchObject({ submitterEmail: "a@b.io" });
    expect(planCarriesSignal(note)).toBe(false);
    expect(note.facets).toBeUndefined();
    const subject = planGuestWrite({
      formId: "f",
      config: CONFIG,
      properties: props,
      matchedEntityId: null,
      facetSlug: "lead",
      idempotencyKey: "k",
      now: new Date(0),
    });
    expect(subject.profileSlug).toBe("person");
    expect(planCarriesSignal(subject)).toBe(true); // the detector is live
    expect(subject.entityId).toBe(note.entityId); // same key ⇒ same id
  });
});

describe("guest provenance", () => {
  it("a form actor renders as guest; any other agent as agent; no agent as human", () => {
    expect(guestProvenanceFor("form:abc")).toEqual({
      actorKind: "guest",
      formId: "abc",
    });
    expect(guestProvenanceFor("capture")).toBeNull();
    expect(proposalActorKind({ agentUserId: "u", agentType: "form:abc" })).toBe(
      "guest"
    );
    expect(proposalActorKind({ agentUserId: "u", agentType: "capture" })).toBe(
      "agent"
    );
    expect(proposalActorKind({ agentUserId: null, agentType: null })).toBe(
      "human"
    );
  });
});

describe("verifyCaptcha", () => {
  const cfg = captchaConfigFromEnv({ FORMS_CAPTCHA_SECRET: "s" })!;
  const reply = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status })) as never;

  it("off unless configured", () => {
    expect(captchaConfigFromEnv({})).toBeNull();
  });
  it("pass / fail / unavailable", async () => {
    expect(await verifyCaptcha("t", cfg, reply(200, { success: true }))).toBe(
      "pass"
    );
    expect(await verifyCaptcha("t", cfg, reply(200, { success: false }))).toBe(
      "fail"
    );
    expect(
      await verifyCaptcha(undefined, cfg, reply(200, { success: true }))
    ).toBe("fail");
    expect(await verifyCaptcha("t", cfg, reply(500, {}))).toBe("unavailable");
    expect(await verifyCaptcha("t", cfg, reply(200, { nope: 1 }))).toBe(
      "unavailable"
    );
    expect(
      await verifyCaptcha(
        "t",
        cfg,
        vi.fn(async () => {
          throw new Error("ECONNREFUSED");
        }) as never
      )
    ).toBe("unavailable");
    expect(await verifyCaptcha("t", null)).toBe("unavailable");
  });
});
