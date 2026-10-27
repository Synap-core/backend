/**
 * The pod's AI provider choice (founder decision 2026-10-27) — server-owned,
 * on the singleton `pod_settings.settings.aiProviderChoice` blob (the
 * `podApps` pattern: no table, one jsonb key merged in place).
 *
 * Before a pod's first AI request, a pod admin chooses:
 *   - `deepseek`: Synap's AI service, which runs on DeepSeek (servers in
 *     China). This choice IS the explicit consent of GDPR art. 49(1)(a) to
 *     that transfer: China has no adequacy decision and DeepSeek offers no
 *     standard contractual clauses.
 *   - `own_provider`: the pod's own AI provider (e.g. Mistral AI, in the EU).
 *
 * The WORDING is owned here, by version. A client shows the words `read`
 * returns and echoes their version; `choose` refuses any other version and
 * stores the words that version maps to. So the record proves what the person
 * was shown, and no client can record words of its own.
 *
 * Absent = nobody chose. The Intelligence Service reads this through the hub
 * (`GET /api/hub/ai-providers/choice`) and refuses Synap's AI service for a
 * pod without a `deepseek` choice. Existing pods have no record and meet the
 * choice at their next AI use: a consent is only ever what a person chose,
 * never backfilled.
 */

import { db, eq, and, isNotNull, drizzleSql } from "@synap/database";
import {
  aiProviders,
  podSettings,
  type AiProviderChoiceRecord,
  type AiProviderChoiceSetting,
} from "@synap/database/schema";

export type AiProviderChoiceValue = AiProviderChoiceRecord["choice"];

export interface AiProviderChoiceWording {
  version: string;
  title: string;
  body: string;
  options: Record<
    AiProviderChoiceValue,
    { label: string; description: string }
  >;
  /** True in both cases; said once, under the options. */
  footnote: string;
}

/**
 * Every wording a person may have been shown, by version. Add a version, never
 * edit one: a stored decision names the version it consented to.
 */
const WORDINGS: Record<string, AiProviderChoiceWording> = {
  "2026-10-27": {
    version: "2026-10-27",
    title: "Choose who runs your AI",
    body: "To answer you, Synap's AI sends your request and the notes it needs to an AI provider. Choose which one.",
    options: {
      deepseek: {
        label: "Use DeepSeek (servers in China)",
        description:
          "Ready now. Your requests are processed by DeepSeek on servers in China, a country the EU has not recognised as protecting personal data to its standard. By choosing this you consent to that transfer. You can change it at any time in Settings.",
      },
      own_provider: {
        label: "Use my own provider (e.g. Mistral AI, EU)",
        description:
          "Add an API key from a provider you choose, such as Mistral AI in the EU. Synap's AI then answers with your provider, and nothing is sent to DeepSeek.",
      },
    },
    footnote:
      "In both cases, search indexing (embeddings) is done by OpenRouter or OpenAI.",
  },
};

/** The wording a person is shown today. */
export const CURRENT_AI_PROVIDER_CHOICE_WORDING = WORDINGS["2026-10-27"]!;

/** The exact words of one option, as stored with a decision. */
function wordsOf(
  wording: AiProviderChoiceWording,
  choice: AiProviderChoiceValue
): string {
  const option = wording.options[choice];
  return `${wording.title}. ${wording.body} ${option.label}: ${option.description} ${wording.footnote}`;
}

export interface AiProviderChoiceState {
  /** null = nobody has chosen; Synap's AI service is refused for this pod. */
  choice: AiProviderChoiceValue | null;
  decidedAt: string | null;
  decidedBy: string | null;
  wordingVersion: string | null;
  /** The wording to show now (the current version). */
  wording: AiProviderChoiceWording;
  /** Does the pod have an enabled provider of its own, with a key? */
  ownProviderReady: boolean;
}

async function readStored(): Promise<AiProviderChoiceSetting | undefined> {
  const [pod] = await db
    .select({ settings: podSettings.settings })
    .from(podSettings)
    .orderBy(podSettings.createdAt)
    .limit(1);
  return pod?.settings?.aiProviderChoice;
}

async function hasOwnProvider(): Promise<boolean> {
  const [row] = await db
    .select({ id: aiProviders.id })
    .from(aiProviders)
    .where(
      and(eq(aiProviders.enabled, true), isNotNull(aiProviders.encryptedApiKey))
    )
    .limit(1);
  return row !== undefined;
}

export async function readAiProviderChoice(): Promise<AiProviderChoiceState> {
  const [stored, ownProviderReady] = await Promise.all([
    readStored(),
    hasOwnProvider(),
  ]);
  return {
    choice: stored?.choice ?? null,
    decidedAt: stored?.decidedAt ?? null,
    decidedBy: stored?.decidedBy ?? null,
    wordingVersion: stored?.wordingVersion ?? null,
    wording: CURRENT_AI_PROVIDER_CHOICE_WORDING,
    ownProviderReady,
  };
}

/** What the Intelligence Service needs, and nothing more (no user ids). */
export async function readAiProviderChoiceForService(): Promise<{
  choice: AiProviderChoiceValue | null;
  decidedAt: string | null;
  wordingVersion: string | null;
}> {
  const stored = await readStored();
  return {
    choice: stored?.choice ?? null,
    decidedAt: stored?.decidedAt ?? null,
    wordingVersion: stored?.wordingVersion ?? null,
  };
}

/** The version a client echoed is not the one it must show. */
export class StaleAiProviderChoiceWordingError extends Error {
  constructor(readonly sent: string) {
    super(
      `The wording you were shown (${sent}) is not the current one (${CURRENT_AI_PROVIDER_CHOICE_WORDING.version}). Reload and choose again.`
    );
    this.name = "StaleAiProviderChoiceWordingError";
  }
}

/**
 * Record a person's choice. The caller has checked that a signed-in pod admin
 * (not an agent credential) is choosing; this only validates the wording and
 * stores. A new choice keeps the previous one in `history`.
 */
export async function chooseAiProvider(input: {
  choice: AiProviderChoiceValue;
  wordingVersion: string;
  decidedBy: string;
}): Promise<AiProviderChoiceState> {
  if (input.wordingVersion !== CURRENT_AI_PROVIDER_CHOICE_WORDING.version) {
    throw new StaleAiProviderChoiceWordingError(input.wordingVersion);
  }
  const previous = await readStored();
  const record: AiProviderChoiceRecord = {
    choice: input.choice,
    decidedAt: new Date().toISOString(),
    decidedBy: input.decidedBy,
    wordingVersion: CURRENT_AI_PROVIDER_CHOICE_WORDING.version,
    wording: wordsOf(CURRENT_AI_PROVIDER_CHOICE_WORDING, input.choice),
  };
  const aiProviderChoice: AiProviderChoiceSetting = {
    ...record,
    history: previous
      ? [
          {
            choice: previous.choice,
            decidedAt: previous.decidedAt,
            decidedBy: previous.decidedBy,
            wordingVersion: previous.wordingVersion,
            wording: previous.wording,
          },
          ...(previous.history ?? []),
        ]
      : [],
  };
  const [existing] = await db
    .select({ id: podSettings.id })
    .from(podSettings)
    .orderBy(podSettings.createdAt)
    .limit(1);
  if (existing) {
    await db
      .update(podSettings)
      .set({
        settings: drizzleSql`coalesce(${podSettings.settings}, '{}'::jsonb) || ${JSON.stringify(
          { aiProviderChoice }
        )}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(podSettings.id, existing.id));
  } else {
    await db.insert(podSettings).values({ settings: { aiProviderChoice } });
  }
  return readAiProviderChoice();
}
