/**
 * Tool labels — THE door from an AI tool's machine name to the words a person
 * reads ("search_unified" → "Searching your pod").
 *
 * WHY. Four hand tables answered this independently and disagreed: chat-ui's
 * `StreamStatus` and `StreamingPartsList` (two copies of one `TOOL_VERBS`,
 * "Searching your notes…"), ai-chat's `AIStepsPanel` ("Searched entities"), and
 * the IS's own `TOOL_DISPLAY_NAMES` ("Searching your workspace"). Every tool none
 * of them listed leaked its snake_case name. This file merges them.
 *
 * THREE MOODS, not two — a tool is watched WHILE it runs, which an action
 * proposal never is:
 *   - `progressive` — what the agent is doing now: the live status line.
 *   - `past`        — what it did: the settled trace, receipts.
 *   - `imperative`  — what it would do: an approval prompt, a button.
 *
 * HOW. Most IS tools are `<verb>_<object>` (`create_document`, `list_views`), so
 * a label is COMPOSED: the verb from {@link TOOL_VERB_MOODS}, the object from the
 * ONE noun door ({@link resolveObjectNoun}) — so `create_automation` reads
 * "Creating rule" because the glossary calls an automation a rule, and a rename
 * there reaches the tool label for free. Names whose composition reads badly,
 * or that are not `<verb>_<object>`, take a whole-name row in
 * {@link TOOL_LABEL_OVERRIDES}.
 *
 * UNKNOWN tools humanize (`frobnicate_thing` → "Frobnicate thing", every mood):
 * safe, never a raw token, and deliberately mood-less — a guess at tense for a
 * verb nobody curated is how "Complete capture" once rendered as history.
 * {@link isKnownToolName} lets a caller prefer a producer-authored title instead.
 */

import { OBJECT_KINDS, OBJECT_KIND_ALIASES } from "./object-kinds.js";
import {
  humanizeToken,
  resolveObjectNoun,
  resolveObjectNounPlural,
} from "./index.js";

export interface ToolLabelMoods {
  progressive: string;
  past: string;
  imperative: string;
}

export type ToolLabelMood = keyof ToolLabelMoods;

/**
 * The leading verb of a `<verb>_<object>` tool name, in all three moods.
 * `get` reads as "Read": the person cares that the agent looked, not how.
 */
export const TOOL_VERB_MOODS: Readonly<Record<string, ToolLabelMoods>> = {
  advance: {
    progressive: "Advancing",
    past: "Advanced",
    imperative: "Advance",
  },
  arrange: {
    progressive: "Arranging",
    past: "Arranged",
    imperative: "Arrange",
  },
  attach: { progressive: "Attaching", past: "Attached", imperative: "Attach" },
  classify: {
    progressive: "Classifying",
    past: "Classified",
    imperative: "Classify",
  },
  connect: {
    progressive: "Connecting",
    past: "Connected",
    imperative: "Connect",
  },
  consolidate: {
    progressive: "Consolidating",
    past: "Consolidated",
    imperative: "Consolidate",
  },
  create: { progressive: "Creating", past: "Created", imperative: "Create" },
  delete: { progressive: "Deleting", past: "Deleted", imperative: "Delete" },
  detach: { progressive: "Detaching", past: "Detached", imperative: "Detach" },
  generate: {
    progressive: "Generating",
    past: "Generated",
    imperative: "Generate",
  },
  get: { progressive: "Reading", past: "Read", imperative: "Read" },
  link: { progressive: "Linking", past: "Linked", imperative: "Link" },
  list: { progressive: "Listing", past: "Listed", imperative: "List" },
  load: { progressive: "Loading", past: "Loaded", imperative: "Load" },
  manage: { progressive: "Managing", past: "Managed", imperative: "Manage" },
  pin: { progressive: "Pinning", past: "Pinned", imperative: "Pin" },
  place: { progressive: "Placing", past: "Placed", imperative: "Place" },
  promote: {
    progressive: "Promoting",
    past: "Promoted",
    imperative: "Promote",
  },
  propose: {
    progressive: "Proposing",
    past: "Proposed",
    imperative: "Propose",
  },
  record: { progressive: "Recording", past: "Recorded", imperative: "Record" },
  rename: { progressive: "Renaming", past: "Renamed", imperative: "Rename" },
  request: {
    progressive: "Requesting",
    past: "Requested",
    imperative: "Request",
  },
  resolve: {
    progressive: "Resolving",
    past: "Resolved",
    imperative: "Resolve",
  },
  run: { progressive: "Running", past: "Ran", imperative: "Run" },
  save: { progressive: "Saving", past: "Saved", imperative: "Save" },
  set: { progressive: "Setting", past: "Set", imperative: "Set" },
  start: { progressive: "Starting", past: "Started", imperative: "Start" },
  suggest: {
    progressive: "Suggesting",
    past: "Suggested",
    imperative: "Suggest",
  },
  trigger: {
    progressive: "Triggering",
    past: "Triggered",
    imperative: "Trigger",
  },
  update: { progressive: "Updating", past: "Updated", imperative: "Update" },
};

/** One row per mood, from the three stems — keeps the override table legible. */
function moods(
  progressive: string,
  past: string,
  imperative: string
): ToolLabelMoods {
  return { progressive, past, imperative };
}

/**
 * Whole-name rows: tools that are not `<verb>_<object>`, or whose composed
 * label would mislead ("Searching unified"). Seeded from the four merged tables.
 */
export const TOOL_LABEL_OVERRIDES: Readonly<Record<string, ToolLabelMoods>> = {
  // Search — the three old tables said "your notes" / "entities" / "your
  // workspace" for the same call. One answer: it searches the person's pod.
  search: moods("Searching your pod", "Searched your pod", "Search your pod"),
  search_unified: moods(
    "Searching your pod",
    "Searched your pod",
    "Search your pod"
  ),
  search_entities: moods(
    "Searching your pod",
    "Searched your pod",
    "Search your pod"
  ),
  search_documents: moods(
    "Searching documents",
    "Searched documents",
    "Search documents"
  ),
  vector_search: moods(
    "Searching by meaning",
    "Searched by meaning",
    "Search by meaning"
  ),
  memory_search: moods(
    "Recalling memories",
    "Recalled memories",
    "Recall memories"
  ),
  remember_fact: moods("Saving to memory", "Saved to memory", "Save to memory"),
  web_search: moods("Searching the web", "Searched the web", "Search the web"),
  web_fetch: moods("Reading a web page", "Read a web page", "Read a web page"),
  batch_web_fetch: moods(
    "Reading web pages",
    "Read web pages",
    "Read web pages"
  ),
  graph_traverse: moods(
    "Exploring connections",
    "Explored connections",
    "Explore connections"
  ),
  link_context: moods("Linking context", "Linked context", "Link context"),
  // Delegation — the agent hands work to another agent.
  dispatch_agent: moods(
    "Delegating to a teammate",
    "Delegated to a teammate",
    "Delegate to a teammate"
  ),
  query_agent: moods("Asking a teammate", "Asked a teammate", "Ask a teammate"),
  discover_tools: moods(
    "Activating tools",
    "Activated tools",
    "Activate tools"
  ),
  run_command: moods("Running a command", "Ran a command", "Run a command"),
  // A skill FILE is instructions the agent reads, not the runnable "Tool" the
  // `skill` kind names — composing would say "Loading tool".
  load_skill: moods(
    "Loading instructions",
    "Loaded instructions",
    "Load instructions"
  ),
  // Reads whose object is not a kind.
  get_bento_schema: moods(
    "Reading the dashboard layout",
    "Read the dashboard layout",
    "Read the dashboard layout"
  ),
  get_workflow_place: moods(
    "Checking the workflow",
    "Checked the workflow",
    "Check the workflow"
  ),
  get_whiteboard_state: moods(
    "Reading the whiteboard",
    "Read the whiteboard",
    "Read the whiteboard"
  ),
  get_feed_preferences: moods(
    "Reading feed preferences",
    "Read feed preferences",
    "Read feed preferences"
  ),
  set_track_params: moods(
    "Setting track parameters",
    "Set track parameters",
    "Set track parameters"
  ),
  focus_surface: moods(
    "Opening a surface",
    "Opened a surface",
    "Open a surface"
  ),
  // Messaging / channels.
  proactive_post: moods(
    "Posting an update",
    "Posted an update",
    "Post an update"
  ),
  send_message_external: moods(
    "Sending a message",
    "Sent a message",
    "Send a message"
  ),
  route_to_channel: moods(
    "Routing to a channel",
    "Routed to a channel",
    "Route to a channel"
  ),
  // Inbox.
  inbox_list_threads: moods(
    "Listing inbox threads",
    "Listed inbox threads",
    "List inbox threads"
  ),
  inbox_get_thread: moods(
    "Reading an inbox thread",
    "Read an inbox thread",
    "Read an inbox thread"
  ),
  inbox_enrich_thread: moods(
    "Enriching an inbox thread",
    "Enriched an inbox thread",
    "Enrich an inbox thread"
  ),
  inbox_suggest_snippet: moods(
    "Suggesting a reply",
    "Suggested a reply",
    "Suggest a reply"
  ),
  // Feeds / signals.
  fetch_and_classify_signals: moods(
    "Fetching signals",
    "Fetched signals",
    "Fetch signals"
  ),
  personalize_feed_content: moods(
    "Personalizing your feed",
    "Personalized your feed",
    "Personalize your feed"
  ),
};

/** A tool's object segment as a kind key, singular — `views` → `view`. */
function singularKind(object: string): string | null {
  const known = (k: string) => k in OBJECT_KINDS || k in OBJECT_KIND_ALIASES;
  if (known(object)) return OBJECT_KIND_ALIASES[object] ?? object;
  if (object.endsWith("s") && known(object.slice(0, -1))) {
    const k = object.slice(0, -1);
    return OBJECT_KIND_ALIASES[k] ?? k;
  }
  return null;
}

/** Lower-case a noun for mid-sentence use, keeping acronyms ("MCP server"). */
function midSentence(noun: string): string {
  return /^[A-Z][a-z]/.test(noun)
    ? noun.charAt(0).toLowerCase() + noun.slice(1)
    : noun;
}

function compose(toolName: string): ToolLabelMoods | null {
  const cut = toolName.indexOf("_");
  if (cut <= 0) return null;
  const verb = TOOL_VERB_MOODS[toolName.slice(0, cut)];
  const object = toolName.slice(cut + 1);
  if (!verb || !object) return null;
  const kind = singularKind(object);
  const tail = kind
    ? midSentence(
        toolName.startsWith("list_")
          ? resolveObjectNounPlural(kind)
          : resolveObjectNoun(kind)
      )
    : object.includes("_")
      ? // A phrase (`session_to_playbook`, `workspace_template`): each word
        // that names a kind goes through the noun door, so the phrase uses the
        // glossary's words ("session to template", "space template").
        object
          .split("_")
          .filter(Boolean)
          .map((word) => {
            const k = singularKind(word);
            return k ? midSentence(resolveObjectNoun(k)) : word;
          })
          .join(" ")
      : midSentence(resolveObjectNoun(object));
  return {
    progressive: `${verb.progressive} ${tail}`,
    past: `${verb.past} ${tail}`,
    imperative: `${verb.imperative} ${tail}`,
  };
}

function normalize(toolName: string): string {
  return toolName.trim().toLowerCase();
}

/**
 * True when this door has curated words for the tool (an override or a known
 * verb). False means {@link resolveToolLabel} will only humanize — a caller
 * holding a producer-authored title should prefer that title then.
 */
export function isKnownToolName(toolName: string | null | undefined): boolean {
  if (!toolName) return false;
  const key = normalize(toolName);
  return key in TOOL_LABEL_OVERRIDES || compose(key) !== null;
}

/**
 * The human label for an AI tool, in the requested mood. Never a raw token:
 * an unknown tool humanizes (the same words in every mood — see the header).
 */
export function resolveToolLabel(
  toolName: string | null | undefined,
  mood: ToolLabelMood = "progressive"
): string {
  if (!toolName) return "";
  const key = normalize(toolName);
  const row = TOOL_LABEL_OVERRIDES[key] ?? compose(key);
  return row ? row[mood] : humanizeToken(toolName);
}
