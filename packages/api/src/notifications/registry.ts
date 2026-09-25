/**
 * Notification Type Registry
 *
 * Maps notification type keys to their definition.
 * Adding a new notification type = add one entry here. Zero code.
 *
 * Templates support simple {{variable}} interpolation.
 * Variables come from the `data` object passed to NotificationService.create().
 * Interpolation covers `titleTemplate` and `bodyTemplate` ONLY — `actions` are
 * persisted and emitted verbatim.
 *
 * NOT unified here (deliberately, and still open): `notifications.workspaceUrl`
 * and `navigation/deep-links.ts` are two further address vocabularies for the
 * same destinations. Only the inline ACTION vocabulary is folded into the ONE
 * route table by `navigate-object` below.
 */

export type DeliveryChannel = "in_app" | "os" | "telegram" | "email_digest";

export interface NotificationActionDef {
  id: string;
  label: string;
  variant: "primary" | "secondary" | "destructive";
  handler:
    | NotificationNavigateHandler
    | NotificationNavigateObjectHandler
    | { type: "mutation"; procedure: string; inputKey?: string };
}

/**
 * A destination that is NOT an object — a settings tab, the vault, a listing.
 * These have no id and no route-table row, so they name an app directly.
 *
 * Anything whose destination IS an object must use `navigate-object` below;
 * an app+params pair for an object is a second, hand-rolled routing vocabulary
 * that drifts from the ONE route table the moment either side changes.
 */
export interface NotificationNavigateHandler {
  type: "navigate";
  app: string;
  params?: Record<string, unknown>;
}

/**
 * A destination that IS an object. The client resolves `{kind, id}` through the
 * ONE route table — `objectNavTarget()` in
 * `browser/electron/renderer/src/navigation/object-nav.ts` (its `fallbackNavTarget`
 * switch lists every routable kind) — so this registry never restates where a
 * kind lives.
 *
 * `kind` is typed as a plain string on purpose: the route table is a browser
 * module and the kind vocabulary (`OBJECT_KINDS` in
 * `@synap-core/types/vocabulary`) is an open `Record<string, …>`, not a union.
 *
 * `id` is OMITTED for the common case, and then means "this notification's own
 * `sourceId`" — which is the object id for every action migrated so far
 * (chat.mention → channelId, automation.broken → automationId, proposal.created
 * → proposalId). Nothing interpolates `{{tokens}}` inside a handler: `create()`
 * stores `def.actions` VERBATIM and the persisted row does not carry `data`, so
 * a templated id would reach the client as the literal `{{…}}` text. That was
 * already true of the `chat.mention` action this replaces.
 */
export interface NotificationNavigateObjectHandler {
  type: "navigate-object";
  /** Object-nav kind — see `fallbackNavTarget` in object-nav.ts. */
  kind: string;
  /** Literal object id. Omit ⇒ the notification's own `sourceId`. */
  id?: string;
  /**
   * Optional object-nav VIEW reading (`OBJECT_NAV_VIEWS` in
   * `@synap-core/types/navigation` — `'room'` opens a session's Intake Room).
   * Literal, never templated; the client re-validates it with
   * `isObjectNavView` and drops an unknown one.
   */
  view?: string;
}

export interface NotificationDef {
  type: string;
  category: "governance" | "data" | "ai" | "system" | "inbox";
  label: string;
  icon: string; // lucide icon name
  priority: "low" | "normal" | "high" | "urgent";
  /** Mustache-style template: {{variable}} */
  titleTemplate: string;
  bodyTemplate: string;
  /** Default delivery channels (user prefs can override) */
  defaultChannels: DeliveryChannel[];
  /**
   * The channels this type may EVER go out on, whatever a routing rule says.
   * Omit ⇒ no ceiling. Exists for a type whose audience is fixed by what it IS:
   * a phone→desktop handoff pushed back to the phone that sent it is noise.
   */
  channelCeiling?: DeliveryChannel[];
  /** Inline action buttons */
  actions?: NotificationActionDef[];
  /** Auto-dismiss after ms. 0 = persistent. */
  ttl?: number;
  /** Group notifications sharing the same resolved groupBy field */
  groupBy?: string;
  /**
   * SUPPRESSION window, in ms. Declared ⇒ `NotificationService.create()` looks
   * for an existing row with the SAME `(userId, type, groupKey)` created within
   * this window and, finding one, writes NOTHING and interrupts nobody.
   *
   * This is not `groupBy`. `groupBy` is DISPLAY collapsing — N rows exist and
   * the bell stacks them, which is fine for a bell and wrong for a phone: N
   * rows means N pushes. A type that can be emitted repeatedly for the same
   * subject (a second criterion escalating in the same session, a redelivered
   * close event) needs the row itself not to be written a second time.
   *
   * Opt-IN on purpose. Applying a window to every type would silently swallow
   * `proposal.created`, which groups by AGENT and legitimately fires once per
   * proposal — the second proposal from the same agent is real news, not a
   * duplicate. Only a type whose groupKey IS its identity may declare one.
   *
   * WHAT IT DOES NOT COVER, measured: it is keyed on the resolved `groupKey`,
   * so two notifications that differ in any way the groupKey does not encode
   * (a DIFFERENT criterion in the same session) are the same key and the second
   * is suppressed — that is the intent here, not a gap. Conversely it cannot
   * coalesce two events whose groupKeys differ, however similar they read. A
   * type with no resolvable groupKey is never deduped (and says so in the log).
   */
  dedupeWindowMs?: number;
}

/**
 * The suppression window both session-attention types use: one notification per
 * session per six hours.
 *
 * Six hours, not "forever": a redelivered event, a retried evaluation pass, and
 * a second criterion escalating in the same run all land inside one working
 * block and are one piece of news ("this session needs you"). A session that
 * escalates again TOMORROW is genuinely news again, and a permanent key would
 * silence it forever with nothing to say so. Six hours is the smallest window
 * that covers a working block without making that claim.
 */
export const SESSION_ATTENTION_DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * An agent's room UPDATES (in-app only): at most one bell row per session per
 * thirty minutes. Shorter than the attention window on purpose — an update is
 * not a stop, so a later one in the same afternoon is still worth a glance —
 * and long enough that an agent narrating every step writes one row, not
 * twenty. The room itself carries every message in realtime regardless.
 */
export const SESSION_ROOM_UPDATE_DEDUPE_WINDOW_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const NOTIFICATION_REGISTRY: NotificationDef[] = [
  // ── Governance ────────────────────────────────────────────────────────────
  {
    type: "proposal.created",
    category: "governance",
    label: "AI Proposal",
    icon: "bot",
    priority: "high",
    titleTemplate: "Review: {{proposalType}}",
    bodyTemplate: "{{description}}",
    defaultChannels: ["in_app", "os"],
    actions: [
      {
        id: "approve",
        label: "Approve",
        variant: "primary",
        handler: {
          type: "mutation",
          procedure: "proposals.approve",
          inputKey: "proposalId",
        },
      },
      {
        id: "reject",
        label: "Reject",
        variant: "destructive",
        handler: {
          type: "mutation",
          procedure: "proposals.reject",
          inputKey: "proposalId",
        },
      },
      {
        id: "review",
        label: "Review",
        variant: "secondary",
        // Deciding without reading is the failure mode this row exists to
        // avoid. `sourceId` is the proposalId.
        handler: { type: "navigate-object", kind: "proposal" },
      },
    ],
    ttl: 0,
    groupBy: "agentUserId",
  },
  {
    type: "proposal.auto_approved",
    category: "governance",
    label: "Auto-Approved Action",
    icon: "check-circle",
    priority: "low",
    titleTemplate: "Auto-approved: {{proposalType}}",
    bodyTemplate: "{{description}}",
    defaultChannels: ["in_app"],
    ttl: 5_000,
  },
  {
    // Proactive twin of the approve-time preflight: a pending proposal whose
    // target workspace the owner can no longer reach will FAIL on approve. Surface
    // it before they try. Hygiene, not blocking → `normal` (reserve high/urgent for
    // live approvals + auth-expired). Deduped per workspace+reason via groupBy.
    type: "governance.proposal_stale",
    category: "governance",
    label: "Stale Proposal",
    icon: "clock-alert",
    priority: "normal",
    titleTemplate: "Can't be approved: {{proposalType}}",
    bodyTemplate: "Its {{reason}} — withdraw it or re-run fresh.",
    defaultChannels: ["in_app"],
    actions: [
      {
        id: "withdraw",
        label: "Withdraw",
        variant: "destructive",
        handler: {
          type: "mutation",
          procedure: "proposals.reject",
          inputKey: "proposalId",
        },
      },
    ],
    ttl: 0,
    groupBy: "reason",
  },
  {
    // A newer intake prompt version is rejected clearly more often than the one
    // before it (same engine + model, minimum sample on both sides). Producer:
    // `services/intake/prompt-version-regression.ts` (daily cron), once per
    // regression per pod admin. No action: the prompt lives in the IS and no
    // pod write reverts it.
    type: "intake.prompt_version_regression",
    category: "ai",
    label: "Prompt quality regression",
    icon: "trending-down",
    priority: "normal",
    titleTemplate: "Prompt {{promptVersion}} is rejected more often",
    bodyTemplate:
      "{{newerRejectPct}}% of {{newerDecided}} reviewed proposals rejected vs {{previousRejectPct}}% of {{previousDecided}} for {{previousPromptVersion}} ({{engine}} / {{model}}).",
    defaultChannels: ["in_app"],
    ttl: 0,
  },
  {
    type: "ai_request.vault_access",
    category: "governance",
    label: "Vault Access Request",
    icon: "shield",
    priority: "urgent",
    titleTemplate: "AI needs {{secretType}} for {{service}}",
    bodyTemplate: "{{purpose}}",
    defaultChannels: ["in_app", "os"],
    actions: [
      {
        id: "open_vault",
        label: "Open Vault",
        variant: "primary",
        handler: { type: "navigate", app: "vault" },
      },
      {
        id: "deny",
        label: "Deny",
        variant: "destructive",
        handler: {
          type: "mutation",
          procedure: "proposals.reject",
          inputKey: "proposalId",
        },
      },
    ],
    ttl: 0,
  },
  {
    type: "ai_request.terminal_exec",
    category: "governance",
    label: "Terminal Command Request",
    icon: "terminal",
    priority: "urgent",
    titleTemplate: "AI wants to run: {{command}}",
    bodyTemplate: "In: {{cwd}}",
    defaultChannels: ["in_app", "os"],
    actions: [
      {
        id: "allow",
        label: "Allow",
        variant: "primary",
        handler: {
          type: "mutation",
          procedure: "proposals.approve",
          inputKey: "proposalId",
        },
      },
      {
        id: "deny",
        label: "Deny",
        variant: "destructive",
        handler: {
          type: "mutation",
          procedure: "proposals.reject",
          inputKey: "proposalId",
        },
      },
    ],
    ttl: 0,
  },

  // ── Data ──────────────────────────────────────────────────────────────────
  {
    type: "connector.sync.complete",
    category: "data",
    label: "Connector Sync Complete",
    icon: "refresh-cw",
    priority: "normal",
    titleTemplate: "{{connectorName}} sync complete",
    bodyTemplate: "{{itemCount}} items imported",
    defaultChannels: ["in_app"],
    ttl: 6_000,
  },
  {
    type: "connector.sync.failed",
    category: "data",
    label: "Connector Sync Failed",
    icon: "alert-circle",
    priority: "high",
    titleTemplate: "{{connectorName}} sync failed",
    bodyTemplate: "{{errorMessage}}",
    defaultChannels: ["in_app", "os"],
    actions: [
      {
        id: "settings",
        label: "Check Settings",
        variant: "primary",
        handler: {
          type: "navigate",
          app: "settings",
          params: { tab: "connectors" },
        },
      },
    ],
    ttl: 0,
  },
  {
    type: "connector.auth.expired",
    category: "data",
    label: "Connector Auth Expired",
    icon: "key",
    priority: "high",
    titleTemplate: "{{connectorName}} needs re-authorization",
    bodyTemplate: "Your connection expired. Reconnect to resume syncing.",
    defaultChannels: ["in_app", "os"],
    actions: [
      {
        id: "reconnect",
        label: "Reconnect",
        variant: "primary",
        handler: {
          type: "navigate",
          app: "settings",
          params: { tab: "connectors" },
        },
      },
    ],
    ttl: 0,
  },
  {
    type: "entity.created_by_ai",
    category: "data",
    label: "AI Created Entity",
    icon: "sparkles",
    priority: "low",
    titleTemplate: "{{agentName}} created {{entityType}}",
    bodyTemplate: "{{entityTitle}}",
    defaultChannels: ["in_app"],
    ttl: 5_000,
  },

  // ── AI ────────────────────────────────────────────────────────────────────
  {
    type: "skill.triggered",
    category: "ai",
    label: "Skill Activated",
    icon: "zap",
    priority: "normal",
    titleTemplate: "Skill triggered: {{skillName}}",
    bodyTemplate: "{{description}}",
    defaultChannels: ["in_app"],
    ttl: 4_000,
  },
  {
    type: "agent.task_complete",
    category: "ai",
    label: "Agent Task Complete",
    icon: "check",
    priority: "normal",
    titleTemplate: "{{agentName}} finished a task",
    bodyTemplate: "{{summary}}",
    defaultChannels: ["in_app"],
    ttl: 6_000,
    actions: [
      {
        id: "view",
        label: "View",
        variant: "primary",
        handler: { type: "navigate", app: "chat" },
      },
    ],
  },
  {
    type: "agent.task_failed",
    category: "ai",
    label: "Agent Task Failed",
    icon: "alert-triangle",
    priority: "high",
    titleTemplate: "{{agentName}} encountered an error",
    bodyTemplate: "{{errorMessage}}",
    defaultChannels: ["in_app", "os"],
    // Group repeated failures of the same agent in the bell. Producers pass an
    // explicit agentUserId-keyed groupKey; this declares the fallback grouping
    // for any other caller.
    groupBy: "agentName",
    // ONE HOUR, and it is a CONSOLIDATION, not a new rule. This exact cooldown
    // was hand-rolled twice — `AGENT_FAILURE_RENOTIFY_COOLDOWN_MS`, once in the
    // headless A2AI response worker in @synap/jobs and again in
    // `routers/hub-protocol/rest/events.ts`, each with its own pre-insert
    // SELECT over the same `(type, groupKey, createdAt)`. Two copies of a
    // suppression rule is two places for it to drift; declaring it on the type
    // puts it where every producer reaching the one door inherits it.
    // (The worker is named in prose rather than by filename on purpose: the
    // `a2ai-one-door` tripwire scans api/src for the queue-name literal and
    // does NOT strip comments, so spelling the filename here trips it.)
    dedupeWindowMs: 60 * 60 * 1000,
    ttl: 0,
    actions: [
      {
        id: "view",
        label: "View",
        variant: "primary",
        handler: { type: "navigate", app: "chat" },
      },
    ],
  },
  {
    type: "agent.insight",
    category: "ai",
    label: "AI Insight",
    icon: "lightbulb",
    priority: "normal",
    titleTemplate: "{{agentName}}: {{title}}",
    bodyTemplate: "{{body}}",
    defaultChannels: ["in_app"],
    ttl: 0,
  },
  {
    // The generic `notification` automation output node (see `case "notification"`
    // in `packages/jobs/src/workers/steps/output.ts`) — an automation AUTHOR wrote
    // this title/body, so it is templated verbatim rather than composed from a
    // fixed sentence. `category`/`priority` used to be per-call config (default
    // 'ai'/'normal'); the service resolves both from the TYPE, not the call, same
    // as every other producer migrated onto this door (`ai.proactive.*`,
    // `agent.task_failed`) — so this entry fixes them at their prior defaults
    // rather than special-casing a per-call override.
    type: "automation.notification",
    category: "ai",
    label: "Automation Notification",
    icon: "bell",
    priority: "normal",
    titleTemplate: "{{title}}",
    bodyTemplate: "{{body}}",
    defaultChannels: ["in_app"],
    ttl: 0,
  },
  {
    // An automation the system flipped to status='error' has silently stopped
    // running — surface it so the user can fix/re-enable it (absence-is-invisible
    // otherwise). High (a dead automation means work isn't happening). Deduped per
    // automation via groupBy so a persistently-broken one collapses to one row.
    type: "automation.broken",
    category: "system",
    label: "Automation Broken",
    icon: "alert-octagon",
    priority: "high",
    titleTemplate: "Automation stopped: {{automationName}}",
    bodyTemplate: "{{errorMessage}}",
    defaultChannels: ["in_app"],
    ttl: 0,
    groupBy: "automationId",
    actions: [
      {
        id: "view",
        label: "View Automation",
        variant: "primary",
        // `sourceId` is the automation id (see `scan-broken-automations.ts`).
        handler: { type: "navigate-object", kind: "automation" },
      },
    ],
  },

  // ── Data: Entity Lifecycle ──────────────────────────────────────────────
  {
    type: "data.entity.deleted",
    category: "data",
    label: "Entity Deleted",
    icon: "trash-2",
    priority: "normal",
    titleTemplate: "Entity deleted: {{entityName}}",
    bodyTemplate: "{{entityType}} was removed",
    defaultChannels: ["in_app"],
    ttl: 6_000,
  },
  {
    type: "data.document.created",
    category: "data",
    label: "Document Created",
    icon: "file-text",
    priority: "low",
    titleTemplate: "New document: {{title}}",
    bodyTemplate: "{{description}}",
    defaultChannels: ["in_app"],
    ttl: 5_000,
  },
  {
    type: "data.view.created",
    category: "data",
    label: "View Created",
    icon: "layout-grid",
    priority: "low",
    titleTemplate: "New view: {{title}}",
    bodyTemplate: "{{viewType}} view created",
    defaultChannels: ["in_app"],
    ttl: 5_000,
  },
  {
    type: "data.relation.created",
    category: "data",
    label: "Relation Created",
    icon: "link",
    priority: "low",
    titleTemplate: "New relation: {{sourceTitle}} → {{targetTitle}}",
    bodyTemplate: "{{relationType}}",
    defaultChannels: ["in_app"],
    ttl: 5_000,
  },

  // ── AI: Proactive Messages ──────────────────────────────────────────────
  {
    type: "ai.proactive.morning_briefing",
    category: "ai",
    label: "Morning Briefing",
    icon: "sunrise",
    priority: "normal",
    titleTemplate: "{{title}}",
    bodyTemplate: "{{body}}",
    defaultChannels: ["in_app"],
    ttl: 0,
  },
  {
    type: "ai.proactive.weekly_digest",
    category: "ai",
    label: "Weekly Digest",
    icon: "calendar-range",
    priority: "normal",
    titleTemplate: "{{title}}",
    bodyTemplate: "{{body}}",
    defaultChannels: ["in_app"],
    ttl: 0,
  },
  {
    type: "ai.proactive.health_check",
    category: "ai",
    label: "Health Check",
    icon: "heart-pulse",
    priority: "low",
    titleTemplate: "{{title}}",
    bodyTemplate: "{{body}}",
    defaultChannels: ["in_app"],
    ttl: 0,
  },
  {
    type: "ai.proactive.insight",
    category: "ai",
    label: "AI Insight",
    icon: "lightbulb",
    priority: "normal",
    titleTemplate: "{{title}}",
    bodyTemplate: "{{body}}",
    defaultChannels: ["in_app"],
    ttl: 0,
  },
  {
    type: "ai.proactive.nudge",
    category: "ai",
    label: "AI Nudge",
    icon: "sparkles",
    priority: "low",
    titleTemplate: "{{title}}",
    bodyTemplate: "{{body}}",
    defaultChannels: ["in_app"],
    ttl: 0,
  },
  /*
   * `suggestion` and `alert` complete the set. `ProactiveMessageType`
   * (`jobs/src/utils/proactive-post.ts`) has always had SEVEN members while this
   * registry declared five, so routing that producer through
   * `NotificationService.create()` without these two would have made them hit
   * "Unknown notification type — skipping" and stop writing rows ALTOGETHER —
   * trading a silent governance gap for a silent data loss.
   *
   * Both follow their five siblings exactly: `in_app` only, no push. These are
   * AI-INITIATED posts — the agent volunteering something — not a decision owed
   * by the founder, and the two session types in this wave push precisely
   * because work is stopped until they answer. Nothing is stopped here. `alert`
   * is the one that invites a push default and still does not get one: its
   * "alert" is the AI's own word for its message, not a severity this registry
   * can vouch for, and a type whose urgency is decided by the caller must not
   * be allowed to ring a phone by default. A founder who wants either on their
   * phone turns it on per type — which is exactly what the catalogue and the
   * per-type routing rule are for.
   */
  {
    type: "ai.proactive.suggestion",
    category: "ai",
    label: "AI Suggestion",
    icon: "lightbulb",
    priority: "low",
    titleTemplate: "{{title}}",
    bodyTemplate: "{{body}}",
    defaultChannels: ["in_app"],
    ttl: 0,
  },
  {
    type: "ai.proactive.alert",
    category: "ai",
    label: "AI Alert",
    icon: "bell-ring",
    priority: "normal",
    titleTemplate: "{{title}}",
    bodyTemplate: "{{body}}",
    defaultChannels: ["in_app"],
    ttl: 0,
  },

  // ── System ────────────────────────────────────────────────────────────────
  {
    type: "pod.update_available",
    category: "system",
    label: "Update Available",
    icon: "download",
    priority: "normal",
    titleTemplate: "Synap {{version}} is available",
    bodyTemplate: "Update when you're ready.",
    defaultChannels: ["in_app"],
    ttl: 0,
    actions: [
      {
        id: "update",
        label: "Update Now",
        variant: "primary",
        handler: {
          type: "navigate",
          app: "settings",
          params: { tab: "updates" },
        },
      },
    ],
  },
  {
    type: "system.capability_update_available",
    category: "system",
    label: "Capability Updates Available",
    icon: "package",
    priority: "normal",
    // `count` + `names` come from the boot reconcile report (the caller). One
    // grouped bell item — never one-per-drifted-capability.
    titleTemplate: "{{count}} capability updates available",
    bodyTemplate: "Updated templates are ready to apply: {{names}}",
    defaultChannels: ["in_app"],
    ttl: 0,
    actions: [
      {
        id: "review",
        label: "Review",
        variant: "primary",
        // Apply lives on the capabilities surface (tRPC applyUpdates), not here.
        handler: { type: "navigate", app: "capabilities" },
      },
    ],
  },
  {
    type: "pod.storage_warning",
    category: "system",
    label: "Storage Warning",
    icon: "hard-drive",
    priority: "high",
    titleTemplate: "Storage at {{percent}}% capacity",
    bodyTemplate: "Consider archiving or cleaning up unused data.",
    defaultChannels: ["in_app", "os"],
    ttl: 0,
  },
  {
    // An intelligence service reporting degraded/unhealthy. NOT
    // `connector.auth.expired` — that template asserts an expired credential,
    // and an IS outage is usually something else entirely. The body carries
    // the health endpoint's own detail rather than a guessed cause.
    type: "system.intelligence_degraded",
    category: "system",
    label: "AI Service Degraded",
    icon: "brain-circuit",
    priority: "high",
    titleTemplate: "{{connectorName}} is {{healthStatus}}",
    bodyTemplate: "{{errorMessage}}",
    defaultChannels: ["in_app", "os"],
    ttl: 0,
  },
  {
    type: "system.issuer_pending_approval",
    category: "system",
    label: "Issuer Pending Approval",
    icon: "shield-alert",
    priority: "high",
    titleTemplate: "New external issuer needs approval",
    bodyTemplate: "{{displayName}} ({{issuerUrl}}) requested pod access.",
    defaultChannels: ["in_app", "os"],
    ttl: 0,
  },
  {
    type: "workspace.invite",
    category: "system",
    label: "Workspace Invite",
    icon: "users",
    priority: "high",
    titleTemplate: "You've been invited to {{workspaceName}}",
    bodyTemplate: "by {{inviterName}}",
    defaultChannels: ["in_app", "os"],
    ttl: 0,
    actions: [
      {
        id: "accept",
        label: "Accept",
        variant: "primary",
        handler: {
          type: "navigate",
          app: "settings",
          params: { tab: "workspaces" },
        },
      },
    ],
  },

  // ── Inbox ─────────────────────────────────────────────────────────────────
  {
    type: "inbox.email",
    category: "inbox",
    label: "New Email",
    icon: "mail",
    priority: "normal",
    titleTemplate: "{{subject}}",
    bodyTemplate: "From: {{sender}}",
    defaultChannels: ["in_app"],
    ttl: 0,
  },
  {
    type: "inbox.mention",
    category: "inbox",
    label: "Mention",
    icon: "at-sign",
    priority: "high",
    titleTemplate: "{{sender}} mentioned you",
    bodyTemplate: "{{preview}}",
    defaultChannels: ["in_app", "os"],
    ttl: 0,
  },
  {
    type: "inbox.priority_item",
    category: "inbox",
    label: "Priority Item",
    icon: "star",
    priority: "high",
    titleTemplate: "{{subject}}",
    bodyTemplate: "AI scored this as high priority",
    defaultChannels: ["in_app"],
    ttl: 0,
  },
  {
    // A HUMAN @mentioned another human in a channel/room. Distinct from
    // `inbox.mention` (imported inbox items) and from agent @handles (which route
    // to an AI, never notify a person). Clicking opens the channel in chat.
    type: "chat.mention",
    category: "inbox",
    label: "Mention",
    icon: "at-sign",
    priority: "high",
    titleTemplate: "{{sender}} mentioned you",
    bodyTemplate: "{{preview}}",
    defaultChannels: ["in_app", "os"],
    ttl: 0,
    actions: [
      {
        id: "view",
        label: "View",
        variant: "primary",
        // The channel IS the destination — routed through the ONE route table,
        // not an app+params pair. `sourceId` on this notification is the
        // channelId (see `channels/send-message.ts`), so no explicit id is
        // needed — and the `{{channelId}}` template that stood here never
        // interpolated (handlers are stored verbatim), so this also fixes a
        // link that shipped the literal braces to the client.
        handler: { type: "navigate-object", kind: "channel" },
      },
    ],
  },

  // ── Sessions ──────────────────────────────────────────────────────────────
  {
    /**
     * The LAST open blocker of a session closed, so the work can resume.
     *
     * Fires once per unblocking, not once per closed blocker — a session
     * waiting on three things is not "unblocked" twice while two remain
     * (Asana's rule, and the reason the reactor re-derives `openBlockerIds`
     * instead of reacting to the close alone). Producer: the
     * `session-unblock-notify` reactor (`session-unblock-reactor.ts`).
     */
    type: "session.unblocked",
    category: "system",
    label: "Session Unblocked",
    icon: "circle-play",
    priority: "normal",
    titleTemplate: "{{sessionTitle}} is unblocked",
    bodyTemplate: "{{blockerTitle}} closed — nothing else is blocking it.",
    defaultChannels: ["in_app"],
    ttl: 0,
    actions: [
      {
        id: "view",
        label: "Open Session",
        variant: "primary",
        // `sourceId` is the UNBLOCKED session's id (see the reactor), so no
        // explicit id is needed — the route table resolves it.
        handler: { type: "navigate-object", kind: "session" },
      },
    ],
  },
  {
    /**
     * "Continue on desktop" — the person asked, from their phone, for their own
     * desktop to pick up this run. Producer: `notifCenter.requestHandoff`, which
     * owner-floors the session first. `sourceId` is the session id.
     *
     * In-app ONLY, and capped there (`channelCeiling`): the request came FROM the
     * phone, so pushing it back to the phone is noise, whatever a routing rule
     * says. A running desktop receives it over the user room; a closed one finds
     * it unread in the inbox later. Opening is a click — never automatic.
     */
    type: "handoff.continue",
    category: "system",
    label: "Continue on desktop",
    icon: "monitor",
    priority: "normal",
    titleTemplate: "Continue on desktop: {{goal}}",
    // "another device", not "your phone": the door refuses agents, but any
    // human client (relay, CLI, a second desktop) can call it.
    bodyTemplate:
      "Sent from another device. Open the room to pick up this run.",
    defaultChannels: ["in_app"],
    channelCeiling: ["in_app"],
    ttl: 0,
    actions: [
      {
        id: "open-room",
        label: "Open room",
        variant: "primary",
        handler: { type: "navigate-object", kind: "session", view: "room" },
      },
    ],
  },
  {
    /**
     * An agent spent its allowed automatic attempts on a REQUIRED criterion and
     * still could not pass it, so the grade is now the founder's to make.
     *
     * Producer: `recordSessionEvaluation` (`evaluations/record.ts`), in the same
     * `if (outcome.escalate)` block that files the owed slot — so the slot in
     * the needs-you tray and the notification can never disagree about whether
     * an escalation happened.
     *
     * Category `ai`, not `governance`: nothing is being APPROVED here. The
     * governance category is the proposal lane (approve/reject an AI's write);
     * this is an AI handing back a judgement it could not make. `system` would
     * be a lie too — no component is unhealthy. Priority `high`, and BOTH
     * channels: the work is stopped until the founder answers, which is the
     * definition of an interrupt.
     *
     * ONE per session, not one per criterion — `dedupeWindowMs` on a
     * session-keyed groupKey. A second criterion escalating in the same run is
     * the same news and must not be a second push.
     */
    type: "session.criterion_escalated",
    category: "ai",
    label: "Criterion needs your call",
    icon: "user-check",
    priority: "high",
    titleTemplate: "Needs your call: {{sessionTitle}}",
    bodyTemplate:
      "{{criterionStatement}} — checked {{attempts}} times and still not passing. Mark it pass or fail.",
    defaultChannels: ["in_app", "os"],
    ttl: 0,
    groupBy: "sessionId",
    dedupeWindowMs: SESSION_ATTENTION_DEDUPE_WINDOW_MS,
    actions: [
      {
        id: "view",
        label: "Open session",
        variant: "primary",
        // `sourceId` is the session id (see the producer), so the route table
        // resolves it — and `pushTarget()` reads THIS handler to give the push
        // its `{kind,id}`, so the tap and the button land on one screen.
        handler: { type: "navigate-object", kind: "session" },
      },
    ],
  },
  {
    /**
     * An AGENT handed the person work in a session, or asked them something in
     * its room — the work waits on them. Producer: `notifySessionNeedsYou`
     * (`services/focus-sessions/notify-needs-you.ts`), called by every door that
     * can newly hand a slot to the person (block_output, addOutput, a PATCH or
     * create declaring an `owner: 'human'` slot, a followed playbook's
     * unanswered param, a headless run's owed param) and by `post_message` with
     * `kind: 'question'` in a session room. The door set is pinned by
     * `__tripwires__/needs-you-every-handoff-door.test.ts`.
     *
     * Never for the person's OWN write (no acting agent ⇒ no row).
     *
     * `high` + BOTH channels: a hand-off is work that has stopped until they
     * answer — the same definition of an interrupt the escalation uses. ONE per
     * session per window (session-keyed `dedupeWindowMs`): three slots and a
     * question in one working block are one piece of news, one push.
     */
    type: "session.needs_you",
    category: "ai",
    label: "Session needs you",
    icon: "hand",
    priority: "high",
    titleTemplate: "Needs you: {{sessionTitle}}",
    bodyTemplate: "{{summary}}",
    defaultChannels: ["in_app", "os"],
    ttl: 0,
    groupBy: "sessionId",
    dedupeWindowMs: SESSION_ATTENTION_DEDUPE_WINDOW_MS,
    actions: [
      {
        id: "view",
        label: "Open session",
        variant: "primary",
        // `sourceId` is the session id (see the producer).
        handler: { type: "navigate-object", kind: "session" },
      },
    ],
  },
  {
    /**
     * An AGENT posted a progress UPDATE in a session's room (`post_message`,
     * default `kind: 'update'`). Producer: `notifyRoomPost`
     * (`services/messaging/notify-room-post.ts`).
     *
     * IN-APP ONLY, and capped there (`channelCeiling`): ordinary AI chatter
     * never rings a phone — the same rule the `ai.proactive.*` rows state. A
     * question (`kind: 'question'`) or an explicit @mention of the person is
     * what pushes, through `session.needs_you` / `chat.mention`.
     *
     * One row per session per {@link SESSION_ROOM_UPDATE_DEDUPE_WINDOW_MS}: the
     * bell says "this session has news", the room holds every line of it.
     */
    type: "session.room_update",
    category: "ai",
    label: "Session room update",
    icon: "message-square",
    priority: "low",
    titleTemplate: "{{sender}} in {{sessionTitle}}",
    bodyTemplate: "{{preview}}",
    defaultChannels: ["in_app"],
    channelCeiling: ["in_app"],
    ttl: 0,
    groupBy: "sessionId",
    dedupeWindowMs: SESSION_ROOM_UPDATE_DEDUPE_WINDOW_MS,
    actions: [
      {
        id: "open-room",
        label: "Open room",
        variant: "primary",
        handler: { type: "navigate-object", kind: "session", view: "room" },
      },
    ],
  },
  {
    /**
     * A session closed with required criteria still unmet. Producer: the
     * `session-criteria-unmet-notify` reactor
     * (`session-criteria-unmet-reactor.ts`), off the close door's
     * `focus_session.closed` emit.
     *
     * PRIOR ART SAYS THIS SHOULD NOT PUSH, and the founder overrode it
     * knowingly. A finished-but-flagged result is not, by the usual rule, an
     * interrupt — the work is over; nothing is waiting on the person. The
     * founder's counter is that a session closing flagged is precisely the
     * moment a course correction is cheap, and that the override is safe
     * BECAUSE it is toggleable per type. That toggle is the load-bearing half:
     * do not remove the `os` default without also removing the setting, and do
     * not remove the setting while this default stands.
     *
     * Priority `normal`, not `high`: nothing is blocked. Category `ai` — same
     * lane as the escalation, and for the same reason (an AI's judgement about
     * work, not a governance approval).
     */
    type: "session.closed.criteria_unmet",
    category: "ai",
    label: "Closed with criteria unmet",
    icon: "flag",
    priority: "normal",
    titleTemplate: "Closed and flagged: {{sessionTitle}}",
    bodyTemplate:
      "{{statusLabel}} with {{unmetSummary}} — open the session to decide what to do.",
    defaultChannels: ["in_app", "os"],
    ttl: 0,
    groupBy: "sessionId",
    dedupeWindowMs: SESSION_ATTENTION_DEDUPE_WINDOW_MS,
    actions: [
      {
        id: "view",
        label: "Open session",
        variant: "primary",
        handler: { type: "navigate-object", kind: "session" },
      },
    ],
  },
];

// Fast lookup map (built once at module init)
export const NOTIFICATION_REGISTRY_MAP = new Map<string, NotificationDef>(
  NOTIFICATION_REGISTRY.map((def) => [def.type, def])
);

export function getNotificationDef(type: string): NotificationDef | undefined {
  return NOTIFICATION_REGISTRY_MAP.get(type);
}
