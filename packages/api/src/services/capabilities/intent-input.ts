/**
 * ONE INPUT PER INTENT (intent actions, decision 5B, founder 2026-10-28).
 *
 * A pod app asks the person's tools to do ONE intent ("publish a post") and
 * sends ONE input shape, whatever tool answers: the intent's
 * `capability_intents.input_schema` (`publish_post` = `{ text, media?, link?,
 * when? }`). Each verb serving the intent says how its own parameters are read
 * from that input — `skills.input_map`, written only by the definition applier
 * from an official template's skill `inputMap`:
 *
 *   { "params": { "content": "$.text", "date": "$.when",
 *                 "integrationId": "$account.id",
 *                 "provider": "$account.provider",
 *                 "type": { "const": "schedule" } },
 *     "accounts": { "verb": "postiz_list_integrations",
 *                   "id": "id", "label": "name", "provider": "provider" } }
 *
 * The mapping language is path copy and constants, nothing else. A string is
 * a path: `$.<field>` into the app's input (`$.a.b` nested), or
 * `$account.<id|label|provider>` into the account the action targets.
 * `{ const }` is a literal. No expressions, no conditionals, no defaults — a
 * verb that needs more declares no map and is not offered to apps.
 *
 * RECIPIENT. `$to.<address>` reads an address of the person or company the
 * app names in its input `to` (an entity id), for the account the action
 * targets: `email`, `phone`, `linkedin.providerId`,
 * `linkedin.publicIdentifier`, `chat` (a conversation the pod already holds
 * with them on that account) or `attendee` (their id on that account's
 * provider). The POD resolves it (`intent-recipient.ts`), never the app: a
 * provider id never leaves the pod, and the person's review names the
 * recipient. A map that reads `$to` makes `to` part of the action's input.
 *
 * ACCOUNTS. When a tool reaches several accounts through ONE pod connection
 * (a Postiz key → several social channels), the map names an account source:
 * a READ verb of the same tool that lists them, and which field of each
 * listed record is its id, its label and its provider. The actions door lists
 * one action per account; the run door lists them again and refuses one that
 * is gone. With no account source, `$account` cannot be read.
 *
 * The run door validates the input against the action (the intent's schema
 * narrowed to what the map reads), maps it, then validates the mapped
 * parameters against the VERB exactly as any other run (`executeCapability`).
 * Pure: the intent's schema is read by `loadIntentInput`
 * (`intent-registry.ts`), the map off the skill row.
 */
import { z } from "zod";
import { humanizeToken } from "@synap-core/types/vocabulary";
import type {
  SkillInputMap,
  SkillInputMapAccounts,
  SkillInputMapValue,
} from "@synap/database/schema";

/** `$.field`, `$.field.sub` (the app's input), `$account.field` or `$to.address`. */
const PATH_RE = /^\$(account|to)?(\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The fields of an account a map may read (`$account.<field>`). */
export const ACCOUNT_FIELDS = ["id", "label", "provider"] as const;
export type AccountField = (typeof ACCOUNT_FIELDS)[number];

/** One account an action targets, read off the account source's records. */
export interface IntentAccount {
  id: string;
  label: string;
  provider: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isConst = (v: unknown): v is { const: unknown } =>
  isRecord(v) && Object.keys(v).length === 1 && "const" in v;

const isAccountPath = (source: string) => source.startsWith("$account.");

/** The addresses of a recipient a map may read (`$to.<address>`). */
export const RECIPIENT_ADDRESSES = [
  "email",
  "phone",
  "linkedin.providerId",
  "linkedin.publicIdentifier",
  "chat",
  "attendee",
] as const;
export type RecipientAddress = (typeof RECIPIENT_ADDRESSES)[number];

/** The input field naming the recipient, which `$to` reads from. */
export const RECIPIENT_INPUT_FIELD = "to";

const isRecipientPath = (source: string) => source.startsWith("$to.");

/** The address a `$to.<address>` path reads (`$to.linkedin.providerId` → `linkedin.providerId`). */
const recipientAddressOf = (source: string) => source.slice("$to.".length);

/** The app input field a path reads, or null for an account path. */
function inputFieldOf(source: string): string | null {
  if (isAccountPath(source)) return null;
  if (isRecipientPath(source)) return RECIPIENT_INPUT_FIELD;
  return source.split(".")[1]!;
}

/** The account source's own problems (its shape only). */
function accountsShapeProblems(raw: unknown): string[] {
  if (!isRecord(raw))
    return ['inputMap.accounts must be { "verb", "id", "label", "provider"? }'];
  const problems: string[] = [];
  for (const k of Object.keys(raw))
    if (!["verb", "id", "label", "provider"].includes(k))
      problems.push(
        `inputMap.accounts.${k} is not part of the mapping language`
      );
  for (const k of ["verb", "id", "label"] as const)
    if (typeof raw[k] !== "string" || !NAME_RE.test(raw[k] as string))
      problems.push(`inputMap.accounts.${k} must name a field or a verb`);
  if (
    raw.provider !== undefined &&
    (typeof raw.provider !== "string" || !NAME_RE.test(raw.provider))
  )
    problems.push("inputMap.accounts.provider must name a field");
  return problems;
}

/** What the installer knows about the verb an account source names. */
export interface AccountVerbFacts {
  /** Declared `metadata.readOnly: true`. */
  readOnly: boolean;
  /** It uses the same tool as the mapped verb. */
  sameTool: boolean;
  /** The fields each listed record carries, when the verb declares them. */
  fields?: readonly string[] | null;
}

/**
 * Every problem with a declared map, or `[]`. Checked on install (the
 * applier refuses the definition) and on read (`readInputMap`).
 * `inputFields` (the intent's input properties), `verbParams` (the verb's
 * declared parameter names) and `accountVerb` (the account source's verb,
 * looked up in the same definition; null = no such verb) are checked when
 * given.
 */
export function inputMapProblems(
  raw: unknown,
  opts: {
    intent?: string | null;
    inputFields?: readonly string[] | null;
    verbParams?: readonly string[] | null;
    accountVerb?: AccountVerbFacts | null;
  } = {}
): string[] {
  if (!isRecord(raw) || !isRecord(raw.params))
    return ['inputMap must be { "params": { <verb parameter>: <source> } }'];
  const extra = Object.keys(raw).filter(
    (k) => k !== "params" && k !== "accounts"
  );
  const problems: string[] = extra.map(
    (k) => `inputMap.${k} is not part of the mapping language`
  );
  if (!opts.intent)
    problems.push("inputMap needs the skill to declare an intent");
  const accounts = raw.accounts;
  if (accounts !== undefined) {
    const shape = accountsShapeProblems(accounts);
    problems.push(...shape);
    if (shape.length === 0 && opts.accountVerb !== undefined)
      problems.push(
        ...accountVerbProblems(
          accounts as unknown as SkillInputMapAccounts,
          opts.accountVerb
        )
      );
  }
  const entries = Object.entries(raw.params);
  if (entries.length === 0) problems.push("inputMap.params is empty");
  for (const [param, source] of entries) {
    if (!NAME_RE.test(param))
      problems.push(`inputMap.params: "${param}" is not a parameter name`);
    else if (opts.verbParams && !opts.verbParams.includes(param))
      problems.push(
        `inputMap.params.${param}: the verb declares no parameter "${param}"`
      );
    if (isConst(source)) continue;
    if (typeof source !== "string" || !PATH_RE.test(source)) {
      problems.push(
        `inputMap.params.${param}: use "$.<input field>", "$account.<field>", "$to.<address>" or { "const": <value> }`
      );
      continue;
    }
    const segs = source.split(".");
    const field = segs[1]!;
    if (isRecipientPath(source)) {
      if (
        !(RECIPIENT_ADDRESSES as readonly string[]).includes(
          recipientAddressOf(source)
        )
      )
        problems.push(
          `inputMap.params.${param}: a recipient has only ${RECIPIENT_ADDRESSES.join(", ")}`
        );
      else if (
        opts.inputFields &&
        !opts.inputFields.includes(RECIPIENT_INPUT_FIELD)
      )
        problems.push(
          `inputMap.params.${param}: "$to" needs the intent's input to have a field "${RECIPIENT_INPUT_FIELD}"`
        );
    } else if (!isAccountPath(source)) {
      if (opts.inputFields && !opts.inputFields.includes(field))
        problems.push(
          `inputMap.params.${param}: the intent's input has no field "${field}"`
        );
    } else if (
      segs.length !== 2 ||
      !(ACCOUNT_FIELDS as readonly string[]).includes(field)
    )
      problems.push(
        `inputMap.params.${param}: an account has only ${ACCOUNT_FIELDS.join(", ")}`
      );
    else if (!isRecord(accounts))
      problems.push(
        `inputMap.params.${param}: "$account" needs inputMap.accounts`
      );
    else if (field === "provider" && accounts.provider === undefined)
      problems.push(
        `inputMap.params.${param}: inputMap.accounts names no provider`
      );
  }
  return problems;
}

function accountVerbProblems(
  a: SkillInputMapAccounts,
  v: AccountVerbFacts | null
): string[] {
  if (v === null)
    return [`inputMap.accounts.verb: no verb "${a.verb}" in this definition`];
  const problems: string[] = [];
  if (!v.readOnly)
    problems.push(
      `inputMap.accounts.verb: "${a.verb}" must be a read (metadata.readOnly)`
    );
  if (!v.sameTool)
    problems.push(`inputMap.accounts.verb: "${a.verb}" must use the same tool`);
  if (v.fields)
    for (const k of ["id", "label", "provider"] as const) {
      const f = a[k];
      if (f !== undefined && !v.fields.includes(f))
        problems.push(
          `inputMap.accounts.${k}: "${a.verb}" lists no field "${f}"`
        );
    }
  return problems;
}

/** The parts of a definition skill the install check reads. */
export interface DefinitionSkillForMap {
  name: string;
  intent?: unknown;
  inputMap?: unknown;
  parameters?: unknown;
  requires?: readonly string[];
  metadata?: Record<string, unknown>;
  providerSpec?: { responseShape?: { item?: Record<string, string> } };
}

/**
 * Every problem with one skill's `inputMap`, read against its own definition
 * (`skills`, where an account source's verb must be) and its intent's input
 * schema (null = the intent declares none, so nothing can be mapped).
 */
export function definitionInputMapProblems(
  skill: DefinitionSkillForMap,
  skills: readonly DefinitionSkillForMap[],
  intentSchema: Record<string, unknown> | null
): string[] {
  const names = (p: unknown) =>
    isRecord(p) ? Object.keys(isRecord(p.properties) ? p.properties : p) : null;
  const intent = typeof skill.intent === "string" ? skill.intent : null;
  const accounts = isRecord(skill.inputMap) ? skill.inputMap.accounts : null;
  const source = isRecord(accounts)
    ? skills.find((o) => o.name === accounts.verb && o !== skill)
    : undefined;
  const item = source?.providerSpec?.responseShape?.item;
  const problems = inputMapProblems(skill.inputMap, {
    intent,
    inputFields: names(intentSchema?.properties),
    verbParams: names(skill.parameters),
    accountVerb: source
      ? {
          readOnly: source.metadata?.readOnly === true,
          sameTool: (source.requires ?? []).some((t) =>
            (skill.requires ?? []).includes(t)
          ),
          fields: item ? Object.keys(item) : null,
        }
      : null,
  });
  if (intent && !intentSchema)
    problems.push(`the intent "${intent}" declares no input shape yet`);
  return problems;
}

/** A stored map, or null when absent or no longer valid (never guessed). */
export function readInputMap(raw: unknown): SkillInputMap | null {
  if (!isRecord(raw)) return null;
  // The applier stored a checked map; this re-check refuses a hand-edited row
  // rather than running something the language cannot say.
  return inputMapProblems(raw, { intent: "stored" }).length === 0
    ? (raw as unknown as SkillInputMap)
    : null;
}

/** The top-level input fields a map reads (`$.text` → `text`, `$to.email` → `to`). */
export function inputFieldsRead(map: SkillInputMap): string[] {
  const fields = new Set<string>();
  for (const source of Object.values(map.params)) {
    const field = typeof source === "string" ? inputFieldOf(source) : null;
    if (field) fields.add(field);
  }
  return [...fields];
}

/** The recipient addresses a map reads (`$to.email` → `email`), in map order. */
export function recipientAddressesRead(map: SkillInputMap): RecipientAddress[] {
  const addresses = new Set<RecipientAddress>();
  for (const source of Object.values(map.params))
    if (typeof source === "string" && isRecipientPath(source))
      addresses.add(recipientAddressOf(source) as RecipientAddress);
  return [...addresses];
}

function readPath(input: Record<string, unknown>, path: string): unknown {
  let value: unknown = input;
  for (const seg of path.split(".").slice(1)) {
    if (!isRecord(value)) return undefined;
    value = value[seg];
  }
  return value;
}

/** A recipient's addresses, as the pod resolved them for one action. */
export type RecipientAddresses = Partial<Record<RecipientAddress, string>>;

function sourceValue(
  source: SkillInputMapValue,
  input: Record<string, unknown>,
  account: IntentAccount | null,
  recipient: RecipientAddresses | null
): unknown {
  if (typeof source !== "string") return source.const;
  if (isAccountPath(source))
    return account?.[source.split(".")[1] as AccountField] ?? undefined;
  if (isRecipientPath(source))
    return recipient?.[recipientAddressOf(source) as RecipientAddress];
  return readPath(input, source);
}

/**
 * The verb's parameters for this input, the account the action targets
 * (null = the action has none) and the recipient's addresses the pod
 * resolved (null = none). A param whose source is absent is left out (the
 * verb's own default, or its own "missing required" refusal, applies).
 */
export function mapIntentInput(
  map: SkillInputMap,
  input: Record<string, unknown>,
  account: IntentAccount | null = null,
  recipient: RecipientAddresses | null = null
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [param, source] of Object.entries(map.params)) {
    const value = sourceValue(source, input, account, recipient);
    if (value !== undefined) params[param] = value;
  }
  return params;
}

/**
 * The accounts an account source's records describe: each record's id, label
 * and provider, read from the fields the source names. A record with no id or
 * no label is skipped: it cannot be targeted, or named to the person.
 */
export function accountsFromRecords(
  source: SkillInputMapAccounts,
  records: readonly unknown[]
): IntentAccount[] {
  const text = (v: unknown) =>
    typeof v === "string" && v.trim()
      ? v.trim()
      : typeof v === "number"
        ? String(v)
        : null;
  const out: IntentAccount[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    if (!isRecord(r)) continue;
    const id = text(r[source.id]);
    const label = text(r[source.label]);
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      label,
      provider: source.provider ? text(r[source.provider]) : null,
    });
  }
  return out;
}

type JsonSchemaObject = {
  type?: unknown;
  properties?: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown;
};

/**
 * The input ONE action accepts: the intent's schema narrowed to the fields
 * its verb's map reads, so an app is never invited to send a field the verb
 * would drop. A field becomes required when the intent requires it or when
 * it feeds a parameter the verb requires (`verbRequires`).
 */
export function actionInputSchema(
  intentSchema: Record<string, unknown>,
  map: SkillInputMap,
  verbRequires: readonly string[] = []
): Record<string, unknown> {
  const s = intentSchema as JsonSchemaObject;
  const read = new Set(inputFieldsRead(map));
  const properties = Object.fromEntries(
    Object.entries(s.properties ?? {}).filter(([k]) => read.has(k))
  );
  const fedRequired = Object.entries(map.params)
    .filter(([param]) => verbRequires.includes(param))
    .map(([, source]) =>
      typeof source === "string" ? inputFieldOf(source) : null
    )
    .filter((field): field is string => field !== null);
  const required = [
    ...new Set([
      ...(s.required ?? []).filter((k) => read.has(k)),
      ...fedRequired.filter((k) => k in properties),
    ]),
  ];
  return {
    ...s,
    properties,
    required,
    additionalProperties: false,
  };
}

export interface InputIssue {
  path: string;
  message: string;
}

/** Validate a value against a JSON Schema (zod's own reader of it). */
export function validateInput(
  schema: Record<string, unknown>,
  value: unknown
):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; issues: InputIssue[] } {
  let parsed;
  try {
    parsed = z.fromJSONSchema(schema as never).safeParse(value);
  } catch (err) {
    // A schema the reader cannot read is the pod's fault, never a pass.
    return {
      ok: false,
      issues: [
        {
          path: "",
          message: `The intent's input schema cannot be read: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
  if (parsed.success)
    return { ok: true, value: parsed.data as Record<string, unknown> };
  return {
    ok: false,
    issues: parsed.error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    })),
  };
}

/**
 * What an app's intent run does, in the words the person reviews it by: the
 * action's label, the recipient by name, the account it goes from — "Send
 * message to Marie Dupont from Antoine Servant on LinkedIn". Never an id.
 */
export function describeIntentRun(ask: {
  label: string;
  account: IntentAccount | null;
  recipient?: { name: string } | null;
}): string {
  let words = ask.label;
  if (ask.recipient) words += ` to ${ask.recipient.name}`;
  if (ask.account) words += ` from ${ask.account.label}`;
  const provider = ask.account?.provider;
  if (provider) {
    const named = humanizeToken(provider);
    if (!words.toLowerCase().includes(named.toLowerCase()))
      words += ` on ${named}`;
  }
  return words;
}
