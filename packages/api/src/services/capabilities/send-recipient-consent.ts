/**
 * DO NOT CONTACT AT THE CAPABILITY DOOR (founder, 2026-11-09; finding
 * 44a7cfb5). A verb whose intent reaches a person (`PERSON_CONTACT_INTENTS`:
 * `gmail_send`, `linkedin_send_invite`) runs through the capability runner and
 * a provider action or a skill sandbox, never through the messaging send door
 * (`sendExternalMessage`). Its recipient is named in its PARAMETERS (an email,
 * a LinkedIn profile, a provider member id, a chat), not by a channel. This
 * module finds the person those parameters name and reads the ONE flag
 * (`services/channels/do-not-contact.ts`, `readPersonDoNotContact`).
 *
 * WHICH PARAMETERS NAME THE RECIPIENT: the verb's own declaration, never a
 * guess over parameter names or values. A verb's `inputMap` maps a parameter
 * to a recipient address (`"to": "$to.email"`, `"providerId":
 * "$to.linkedin.publicIdentifier"`, `intent-input.ts`); that mapping holds
 * whoever calls the verb (a pod app through its intent action, an agent with
 * free parameters, an automation), so the same parameter is read every time.
 * A run asked through an intent action also names the person by id
 * (`intentRequest.recipient`).
 *
 * HOW AN ADDRESS BECOMES A PERSON: the identity door (`resolveIdentity`, the
 * strong atoms `email`, `phone`, `linkedin_url`, `external_id`
 * `<provider>:<id>`), and for a chat the conversation's channel, read by the
 * messaging door's own derivation (`readRecipientDoNotContact`).
 *
 * UNRESOLVABLE RECIPIENT (no declared address, or an address that names no
 * person the pod knows): the run goes on, exactly as the messaging door goes
 * on for a conversation bound to nobody. This refuses a flagged person; it
 * does not widen the door to refuse an unknown one.
 *
 * NAMING. The refusal names the person and their reason only when the caller
 * may read that person (`readableRecipient`, the key's grant floor): an app
 * that typed an email must not learn whose it is from a refusal.
 *
 * A failed READ throws: the run fails without reaching the provider, never
 * "not flagged".
 */

import {
  db,
  and,
  eq,
  or,
  channels,
  ChannelType,
  resolveIdentity,
  isLinkedinUrl,
  providerExternalId,
  PROVIDER_ID_PROPERTY_KEYS,
  type IdentitySignal,
} from "@synap/database";
import type { FailureErrorClass } from "@synap-core/types/failures";
import {
  doNotContactRefusal,
  isPersonContactIntent,
  readPersonDoNotContact,
  readRecipientDoNotContact,
  type DoNotContactFlag,
} from "../channels/do-not-contact.js";
import { readInputMap, type RecipientAddress } from "./intent-input.js";
import { readableRecipient } from "./intent-recipient.js";

/** The verb facts this check reads (a loader must select both columns). */
export interface ContactVerb {
  intent: string | null;
  inputMap: unknown;
}

/** One recipient address a send verb's parameters carry. */
export interface RecipientAddressValue {
  address: RecipientAddress;
  value: string;
}

const textOf = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

/** Every string a parameter value carries (one, or a list of them). */
function stringsOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(stringsOf);
  const t = textOf(v);
  return t ? [t] : [];
}

/**
 * The recipient addresses a verb's parameters carry, read from the verb's
 * DECLARED mapping (`inputMap.params`: a parameter ← `$to.<address>`). Empty
 * when the verb does not reach a person, or declares no recipient address.
 * Pure: the guard drives it over every shipped send verb.
 */
export function capabilityRecipientAddresses(
  verb: ContactVerb,
  parameters: Record<string, unknown> | undefined
): RecipientAddressValue[] {
  if (!isPersonContactIntent(verb.intent)) return [];
  const map = readInputMap(verb.inputMap);
  if (!map || !parameters) return [];
  const out: RecipientAddressValue[] = [];
  for (const [param, source] of Object.entries(map.params)) {
    if (typeof source !== "string" || !source.startsWith("$to.")) continue;
    const address = source.slice("$to.".length) as RecipientAddress;
    for (const value of stringsOf(parameters[param])) {
      out.push({ address, value });
    }
  }
  return out;
}

/** Each address in a free `to` line ("Paul <p@x.com>, q@y.com"). */
const EMAIL_IN_TEXT = /[^\s<>,;"'()]+@[^\s<>,;"'()]+\.[^\s<>,;"'()]+/g;

/** The providers whose member ids the pod stores on a person. */
const MEMBER_ID_PROVIDERS = [
  ...new Set(Object.values(PROVIDER_ID_PROPERTY_KEYS)),
];

/** The identity atoms one address names (`chat` is read from its channel). */
export function recipientSignals(a: RecipientAddressValue): IdentitySignal[] {
  switch (a.address) {
    case "email":
      return (a.value.match(EMAIL_IN_TEXT) ?? []).map((value) => ({
        type: "email",
        value,
      }));
    case "phone":
      return [{ type: "phone", value: a.value }];
    case "linkedin.providerId":
      return [
        { type: "external_id", value: providerExternalId("linkedin", a.value) },
      ];
    case "linkedin.publicIdentifier":
      // A profile URL, its slug, or (Unipile accepts either) a member id.
      return isLinkedinUrl(a.value)
        ? [{ type: "linkedin_url", value: a.value }]
        : [
            {
              type: "linkedin_url",
              value: `https://www.linkedin.com/in/${a.value}`,
            },
            {
              type: "external_id",
              value: providerExternalId("linkedin", a.value),
            },
          ];
    case "attendee":
      return MEMBER_ID_PROVIDERS.map((p) => ({
        type: "external_id",
        value: providerExternalId(p, a.value),
      }));
    case "chat":
      return [];
  }
}

/**
 * The first flagged person a send verb's run would reach, or null (not a
 * send, no recipient the pod can name, or nobody flagged).
 */
export async function readCapabilityRecipientDoNotContact(
  verb: ContactVerb,
  parameters: Record<string, unknown> | undefined,
  ctx: { userId: string; recipientId?: string | null }
): Promise<DoNotContactFlag | null> {
  if (!isPersonContactIntent(verb.intent)) return null;

  if (ctx.recipientId) {
    const flag = await readPersonDoNotContact(ctx.recipientId);
    if (flag) return flag;
  }

  for (const a of capabilityRecipientAddresses(verb, parameters)) {
    if (a.address === "chat") {
      const channel = await db.query.channels.findFirst({
        where: and(
          eq(channels.channelType, ChannelType.EXTERNAL),
          eq(channels.userId, ctx.userId),
          or(
            eq(channels.externalChannelId as never, a.value),
            eq(channels.externalId as never, a.value)
          )
        ),
        columns: { contextObjectType: true, contextObjectId: true },
      });
      const flag = await readRecipientDoNotContact(channel);
      if (flag) return flag;
      continue;
    }
    for (const signal of recipientSignals(a)) {
      const resolved = await resolveIdentity(db, {
        userId: ctx.userId,
        kindSlug: "person",
        signals: [signal],
      });
      if (resolved.match !== "strong" || !resolved.entity) continue;
      const flag = await readPersonDoNotContact(resolved.entity.id);
      if (flag) return flag;
    }
  }
  return null;
}

/** The capability door's refusal: a definite not-delivered, nothing sent. */
export interface DoNotContactCapabilityRefusal {
  kind: "error";
  message: string;
  errorClass: FailureErrorClass;
}

/**
 * Refuse a send verb's run when a person it reaches is marked do not contact;
 * null lets the run go on. Called by the capability door BEFORE the gate (so
 * nothing is filed) and by the one post-gate runner (so an approved run whose
 * person was flagged after it was filed sends nothing).
 */
export async function refuseFlaggedCapabilityRecipient(
  verb: ContactVerb,
  parameters: Record<string, unknown> | undefined,
  ctx: {
    userId: string;
    agentUserId?: string | null;
    recipientId?: string | null;
  }
): Promise<DoNotContactCapabilityRefusal | null> {
  const flag = await readCapabilityRecipientDoNotContact(verb, parameters, ctx);
  if (!flag) return null;
  const readable = await readableRecipient(
    { userId: ctx.userId, agentUserId: ctx.agentUserId ?? null },
    flag.personId
  );
  return {
    kind: "error",
    message: doNotContactRefusal(
      readable ? flag : { ...flag, name: null, reason: null }
    ),
    errorClass: "do_not_contact",
  };
}
