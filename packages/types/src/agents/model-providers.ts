/**
 * The MODEL a run used and the PROVIDER that served it (decision 5e7c77dc,
 * research document 646fbb16): facts a client REPORTS on every call, never
 * part of an agent's identity (owner × computer × harness). A harness on one
 * computer is one agent whether it talks to Anthropic, Bedrock or Z.ai.
 *
 * The client says them on any key-auth call: `X-Synap-Model` (the model id as
 * the harness names it, `claude-opus-5-5`) and `X-Synap-Model-Provider` (a
 * slug of {@link MODEL_PROVIDERS}). The pod stamps them on the request's events
 * and on the calling runner (`session_runners`). CLAIMED by the client, not
 * attested: a client that sends nothing is UNKNOWN (null), never "anthropic".
 *
 * A client classifies its provider ITSELF (Claude Code: from the host of
 * `ANTHROPIC_BASE_URL`, or a `CLAUDE_CODE_USE_*` flag) and sends only the
 * slug, never the URL: a gateway URL can hold a token or an internal host.
 */

export interface ModelProvider {
  /** The wire value and the stored one. */
  slug: string;
  /** How a person calls it. */
  label: string;
}

export const MODEL_PROVIDERS = [
  { slug: "anthropic", label: "Anthropic" },
  { slug: "bedrock", label: "Amazon Bedrock" },
  { slug: "vertex", label: "Google Vertex AI" },
  { slug: "foundry", label: "Microsoft Foundry" },
  { slug: "openai", label: "OpenAI" },
  { slug: "openrouter", label: "OpenRouter" },
  { slug: "zai", label: "Z.ai" },
  { slug: "deepseek", label: "DeepSeek" },
  /** A provider the client named that is not on this list. */
  { slug: "other", label: "Other provider" },
] as const satisfies readonly ModelProvider[];

export type ModelProviderSlug = (typeof MODEL_PROVIDERS)[number]["slug"];

/** The provider for a slug, or null when it names none. */
export function resolveModelProvider(
  slug: string | null | undefined
): ModelProvider | null {
  return MODEL_PROVIDERS.find((p) => p.slug === slug) ?? null;
}

/**
 * A client-reported provider: its slug when listed (case and spaces folded),
 * `other` for any other word (a URL included: it is never kept), undefined
 * when the client named none.
 */
export function parseModelProvider(
  raw: string | null | undefined
): ModelProviderSlug | undefined {
  const v = raw?.trim().toLowerCase();
  if (!v) return undefined;
  return resolveModelProvider(v)?.slug ?? "other";
}

/** The longest model id kept. */
export const MODEL_ID_MAX_LENGTH = 128;

/**
 * Model ids as harnesses name them: `claude-opus-5-5`, `claude-opus-4-6[1m]`,
 * `anthropic/claude-sonnet-4`, `us.anthropic.claude-sonnet-4-5-v1:0`,
 * `glm-4.6`, `deepseek-chat@2025`. No spaces, no query strings.
 */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]*$/;

/**
 * A client-reported model id, or undefined when it is unusable: empty, longer
 * than {@link MODEL_ID_MAX_LENGTH}, outside the id alphabet, or a URL. Refused
 * whole, never clipped: a clipped id names another model.
 */
export function parseReportedModel(
  raw: string | null | undefined
): string | undefined {
  const v = raw?.trim();
  if (!v || v.length > MODEL_ID_MAX_LENGTH) return undefined;
  if (v.includes("://") || !MODEL_ID_RE.test(v)) return undefined;
  return v;
}
