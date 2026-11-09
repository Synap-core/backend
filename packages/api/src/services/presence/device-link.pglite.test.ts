/**
 * "Add this device" (founder decision of 9 Nov 2026, session 84c74a23) on
 * PGlite, through the real service, the real gate and the real proof door,
 * with REAL device-key signatures. Stubbed: Kratos' admin API (the person
 * holds no passkey here: their factor is a device key), notifications and the
 * audit log (captured).
 *
 * Guardrails:
 *   - a new device ASKS; a device the person already uses APPROVES it, with
 *     the number the new device shows AND a proof from an existing factor;
 *   - a wrong number declines the request for good (an attacker's request is
 *     never retried); a device never approves its own request;
 *   - the approval is redeemed ONCE, only by the session that asked, only for
 *     the key it named, within 5 minutes;
 *   - a passkey-change grant is bound to the session that proved it.
 */

import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { PresenceProof } from "@synap-core/types/presence";

const h = vi.hoisted(() => ({
  db: null as unknown,
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  },
  events: [] as Array<{ type: string; data: Record<string, unknown> }>,
  passkeys: [] as Array<Record<string, unknown>>,
  notices: [] as Array<{
    type: string;
    userId: string;
    data?: Record<string, unknown>;
  }>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  class EventRepository {
    async append(e: {
      type: string;
      data: Record<string, unknown>;
      subjectId?: string;
    }) {
      const { SynapEventSchema } = await import("@synap-core/core");
      SynapEventSchema.parse(e);
      h.events.push({ type: e.type, data: e.data });
      return e;
    }
  }
  return { ...actual, db: h.db, EventRepository };
});

vi.mock("../../notifications/NotificationService.js", () => ({
  NotificationService: {
    create: async (n: {
      type: string;
      userId: string;
      data?: Record<string, unknown>;
    }) => {
      h.notices.push({ type: n.type, userId: n.userId, data: n.data });
    },
  },
}));
vi.mock("../../utils/audit-log.js", () => ({ auditLog: () => undefined }));

vi.mock("@synap/auth", () => ({
  kratosAdmin: {
    getIdentity: async () => ({
      data: {
        credentials: { passkey: { config: { credentials: h.passkeys } } },
      },
    }),
    listIdentitySessions: async () => ({ data: [] }),
    disableSession: async () => undefined,
  },
}));

const {
  approveDeviceLink,
  callerSessionKey,
  declineDeviceLink,
  deviceLinkReadStatus,
  deviceLinkStatus,
  makeDeviceLinkMatch,
  pendingDeviceLinks,
  redeemDeviceLink,
  requestDeviceLink,
} = await import("./device-link.js");
const { redeemPasskeyChangeGrant } = await import("./passkey-change.js");
const { enrollDeviceKey } = await import("./factors.js");
const { issuePresenceChallenge } = await import("./proof.js");
const { invalidatePresenceMode, writePresenceMode } = await import("./mode.js");
const { enrollmentSubject, presenceKeyFingerprint, DEVICE_LINK_TTL_SECONDS } =
  await import("@synap-core/types/presence");

const POD = "https://pod.example.test";
const PERSON = crypto.randomUUID();
const OTHER = crypto.randomUUID();
/** A person who holds no proof factor at all. */
const NEWCOMER = crypto.randomUUID();

/** The new device's session, and a device the person already uses. */
const NEW_PHONE = "kratos:new-phone-browser";
const RELAY = "device:relay-row";

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");

// The person's existing factor: a device key, as Relay's Secure Enclave key.
const relayKey = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
let relayKeyId: string;

function sign(message: string, key: crypto.KeyObject): string {
  return b64u(
    crypto.sign("sha256", Buffer.from(message, "utf8"), {
      key,
      dsaEncoding: "der",
    })
  );
}

function newDeviceKey() {
  const key = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    key,
    publicKey: b64u(key.publicKey.export({ type: "spki", format: "der" })),
  };
}

/** A proof from the person's existing device key for `device_link:<id>`. */
async function approvalProof(id: string): Promise<PresenceProof> {
  const c = await issuePresenceChallenge({
    userId: PERSON,
    subject: `device_link:${id}`,
  });
  return {
    kind: "device_key",
    challengeId: c.challengeId,
    keyId: relayKeyId,
    signature: sign(c.message, relayKey.privateKey),
  };
}

/** The number the new device shows (read from the row: only it sees it). */
async function shownNumber(id: string): Promise<string> {
  const { rows } = await h.client!.query(
    `select match_number from presence_device_links where id = $1`,
    [id]
  );
  return (rows[0] as { match_number: string }).match_number;
}

/** A refusal's machine reason (a PresenceError's code, a gate refusal's reasonCode), or "accepted". */
async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "accepted";
  } catch (err) {
    const e = err as {
      code?: unknown;
      cause?: { reasonCode?: unknown };
      message?: string;
    };
    if (e.cause?.reasonCode) return String(e.cause.reasonCode);
    if (typeof e.code === "string" && e.code.startsWith("PRESENCE_")) {
      return e.code;
    }
    return String(e.message);
  }
}

async function ask(
  sessionKey = NEW_PHONE,
  kind: "passkey" | "device_key" = "passkey",
  keyFingerprint?: string
) {
  const asked = await requestDeviceLink({
    userId: PERSON,
    sessionKey,
    kind,
    label: "iPhone · Safari",
    keyFingerprint: keyFingerprint ?? null,
  });
  if (!asked.needed) throw new Error("expected a request");
  return asked;
}

async function approved(sessionKey = NEW_PHONE) {
  const asked = await ask(sessionKey);
  await approveDeviceLink({
    userId: PERSON,
    sessionKey: RELAY,
    id: asked.id,
    number: await shownNumber(asked.id),
    proof: await approvalProof(asked.id),
  });
  return asked;
}

beforeAll(async () => {
  await h.client!.exec(`
    create table users (id text primary key, email text, name text, user_type text default 'human');
    create table presence_challenges (
      id uuid primary key default gen_random_uuid(), user_id text not null, subject text not null,
      nonce text not null, expires_at timestamptz not null, consumed_at timestamptz,
      method text, device_key_id uuid, created_at timestamptz not null default now(),
      redeemed_at timestamptz);
    create table pod_settings (
      id uuid primary key default gen_random_uuid(), settings jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create table presence_device_keys (
      id uuid primary key default gen_random_uuid(), user_id text not null, label text not null,
      public_key text not null, last_used_at timestamptz, revoked_at timestamptz,
      created_at timestamptz not null default now());
  `);
  // The factor tables and the device links, from the migrations as written.
  for (const file of [
    "0294_account_recovery_codes.sql",
    "0405_presence_recovery.sql",
    "0412_presence_device_links.sql",
  ]) {
    await h.client!.exec(
      readFileSync(
        new URL(`../../../../database/migrations/${file}`, import.meta.url),
        "utf8"
      )
    );
  }
  await h.client!.query(
    `insert into users (id, email, name) values ($1, 'a@x.test', 'Antoine'), ($2, 'o@x.test', 'Other'), ($3, 'n@x.test', 'Newcomer')`,
    [PERSON, OTHER, NEWCOMER]
  );
  const { rows } = await h.client!.query(
    `insert into presence_device_keys (user_id, label, public_key) values ($1, 'Antoine''s iPhone', $2) returning id`,
    [PERSON, b64u(relayKey.publicKey.export({ type: "spki", format: "der" }))]
  );
  relayKeyId = (rows[0] as { id: string }).id;
});

beforeEach(async () => {
  process.env.PUBLIC_URL = POD;
  process.env.SYNAP_PRESENCE_PROOF = "enforce";
  h.events.length = 0;
  h.notices.length = 0;
  h.passkeys = [];
  await h.client!.exec("delete from pod_settings");
  invalidatePresenceMode();
  // Each test starts outside the earlier tests' rate windows (the limits
  // have their own tests), with no pending request left over.
  await h.client!.exec(`
    update presence_challenges set created_at = created_at - interval '2 minutes';
    update presence_device_links set created_at = created_at - interval '1 hour';
    update presence_device_links set status = 'replaced' where status = 'pending';
  `);
});
afterEach(() => {
  delete process.env.SYNAP_PRESENCE_PROOF;
  invalidatePresenceMode();
});

describe("the match and the derived status (pure)", () => {
  it("three distinct two-digit numbers, the match among them, whatever the draw", () => {
    for (let i = 0; i < 300; i++) {
      const { number, choices } = makeDeviceLinkMatch();
      expect(choices).toHaveLength(3);
      expect(new Set(choices).size).toBe(3);
      expect(choices).toContain(number);
      for (const c of choices) {
        expect(c).toMatch(/^\d{2}$/);
        expect(Number(c)).toBeGreaterThanOrEqual(10);
        expect(Number(c)).toBeLessThanOrEqual(99);
      }
    }
    // A degenerate draw (always the first) still yields distinct numbers,
    // and never loops.
    const stuck = makeDeviceLinkMatch(() => 0);
    expect(stuck.number).toBe("10");
    expect([...stuck.choices].sort()).toEqual(["10", "11", "12"]);
  });

  it("the match does not always sit in the same place", () => {
    const places = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const { number, choices } = makeDeviceLinkMatch();
      places.add(choices.indexOf(number));
    }
    expect(places.size).toBe(3);
  });

  it("expired is derived: a pending request past its wait, an approval nobody redeemed in time", () => {
    const now = new Date("2026-11-09T12:00:00Z");
    const later = new Date(now.getTime() + 60_000);
    const earlier = new Date(now.getTime() - 60_000);
    const stale = new Date(
      now.getTime() - (DEVICE_LINK_TTL_SECONDS + 1) * 1000
    );
    const row = (over: Record<string, unknown>) => ({
      status: "pending",
      expiresAt: later,
      decidedAt: null,
      redeemedAt: null,
      ...over,
    });
    expect(deviceLinkReadStatus(row({}), now)).toBe("pending");
    expect(deviceLinkReadStatus(row({ expiresAt: earlier }), now)).toBe(
      "expired"
    );
    expect(
      deviceLinkReadStatus(row({ status: "approved", decidedAt: earlier }), now)
    ).toBe("approved");
    expect(
      deviceLinkReadStatus(row({ status: "approved", decidedAt: stale }), now)
    ).toBe("expired");
    expect(
      deviceLinkReadStatus(
        row({ status: "redeemed", decidedAt: stale, redeemedAt: earlier }),
        now
      )
    ).toBe("redeemed");
    expect(deviceLinkReadStatus(row({ status: "declined" }), now)).toBe(
      "declined"
    );
  });

  it("the session key: a browser's Kratos session or a device's row, nothing else", () => {
    expect(
      callerSessionKey({ sessionKind: "kratos", session: { id: "s1" } })
    ).toBe("kratos:s1");
    expect(
      callerSessionKey({
        sessionKind: "person_device",
        session: { device: { id: "d1" } },
      })
    ).toBe("device:d1");
    expect(callerSessionKey({ sessionKind: "kratos", session: {} })).toBeNull();
    expect(
      callerSessionKey({ sessionKind: "person_device", session: {} })
    ).toBeNull();
    expect(callerSessionKey({ session: { id: "s1" } })).toBeNull();
    // A Kratos-marked context carrying a device is not read as a browser.
    expect(
      callerSessionKey({
        sessionKind: "kratos",
        session: { id: "s1", device: { id: "d1" } },
      })
    ).toBeNull();
  });
});

describe("Add this device: asking", () => {
  it("a person with no factor yet needs no approval", async () => {
    await expect(
      requestDeviceLink({
        userId: NEWCOMER,
        sessionKey: NEW_PHONE,
        kind: "passkey",
        label: "iPhone",
      })
    ).resolves.toEqual({ needed: false });
    expect(h.notices).toEqual([]);
  });

  it("asking again replaces an approval nobody redeemed yet: only the newest request can be redeemed", async () => {
    const first = await approved();
    await ask();
    expect(
      (
        await deviceLinkStatus({
          userId: PERSON,
          sessionKey: NEW_PHONE,
          id: first.id,
        })
      ).status
    ).toBe("replaced");
    expect(
      await redeemDeviceLink({
        userId: PERSON,
        sessionKey: NEW_PHONE,
        kind: "passkey",
      })
    ).toBe(false);
  });

  it("asking tells every device, and asking again replaces the pending request", async () => {
    const first = await ask();
    expect(first.number).toMatch(/^\d{2}$/);
    expect(h.notices).toEqual([
      {
        type: "security.device_link_requested",
        userId: PERSON,
        data: { label: "iPhone · Safari", id: first.id },
      },
    ]);
    const second = await ask();
    expect(
      (
        await deviceLinkStatus({
          userId: PERSON,
          sessionKey: NEW_PHONE,
          id: first.id,
        })
      ).status
    ).toBe("replaced");
    expect(
      (
        await deviceLinkStatus({
          userId: PERSON,
          sessionKey: NEW_PHONE,
          id: second.id,
        })
      ).status
    ).toBe("pending");
  });

  it("GUARDRAIL: at most 5 requests per person in 15 minutes", async () => {
    for (let i = 0; i < 5; i++) await ask();
    expect(await refusal(ask())).toBe("PRESENCE_DEVICE_LINK_RATE");
  });

  it("a device-key request names its key", async () => {
    expect(
      await refusal(
        requestDeviceLink({
          userId: PERSON,
          sessionKey: NEW_PHONE,
          kind: "device_key",
          label: "iPhone",
        })
      )
    ).toMatch(/names the key/);
  });

  it("GUARDRAIL: the pending list leaves out the caller's own request and never carries the match", async () => {
    const asked = await ask();
    expect(
      await pendingDeviceLinks({ userId: PERSON, sessionKey: NEW_PHONE })
    ).toEqual([]);
    const seen = await pendingDeviceLinks({
      userId: PERSON,
      sessionKey: RELAY,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      id: asked.id,
      kind: "passkey",
      label: "iPhone · Safari",
    });
    expect(Object.keys(seen[0]!).sort()).toEqual([
      "choices",
      "createdAt",
      "expiresAt",
      "id",
      "kind",
      "label",
    ]);
    expect(seen[0]!.choices).toContain(asked.number);
    expect(
      await pendingDeviceLinks({ userId: OTHER, sessionKey: RELAY })
    ).toEqual([]);
  });

  it("only the session that asked reads its status", async () => {
    const asked = await ask();
    expect(
      await refusal(
        deviceLinkStatus({ userId: PERSON, sessionKey: RELAY, id: asked.id })
      )
    ).toBe("PRESENCE_DEVICE_LINK_GONE");
    expect(
      await refusal(
        deviceLinkStatus({ userId: OTHER, sessionKey: NEW_PHONE, id: asked.id })
      )
    ).toBe("PRESENCE_DEVICE_LINK_GONE");
  });
});

describe("Add this device: approving", () => {
  it("GUARDRAIL: a wrong number declines the request, and a later approve finds it gone", async () => {
    const asked = await ask();
    const wrong = asked.number === "42" ? "43" : "42";
    expect(
      await refusal(
        approveDeviceLink({
          userId: PERSON,
          sessionKey: RELAY,
          id: asked.id,
          number: wrong,
          proof: await approvalProof(asked.id),
        })
      )
    ).toBe("PRESENCE_DEVICE_LINK_MISMATCH");
    expect(
      (
        await deviceLinkStatus({
          userId: PERSON,
          sessionKey: NEW_PHONE,
          id: asked.id,
        })
      ).status
    ).toBe("declined");
    expect(
      await refusal(
        approveDeviceLink({
          userId: PERSON,
          sessionKey: RELAY,
          id: asked.id,
          number: asked.number,
          proof: await approvalProof(asked.id),
        })
      )
    ).toBe("PRESENCE_DEVICE_LINK_GONE");
  });

  it("GUARDRAIL: a device never approves its own request", async () => {
    const asked = await ask();
    expect(
      await refusal(
        approveDeviceLink({
          userId: PERSON,
          sessionKey: NEW_PHONE,
          id: asked.id,
          number: asked.number,
          proof: await approvalProof(asked.id),
        })
      )
    ).toBe("PRESENCE_DEVICE_LINK_SELF");
  });

  it("GUARDRAIL: another person's request, or an expired one, is gone", async () => {
    const asked = await ask();
    expect(
      await refusal(
        approveDeviceLink({
          userId: OTHER,
          sessionKey: RELAY,
          id: asked.id,
          number: asked.number,
        })
      )
    ).toBe("PRESENCE_DEVICE_LINK_GONE");
    await h.client!.query(
      `update presence_device_links set expires_at = now() - interval '1 second' where id = $1`,
      [asked.id]
    );
    expect(
      (
        await deviceLinkStatus({
          userId: PERSON,
          sessionKey: NEW_PHONE,
          id: asked.id,
        })
      ).status
    ).toBe("expired");
    expect(
      await refusal(
        approveDeviceLink({
          userId: PERSON,
          sessionKey: RELAY,
          id: asked.id,
          number: asked.number,
          proof: await approvalProof(asked.id),
        })
      )
    ).toBe("PRESENCE_DEVICE_LINK_GONE");
  });

  it("GUARDRAIL: under enforce the right number alone approves nothing; with a proof from an existing factor it approves", async () => {
    const asked = await ask();
    expect(
      await refusal(
        approveDeviceLink({
          userId: PERSON,
          sessionKey: RELAY,
          id: asked.id,
          number: asked.number,
        })
      )
    ).toBe("PRESENCE_REQUIRED");
    expect(
      (
        await deviceLinkStatus({
          userId: PERSON,
          sessionKey: NEW_PHONE,
          id: asked.id,
        })
      ).status
    ).toBe("pending");
    await expect(
      approveDeviceLink({
        userId: PERSON,
        sessionKey: RELAY,
        id: asked.id,
        number: asked.number,
        proof: await approvalProof(asked.id),
      })
    ).resolves.toEqual({ approved: true });
    expect(h.events.map((e) => e.type)).toContain("presence.proved");
    const read = await deviceLinkStatus({
      userId: PERSON,
      sessionKey: NEW_PHONE,
      id: asked.id,
    });
    expect(read.status).toBe("approved");
    // An approval nobody redeems in time reads expired.
    await h.client!.query(
      `update presence_device_links set decided_at = now() - interval '6 minutes' where id = $1`,
      [asked.id]
    );
    expect(
      (
        await deviceLinkStatus({
          userId: PERSON,
          sessionKey: NEW_PHONE,
          id: asked.id,
        })
      ).status
    ).toBe("expired");
  });

  it("a proof made for another request is refused", async () => {
    const first = await ask();
    const proofForFirst = await approvalProof(first.id);
    const second = await ask();
    expect(
      await refusal(
        approveDeviceLink({
          userId: PERSON,
          sessionKey: RELAY,
          id: second.id,
          number: second.number,
          proof: proofForFirst,
        })
      )
    ).toBe("PRESENCE_INVALID");
  });

  it("report mode approves with no proof and records it missing", async () => {
    delete process.env.SYNAP_PRESENCE_PROOF;
    await writePresenceMode({ mode: "report", changedBy: PERSON });
    invalidatePresenceMode();
    const asked = await ask();
    await expect(
      approveDeviceLink({
        userId: PERSON,
        sessionKey: RELAY,
        id: asked.id,
        number: asked.number,
      })
    ).resolves.toEqual({ approved: true });
    expect(h.events.map((e) => e.type)).toEqual(["presence.missing"]);
  });

  it("declining: any session of the person, an approval not yet redeemed included; idempotent; another person's is gone", async () => {
    const asked = await approved();
    await expect(
      declineDeviceLink({ userId: PERSON, id: asked.id })
    ).resolves.toEqual({ status: "declined" });
    await expect(
      declineDeviceLink({ userId: PERSON, id: asked.id })
    ).resolves.toEqual({ status: "declined" });
    expect(
      await redeemDeviceLink({
        userId: PERSON,
        sessionKey: NEW_PHONE,
        kind: "passkey",
      })
    ).toBe(false);
    const other = await ask();
    expect(
      await refusal(declineDeviceLink({ userId: OTHER, id: other.id }))
    ).toBe("PRESENCE_DEVICE_LINK_GONE");
  });
});

describe("Add this device: redeeming", () => {
  it("GUARDRAIL: a passkey link is redeemed once, only by the session that asked, through the passkey-change grant", async () => {
    const asked = await approved();
    expect(await redeemPasskeyChangeGrant(PERSON, RELAY)).toBe(false);
    expect(await redeemPasskeyChangeGrant(OTHER, NEW_PHONE)).toBe(false);
    expect(await redeemPasskeyChangeGrant(PERSON, null)).toBe(false);
    expect(
      await redeemDeviceLink({
        userId: PERSON,
        sessionKey: NEW_PHONE,
        kind: "device_key",
        keyFingerprint: "0".repeat(64),
      })
    ).toBe(false);
    expect(await redeemPasskeyChangeGrant(PERSON, NEW_PHONE)).toBe(true);
    expect(await redeemPasskeyChangeGrant(PERSON, NEW_PHONE)).toBe(false);
    expect(
      (
        await deviceLinkStatus({
          userId: PERSON,
          sessionKey: NEW_PHONE,
          id: asked.id,
        })
      ).status
    ).toBe("redeemed");
  });

  it("GUARDRAIL: an approval older than 5 minutes is not redeemed", async () => {
    const asked = await approved();
    await h.client!.query(
      `update presence_device_links set decided_at = now() - interval '6 minutes' where id = $1`,
      [asked.id]
    );
    expect(await redeemPasskeyChangeGrant(PERSON, NEW_PHONE)).toBe(false);
  });

  it("GUARDRAIL: an approved device-key link enrols that key with no proof under enforce, once; another key or session is refused", async () => {
    const SESSION = "device:new-relay-row";
    const fresh = newDeviceKey();
    const fingerprint = await presenceKeyFingerprint(fresh.publicKey);
    const asked = await ask(SESSION, "device_key", fingerprint);
    await approveDeviceLink({
      userId: PERSON,
      sessionKey: RELAY,
      id: asked.id,
      number: await shownNumber(asked.id),
      proof: await approvalProof(asked.id),
    });

    const enrol = async (
      key: ReturnType<typeof newDeviceKey>,
      sessionKey: string | null
    ) => {
      const c = await issuePresenceChallenge({
        userId: PERSON,
        subject: enrollmentSubject,
      });
      return enrollDeviceKey({
        userId: PERSON,
        challengeId: c.challengeId,
        label: "New iPhone",
        publicKey: key.publicKey,
        signature: sign(c.message, key.key.privateKey),
        sessionKey,
        deviceLinkId: asked.id,
      });
    };

    // Another session, or another key, cannot spend it.
    expect(await refusal(enrol(fresh, "device:someone-else"))).toBe(
      "PRESENCE_REQUIRED"
    );
    expect(await refusal(enrol(newDeviceKey(), SESSION))).toBe(
      "PRESENCE_REQUIRED"
    );
    expect(await refusal(enrol(fresh, null))).toBe("PRESENCE_REQUIRED");
    h.events.length = 0;
    // The session that asked, with the key it named: enrolled, unrecorded.
    const done = await enrol(fresh, SESSION);
    expect(done.viaDeviceLink).toBe(true);
    expect(h.events.map((e) => e.type)).not.toContain("presence.missing");
    const { rows } = await h.client!.query(
      `select count(*)::int as n from presence_device_keys where user_id = $1 and public_key = $2`,
      [PERSON, fresh.publicKey]
    );
    expect((rows[0] as { n: number }).n).toBe(1);
    // Once: the same key again needs a proof.
    expect(await refusal(enrol(fresh, SESSION))).toBe("PRESENCE_REQUIRED");
  });

  it("a passkey link never enrols a device key", async () => {
    await approved("device:another-new-relay");
    const fresh = newDeviceKey();
    const c = await issuePresenceChallenge({
      userId: PERSON,
      subject: enrollmentSubject,
    });
    expect(
      await refusal(
        enrollDeviceKey({
          userId: PERSON,
          challengeId: c.challengeId,
          label: "New iPhone",
          publicKey: fresh.publicKey,
          signature: sign(c.message, fresh.key.privateKey),
          sessionKey: "device:another-new-relay",
        })
      )
    ).toBe("PRESENCE_REQUIRED");
  });
});
