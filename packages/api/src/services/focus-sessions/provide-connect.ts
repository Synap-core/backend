/**
 * CONNECT-AND-ANSWER — a `provide` ask for a connection answers ITSELF when
 * the connection it asked for appears.
 *
 * `connectors.session` with `answerFor` records an INTENT on the session
 * (`metadata.provideConnect[<label>]`: the provider, the ask's fingerprint,
 * when it started) after checking the caller owns the owed slot and that the
 * provider is the asked service. Server-owned: no other door writes the key.
 * When the connection registry mirrors a NEW connection row for that person
 * and provider (`syncNangoConnectionsToRegistry`, which every reconcile path
 * reaches: the client's post-OAuth refetch, the Hub connect door, the
 * broker's webhook poke), the pending intent is CLAIMED atomically and the
 * slot answered through the ONE answer door (`answerSessionSlot`) with that
 * row. So OAuth finished in a phone's system browser, with the app long gone,
 * still answers the ask; and a re-asked slot is never answered with a stale
 * intent (the fingerprint guard refuses it `ask_changed`).
 *
 * An intent lives {@link PROVIDE_CONNECT_INTENT_MINUTES} minutes; an expired
 * one is dropped unanswered.
 */

import { db, and, eq, drizzleSql, focusSessions } from "@synap/database";
import { createLogger } from "@synap-core/core";
import { normalizeServiceId } from "@synap-core/types/service-marks";
import type { NangoIntegration } from "../../connectors/NangoConnector.js";
import { normalizeExpectedLabel } from "./expected-label.js";

const logger = createLogger({ module: "provide-connect" });

export const PROVIDE_CONNECT_INTENT_MINUTES = 30;

/** The server-owned key under `focus_sessions.metadata`. */
export const PROVIDE_CONNECT_META_KEY = "provideConnect";

export interface ProvideConnectIntent {
  /** The slot's label, as the answer door is called with it. */
  label: string;
  /** The broker integration key the session was started for. */
  provider: string;
  askFingerprint: string;
  startedAt: string;
}

// ── Which integration is the asked service (S2) ─────────────────────────────

/**
 * Two service ids name the same service: equal once trimmed and lowercased,
 * or the same registry service (`normalizeServiceId` folds aliases, so an
 * ask's `gmail` meets Nango's `google-mail`).
 */
export function sameService(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const x = (a ?? "").trim().toLowerCase();
  const y = (b ?? "").trim().toLowerCase();
  if (!x || !y) return false;
  if (x === y) return true;
  const nx = normalizeServiceId(x);
  return nx !== null && nx === normalizeServiceId(y);
}

/**
 * The declared integration that IS the asked service. The ask carries a
 * service id the agent chose; the broker keys integrations by a `uniqueKey`
 * the operator chose (often the provider name, sometimes not). A key match
 * wins over a provider match; nothing matching is `null`, never a guess.
 */
export function matchIntegration(
  service: string,
  integrations: readonly NangoIntegration[]
): NangoIntegration | null {
  return (
    integrations.find((i) => sameService(i.uniqueKey, service)) ??
    integrations.find((i) => sameService(i.provider, service)) ??
    null
  );
}

export type ProvideProviderResolution =
  | { status: "ok"; providerId: string }
  | { status: "no_broker" | "not_offered" | "unreadable" };

/** The integration key a new connection for `service` starts with, here. */
export async function resolveProvideProvider(
  service: string
): Promise<ProvideProviderResolution> {
  const { resolveBroker } = await import("../../connectors/index.js");
  const resolved = await resolveBroker("nango");
  if (!resolved.ok) {
    return {
      status: resolved.reason === "not-configured" ? "no_broker" : "unreadable",
    };
  }
  const declared = await resolved.broker.listIntegrationsResult();
  if (!declared.ok) return { status: "unreadable" };
  const match = matchIntegration(service, declared.integrations);
  return match
    ? { status: "ok", providerId: match.uniqueKey }
    : { status: "not_offered" };
}

// ── The intent ──────────────────────────────────────────────────────────────

/** Record (or replace) the slot's pending connect. One per slot. */
export async function recordProvideConnectIntent(p: {
  sessionId: string;
  userId: string;
  label: string;
  provider: string;
  askFingerprint: string;
}): Promise<ProvideConnectIntent> {
  const intent: ProvideConnectIntent = {
    label: p.label,
    provider: p.provider,
    askFingerprint: p.askFingerprint,
    startedAt: new Date().toISOString(),
  };
  const key = normalizeExpectedLabel(p.label) ?? p.label;
  await db
    .update(focusSessions)
    .set({
      metadata: drizzleSql`jsonb_set(
        COALESCE(${focusSessions.metadata}, '{}'::jsonb),
        ARRAY[${PROVIDE_CONNECT_META_KEY}]::text[],
        COALESCE(${focusSessions.metadata} -> ${PROVIDE_CONNECT_META_KEY}, '{}'::jsonb)
          || jsonb_build_object(${key}::text, ${JSON.stringify(intent)}::jsonb)
      )`,
    })
    .where(
      and(eq(focusSessions.id, p.sessionId), eq(focusSessions.userId, p.userId))
    );
  return intent;
}

/** Pure: is the intent still live at `now`, and for this provider? */
export function intentMatches(
  intent: Partial<ProvideConnectIntent> | null | undefined,
  provider: string,
  now: number
): boolean {
  if (!intent || typeof intent.label !== "string") return false;
  if (typeof intent.askFingerprint !== "string") return false;
  if (intent.provider !== provider) return false;
  const started = Date.parse(intent.startedAt ?? "");
  return (
    Number.isFinite(started) &&
    now - started <= PROVIDE_CONNECT_INTENT_MINUTES * 60_000
  );
}

/**
 * A new connection row for (person, provider) appeared: answer every slot of
 * theirs waiting on that provider with it. Each intent is CLAIMED (removed
 * where it is still exactly what was read) before the answer, so two
 * reconciles never answer one slot twice. Expired intents are dropped. Never
 * throws: a failure is logged and the connection stands.
 */
export async function answerPendingProvideConnects(p: {
  userId: string;
  provider: string;
  connectionId: string;
}): Promise<number> {
  let answered = 0;
  try {
    const sessions = await db
      .select({
        id: focusSessions.id,
        intents: drizzleSql<Record<
          string,
          ProvideConnectIntent
        > | null>`${focusSessions.metadata} -> ${PROVIDE_CONNECT_META_KEY}`,
      })
      .from(focusSessions)
      .where(
        and(
          eq(focusSessions.userId, p.userId),
          drizzleSql`${focusSessions.metadata} ? ${PROVIDE_CONNECT_META_KEY}`
        )
      );
    const now = Date.now();
    for (const s of sessions) {
      for (const [key, intent] of Object.entries(s.intents ?? {})) {
        const live = intentMatches(intent, p.provider, now);
        const expired =
          !live &&
          Date.parse(intent?.startedAt ?? "") <
            now - PROVIDE_CONNECT_INTENT_MINUTES * 60_000;
        if (!live && !expired) continue;
        const claimed = await claimIntent(s.id, key, intent);
        if (!claimed || !live) continue;
        const { answerSessionSlot } = await import("./session-answer.js");
        const result = await answerSessionSlot({
          sessionId: s.id,
          userId: p.userId,
          expectedLabel: intent.label,
          value: {
            type: "provide",
            ref: { kind: "connection", connectionId: p.connectionId },
          },
          askFingerprint: intent.askFingerprint,
        });
        if (result.status === "answered") {
          answered += 1;
        } else {
          logger.info(
            { sessionId: s.id, status: result.status },
            "a pending connect was not answered — the slot moved on"
          );
        }
      }
    }
  } catch (err) {
    logger.error(
      { err, provider: p.provider },
      "answering pending connects failed — the connection stands"
    );
  }
  return answered;
}

async function claimIntent(
  sessionId: string,
  key: string,
  intent: unknown
): Promise<boolean> {
  const rows = await db
    .update(focusSessions)
    .set({
      metadata: drizzleSql`${focusSessions.metadata} #- ARRAY[${PROVIDE_CONNECT_META_KEY}, ${key}]::text[]`,
    })
    .where(
      and(
        eq(focusSessions.id, sessionId),
        drizzleSql`${focusSessions.metadata} -> ${PROVIDE_CONNECT_META_KEY} -> ${key} = ${JSON.stringify(intent)}::jsonb`
      )
    )
    .returning({ id: focusSessions.id });
  return rows.length > 0;
}
