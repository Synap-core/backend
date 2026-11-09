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
  client: null as null | { exec: (sql: string) => Promise<unknown> },
  events: [] as Array<{ type: string; data: Record<string, unknown> }>,
  passkeys: [] as Array<Record<string, unknown>>,
  notices: [] as Array<{ type: string; userId: string }>,
  /** When set, every passkey read waits here (the race test's rendezvous). */
  kratosGate: null as null | (() => Promise<void>),
  /** The person's active Kratos sessions, and the ones the pod ended. */
  sessions: [] as Array<{ id: string }>,
  disabled: [] as string[],
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
    listIdentitySessions: async () => ({ data: h.sessions }),
    disableSession: async ({ id }: { id: string }) => {
      h.disabled.push(id);
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
const { redeemPasskeyChangeGrant, assertMayRemovePasskey } =
  await import("./passkey-change.js");
const { writePresenceSensitivity, readPresenceSensitivity } =
  await import("./mode.js");
const { changePresenceSensitivity } = await import("./sensitivity-change.js");
const { enrollDeviceKey } = await import("./factors.js");
const { assertPresencePass, mintPresencePass } = await import("./pass.js");
const { passPresenceForAction, PRESENCE_KEY_CALLER_MESSAGE } =
  await import("./gate.js");
const { issuePresenceChallenge, passkeyRpId } = await import("./proof.js");
const { beginTotpEnrolment, confirmTotpEnrolment } = await import("./totp.js");
const { base32Decode, totpCode, totpStepAt } = await import("./totp-code.js");
const { runAsBrowserPerson } = await import("../../utils/device-session.js");
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
  proof?: PresenceProof
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
    proof: proof ?? null,
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
  proof?: PresenceProof,
  userId = PERSON
) {
  return assertPresenceForApproval({
    userId,
    proposal,
    proof: proof ?? null,
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

/** Recovery codes for a person, hashed as the account recovery door does. */
async function seedRecoveryCodes(userId: string, codes: string[]) {
  const { hashRecoveryCode, newBatchSalt } =
    await import("../account-recovery/codes.js");
  const { normalizeRecoveryCode } =
    await import("@synap-core/types/account-recovery");
  const salt = newBatchSalt();
  const batch = crypto.randomUUID();
  for (const code of codes) {
    const hash = await hashRecoveryCode(normalizeRecoveryCode(code)!, salt);
    await (
      h.client as unknown as {
        query: (s: string, p: unknown[]) => Promise<unknown>;
      }
    ).query(
      `insert into account_recovery_codes (user_id, code_hash, batch_id) values ($1, $2, $3)`,
      [userId, hash, batch]
    );
  }
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
    // The recovery ladder's tables, from the migrations as written (0294:
    // recovery codes; 0405: 2FA app, typed-code failures, recovery requests,
    // disowned passkeys).
    for (const file of [
      "0294_account_recovery_codes.sql",
      "0405_presence_recovery.sql",
    ]) {
      await h.client!.exec(
        readFileSync(
          new URL(`../../../../database/migrations/${file}`, import.meta.url),
          "utf8"
        )
      );
    }
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

  it("GUARDRAIL: approving an automation or playbook create with no proof is refused (it lands active)", async () => {
    for (const [targetType, proposalType] of [
      ["automation", "create"],
      ["playbook", "create"],
    ] as const) {
      expect(
        await refusal(
          gate({ id: crypto.randomUUID(), targetType, proposalType })
        )
      ).toBe("PRESENCE_REQUIRED");
    }
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
    } satisfies PresenceProof;
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
    } satisfies PresenceProof;
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
    proof?: PresenceProof
  ) =>
    assertPresenceForRequest({
      userId: PERSON,
      kind,
      id,
      proof: proof ?? null,
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
    } satisfies PresenceProof;
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

  const proofFor = async (subject: string): Promise<PresenceProof> => {
    const c = await challengeFor(subject);
    return {
      kind: "device_key",
      challengeId: c.challengeId,
      keyId: deviceKeyId,
      signature: deviceSign(c.message),
    };
  };
  const action = (path: string, input: unknown, proof?: PresenceProof) =>
    assertPresenceForAction({
      userId: PERSON,
      path,
      input,
      proof: proof ?? null,
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

  it("GUARDRAIL: the pod setting drives the mode; ON needs two ways in, OFF needs a proof and tells the admins", async () => {
    delete process.env.SYNAP_PRESENCE_PROOF;
    await reportByChoice();
    expect((await readPresenceMode()).mode).toBe("report");
    expect(await refusal(action("apiKeys.create", { a: 1 }))).toBe("accepted");
    // PERSON holds ONE way in (a device key): turning enforce on is refused
    // (the recovery ladder: one lost factor must not lock them out).
    expect(
      await refusal(changePresenceMode({ userId: PERSON, mode: "enforce" }))
    ).toBe("PRESENCE_NEEDS_TWO_WAYS");
    expect((await readPresenceMode()).mode).toBe("report");
    // A second way (recovery codes): ON needs no proof.
    await seedRecoveryCodes(PERSON, ["ABCD-EFGH-JKMN-PQRS"]);
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
          proof,
        })
      )
    ).toBe("accepted");
    expect((await readPresenceMode()).mode).toBe("report");
    expect(h.events.map((e) => e.type)).toContain("presence.mode_changed");
    await h.client!.exec("delete from account_recovery_codes");
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
          proof,
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
      proof,
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
      proof: old,
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

describe("what asks for your passkey (W5): the pod's choice", () => {
  beforeEach(async () => {
    process.env.PUBLIC_URL = POD;
    process.env.SYNAP_PRESENCE_PROOF = "enforce";
    h.events.length = 0;
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
  const action = (path: string, input: unknown) =>
    assertPresenceForAction({ userId: PERSON, path, input, proof: null });

  it("GUARDRAIL: with no choice stored, every row of today's lists asks", async () => {
    expect(await readPresenceSensitivity()).toMatchObject({
      approvalsOff: [],
      actionsOff: [],
    });
    expect(await refusal(gate(SENSITIVE))).toBe("PRESENCE_REQUIRED");
    expect(await refusal(gate(OTHER_SENSITIVE))).toBe("PRESENCE_REQUIRED");
    expect(await refusal(action("apiKeys.create", { a: 1 }))).toBe(
      "PRESENCE_REQUIRED"
    );
  });

  it("GUARDRAIL: the gate honours a row switched off and still asks for the rows left on", async () => {
    await writePresenceSensitivity({
      choice: {
        approvalsOff: ["entity/delete"],
        actionsOff: ["apiKeys.create"],
      },
      changedBy: PERSON,
    });
    // Switched off: approved on the session alone, nothing recorded.
    expect(await refusal(gate(OTHER_SENSITIVE))).toBe("accepted");
    expect(await refusal(action("apiKeys.create", { a: 1 }))).toBe("accepted");
    expect(h.events).toEqual([]);
    // Left on: still refused without a proof.
    expect(await refusal(gate(SENSITIVE))).toBe("PRESENCE_REQUIRED");
    expect(await refusal(action("apiKeys.rotate", { a: 1 }))).toBe(
      "PRESENCE_REQUIRED"
    );
    // A request filed AS THE PERSON is never switchable.
    expect(await refusal(gate(AS_PERSON))).toBe("PRESENCE_REQUIRED");
  });

  it("GUARDRAIL: switching a row off needs a proof for that exact choice, in every mode; switching back on is free", async () => {
    const { presenceSensitivityId } =
      await import("@synap-core/types/presence");
    const choice = { approvalsOff: ["entity/delete"], actionsOff: [] };
    delete process.env.SYNAP_PRESENCE_PROOF;
    await reportByChoice();
    expect(
      await refusal(changePresenceSensitivity({ userId: PERSON, choice }))
    ).toBe("PRESENCE_REQUIRED");
    expect((await readPresenceSensitivity()).approvalsOff).toEqual([]);
    // A proof made for another choice does not switch this one off.
    const other = await proofFor(
      `presence_sensitivity:${await presenceSensitivityId({ approvalsOff: ["workspace/delete"], actionsOff: [] })}`
    );
    expect(
      await refusal(
        changePresenceSensitivity({
          userId: PERSON,
          choice,
          proof: other as never,
        })
      )
    ).toBe("PRESENCE_INVALID");
    const proof = await proofFor(
      `presence_sensitivity:${await presenceSensitivityId(choice)}`
    );
    expect(
      await refusal(
        changePresenceSensitivity({
          userId: PERSON,
          choice,
          proof: proof as never,
        })
      )
    ).toBe("accepted");
    expect(await readPresenceSensitivity()).toMatchObject({
      approvalsOff: ["entity/delete"],
      changedBy: PERSON,
    });
    expect(h.events.map((e) => e.type)).toContain(
      "presence.sensitivity_changed"
    );
    // Back on: free, and recorded too.
    expect(
      await refusal(
        changePresenceSensitivity({
          userId: PERSON,
          choice: { approvalsOff: [], actionsOff: [] },
        })
      )
    ).toBe("accepted");
    expect((await readPresenceSensitivity()).approvalsOff).toEqual([]);
  });

  it("GUARDRAIL: the last passkey cannot be removed while the proof is on; a second one can", async () => {
    h.passkeys = [{ id: "AQ==", public_key: "AQ==" }];
    expect(await refusal(assertMayRemovePasskey(PERSON))).toBe(
      "PRESENCE_LAST_PASSKEY"
    );
    h.passkeys = [
      { id: "AQ==", public_key: "AQ==" },
      { id: "Ag==", public_key: "Ag==" },
    ];
    expect(await refusal(assertMayRemovePasskey(PERSON))).toBe("accepted");
    delete process.env.SYNAP_PRESENCE_PROOF;
    await reportByChoice();
    h.passkeys = [{ id: "AQ==", public_key: "AQ==" }];
    expect(await refusal(assertMayRemovePasskey(PERSON))).toBe("accepted");
  });

  it("the router checks the removal BEFORE it spends the proof", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(__dirname, "../../routers/presence.ts"),
      "utf8"
    );
    const door = src.slice(
      src.indexOf("  authorizePasskeyChange: protectedProcedure")
    );
    const checkAt = door.indexOf("assertMayRemovePasskey(");
    const proofAt = door.indexOf("assertPresenceForRequest(");
    expect(checkAt).toBeGreaterThan(0);
    expect(proofAt).toBeGreaterThan(checkAt);
    expect(src).toMatch(/return changePresenceSensitivity\(/);
  });
});

describe("proof of presence: the recovery ladder (6 Nov 2026)", () => {
  const LADDER = crypto.randomUUID();
  let secret = "";

  const q = (sql: string, params: unknown[] = []) =>
    (
      h.client as unknown as {
        query: (
          s: string,
          p: unknown[]
        ) => Promise<{ rows: Array<Record<string, unknown>> }>;
      }
    ).query(sql, params);

  /** The code a 2FA app shows `stepsFromNow` steps from now. */
  const appCode = (stepsFromNow = 0) =>
    totpCode(base32Decode(secret), totpStepAt(new Date()) + stepsFromNow);

  const typed = async (
    kind: "totp" | "recovery_code",
    code: string,
    proposal = SENSITIVE,
    userId = LADDER
  ) => {
    const c = await challengeFor(proposal.id, userId);
    // As pod admin sends it: a person's browser session (tRPC, `kratos`).
    return runAsBrowserPerson(() =>
      gate(proposal, { kind, challengeId: c.challengeId, code }, userId)
    );
  };

  beforeAll(async () => {
    process.env.SYNAP_SERVICE_ENCRYPTION_KEY = "test-service-key-for-totp";
    await q(
      `insert into users (id, email, name) values ($1, 'l@x.test', 'Ladder')`,
      [LADDER]
    );
  });
  beforeEach(async () => {
    process.env.PUBLIC_URL = POD;
    process.env.SYNAP_PRESENCE_PROOF = "enforce";
    h.events.length = 0;
    h.notices.length = 0;
    h.passkeys = [];
    await agePastRateWindow();
    await h.client!.exec("delete from presence_proof_failures");
    await noStoredMode();
  });
  afterEach(() => {
    delete process.env.SYNAP_PRESENCE_PROOF;
    invalidatePresenceMode();
  });

  it("a first 2FA app needs no proof; its first code proves the app holds the secret", async () => {
    const begun = await beginTotpEnrolment({
      userId: LADDER,
      label: "Authenticator",
      account: "l@x.test",
      issuer: "Synap (pod.example.test)",
    });
    secret = begun.secret;
    expect(begun.otpauthUri).toMatch(/^otpauth:\/\/totp\/.+secret=/);
    // The secret is stored encrypted, never as typed.
    const [row] = (
      await q(`select secret from presence_totp_factors where id = $1`, [
        begun.id,
      ])
    ).rows;
    expect(row!.secret).not.toContain(secret);
    expect(
      await refusal(
        confirmTotpEnrolment({ userId: LADDER, id: begun.id, code: "000000" })
      )
    ).toMatch(/doesn't match/);
    // Confirmed two steps back, so the code of NOW is a later step.
    const past = new Date(Date.now() - 60_000);
    const pastCode = totpCode(base32Decode(secret), totpStepAt(past));
    expect(
      await refusal(
        confirmTotpEnrolment({
          userId: LADDER,
          id: begun.id,
          code: pastCode,
          now: past,
        })
      )
    ).toBe("accepted");
  });

  it("GUARDRAIL: a key never carries a typed code: refused before the code is read", async () => {
    // A challenge for exactly this request: only the caller being a key is
    // wrong. A wrong code, so no app step is spent for the tests after.
    const c = await challengeFor(`recovery_codes:${LADDER}`, LADDER);
    const asKey = await assertPresenceForRequest({
      userId: LADDER,
      kind: "recovery_codes",
      id: LADDER,
      proof: { kind: "totp", challengeId: c.challengeId, code: "000000" },
      door: "test",
      keyCaller: true,
    }).catch((e: Error) => e);
    expect((asKey as Error).message).toMatch(/A key can't send one/);
    // Never read: no wrong try counted against the person.
    const { rows } = await q(
      `select count(*)::int as n from presence_proof_failures where user_id = $1`,
      [LADDER]
    );
    expect(rows[0]!.n).toBe(0);
  });

  it("GUARDRAIL: a 2FA app code proves presence ONCE, for the approval its challenge names", async () => {
    const code = appCode();
    expect(await refusal(typed("totp", code))).toBe("accepted");
    const proved = h.events.find((e) => e.type === "presence.proved");
    expect(proved?.data).toMatchObject({ method: "totp" });
    expect(String(proved?.data.actor)).toContain("authenticator app");
    // The same code again: refused (its step was used).
    expect(await refusal(typed("totp", code))).toBe("PRESENCE_INVALID");
    // An earlier step's code: refused too.
    expect(await refusal(typed("totp", appCode(-1)))).toBe("PRESENCE_INVALID");
    // A challenge made for another approval: refused before any code is read.
    const other = await challengeFor(OTHER_SENSITIVE.id, LADDER);
    expect(
      await refusal(
        gate(
          SENSITIVE,
          { kind: "totp", challengeId: other.challengeId, code: appCode(1) },
          LADDER
        )
      )
    ).toBe("PRESENCE_INVALID");
  });

  it("GUARDRAIL: a recovery code proves presence once, and is spent", async () => {
    await seedRecoveryCodes(LADDER, [
      "TVWX-YZ01-2345-6789",
      "0123-4567-89AB-CDEF",
    ]);
    expect(await refusal(typed("recovery_code", "tvwx yz01 2345 6789"))).toBe(
      "accepted"
    );
    expect(
      h.events.find((e) => e.type === "presence.proved")?.data
    ).toMatchObject({ method: "recovery_code" });
    expect(await refusal(typed("recovery_code", "TVWX-YZ01-2345-6789"))).toBe(
      "PRESENCE_INVALID"
    );
    const [left] = (
      await q(
        `select count(*)::int as n from account_recovery_codes where user_id = $1 and used_at is null`,
        [LADDER]
      )
    ).rows;
    expect(left!.n).toBe(1);
  });

  it("GUARDRAIL: a typed code is refused from a Synap app's device session", async () => {
    const { runAsDeviceSession } =
      await import("../../utils/device-session.js");
    const verdict = await runAsDeviceSession(
      { id: crypto.randomUUID(), authTime: new Date() },
      () => refusal(typed("recovery_code", "0123-4567-89AB-CDEF"))
    );
    expect(verdict).toBe("PRESENCE_INVALID");
    // The code was not spent by the refusal.
    expect(await refusal(typed("recovery_code", "0123-4567-89AB-CDEF"))).toBe(
      "accepted"
    );
  });

  it("GUARDRAIL: a typed code outside a person's browser session (a Hub door, an executor) is refused unread", async () => {
    const c = await challengeFor(SENSITIVE.id, LADDER);
    // No scope opened: what a Hub REST approve with the person's CLI key is.
    expect(
      await refusal(
        gate(
          SENSITIVE,
          { kind: "totp", challengeId: c.challengeId, code: "000000" },
          LADDER
        )
      )
    ).toBe("PRESENCE_INVALID");
    const { rows } = await q(
      `select count(*)::int as n from presence_proof_failures where user_id = $1`,
      [LADDER]
    );
    expect(rows[0]!.n).toBe(0);
  });

  it("GUARDRAIL: a burst of wrong codes sent at once reads at most five", async () => {
    const tries = await Promise.all(
      Array.from({ length: 9 }, () => refusal(typed("totp", "123456")))
    );
    expect(tries.every((t) => t === "PRESENCE_INVALID")).toBe(true);
    // At most five were read (each read one stays as a wrong try); a try
    // that counted more than five before reading took its row back. Read
    // before counting, all nine would have been read (nine rows).
    const { rows } = await q(
      `select count(*)::int as n from presence_proof_failures where user_id = $1`,
      [LADDER]
    );
    expect(rows[0]!.n).toBeLessThanOrEqual(5);
  });

  it("GUARDRAIL: five wrong typed codes in 15 minutes stop the sixth, even a right one", async () => {
    for (let i = 0; i < 5; i++) {
      expect(await refusal(typed("totp", "123456"))).toBe("PRESENCE_INVALID");
    }
    const sixth = await typed("totp", appCode(1)).catch((e: Error) => e);
    expect((sixth as Error).message).toMatch(/Too many wrong codes/);
    // An hour later the window has passed.
    await h.client!.exec(
      "update presence_proof_failures set created_at = created_at - interval '1 hour'"
    );
    expect(await refusal(typed("totp", appCode(1)))).toBe("accepted");
  });

  it("GUARDRAIL: a second 2FA app is refused while one is in use; adding one when holding a factor needs a proof from it", async () => {
    expect(
      await refusal(
        beginTotpEnrolment({
          userId: PERSON,
          label: "App",
          account: "a@x.test",
          issuer: "Synap",
        }).then(async (b) => {
          const code = totpCode(base32Decode(b.secret), totpStepAt(new Date()));
          // PERSON holds a device key: no proof, refused under enforce.
          return confirmTotpEnrolment({ userId: PERSON, id: b.id, code });
        })
      )
    ).toBe("PRESENCE_REQUIRED");
    expect(
      await refusal(
        beginTotpEnrolment({
          userId: LADDER,
          label: "Second",
          account: "l@x.test",
          issuer: "Synap",
        })
      )
    ).toMatch(/already use an authenticator app/);
  });

  it("GUARDRAIL: under enforce a removal never leaves fewer than two ways in; report lets it", async () => {
    const { assertKeepsTwoWaysIn } = await import("./factors.js");
    // LADDER: a 2FA app (one way) and no recovery code left.
    await h.client!.exec(
      `update account_recovery_codes set used_at = now() where user_id = '${LADDER}'`
    );
    const removeApp = () =>
      assertKeepsTwoWaysIn({
        userId: LADDER,
        after: (c) => ({ ...c, totp: false }),
      });
    expect(await refusal(removeApp())).toBe("PRESENCE_NEEDS_TWO_WAYS");
    await seedRecoveryCodes(LADDER, ["ABCD-EFGH-JKMN-PQRS"]);
    // Two ways (app + codes): removing the app would leave one. Still refused.
    expect(await refusal(removeApp())).toBe("PRESENCE_NEEDS_TWO_WAYS");
    // Every passkey together is ONE way: two passkeys + the app = two ways.
    h.passkeys = [
      { id: "AQ==", public_key: "AQ==", authenticator: {} },
      { id: "Ag==", public_key: "Ag==", authenticator: {} },
    ];
    const { presenceFactorCounts } = await import("./proof.js");
    const { presenceWaysIn } = await import("@synap-core/types/presence");
    expect(presenceWaysIn(await presenceFactorCounts(LADDER))).toBe(3);
    expect(await refusal(removeApp())).toBe("accepted");
    h.passkeys = [];
    delete process.env.SYNAP_PRESENCE_PROOF;
    await reportByChoice();
    expect(
      await refusal(
        assertKeepsTwoWaysIn({
          userId: LADDER,
          after: () => ({
            passkeys: 0,
            deviceKeys: 0,
            totp: false,
            recoveryCodes: 0,
          }),
        })
      )
    ).toBe("accepted");
  });

  it("GUARDRAIL: 'I lost my passkey' waits 24 h, any session cancels it, and finishing it clears every factor", async () => {
    const {
      requestPresenceRecovery,
      cancelPresenceRecovery,
      completePresenceRecovery,
      readPresenceRecovery,
    } = await import("./recovery.js");
    const { readPasskeys, hasProofFactor } = await import("./proof.js");
    const now = new Date();
    const asked = await requestPresenceRecovery({ userId: LADDER, now });
    expect(asked.status).toBe("pending");
    expect(asked.maturesAt.getTime() - now.getTime()).toBe(24 * 3600 * 1000);
    expect(h.notices).toContainEqual({
      type: "security.presence_recovery",
      userId: LADDER,
    });
    // Asking again returns the same request.
    expect((await requestPresenceRecovery({ userId: LADDER })).id).toBe(
      asked.id
    );
    // Cancelled from any session: nothing changes.
    expect((await cancelPresenceRecovery({ userId: LADDER })).status).toBe(
      "cancelled"
    );
    expect(
      await refusal(
        completePresenceRecovery({ userId: LADDER, keepSessionId: null })
      )
    ).toMatch(/no reset waiting/);

    const again = await requestPresenceRecovery({ userId: LADDER, now });
    expect(again.id).not.toBe(asked.id);
    // Before 24 h: refused.
    expect(
      await refusal(
        completePresenceRecovery({
          userId: LADDER,
          keepSessionId: null,
          now: new Date(now.getTime() + 23 * 3600 * 1000),
        })
      )
    ).toMatch(/can be finished from/);
    // LADDER holds a passkey (in Kratos), a device key, a 2FA app, codes.
    h.passkeys = [
      {
        id: credentialId.toString("base64"),
        public_key: coseKey(passkey.publicKey).toString("base64"),
        authenticator: { sign_count: 0 },
      },
    ];
    await q(
      `insert into presence_device_keys (user_id, label, public_key) values ($1, 'Lost phone', 'x')`,
      [LADDER]
    );
    expect(await hasProofFactor(LADDER)).toBe(true);

    // Three browsers are signed in; the person finishes from "here".
    h.sessions = [{ id: "here" }, { id: "laptop" }, { id: "stolen" }];
    h.disabled = [];
    expect(h.disabled).toEqual([]); // nothing ended before the finish
    const done = await completePresenceRecovery({
      userId: LADDER,
      keepSessionId: "here",
      now: new Date(now.getTime() + 24 * 3600 * 1000 + 1000),
    });
    // Every other browser is signed out; the one that finished stays.
    expect([...h.disabled].sort()).toEqual(["laptop", "stolen"]);
    expect(done.signedOut).toEqual({ listed: true, ended: 2, failed: 0 });
    h.sessions = [];
    expect(done.status).toBe("completed");
    expect(done.cleared.passkeys).toBe(1);
    expect(done.cleared.totp).toBeGreaterThanOrEqual(1);
    expect(done.cleared.recoveryCodes).toBeGreaterThanOrEqual(1);
    expect(done.cleared.deviceKeys).toBeGreaterThanOrEqual(1);
    // The passkey still exists in Kratos, but proves nothing here any more.
    expect(await readPasskeys(LADDER)).toEqual([]);
    expect(await hasProofFactor(LADDER)).toBe(false);
    expect((await readPresenceRecovery(LADDER))?.status).toBe("completed");
    // The way back in: a first factor needs no proof.
    expect(await refusal(enrol(LADDER))).toBe("accepted");
    h.passkeys = [];
  });
});
