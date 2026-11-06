/**
 * Proof of presence (W3) on PGlite, through the real gate and the real proof
 * door, with REAL signatures: a P-256 device key (as Relay's Secure Enclave
 * key signs), and a WebAuthn assertion built byte for byte (authenticatorData,
 * clientDataJSON, COSE public key as Kratos stores it) and verified by
 * `@simplewebauthn/server`. Stubbed: Kratos' admin API (the passkeys it holds)
 * and the event log (captured).
 *
 * Guardrails (founder, 4 Nov 2026: a session proves the account, not the person):
 *   - a sensitive approval without a proof is refused (enforce), and a request
 *     filed AS THE PERSON is refused in every mode;
 *   - a replayed proof, or one made for another proposal, is refused;
 *   - an everyday approval is unchanged (no proof asked, nothing recorded);
 *   - a passkey assertion without user verification is refused.
 */

import crypto from "node:crypto";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const h = vi.hoisted(() => ({
  db: null as unknown,
  client: null as null | { exec: (sql: string) => Promise<unknown> },
  events: [] as Array<{ type: string; data: Record<string, unknown> }>,
  passkeys: [] as Array<Record<string, unknown>>,
  notices: [] as Array<{ type: string; userId: string }>,
  /** When set, every passkey read waits here (the race test's rendezvous). */
  kratosGate: null as null | (() => Promise<void>),
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
      // The real repository validates with SynapEventSchema (subjectId: uuid).
      const { SynapEventSchema } = await import("@synap-core/core");
      SynapEventSchema.parse(e);
      h.events.push({ type: e.type, data: e.data });
      return e;
    }
  }
  return { ...actual, db: h.db, EventRepository };
});

// The mode change and factor notices: only who was told is read here.
vi.mock("../../notifications/NotificationService.js", () => ({
  NotificationService: {
    create: async (n: { type: string; userId: string }) => {
      h.notices.push({ type: n.type, userId: n.userId });
    },
  },
}));
vi.mock("../../utils/audit-log.js", () => ({ auditLog: () => undefined }));

vi.mock("@synap/auth", () => ({
  kratosAdmin: {
    getIdentity: async () => {
      if (h.kratosGate) await h.kratosGate();
      return {
        data: {
          credentials: { passkey: { config: { credentials: h.passkeys } } },
        },
      };
    },
  },
}));

/**
 * A rendezvous for `n` arrivals: each waits until all `n` have arrived, or
 * until `ms` passed (an arrival the others can never join, because they wait
 * behind a lock it holds, goes on alone).
 */
function rendezvous(n: number, ms: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const all = new Promise<void>((r) => (release = r));
  return async () => {
    arrived += 1;
    if (arrived >= n) release();
    await Promise.race([all, new Promise((r) => setTimeout(r, ms))]);
  };
}

const {
  assertPresenceForAction,
  assertPresenceForApproval,
  assertPresenceForRequest,
} = await import("./gate.js");
const { invalidatePresenceMode, readPresenceMode, writePresenceMode } =
  await import("./mode.js");
const { PRESENCE_NO_FACTOR_HINT } = await import("./gate.js");
const { changePresenceMode } = await import("./mode-change.js");
const { redeemPasskeyChangeGrant } = await import("./passkey-change.js");
const { enrollDeviceKey } = await import("./factors.js");
const { assertPresencePass, mintPresencePass } = await import("./pass.js");
const { passPresenceForAction, PRESENCE_KEY_CALLER_MESSAGE } =
  await import("./gate.js");
const { issuePresenceChallenge, passkeyRpId } = await import("./proof.js");
const { presenceMessage, enrollmentSubject } =
  await import("@synap-core/types/presence");

const POD = "https://pod.example.test";
const PERSON = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const SENSITIVE = {
  id: crypto.randomUUID(),
  targetType: "agent",
  proposalType: "connect",
  data: { instanceLabel: "MacBook-Pro" },
};
const OTHER_SENSITIVE = {
  id: crypto.randomUUID(),
  targetType: "entity",
  proposalType: "delete",
};
const EVERYDAY = {
  id: crypto.randomUUID(),
  targetType: "entity",
  proposalType: "create",
};
const AS_PERSON = {
  id: crypto.randomUUID(),
  targetType: "agent",
  proposalType: "connect",
  data: { asPerson: true, instanceLabel: "MacBook-Pro" },
};

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");

// ── A device key, as Relay's Secure Enclave key ──────────────────────────────
const device = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const devicePublic = b64u(
  device.publicKey.export({ format: "der", type: "spki" }) as Buffer
);
let deviceKeyId: string;

function deviceSign(message: string, key = device.privateKey): string {
  return b64u(
    crypto.sign("sha256", Buffer.from(message, "utf8"), {
      key,
      dsaEncoding: "der",
    })
  );
}

/** A new device key, as Relay makes one, and its public half (SPKI DER, base64url). */
function newDeviceKey() {
  const key = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    key,
    publicKey: b64u(key.publicKey.export({ type: "spki", format: "der" })),
  };
}

/** Steps 1 and 2 of enrolling a device key, as the router runs them. */
async function enrol(
  userId: string,
  fresh = newDeviceKey(),
  proof?: unknown
): Promise<{ id: string }> {
  const c = await issuePresenceChallenge({
    userId,
    subject: enrollmentSubject,
  });
  return enrollDeviceKey({
    userId,
    challengeId: c.challengeId,
    label: "Phone",
    publicKey: fresh.publicKey,
    signature: deviceSign(c.message, fresh.key.privateKey),
    proof: (proof ?? null) as never,
  });
}

async function challengeFor(proposalId: string, userId = PERSON) {
  return issuePresenceChallenge({ userId, subject: proposalId });
}

// ── A passkey, as Kratos stores it (COSE key, go-webauthn base64) ────────────
const passkey = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const credentialId = crypto.randomBytes(16);

/** Minimal CBOR for a COSE EC2 key: {1:2, 3:-7, -1:1, -2:x, -3:y}. */
function coseKey(publicKey: crypto.KeyObject): Buffer {
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  const bstr32 = (b: Buffer) => Buffer.concat([Buffer.from([0x58, 0x20]), b]);
  return Buffer.concat([
    Buffer.from([0xa5]), // map(5)
    Buffer.from([0x01, 0x02]), // kty: EC2
    Buffer.from([0x03, 0x26]), // alg: -7 (ES256)
    Buffer.from([0x20, 0x01]), // crv: P-256
    Buffer.from([0x21]),
    bstr32(x), // x
    Buffer.from([0x22]),
    bstr32(y), // y
  ]);
}

function assertion(opts: {
  challenge: string;
  origin?: string;
  rpId?: string;
  flags?: number;
}) {
  const rpIdHash = crypto
    .createHash("sha256")
    .update(opts.rpId ?? "pod.example.test")
    .digest();
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(1);
  const authenticatorData = Buffer.concat([
    rpIdHash,
    Buffer.from([opts.flags ?? 0x05]), // UP | UV
    counter,
  ]);
  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge: opts.challenge,
      origin: opts.origin ?? POD,
      crossOrigin: false,
    })
  );
  const signature = crypto.sign(
    "sha256",
    Buffer.concat([
      authenticatorData,
      crypto.createHash("sha256").update(clientDataJSON).digest(),
    ]),
    { key: passkey.privateKey, dsaEncoding: "der" }
  );
  return {
    id: b64u(credentialId),
    rawId: b64u(credentialId),
    type: "public-key" as const,
    response: {
      clientDataJSON: b64u(clientDataJSON),
      authenticatorData: b64u(authenticatorData),
      signature: b64u(signature),
    },
    clientExtensionResults: {},
  };
}

const webauthnChallengeOf = (message: string) =>
  b64u(crypto.createHash("sha256").update(message, "utf8").digest());

async function gate(
  proposal: typeof SENSITIVE | typeof EVERYDAY,
  proof?: unknown,
  userId = PERSON
) {
  return assertPresenceForApproval({
    userId,
    proposal,
    proof: (proof ?? null) as never,
    door: "test",
  });
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "accepted";
  } catch (err) {
    return String(
      (err as { cause?: { reasonCode?: unknown } }).cause?.reasonCode ??
        (err as Error).message
    );
  }
}

/**
 * Every test asks for challenges; the per-person limit counts the last
 * minute. Age the earlier tests' challenges past it (the limit has its own
 * test).
 */
async function agePastRateWindow(): Promise<void> {
  await h.client!.exec(
    "update presence_challenges set created_at = created_at - interval '2 minutes'"
  );
}

/** A pod whose admins never chose a mode: no stored setting, cache dropped. */
async function noStoredMode(): Promise<void> {
  await h.client!.exec("delete from pod_settings");
  invalidatePresenceMode();
}

/** An admin's explicit choice of `report` (the stored setting). */
async function reportByChoice(): Promise<void> {
  await writePresenceMode({ mode: "report", changedBy: PERSON });
}

describe("proof of presence: the gate", () => {
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
    await (
      h.client as unknown as {
        query: (s: string, p: unknown[]) => Promise<unknown>;
      }
    ).query(
      `insert into users (id, email, name) values ($1, 'a@x.test', 'Antoine'), ($2, 'o@x.test', 'Other')`,
      [PERSON, OTHER]
    );
    const { presenceDeviceKeys } = await import("@synap/database/schema");
    const [row] = await (h.db as any)
      .insert(presenceDeviceKeys)
      .values({
        userId: PERSON,
        label: "Antoine's iPhone",
        publicKey: devicePublic,
      })
      .returning();
    deviceKeyId = row.id;
  });

  beforeEach(async () => {
    process.env.PUBLIC_URL = POD;
    process.env.SYNAP_PRESENCE_PROOF = "enforce";
    h.events.length = 0;
    await agePastRateWindow();
    await noStoredMode();
    h.passkeys = [
      {
        id: credentialId.toString("base64"),
        public_key: coseKey(passkey.publicKey).toString("base64"),
        authenticator: { sign_count: 0 },
      },
    ];
  });
  afterEach(() => {
    delete process.env.SYNAP_PRESENCE_PROOF;
  });

  it("GUARDRAIL: a sensitive approval with no proof is refused (enforce)", async () => {
    expect(await refusal(gate(SENSITIVE))).toBe("PRESENCE_REQUIRED");
    expect(
      await refusal(
        gate({
          ...SENSITIVE,
          targetType: "governance_rule",
          proposalType: "governance.rule_create",
        })
      )
    ).toBe("PRESENCE_REQUIRED");
  });

  it("report mode lets a sensitive approval through and records it; a request made AS THE PERSON is refused in every mode", async () => {
    delete process.env.SYNAP_PRESENCE_PROOF;
    await reportByChoice();
    expect(await refusal(gate(SENSITIVE))).toBe("accepted");
    expect(h.events.map((e) => e.type)).toEqual(["presence.missing"]);
    expect(await refusal(gate(AS_PERSON))).toBe("PRESENCE_REQUIRED");
  });

  it("GUARDRAIL: an everyday approval is unchanged (no proof, nothing recorded)", async () => {
    expect(await refusal(gate(EVERYDAY))).toBe("accepted");
    delete process.env.SYNAP_PRESENCE_PROOF;
    await reportByChoice();
    expect(await refusal(gate(EVERYDAY))).toBe("accepted");
    expect(h.events).toEqual([]);
  });

  it("a device key's signature over the challenge approves, once, with the audit line", async () => {
    const c = await challengeFor(SENSITIVE.id);
    const proof = {
      kind: "device_key",
      challengeId: c.challengeId,
      keyId: deviceKeyId,
      signature: deviceSign(c.message),
    };
    expect(await refusal(gate(SENSITIVE, proof))).toBe("accepted");
    expect(h.events.at(-1)).toMatchObject({
      type: "presence.proved",
      data: {
        proposalId: SENSITIVE.id,
        method: "device_key",
        actor:
          "Antoine (approved with Face ID or the passcode on Antoine's iPhone, requested from MacBook-Pro)",
      },
    });
    // GUARDRAIL: replayed.
    expect(await refusal(gate(SENSITIVE, proof))).toBe("PRESENCE_USED");
  });

  it("GUARDRAIL: a proof made for proposal A is refused on proposal B", async () => {
    const c = await challengeFor(SENSITIVE.id);
    const proof = {
      kind: "device_key",
      challengeId: c.challengeId,
      keyId: deviceKeyId,
      signature: deviceSign(c.message),
    };
    expect(await refusal(gate(OTHER_SENSITIVE, proof))).toBe(
      "PRESENCE_INVALID"
    );
    // A signature over B's message presented with A's challenge also fails.
    const b = await challengeFor(OTHER_SENSITIVE.id);
    expect(
      await refusal(
        gate(SENSITIVE, { ...proof, signature: deviceSign(b.message) })
      )
    ).toBe("PRESENCE_INVALID");
  });

  it("refuses another person's challenge, an expired one, a foreign key and a revoked key", async () => {
    const theirs = await challengeFor(SENSITIVE.id, OTHER);
    expect(
      await refusal(
        gate(SENSITIVE, {
          kind: "device_key",
          challengeId: theirs.challengeId,
          keyId: deviceKeyId,
          signature: deviceSign(theirs.message),
        })
      )
    ).toBe("PRESENCE_INVALID");

    const c = await challengeFor(SENSITIVE.id);
    const stranger = crypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    expect(
      await refusal(
        gate(SENSITIVE, {
          kind: "device_key",
          challengeId: c.challengeId,
          keyId: deviceKeyId,
          signature: deviceSign(c.message, stranger.privateKey),
        })
      )
    ).toBe("PRESENCE_INVALID");

    const old = await challengeFor(SENSITIVE.id);
    await (h.client as any).query(
      `update presence_challenges set expires_at = now() - interval '1 second' where id = $1`,
      [old.challengeId]
    );
    expect(
      await refusal(
        gate(SENSITIVE, {
          kind: "device_key",
          challengeId: old.challengeId,
          keyId: deviceKeyId,
          signature: deviceSign(old.message),
        })
      )
    ).toBe("PRESENCE_EXPIRED");
  });

  it("a passkey assertion with user verification over the challenge approves; without UV, or from another site, it is refused", async () => {
    const c = await challengeFor(SENSITIVE.id);
    const ok = await refusal(
      gate(SENSITIVE, {
        kind: "passkey",
        challengeId: c.challengeId,
        credential: assertion({ challenge: c.webauthnChallenge }),
      })
    );
    expect(ok).toBe("accepted");

    const noUv = await challengeFor(SENSITIVE.id);
    expect(
      await refusal(
        gate(SENSITIVE, {
          kind: "passkey",
          challengeId: noUv.challengeId,
          credential: assertion({
            challenge: noUv.webauthnChallenge,
            flags: 0x01,
          }),
        })
      )
    ).toBe("PRESENCE_INVALID");

    const phished = await challengeFor(SENSITIVE.id);
    expect(
      await refusal(
        gate(SENSITIVE, {
          kind: "passkey",
          challengeId: phished.challengeId,
          credential: assertion({
            challenge: phished.webauthnChallenge,
            origin: "https://evil.example",
          }),
        })
      )
    ).toBe("PRESENCE_INVALID");

    // The WebAuthn challenge names the proposal: one made for B fails on A.
    const a = await challengeFor(SENSITIVE.id);
    const forB = webauthnChallengeOf(
      presenceMessage({
        podOrigin: POD,
        challengeId: a.challengeId,
        subject: OTHER_SENSITIVE.id,
        nonce: a.nonce,
      })
    );
    expect(
      await refusal(
        gate(SENSITIVE, {
          kind: "passkey",
          challengeId: a.challengeId,
          credential: assertion({ challenge: forB }),
        })
      )
    ).toBe("PRESENCE_INVALID");
  });
});

describe("passkeyRpId: the rp id the installer gives Kratos", () => {
  it("is the domain the pod and its console share, else the pod host", () => {
    expect(
      passkeyRpId(
        "https://antoine.pod.synap.live",
        "https://admin.antoine.pod.synap.live"
      )
    ).toBe("antoine.pod.synap.live");
    expect(
      passkeyRpId("https://pod.example.com", "https://pod-admin.example.com")
    ).toBe("example.com");
    // A legacy flat pod shares only the tenant zone: host-only, the pod's own.
    expect(
      passkeyRpId(
        "https://antoine.synap.live",
        "https://antoine-admin.synap.live"
      )
    ).toBe("antoine.synap.live");
  });
});

describe("proof of presence: decisions that settle no proposal (slice 2)", () => {
  beforeEach(async () => {
    process.env.PUBLIC_URL = POD;
    process.env.SYNAP_PRESENCE_PROOF = "enforce";
    h.events.length = 0;
    await agePastRateWindow();
    await noStoredMode();
  });
  afterEach(() => {
    delete process.env.SYNAP_PRESENCE_PROOF;
  });

  const request = (
    kind: "key_request" | "device_request",
    id: string,
    proof?: unknown
  ) =>
    assertPresenceForRequest({
      userId: PERSON,
      kind,
      id,
      proof: (proof ?? null) as never,
      door: "test",
    });

  it("GUARDRAIL: a key request approved with no proof is refused (enforce), naming the request", async () => {
    const id = crypto.randomUUID();
    const err = await request("key_request", id).catch(
      (e: { cause?: { reasonCode?: string; proposalId?: string } }) => e.cause
    );
    expect(err).toMatchObject({
      reasonCode: "PRESENCE_REQUIRED",
      proposalId: `key_request:${id}`,
    });
  });

  it("a proof made for that request approves it, once; it is refused on another kind or id", async () => {
    const id = crypto.randomUUID();
    const c = await challengeFor(`key_request:${id}`);
    const proof = {
      kind: "device_key",
      challengeId: c.challengeId,
      keyId: deviceKeyId,
      signature: deviceSign(c.message),
    };
    expect(await refusal(request("device_request", id, proof))).toBe(
      "PRESENCE_INVALID"
    );
    expect(
      await refusal(request("key_request", crypto.randomUUID(), proof))
    ).toBe("PRESENCE_INVALID");
    expect(await refusal(request("key_request", id, proof))).toBe("accepted");
    expect(await refusal(request("key_request", id, proof))).toBe(
      "PRESENCE_USED"
    );
    // The event validates (a request is no uuid subject) and says what it was.
    expect(h.events.at(-1)).toMatchObject({
      type: "presence.proved",
      data: { proposalId: `key_request:${id}`, proposalType: "key_request" },
    });
  });

  it("report mode lets it through and records a valid presence.missing", async () => {
    delete process.env.SYNAP_PRESENCE_PROOF;
    await reportByChoice();
    expect(await refusal(request("device_request", crypto.randomUUID()))).toBe(
      "accepted"
    );
    expect(h.events.map((e) => e.type)).toEqual(["presence.missing"]);
  });
});

describe("proof of presence: actions, the mode, new factors (slice 3)", () => {
  beforeEach(async () => {
    process.env.PUBLIC_URL = POD;
    process.env.SYNAP_PRESENCE_PROOF = "enforce";
    h.events.length = 0;
    await agePastRateWindow();
    h.notices.length = 0;
    h.passkeys = [];
    await noStoredMode();
  });
  afterEach(() => {
    delete process.env.SYNAP_PRESENCE_PROOF;
    invalidatePresenceMode();
  });

  const proofFor = async (subject: string) => {
    const c = await challengeFor(subject);
    return {
      kind: "device_key",
      challengeId: c.challengeId,
      keyId: deviceKeyId,
      signature: deviceSign(c.message),
    };
  };
  const action = (path: string, input: unknown, proof?: unknown) =>
    assertPresenceForAction({
      userId: PERSON,
      path,
      input,
      proof: (proof ?? null) as never,
    });

  it("GUARDRAIL: a sensitive action with no proof is refused (enforce); an everyday path asks nothing", async () => {
    const input = { keyName: "ci", expiresInDays: 30 };
    const { presenceActionDigest } = await import("@synap-core/types/presence");
    const err = await action("apiKeys.create", input).catch(
      (e: { cause?: { reasonCode?: string; proposalId?: string } }) => e.cause
    );
    expect(err).toMatchObject({
      reasonCode: "PRESENCE_REQUIRED",
      proposalId: `action:apiKeys.create:${await presenceActionDigest("apiKeys.create", input)}`,
    });
    expect(await action("shares.share", input)).toBeNull();
  });

  it("GUARDRAIL: a proof binds the path AND the input: it acts once, never on other input", async () => {
    const { presenceActionDigest, presenceActionSubject } =
      await import("@synap-core/types/presence");
    const input = { keyName: "ci", expiresInDays: 30 };
    const proof = await proofFor(
      presenceActionSubject(
        "apiKeys.create",
        await presenceActionDigest("apiKeys.create", input)
      )
    );
    expect(
      await refusal(
        action("apiKeys.create", { ...input, expiresInDays: 365 }, proof)
      )
    ).toBe("PRESENCE_INVALID");
    expect(await refusal(action("apiKeys.rotate", input, proof))).toBe(
      "PRESENCE_INVALID"
    );
    // The proof rides in the input it was made for: the digest ignores it.
    expect(
      await refusal(
        action("apiKeys.create", { ...input, presence: proof }, proof)
      )
    ).toBe("accepted");
    expect(await refusal(action("apiKeys.create", input, proof))).toBe(
      "PRESENCE_USED"
    );
  });

  it("GUARDRAIL: the pod setting drives the mode; ON is free, OFF needs a proof and tells the admins", async () => {
    delete process.env.SYNAP_PRESENCE_PROOF;
    await reportByChoice();
    expect((await readPresenceMode()).mode).toBe("report");
    expect(await refusal(action("apiKeys.create", { a: 1 }))).toBe("accepted");
    await changePresenceMode({ userId: PERSON, mode: "enforce" });
    expect(await readPresenceMode()).toMatchObject({
      mode: "enforce",
      source: "setting",
      changedBy: PERSON,
    });
    expect(await refusal(action("apiKeys.create", { a: 1 }))).toBe(
      "PRESENCE_REQUIRED"
    );
    // Off: refused without a proof, then accepted with one, and recorded.
    expect(
      await refusal(changePresenceMode({ userId: PERSON, mode: "report" }))
    ).toBe("PRESENCE_REQUIRED");
    expect((await readPresenceMode()).mode).toBe("enforce");
    const proof = await proofFor("presence_mode:report");
    expect(
      await refusal(
        changePresenceMode({
          userId: PERSON,
          mode: "report",
          proof: proof as never,
        })
      )
    ).toBe("accepted");
    expect((await readPresenceMode()).mode).toBe("report");
    expect(h.events.map((e) => e.type)).toContain("presence.mode_changed");
  });

  it("GUARDRAIL: a pod with no setting enforces by default; an explicit choice, either way, wins", async () => {
    delete process.env.SYNAP_PRESENCE_PROOF;
    expect(await readPresenceMode()).toMatchObject({
      mode: "enforce",
      source: "default",
      changedBy: null,
    });
    expect(await refusal(action("apiKeys.create", { a: 1 }))).toBe(
      "PRESENCE_REQUIRED"
    );
    await reportByChoice();
    expect(await readPresenceMode()).toMatchObject({
      mode: "report",
      source: "setting",
      changedBy: PERSON,
    });
    expect(await refusal(action("apiKeys.create", { a: 1 }))).toBe("accepted");
    await writePresenceMode({ mode: "enforce", changedBy: OTHER });
    expect(await readPresenceMode()).toMatchObject({
      mode: "enforce",
      source: "setting",
      changedBy: OTHER,
    });
    // The env floor keeps its meaning over an explicit `report`.
    await reportByChoice();
    process.env.SYNAP_PRESENCE_PROOF = "enforce";
    expect(await readPresenceMode()).toMatchObject({
      mode: "enforce",
      source: "env",
    });
  });

  it("GUARDRAIL: with no factor, the default refuses, says how to add one, and the first factor needs no proof", async () => {
    delete process.env.SYNAP_PRESENCE_PROOF;
    // OTHER holds no device key and no passkey (h.passkeys is empty).
    const refused = await gate(SENSITIVE, undefined, OTHER).catch(
      (e: Error & { cause?: { reasonCode?: string } }) => e
    );
    expect(
      (refused as { cause?: { reasonCode?: string } }).cause?.reasonCode
    ).toBe("PRESENCE_REQUIRED");
    expect((refused as Error).message).toContain(PRESENCE_NO_FACTOR_HINT);
    // Switching the check off says the same to someone with no factor.
    const off = await changePresenceMode({
      userId: OTHER,
      mode: "report",
    }).catch((e: Error) => e);
    expect((off as Error).message).toContain(PRESENCE_NO_FACTOR_HINT);
    // The way back in: their first Relay device key needs no proof.
    const lockedOut = crypto.randomUUID();
    expect(await refusal(enrol(lockedOut))).toBe("accepted");
    // Someone who HOLDS a factor gets the plain refusal, no hint.
    const held = await gate(SENSITIVE).catch((e: Error) => e);
    expect((held as Error).message).not.toContain(PRESENCE_NO_FACTOR_HINT);
    expect(
      (held as { cause?: { reasonCode?: string } }).cause?.reasonCode
    ).toBe("PRESENCE_REQUIRED");
  });

  it("the operator env floor forces enforce and cannot be switched off here", async () => {
    process.env.SYNAP_PRESENCE_PROOF = "enforce";
    expect(await readPresenceMode()).toMatchObject({
      mode: "enforce",
      source: "env",
    });
    const proof = await proofFor("presence_mode:report");
    expect(
      await refusal(
        changePresenceMode({
          userId: PERSON,
          mode: "report",
          proof: proof as never,
        })
      )
    ).toMatch(/operator/);
  });

  it("GUARDRAIL: a second device key needs a proof from an existing factor; the first does not", async () => {
    const { presenceKeyFingerprint } =
      await import("@synap-core/types/presence");
    const fresh = newDeviceKey();
    // PERSON already holds a device key: refused without a proof, and the
    // enrolment challenge is not spent by the refusal.
    expect(await refusal(enrol(PERSON, fresh))).toBe("PRESENCE_REQUIRED");
    const proof = await proofFor(
      `device_enroll:${await presenceKeyFingerprint(fresh.publicKey)}`
    );
    expect(await refusal(enrol(PERSON, fresh, proof))).toBe("accepted");
    // Someone who holds no factor: their first key needs none.
    expect(await refusal(enrol(crypto.randomUUID()))).toBe("accepted");
  });

  it("GUARDRAIL: two first enrolments at once yield ONE factor; the other needs a proof", async () => {
    const newcomer = crypto.randomUUID();
    // Both enrolments read "does this person hold a factor?" at the same
    // moment when they can: the read waits for the other one (up to 300 ms).
    // Decided outside a lock, both read "none" and both enrol unproved.
    h.kratosGate = rendezvous(2, 300);
    const results = await Promise.all([
      refusal(enrol(newcomer)),
      refusal(enrol(newcomer)),
    ]).finally(() => {
      h.kratosGate = null;
    });
    expect(results.sort()).toEqual(["PRESENCE_REQUIRED", "accepted"]);
    const { rows } = await (
      h.client as unknown as {
        query: (s: string, p: unknown[]) => Promise<{ rows: unknown[] }>;
      }
    ).query(`select id from presence_device_keys where user_id = $1`, [
      newcomer,
    ]);
    expect(rows).toHaveLength(1);
  });

  it("report mode lets a second key through without a proof, and records it", async () => {
    delete process.env.SYNAP_PRESENCE_PROOF;
    await reportByChoice();
    expect(await refusal(enrol(PERSON))).toBe("accepted");
    expect(h.events.map((e) => e.type)).toContain("presence.missing");
  });

  it("a person asks at most 20 challenges a minute", async () => {
    const busy = crypto.randomUUID();
    for (let i = 0; i < 20; i++) {
      await issuePresenceChallenge({ userId: busy, subject: `s${i}` });
    }
    const err = await issuePresenceChallenge({
      userId: busy,
      subject: "one more",
    }).catch((e: { code?: string }) => e);
    expect((err as { code?: string }).code).toBe("TOO_MANY_REQUESTS");
    // Someone else is not slowed down by it.
    await expect(
      issuePresenceChallenge({ userId: crypto.randomUUID(), subject: "x" })
    ).resolves.toMatchObject({ subject: "x" });
  });

  it("GUARDRAIL: a key caller is told the person does it in pod admin, never the passkey hint", async () => {
    const err = await assertPresenceForAction({
      userId: OTHER,
      path: "apps.issueKey",
      input: { publicId: "app_x" },
      proof: null,
      keyCaller: true,
    }).catch((e: Error) => e);
    expect((err as Error).message).toBe(PRESENCE_KEY_CALLER_MESSAGE);
    expect((err as { cause?: { reasonCode?: string } }).cause?.reasonCode).toBe(
      "PRESENCE_REQUIRED"
    );
  });

  it("GUARDRAIL: a sensitive service takes only a pass the gate minted, for its act and person", async () => {
    // Report mode: the gate lets it through, records it, and hands a pass.
    delete process.env.SYNAP_PRESENCE_PROOF;
    await reportByChoice();
    const { pass } = await passPresenceForAction({
      userId: PERSON,
      path: "apps.issueKey",
      input: { publicId: "app_x" },
    });
    expect(pass).toMatchObject({ action: "apps.issueKey", proved: false });
    const actions = ["apps.issueKey"] as const;
    expect(() =>
      assertPresencePass(pass, { actions, userId: PERSON })
    ).not.toThrow();
    // A look-alike object, a pass for another act or another person: refused.
    const forged = { action: "apps.issueKey", userId: PERSON, proved: true };
    for (const [p, userId, acts] of [
      [forged, PERSON, actions],
      [pass, OTHER, actions],
      [pass, PERSON, ["apps.setWriteMode"] as const],
      [null, PERSON, actions],
    ] as const) {
      expect(() =>
        assertPresencePass(p as never, { actions: acts, userId })
      ).toThrow(/pod admin/);
    }
    // Only the gate mints: the helper is the gate's (pinned by the tripwire).
    expect(typeof mintPresencePass).toBe("function");
  });

  it("GUARDRAIL: one passkey-change proof is redeemed once, and only within 5 minutes", async () => {
    expect(await redeemPasskeyChangeGrant(PERSON)).toBe(false);
    const proof = await proofFor(`passkey_change:${PERSON}`);
    await assertPresenceForRequest({
      userId: PERSON,
      kind: "passkey_change",
      id: PERSON,
      proof: proof as never,
      door: "test",
    });
    expect(await redeemPasskeyChangeGrant(OTHER)).toBe(false);
    expect(await redeemPasskeyChangeGrant(PERSON)).toBe(true);
    expect(await redeemPasskeyChangeGrant(PERSON)).toBe(false);
    // An old grant does not redeem.
    const old = await proofFor(`passkey_change:${PERSON}`);
    await assertPresenceForRequest({
      userId: PERSON,
      kind: "passkey_change",
      id: PERSON,
      proof: old as never,
      door: "test",
    });
    await h.client!.exec(
      `update presence_challenges set consumed_at = now() - interval '6 minutes' where redeemed_at is null`
    );
    expect(await redeemPasskeyChangeGrant(PERSON)).toBe(false);
  });

  it("the router enrols through enrollDeviceKey, which decides the factor under the lock BEFORE it spends the challenge", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const router = readFileSync(
      join(__dirname, "../../routers/presence.ts"),
      "utf8"
    );
    const enroll = router.slice(
      router.indexOf("    enroll: protectedProcedure")
    );
    expect(enroll).toMatch(/enrollDeviceKey\(/);
    expect(enroll).not.toMatch(/\.insert\(presenceDeviceKeys\)/);
    expect(router).toMatch(/return changePresenceMode\(/);
    const factors = readFileSync(join(__dirname, "factors.ts"), "utf8");
    const tx = factors.slice(factors.indexOf("db.transaction(async (tx)"));
    const lockAt = tx.indexOf("pg_advisory_xact_lock");
    const decideAt = tx.indexOf("hasProofFactor(args.userId, tx)");
    const spendAt = tx.indexOf(".update(presenceChallenges)");
    const insertAt = tx.indexOf(".insert(presenceDeviceKeys)");
    expect(lockAt).toBeGreaterThan(0);
    expect(decideAt).toBeGreaterThan(lockAt);
    expect(spendAt).toBeGreaterThan(decideAt);
    expect(insertAt).toBeGreaterThan(spendAt);
  });
});
