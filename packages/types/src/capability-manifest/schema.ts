/**
 * THE CAPABILITY MANIFEST RULE — what a capability NEEDS, what it OFFERS for the
 * intents it provides, how a COMPOSITE builds one intent from others, and the
 * host SERVICES it runs on a computer (plan U3, document 64072312; addendum
 * 000e75ff §3–§4; parent design ccd509f8 §3).
 *
 * Decided ONE way for every door that ships or installs one: the pod's
 * definition applier (`create-from-definition.ts`), the resolver, and the
 * catalog validator (`synap catalog validate`), so a manifest the catalog
 * passes is one the pod accepts at install.
 *
 * No provider name appears anywhere in this file. A need names an INTENT and
 * constraints; a provider is any capability whose `offers` meet them.
 *
 * Pure: zod and the intent vocabulary leaf only. The intents' CONTRACTS live in
 * the pod's `capability_intents` table, so the caller passes them in
 * (`ManifestContext.contractFor`); without it, the checks that need a contract
 * are skipped, never guessed.
 */
import { z } from "zod";
import {
  INTENT_OPS,
  isIntentOp,
  isKnownIntent as isVocabularyIntent,
  type IntentContract,
} from "../capability-intents/index.js";

/** An intent slug, a need key, a service id: the registry's slug seat. */
export const MANIFEST_SLUG_RE = /^[a-z][a-z0-9_]{0,63}$/;
const slug = z.string().regex(MANIFEST_SLUG_RE, {
  message: "a slug: lowercase letters, digits and underscores",
});

// ── needs ────────────────────────────────────────────────────────────────────

/**
 * One thing the capability needs to work, by intent: "somewhere to run",
 * "a URL for the studio". `constraints` keys are the intent contract's
 * `constraints`; their values are matched against a provider's `offers`.
 */
export const ManifestNeedSchema = z
  .object({
    key: slug,
    intent: slug,
    /** The service (`services[].id`) this need serves, if any. */
    for: slug.optional(),
    constraints: z.record(z.string(), z.unknown()).optional(),
    /** An optional need may stay unbound; the install goes on without it. */
    optional: z.boolean().optional(),
  })
  .strict();
export type ManifestNeed = z.output<typeof ManifestNeedSchema>;

// ── offers ───────────────────────────────────────────────────────────────────

/** Where a provider's ops execute. Every provider may say it. */
export const OFFER_RUNS_ON = ["pod", "computer"] as const;

/**
 * The terms on which a provider serves ONE intent. Keys other than `runsOn` are
 * the contract's constraint keys (`auth`, `source`, `hostname`, `public` for
 * `expose_http`); their values are what it supports. `auth` lists the access
 * modes it ENFORCES itself; `public: true` says it can ever make something
 * reachable by anyone, which also needs `public` in `auth`.
 */
export const ManifestOfferSchema = z
  .object({
    auth: z.array(slug).min(1).optional(),
    source: z.array(slug).min(1).optional(),
    hostname: z
      .object({
        kind: z.enum(["machine", "subdomain_of", "any_fqdn"]),
        zone: z.string().min(1).max(253).optional(),
      })
      .strict()
      .optional(),
    runsOn: z.enum(OFFER_RUNS_ON).optional(),
    public: z.boolean().optional(),
  })
  .catchall(z.unknown());
export type ManifestOffer = z.output<typeof ManifestOfferSchema>;

/** Offer keys any provider may declare, whatever the contract lists. */
const GENERIC_OFFER_KEYS: ReadonlySet<string> = new Set(["runsOn"]);

// ── compose ──────────────────────────────────────────────────────────────────

/**
 * A value in a compose step: the SAME path-copy grammar `skills.input_map`
 * uses, no expressions. A string is a path — `$.<field>` into the op's input,
 * or `$<need>.output.<field>` into what an EARLIER step of that need returned.
 * `{ const }` is a literal, a list is a list of values, and `{ join }` is the
 * one concatenation (strings only), so a composite can build
 * `https://` + a record's name without an expression language.
 */
export const COMPOSE_PATH_RE =
  /^\$([a-z][a-z0-9_]{0,63})?(\.[A-Za-z_][A-Za-z0-9_]*)+$/;

export type ComposeValue =
  string | { const: unknown } | { join: ComposeValue[] } | ComposeValue[];

export const ComposeValueSchema: z.ZodType<ComposeValue> = z.lazy(() =>
  z.union([
    z.string().regex(COMPOSE_PATH_RE, {
      message: "a path: $.<field> or $<need>.output.<field>",
    }),
    z.object({ const: z.unknown() }).strict(),
    z.object({ join: z.array(ComposeValueSchema).min(1).max(16) }).strict(),
    z.array(ComposeValueSchema).max(16),
  ])
) as z.ZodType<ComposeValue>;

export const ComposeStepSchema = z
  .object({
    need: slug,
    op: z.enum(INTENT_OPS),
    input: z.record(z.string(), ComposeValueSchema).default({}),
  })
  .strict();
export type ComposeStep = z.output<typeof ComposeStepSchema>;

/**
 * How a composite serves ONE intent from its own needs: per op, the steps in
 * order. `revoke: "reverse"` revokes every need `create` used, in reverse
 * order; `status: "all"` is live only when every need is. `output` maps the
 * provided intent's output fields.
 */
export const ComposeEntrySchema = z
  .object({
    create: z.array(ComposeStepSchema).min(1).max(16),
    status: z
      .union([z.literal("all"), z.array(ComposeStepSchema).min(1).max(16)])
      .optional(),
    renew: z.array(ComposeStepSchema).min(1).max(16).optional(),
    revoke: z
      .union([z.literal("reverse"), z.array(ComposeStepSchema).min(1).max(16)])
      .optional(),
    output: z.record(z.string(), ComposeValueSchema),
  })
  .strict();
export type ComposeEntry = z.output<typeof ComposeEntrySchema>;

// ── host services ────────────────────────────────────────────────────────────

/** An image pinned by digest — never a bare tag. */
export const IMAGE_BY_DIGEST_RE =
  /^[a-z0-9]+([._/-][a-z0-9]+)*(:[A-Za-z0-9._-]{1,128})?@sha256:[a-f0-9]{64}$/;
const SERVICE_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
const port = z.number().int().min(1).max(65535);

/**
 * One container the capability runs on a computer. A strict subset of Docker
 * Compose: an image by digest, ports bound to 127.0.0.1 only, a health check,
 * hard limits, named volumes only. `.strict()` is the guard: `privileged`,
 * `network_mode: host`, a host path or a capability add are not keys this
 * schema knows, so they are refused, never ignored.
 */
export const HostServiceSchema = z
  .object({
    id: z.string().regex(SERVICE_ID_RE, {
      message: "a service id: lowercase letters, digits, - and _",
    }),
    image: z.string().regex(IMAGE_BY_DIGEST_RE, {
      message: "an image pinned by digest: <name>[:tag]@sha256:<64 hex>",
    }),
    ports: z
      .array(
        z
          .object({
            container: port,
            host: port,
            /** Always the loopback: Docker-published ports bypass the firewall. */
            bind: z.literal("127.0.0.1").default("127.0.0.1"),
            protocol: z.enum(["tcp", "udp"]).default("tcp"),
          })
          .strict()
      )
      .max(16)
      .default([]),
    health: z
      .object({
        http: z.string().regex(/^\/[^\s]{0,511}$/, {
          message: "an HTTP path starting with /",
        }),
        port,
      })
      .strict()
      .optional(),
    env: z
      .record(
        z.string().regex(ENV_NAME_RE, {
          message: "an environment name like NO_TELEMETRY",
        }),
        z.string().max(4096)
      )
      .optional(),
    limits: z
      .object({
        cpus: z.number().positive().max(64),
        memoryMb: z.number().int().min(64).max(262144),
        diskMb: z.number().int().min(64).max(2097152),
      })
      .strict(),
    volumes: z
      .array(
        z
          .object({
            /** A named volume inside the installation's folder, never a host path. */
            name: z.string().regex(SERVICE_ID_RE),
            path: z.string().regex(/^\/[^\s]{0,511}$/),
          })
          .strict()
      )
      .max(8)
      .default([]),
    /** Outside hosts the service may reach. Default none. */
    egress: z.array(z.string().min(1).max(253)).max(32).default([]),
  })
  .strict();
export type HostService = z.output<typeof HostServiceSchema>;

// ── the manifest ─────────────────────────────────────────────────────────────

const ManifestSkillSchema = z
  .object({
    name: z.string().min(1),
    intent: z.string().nullable().optional(),
    intentOp: z.string().optional(),
  })
  .passthrough();

/**
 * The manifest fields of a capability definition. Every field is optional: a
 * definition that declares none has nothing to check and nothing to persist.
 */
export const CapabilityManifestSchema = z
  .object({
    needs: z.array(ManifestNeedSchema).max(32).optional(),
    offers: z.record(slug, ManifestOfferSchema).optional(),
    compose: z.record(slug, ComposeEntrySchema).optional(),
    services: z.array(HostServiceSchema).max(16).optional(),
    skills: z.array(ManifestSkillSchema).optional(),
  })
  .passthrough();

/** The persisted shape (`capabilities.metadata.{needs,offers,compose,services}`). */
export interface CapabilityManifest {
  needs?: ManifestNeed[];
  offers?: Record<string, ManifestOffer>;
  compose?: Record<string, ComposeEntry>;
  services?: HostService[];
}

/** What the checker needs to know about the intents. */
export interface ManifestContext {
  /** A slug the pod knows. Default: the published vocabulary. */
  isKnownIntent?: (slug: string) => boolean;
  /**
   * The intent's contract: a contract, `null` (a known intent with none), or
   * `undefined` (not looked up). Contract checks run only on a contract.
   */
  contractFor?: (slug: string) => IntentContract | null | undefined;
}

const where = (path: readonly PropertyKey[]): string =>
  path.length > 0 ? `${path.map(String).join(".")}: ` : "";

/** The `$<need>` a path reads, or null for `$.<field>`. */
function pathNeed(path: string): string | null {
  const m = /^\$([a-z][a-z0-9_]*)\./.exec(path);
  return m ? m[1]! : null;
}

function pathsIn(value: ComposeValue, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => pathsIn(v, out));
  else if ("join" in value) value.join.forEach((v) => pathsIn(v, out));
  return out;
}

/**
 * Parse a definition's manifest fields. Returns the normalised manifest (only
 * the fields it declares) or every problem, one sentence each.
 */
export function parseCapabilityManifest(
  definition: unknown,
  context: ManifestContext = {}
):
  | { ok: true; manifest: CapabilityManifest }
  | { ok: false; problems: string[] } {
  const parsed = CapabilityManifestSchema.safeParse(definition);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((i) => `${where(i.path)}${i.message}`),
    };
  }
  const d = parsed.data;
  const known = context.isKnownIntent ?? isVocabularyIntent;
  const contractFor = context.contractFor ?? (() => undefined);
  const problems: string[] = [];

  const intentKnown = (intent: string, at: string): boolean => {
    if (known(intent)) return true;
    problems.push(`${at}: "${intent}" is not a known intent.`);
    return false;
  };
  const contractOf = (intent: string): IntentContract | null | undefined =>
    known(intent) ? contractFor(intent) : undefined;

  // needs
  const needIntent = new Map<string, string>();
  const serviceIds = new Set((d.services ?? []).map((s) => s.id));
  for (const [i, need] of (d.needs ?? []).entries()) {
    const at = `needs.${i}`;
    if (needIntent.has(need.key)) {
      problems.push(`${at}: the need key "${need.key}" is declared twice.`);
    }
    needIntent.set(need.key, need.intent);
    if (!intentKnown(need.intent, at)) continue;
    if (need.for !== undefined && !serviceIds.has(need.for)) {
      problems.push(
        `${at}: it is for the service "${need.for}", which the manifest does not declare.`
      );
    }
    const contract = contractOf(need.intent);
    if (contract && need.constraints) {
      const allowed = new Set(contract.constraints);
      for (const key of Object.keys(need.constraints)) {
        if (!allowed.has(key)) {
          problems.push(
            `${at}: "${key}" is not a constraint of ${need.intent} (it has ${contract.constraints.join(", ")}).`
          );
        }
      }
    }
  }

  // offers
  for (const [intent, offer] of Object.entries(d.offers ?? {})) {
    const at = `offers.${intent}`;
    if (!intentKnown(intent, at)) continue;
    if (false as boolean) {
      problems.push(
        `${at}: it says public: true, but "public" is not among the access modes it enforces (auth).`
      );
    }
    const contract = contractOf(intent);
    if (contract) {
      const allowed = new Set(contract.constraints);
      for (const key of Object.keys(offer)) {
        if (!allowed.has(key) && !GENERIC_OFFER_KEYS.has(key)) {
          problems.push(
            `${at}: "${key}" is not a constraint of ${intent} (it has ${contract.constraints.join(", ")}).`
          );
        }
      }
    }
  }

  // compose
  for (const [intent, entry] of Object.entries(d.compose ?? {})) {
    const at = `compose.${intent}`;
    if (!intentKnown(intent, at)) continue;
    const contract = contractOf(intent);
    if (contract === null) {
      problems.push(
        `${at}: ${intent} has no contract, so it has no ops to compose.`
      );
      continue;
    }
    for (const op of ["create", "status", "renew", "revoke"] as const) {
      const steps = entry[op];
      if (steps === undefined) continue;
      if (contract && !contract.ops[op]) {
        problems.push(
          `${at}.${op}: ${intent}'s contract declares no ${op} op.`
        );
      }
      if (!Array.isArray(steps)) continue;
      const done = new Set<string>();
      for (const [n, step] of steps.entries()) {
        const sat = `${at}.${op}.${n}`;
        const stepIntent = needIntent.get(step.need);
        if (stepIntent === undefined) {
          problems.push(
            `${sat}: it uses the need "${step.need}", which the manifest does not declare.`
          );
        } else {
          const needContract = contractOf(stepIntent);
          if (needContract === null) {
            problems.push(
              `${sat}: the need "${step.need}" is ${stepIntent}, which has no contract and no ${step.op} op.`
            );
          } else if (needContract && !needContract.ops[step.op]) {
            problems.push(
              `${sat}: ${stepIntent}'s contract declares no ${step.op} op.`
            );
          }
        }
        for (const value of Object.values(step.input)) {
          for (const path of pathsIn(value)) {
            const from = pathNeed(path);
            if (from !== null && !done.has(from)) {
              problems.push(
                `${sat}: ${path} reads the need "${from}" before a step of it ran.`
              );
            }
          }
        }
        done.add(step.need);
      }
    }
    const created = new Set(entry.create.map((s) => s.need));
    for (const value of Object.values(entry.output)) {
      for (const path of pathsIn(value)) {
        const from = pathNeed(path);
        if (from !== null && !created.has(from)) {
          problems.push(
            `${at}.output: ${path} reads the need "${from}", which create never uses.`
          );
        }
      }
    }
  }

  // services
  const seenServices = new Set<string>();
  const seenHostPorts = new Set<number>();
  for (const [i, service] of (d.services ?? []).entries()) {
    if (seenServices.has(service.id)) {
      problems.push(
        `services.${i}: the service id "${service.id}" is declared twice.`
      );
    }
    seenServices.add(service.id);
    for (const p of service.ports) {
      if (seenHostPorts.has(p.host)) {
        problems.push(`services.${i}: the host port ${p.host} is used twice.`);
      }
      seenHostPorts.add(p.host);
    }
  }

  // skills: the op a verb implements
  for (const [i, skill] of (d.skills ?? []).entries()) {
    if (skill.intentOp === undefined) continue;
    const at = `skills.${i} (${skill.name})`;
    if (!isIntentOp(skill.intentOp)) {
      problems.push(
        `${at}: "${skill.intentOp}" is not an op (they are ${INTENT_OPS.join(", ")}).`
      );
      continue;
    }
    if (typeof skill.intent !== "string") {
      problems.push(`${at}: it declares intentOp without an intent.`);
      continue;
    }
    if (!intentKnown(skill.intent, at)) continue;
    const contract = contractOf(skill.intent);
    if (contract === null) {
      problems.push(
        `${at}: ${skill.intent} has no contract, so a verb cannot implement its ${skill.intentOp} op.`
      );
    } else if (contract && !contract.ops[skill.intentOp]) {
      problems.push(
        `${at}: ${skill.intent}'s contract declares no ${skill.intentOp} op.`
      );
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  const manifest: CapabilityManifest = {};
  if (d.needs !== undefined) manifest.needs = d.needs;
  if (d.offers !== undefined) manifest.offers = d.offers;
  if (d.compose !== undefined) manifest.compose = d.compose;
  if (d.services !== undefined) manifest.services = d.services;
  return { ok: true, manifest };
}

/** Every problem with a definition's manifest fields; empty when none. */
export function capabilityManifestProblems(
  definition: unknown,
  context: ManifestContext = {}
): string[] {
  const result = parseCapabilityManifest(definition, context);
  return result.ok ? [] : result.problems;
}

/** The intents a manifest's needs, offers, compose and verbs name. */
export function manifestIntents(definition: unknown): string[] {
  if (typeof definition !== "object" || definition === null) return [];
  const d = definition as {
    needs?: Array<{ intent?: unknown }>;
    offers?: Record<string, unknown>;
    compose?: Record<string, unknown>;
    skills?: Array<{ intent?: unknown; intentOp?: unknown }>;
  };
  const out = new Set<string>();
  for (const n of Array.isArray(d.needs) ? d.needs : []) {
    if (typeof n?.intent === "string") out.add(n.intent);
  }
  for (const k of Object.keys(d.offers ?? {})) out.add(k);
  for (const k of Object.keys(d.compose ?? {})) out.add(k);
  for (const s of Array.isArray(d.skills) ? d.skills : []) {
    if (typeof s?.intent === "string" && s.intentOp !== undefined) {
      out.add(s.intent);
    }
  }
  return [...out];
}
