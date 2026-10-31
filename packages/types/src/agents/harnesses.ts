/**
 * The HARNESS registry: every AI client a person connects, once. A harness is
 * the program that holds an agent's key (Claude Code, Cursor, Raycast…): its
 * slug is the agent's `agentType`, its label is how a person calls it, and
 * where its conversations can be reopened, its reopen template lives here.
 *
 * Three lists used to say this in three places (the API's surface allowlist,
 * the reopenable-conversation list, the device door's enum) and the Claude
 * Code slug had four spellings elsewhere. Backend code reads THIS list; the
 * CLI, Raycast and Eve keep copies that a later lane folds in (see
 * `harnesses.test.ts` for the pinned slugs).
 *
 * Not the IS persona keys (orchestrator, meta… — WHICH agent answers a turn)
 * and not the browser's `CompanionMode`: those are other concepts.
 */

/** How a harness's conversation becomes a command a person can run. */
export interface HarnessReopen {
  /** The conversation half of a client key is `<slug>:<id>`; `id` must match. */
  idPattern: RegExp;
  /** The shell command that reopens it, on the computer it ran on. */
  command: (conversationId: string) => string;
}

export interface AgentHarness {
  /** The agent's `agentType`. */
  slug: string;
  /** How a person calls it; the service registry names it the same. */
  label: string;
  /**
   * May an AGENT key provision it without a human-owned key (`SURFACE_AGENT_TYPES`
   * in the setup door)? A surface identity: which program holds the key.
   */
  surface: boolean;
  /** Present only where a conversation can be reopened. */
  reopen?: HarnessReopen;
}

export const AGENT_HARNESSES = [
  {
    slug: "claude-code",
    label: "Claude Code",
    surface: true,
    reopen: {
      idPattern:
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      command: (id) => `claude --resume ${id}`,
    },
  },
  { slug: "claude-desktop", label: "Claude Desktop", surface: true },
  { slug: "cursor", label: "Cursor", surface: true },
  { slug: "raycast", label: "Raycast", surface: true },
  { slug: "codex", label: "Codex", surface: true },
  { slug: "openwebui", label: "Open WebUI", surface: true },
  { slug: "discord", label: "Discord", surface: true },
  { slug: "proton", label: "Proton", surface: true },
  { slug: "generic", label: "Generic", surface: true },
] as const satisfies readonly AgentHarness[];

export type AgentHarnessSlug = (typeof AGENT_HARNESSES)[number]["slug"];

/** The harness for an `agentType`, or null when it names none. */
export function resolveHarness(
  slug: string | null | undefined
): AgentHarness | null {
  return AGENT_HARNESSES.find((h) => h.slug === slug) ?? null;
}

/** Slugs an agent key may provision (the setup door's allowlist). */
export const SURFACE_HARNESS_SLUGS = AGENT_HARNESSES.filter(
  (h) => h.surface
).map((h) => h.slug) as unknown as readonly [
  AgentHarnessSlug,
  ...AgentHarnessSlug[],
];

/** Slugs whose conversations can be reopened. */
export const REOPENABLE_HARNESS_SLUGS = AGENT_HARNESSES.filter(
  (h) => "reopen" in h
).map((h) => h.slug) as AgentHarnessSlug[];
