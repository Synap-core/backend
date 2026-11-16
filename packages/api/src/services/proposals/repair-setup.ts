/**
 * The SETUP arm of a proposal repair: a person hands over what a proposal
 * still needs before it can apply (a key, a value), ON the proposal, instead
 * of reading "Needs setup: Cal.com API key." and leaving to find where the
 * key goes (finding 91a3bfd3; plan d717d6ac addendum B, founder defaults B1
 * and B2, 16 Nov 2026).
 *
 * ONE model, two kinds of proposal:
 *   - `capability.install` of a capability: its setup is the read-time
 *     projection (`proposal-setup.ts`), one row per manifest param, each
 *     with the manifest's `obtain` steps;
 *   - `vault.request` with no secret the approval could grant: one row, the
 *     key the agent asked for (its approval would refuse "No secret in your
 *     vault matches X" — the same read decides both, `vault-request-secrets.ts`).
 *
 * ONE write rule, on the server (B1), so pod admin, desktop and phone cannot
 * drift: VAULT FIRST, then one revision carrying refs only.
 *   - a secret row takes an existing vault secret of the person's own (a
 *     `vault://` ref) or a NEW key, which is created in the vault through the
 *     vault's own create door, and only its ref reaches the proposal;
 *   - a plain row takes a value;
 *   - every entry is checked before anything is written: an undeclared key, a
 *     plain value under a secret row, a ref that is not the person's own
 *     secret, an empty patch are each refused and nothing changes.
 * A key's value is never written to the proposal, its history, a log or the
 * reply. A create that succeeded before a later refusal leaves a vault secret
 * nobody linked, which the person can see and reuse (the same trade the
 * client rule `runSetupSubmit` documents).
 *
 * Person-only and the approve right: the door (`proposals.repair`) refuses an
 * agent and a key; typing a new key needs a recent sign-in (B2).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { db, and, eq, isNull, asc } from "@synap/database";
import { secrets, ProposalStatus } from "@synap/database/schema";
import {
  SECRET_TYPES,
  parseVaultReference,
  makeVaultReference,
  type SecretType,
} from "@synap-core/types/vault";
import { resolveServiceName } from "@synap-core/types/service-marks";
import type { ProposalSetup, ProposalSetupParam } from "./proposal-setup.js";
import {
  listRequestableSecrets,
  matchRequestedSecrets,
  vaultRequestFields,
} from "./vault-request-secrets.js";

/** The row name a `vault.request`'s setup row goes by. */
export const VAULT_REQUEST_SETUP_PARAM = "secret";

/** The vault type a key typed on an install proposal is stored as. */
export const SETUP_SECRET_TYPE: SecretType = "api_key";

/** One of the person's own vault secrets a secret row may take. Labels only. */
export interface SetupSecretChoice {
  /** `vault://<id>`. A pointer, never a value. */
  ref: string;
  label: string;
  /** The secret's category ("Stripe"), when it has one. */
  service?: string;
}

/** What `proposals.repairOptions` returns for a proposal that needs an input. */
export interface ProposalRepairSetup extends ProposalSetup {
  /** The person's own vault secrets, for every secret row's picker. */
  secretChoices: SetupSecretChoice[];
}

/** What the person hands over for one row. */
export const setupRepairEntrySchema = z.discriminatedUnion("kind", [
  /** A vault secret the person already has: `vault://<id>`. */
  z.object({ kind: z.literal("existing"), ref: z.string().min(1).max(200) }),
  /** A new key, typed masked: created in the vault, only its ref is kept. */
  z.object({ kind: z.literal("new"), value: z.string().min(1).max(10_000) }),
  /** A plain (not secret) value. */
  z.object({
    kind: z.literal("value"),
    value: z.union([z.string().max(2_000), z.number(), z.boolean()]),
  }),
]);
export type SetupRepairEntry = z.infer<typeof setupRepairEntrySchema>;

/** `proposals.repair`'s `setup` input: row name → what the person hands over. */
export const setupRepairInputSchema = z
  .record(z.string().min(1).max(100), setupRepairEntrySchema)
  .refine((v) => Object.keys(v).length <= 20, {
    message: "At most 20 rows at once.",
  });

type SetupSource = {
  id: string;
  status: string;
  targetType: string;
  proposalType: string;
  data: unknown;
};

type SetupKind = "install" | "vault_request";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Which setup model reads this proposal, if any. */
export function setupRepairKind(p: {
  targetType: string;
  proposalType: string;
  data: unknown;
}): SetupKind | null {
  const data = asRecord(p.data);
  if (p.proposalType === "capability.install" && data.kind === "capability") {
    return "install";
  }
  if (p.targetType === "vault" && p.proposalType === "vault.request") {
    // A request naming its secret is decided by that name, not by a row.
    return typeof vaultRequestFields(p.data).secretId === "string"
      ? null
      : "vault_request";
  }
  return null;
}

/**
 * The person's own vault secrets a row may take: server-encrypted (the pod
 * can resolve it), not deleted, and not a connection pointer — the same floor
 * the provide sheet lists (`provide-options.ts`).
 */
async function ownSecretChoices(userId: string): Promise<SetupSecretChoice[]> {
  const rows = await db
    .select({
      id: secrets.id,
      name: secrets.name,
      category: secrets.category,
    })
    .from(secrets)
    .where(
      and(
        eq(secrets.userId, userId),
        isNull(secrets.deletedAt),
        isNull(secrets.capabilityId),
        eq(secrets.encryptionMode, "server")
      )
    )
    .orderBy(asc(secrets.name))
    .limit(200);
  return rows.map((r) => ({
    ref: makeVaultReference(r.id),
    label: r.name,
    ...(r.category ? { service: r.category } : {}),
  }));
}

/** The vault.request's one row, when no secret of the reader's would be granted. */
async function vaultRequestSetup(
  source: SetupSource,
  userId: string
): Promise<ProposalSetup | null> {
  const fields = vaultRequestFields(source.data);
  const matches = matchRequestedSecrets(
    await listRequestableSecrets(userId),
    fields
  );
  if (matches.length > 0) return null;
  const service = typeof fields.service === "string" ? fields.service : "";
  const purpose =
    typeof fields.purpose === "string" ? fields.purpose.trim() : "";
  const label = service ? `${resolveServiceName(service)} key` : "The key";
  const row: ProposalSetupParam = {
    name: VAULT_REQUEST_SETUP_PARAM,
    label,
    required: true,
    ...(purpose ? { description: purpose } : {}),
    secret: true,
    satisfied: false,
  };
  return { params: [row], blocking: true };
}

/**
 * The setup rows of one proposal, for `proposals.repairOptions`: `null` when
 * the proposal takes none (another kind, a decided one, an install whose
 * manifest the pod cannot read, or a request a secret already matches).
 */
export async function describeSetupRepair(
  source: SetupSource,
  userId: string
): Promise<ProposalRepairSetup | null> {
  if (
    source.status !== ProposalStatus.APPROVAL_FAILED &&
    source.status !== ProposalStatus.PENDING
  ) {
    return null;
  }
  const kind = setupRepairKind(source);
  if (!kind) return null;
  let setup: ProposalSetup | null;
  if (kind === "install") {
    const { resolveProposalSetups } = await import("./proposal-setup.js");
    setup =
      (
        await resolveProposalSetups(
          [source as unknown as Record<string, unknown>],
          userId
        )
      ).get(source.id) ?? null;
  } else {
    setup = await vaultRequestSetup(source, userId);
  }
  if (!setup) return null;
  const needsChoices = setup.params.some((p) => p.secret);
  return {
    ...setup,
    secretChoices: needsChoices ? await ownSecretChoices(userId) : [],
  };
}

/** The door that creates a vault secret (the vault's own `create`). */
export type CreateSetupSecret = (input: {
  name: string;
  type: SecretType;
  category?: string;
  value: string;
}) => Promise<{ vaultRef: string }>;

function refuse(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

/** Does this repair type a new key (and so need a recent sign-in)? */
export function setupRepairCreatesSecret(
  entries: Record<string, SetupRepairEntry>
): boolean {
  return Object.values(entries).some((e) => e.kind === "new");
}

/**
 * Check every entry against the proposal's setup rows, create the new keys
 * in the vault, and answer the payload fields the revision writes. Nothing is
 * written when an entry is refused; the revision itself is the caller's
 * (`mergeProposalRevision`, under the row lock).
 */
export async function buildSetupRepair(args: {
  source: SetupSource;
  userId: string;
  entries: Record<string, SetupRepairEntry>;
  createSecret: CreateSetupSecret;
}): Promise<{ fields: Record<string, unknown>; secretsCreated: number }> {
  const { source, userId, entries, createSecret } = args;
  const kind = setupRepairKind(source);
  const setup = await describeSetupRepair(source, userId);
  if (!kind || !setup) {
    return refuse(
      "This proposal has nothing to hand over here: it needs no key or value, or the pod cannot read what it needs."
    );
  }
  if (setup.unreadable) {
    return refuse(
      "The pod cannot read what this proposal needs right now (its catalog entry did not load), so nothing can be handed over yet. Try again later, or ask the AI to redo it."
    );
  }
  const names = Object.keys(entries);
  if (names.length === 0) {
    return refuse("Hand over at least one value.");
  }
  const rows = new Map(setup.params.map((p) => [p.name, p]));
  const own = new Set(setup.secretChoices.map((c) => c.ref));

  // Every entry checked BEFORE any vault write.
  for (const name of names) {
    const row = rows.get(name);
    const entry = entries[name]!;
    if (!row) {
      refuse(`"${name}" is not something this proposal needs.`);
    }
    const label = row!.label ?? name;
    if (row!.secret) {
      if (entry.kind === "value") {
        refuse(
          `${label} is a secret: pick one of your vault secrets or type a new key, so it is kept in the vault.`
        );
      }
      if (entry.kind === "existing") {
        const id = parseVaultReference(entry.ref);
        if (!id || !own.has(makeVaultReference(id))) {
          refuse(
            `The secret picked for ${label} is not one of yours in the vault.`
          );
        }
      }
      if (entry.kind === "new" && !entry.value.trim()) {
        refuse(`Type the key for ${label}.`);
      }
    } else {
      if (entry.kind !== "value") {
        refuse(`${label} is not a secret: type its value.`);
      }
      if (
        entry.kind === "value" &&
        typeof entry.value === "string" &&
        !entry.value.trim()
      ) {
        refuse(`Type a value for ${label}.`);
      }
    }
  }

  // Vault first: each new key becomes a vault secret, and only its ref goes on.
  const set: Record<string, unknown> = {};
  let secretsCreated = 0;
  const fields = vaultRequestFields(source.data);
  for (const name of names) {
    const row = rows.get(name)!;
    const entry = entries[name]!;
    if (entry.kind === "value") {
      set[name] =
        typeof entry.value === "string" ? entry.value.trim() : entry.value;
      continue;
    }
    if (entry.kind === "existing") {
      set[name] = makeVaultReference(parseVaultReference(entry.ref)!);
      continue;
    }
    const service =
      kind === "vault_request" && typeof fields.service === "string"
        ? fields.service
        : undefined;
    const requestedType =
      kind === "vault_request" && typeof fields.secretType === "string"
        ? fields.secretType
        : null;
    const created = await createSecret({
      name:
        kind === "install"
          ? `${asRecord(source.data).slug as string} · ${row.label ?? name}`
          : (row.label ?? name),
      type:
        requestedType &&
        (SECRET_TYPES as readonly string[]).includes(requestedType)
          ? (requestedType as SecretType)
          : SETUP_SECRET_TYPE,
      ...(service ? { category: service } : {}),
      value: entry.value.trim(),
    });
    const ref = parseVaultReference(created?.vaultRef);
    if (!ref) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `Your key for ${row.label ?? name} was saved in the vault, but no reference came back, so nothing was attached to the proposal.`,
      });
    }
    secretsCreated += 1;
    set[name] = makeVaultReference(ref);
  }

  if (kind === "vault_request") {
    // The approval grants the secret the request NAMES (`secretId`).
    const ref = set[VAULT_REQUEST_SETUP_PARAM];
    return {
      fields: { secretId: parseVaultReference(ref) },
      secretsCreated,
    };
  }
  const data = asRecord(source.data);
  return {
    fields: { params: { ...asRecord(data.params), ...set } },
    secretsCreated,
  };
}
