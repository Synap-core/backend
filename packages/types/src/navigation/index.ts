/**
 * The `view` readings an object-nav address may carry (`?view=room`,
 * `{ kind, id, view: 'room' }`) — a session's `'room'` view opens its Intake
 * Room instead of the plain session detail.
 *
 * THE one allowlist. The pod (signal targets, the handoff notification input),
 * the browser route table (`object-nav.ts`) and relay (`lib/object-nav.ts`) all
 * read it from here, so a new view is added once and every door that validates
 * an untrusted `view` agrees. Pure and dependency-free: safe to value-import in
 * Hermes via this subpath (never the package root barrel).
 */
export const OBJECT_NAV_VIEWS = ["room"] as const;

export type ObjectNavView = (typeof OBJECT_NAV_VIEWS)[number];

/** True iff `value` is a known view. Unknown/absent values (a stale link, an
 *  unrelated query param, a notification payload) must be DROPPED by the
 *  caller, never forwarded raw. */
export function isObjectNavView(value: unknown): value is ObjectNavView {
  return (
    typeof value === "string" &&
    (OBJECT_NAV_VIEWS as readonly string[]).includes(value)
  );
}

/**
 * THE link rule for a URL a person is about to OPEN — a slot's `ref.url`, an
 * `act` ask's `url`, any agent-authored link a surface renders as a door.
 *
 * True iff `value` parses as an `http:` or `https:` URL. Script-capable and
 * non-network schemes (`javascript:`, `data:`, `file:`, custom app schemes) are
 * refused. Loopback / private hosts are deliberately ALLOWED: the pod never
 * fetches these (display / click-through only), and a developer must be able
 * to point at `http://localhost:3000/thing`.
 *
 * ONE definition: the pod's wire schemas (`@synap/shared-utils` re-exports this
 * as its `isHttpUrl`), relay and the browser all read it from here, so a link
 * the pod stored is exactly a link every surface will open — no surface opens
 * "any scheme" and none narrows to https-only. Never use it to guard a
 * server-side `fetch()` — that is `validateExternalUrl` / `safePublicFetch`.
 */
export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}

// ─── Object kinds: one spelling for every route table ──────────────────────

/**
 * Spellings of an object kind that name the SAME destination as another
 * kind. The pod's event spine and table names reach the clients as
 * `focus_session`, `workspaces`, `project_tracks`…; each route table keys on
 * the canonical spelling on the right.
 *
 * NARROW ON PURPOSE — not the label vocabulary's `OBJECT_KIND_ALIASES`
 * (`@synap-core/types/vocabulary`). That map also folds LABEL-only spellings
 * (`workflow` → `automation`, `step` → `stage`, `suite` → `pack`), and the
 * browser route table has a deliberate `workflow` arm (the Processes home), so
 * adopting it wholesale would redirect a door. A row belongs here only when
 * the two spellings open the same page. Where both maps name a spelling they
 * must agree (`navigation.test.ts`).
 */
export const NAV_KIND_ALIASES: Readonly<Record<string, string>> = {
  focus_session: "session",
  focus_sessions: "session",
  sessions: "session",
  project_track: "track",
  project_tracks: "track",
  tracks: "track",
  workspaces: "workspace",
  entities: "entity",
  documents: "document",
  proposals: "proposal",
  projects: "project",
  automations: "automation",
  playbooks: "playbook",
  skills: "skill",
  library_groups: "library_group",
  // An event's subject names an Application `app`.
  app: "application",
  // The pod's CRUD subject spelling of a key, and its table name.
  apikey: "api_key",
  api_keys: "api_key",
  apikeys: "api_key",
};

/**
 * THE fold of an incoming kind onto the route tables' canonical spelling:
 * trimmed, lower-cased, then {@link NAV_KIND_ALIASES}. An unknown kind comes
 * back as its trimmed lower-case self, so a table that has no row for it still
 * answers "cannot open", never a guessed page.
 */
export function canonicalNavKind(kind: string): string {
  const token = kind.trim().toLowerCase();
  return NAV_KIND_ALIASES[token] ?? token;
}

/**
 * Which kinds each view applies to. `room` is a session's Intake Room; no
 * other kind has one. A view on any other kind is dropped by a client and
 * refused by the pod's doors.
 */
export const OBJECT_NAV_VIEW_KINDS: Readonly<
  Record<ObjectNavView, readonly string[]>
> = {
  room: ["session"],
};

/** True iff `view` is a known view that applies to (canonical) `kind`. */
export function objectNavViewApplies(kind: string, view: unknown): boolean {
  return (
    isObjectNavView(view) &&
    OBJECT_NAV_VIEW_KINDS[view].includes(canonicalNavKind(kind))
  );
}

// ─── Handoff: continue on the other device (decision D5, be431bee) ─────────

/**
 * The objects a person can send to their other device ("Continue on
 * desktop" on the phone, "Send to phone" on the desktop), through the pod's
 * ONE handoff door (`notifCenter.handoff`). The request is a POINTER — `{kind,
 * id, view?}` — stored in the pod as a notification, so a closed device finds
 * it later; never a URL.
 *
 * A kind is here only when all three hold:
 *   - the pod can read it through its own registered read floor, so a handoff
 *     never names an object its sender cannot see (the door's `Record` over
 *     this list is the compile-time check);
 *   - relay's route table opens it (`src/lib/object-nav.ts`);
 *   - the browser's route table opens it (`navigation/object-nav.ts`).
 * Each client pins the last two with a tripwire over this list. A kind the
 * pod can floor but a client cannot open (a skill rule, a workspace) joins
 * the day both tables route it.
 */
export const HANDOFF_KINDS = [
  "session",
  "entity",
  "document",
  "proposal",
  "track",
  "project",
  "automation",
  "playbook",
  "library_group",
] as const;

export type HandoffKind = (typeof HANDOFF_KINDS)[number];

/** True iff `kind` (already canonical) is a kind the handoff door takes. */
export function isHandoffKind(kind: unknown): kind is HandoffKind {
  return (
    typeof kind === "string" &&
    (HANDOFF_KINDS as readonly string[]).includes(kind)
  );
}

/**
 * Where a handoff goes. `desktop` = the Synap desktop app, `phone` = Relay.
 * Each is a class of the person's signed-in devices, never one device: every
 * desktop the person is signed in on gets the request (Apple Handoff's and
 * Chrome's "send to your devices" shape, without a device picker).
 */
export const HANDOFF_DEVICES = ["desktop", "phone"] as const;

export type HandoffDevice = (typeof HANDOFF_DEVICES)[number];

/** What a handoff points at: the same `{kind, id, view?}` both route tables speak. */
export interface HandoffTarget {
  kind: HandoffKind;
  id: string;
  view?: ObjectNavView;
}

/**
 * Whether the person has a device of one class signed in, as the pod knows it
 * (`notifCenter.handoffTargets`, and on every `handoff` answer).
 *
 * `signedIn` reads the Synap apps' sign-ins (`person_devices`), and for a
 * phone also its push registration. It is a HINT for the words, never a gate:
 * the door stores the request either way, and an app signed in before device
 * sign-ins existed is not seen. `push` (phone only): a phone that gets pushes
 * is connected, so the request rings it; otherwise it waits in the app.
 */
export interface HandoffReach {
  signedIn: boolean;
  /** The most recent use of a device of this class (ISO), or null. */
  lastSeenAt: string | null;
  /** Phone only: at least one phone gets pushes. */
  push?: boolean;
}
