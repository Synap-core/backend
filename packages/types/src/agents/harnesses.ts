/**
 * The HARNESS registry: every AI client a person connects, once. A harness is
 * the program that holds an agent's key (Claude Code, Cursor, Raycast…): its
 * slug is the agent's `agentType`, its label is how a person calls it, and
 * where its conversations can be reopened, its reopen template lives here,
 * and where a person can start one, its launch template.
 *
 * Three lists used to say this in three places (the API's surface allowlist,
 * the reopenable-conversation list, the device door's enum) and the Claude
 * Code slug had four spellings elsewhere. Backend code reads THIS list. Each
 * row says which doors the client supports (`doors`) and which `synap
 * connect` writer configures it (`cliTarget`); the CLI does not import the
 * list yet and keeps its own `TARGETS`. Raycast and Eve also keep copies (see
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

/**
 * How a person starts a NEW conversation with a harness, on the computer it
 * runs on (review M5): data only. The pod renders the command from it plus
 * validated parameters (`resolveAgentLaunch`), so no agent key ever writes a
 * command a person is told to run.
 */
export interface HarnessLaunch {
  /** The program a person runs. */
  program: string;
  /** The flag that picks the model, when the harness has one. */
  modelFlag?: string;
}

/**
 * How a client reaches the pod (plan "one way to connect an AI to Synap", A):
 * - `account`: the remote MCP server of the Synap account (`mcp.synap.live`),
 *   which the client signs in to itself with OAuth. Nothing holds a key.
 * - `pod`: a pod key the CLI writes into the client's config file.
 */
export const HARNESS_DOORS = ["account", "pod"] as const;
export type HarnessDoor = (typeof HARNESS_DOORS)[number];

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
  /** Present only where a person starts one with a command. */
  launch?: HarnessLaunch;
  /**
   * The doors this client supports, never empty. `account` only where the
   * client is CONFIRMED to finish OAuth against a URL-only remote server.
   */
  doors: readonly [HarnessDoor, ...HarnessDoor[]];
  /**
   * The synap-cli `TARGETS` key whose writer configures this client
   * (`synap connect <cliTarget>`), unique across rows; null where the CLI
   * writes no config for it.
   */
  cliTarget: string | null;
}

export const AGENT_HARNESSES = [
  // `doors`: `account` is set ONLY for the clients confirmed to finish OAuth
  // against a URL-only remote server (claude.ai, ChatGPT, Claude Code,
  // Cursor). Every other client is `["pod"]` until wave W5's test matrix
  // confirms it (plan f61a20a5, "Open questions"); add `account` to a row
  // only with that evidence. claude.ai has no row: it runs on no computer
  // and holds no key, and its pod identity is the account connector's agent.
  {
    slug: "claude-code",
    label: "Claude Code",
    surface: true,
    reopen: {
      idPattern:
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      command: (id) => `claude --resume ${id}`,
    },
    launch: { program: "claude", modelFlag: "--model" },
    doors: ["account", "pod"],
    cliTarget: "claude-code",
  },
  {
    slug: "claude-desktop",
    label: "Claude Desktop",
    surface: true,
    doors: ["pod"],
    cliTarget: "claude-desktop",
  },
  {
    slug: "cursor",
    label: "Cursor",
    surface: true,
    doors: ["account", "pod"],
    cliTarget: "cursor",
  },
  {
    slug: "raycast",
    label: "Raycast",
    surface: true,
    doors: ["pod"],
    cliTarget: "raycast",
  },
  {
    slug: "codex",
    label: "Codex",
    surface: true,
    launch: { program: "codex", modelFlag: "--model" },
    doors: ["pod"],
    cliTarget: "codex",
  },
  {
    slug: "openwebui",
    label: "Open WebUI",
    surface: true,
    doors: ["pod"],
    cliTarget: "openwebui",
  },
  // Discord and Proton hold a pod key, but no `synap connect` writer.
  {
    slug: "discord",
    label: "Discord",
    surface: true,
    doors: ["pod"],
    cliTarget: null,
  },
  {
    slug: "proton",
    label: "Proton",
    surface: true,
    doors: ["pod"],
    cliTarget: null,
  },
  {
    slug: "generic",
    label: "Generic",
    surface: true,
    doors: ["pod"],
    cliTarget: "generic",
  },
  // The other clients `synap connect` mints a key for under their own name
  // (synap-cli TARGETS, 4 Nov 2026). Without a row here the setup door
  // refused them to an agent key (SURFACE_AGENT_TYPE_REQUIRED). ChatGPT is
  // minted as `chatgpt`, never `generic`.
  {
    slug: "chatgpt",
    label: "ChatGPT",
    surface: true,
    doors: ["account", "pod"],
    cliTarget: "chatgpt",
  },
  {
    slug: "opencode",
    label: "OpenCode",
    surface: true,
    doors: ["pod"],
    cliTarget: "opencode",
  },
  {
    slug: "windsurf",
    label: "Windsurf",
    surface: true,
    doors: ["pod"],
    cliTarget: "windsurf",
  },
  {
    slug: "goose",
    label: "Goose",
    surface: true,
    doors: ["pod"],
    cliTarget: "goose",
  },
  {
    slug: "zed",
    label: "Zed",
    surface: true,
    doors: ["pod"],
    cliTarget: "zed",
  },
  {
    slug: "vscode",
    label: "VS Code",
    surface: true,
    doors: ["pod"],
    cliTarget: "vscode",
  },
  {
    slug: "grok",
    label: "Grok",
    surface: true,
    doors: ["pod"],
    cliTarget: "grok",
  },
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

/** Slugs a person can start with a command. */
export const LAUNCHABLE_HARNESS_SLUGS = AGENT_HARNESSES.filter(
  (h) => "launch" in h
).map((h) => h.slug) as AgentHarnessSlug[];
