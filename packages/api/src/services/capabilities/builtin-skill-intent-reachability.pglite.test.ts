/**
 * TRIPWIRE — a TOOL-LESS skill's declared intent REACHES the intent index.
 *
 * ── WHY A SECOND FILE, AND WHY THE EXISTING ONE IS NOT ENOUGH ───────────────
 * `__tripwires__/builtin-verb-intent-reachability.tripwire.test.ts` proves a
 * declared intent survives `resolveVerbIntent` → `foldVerbsByIntent`. It is
 * green, and it was green while the defect shipped. The reason is visible in
 * its own fixture: `registryRowFor` HAND-BUILDS a row carrying
 * `verbs: [{ id, intent, … }]` and hands it straight to the fold. It proves the
 * fold indexes a verb that already has an `intent` — it never asks WHERE a verb
 * row comes from, so it cannot see a path on which no verb row is ever built.
 *
 * That is the signature failure in `.claude/rules/guards-and-tests.md`: a guard
 * that passes while no longer looking at the claim. Its own header asserts
 * "(a) IT IS NOT BEHAVIOURAL. … It does NOT prove `listCapabilities` returns the
 * rows" — and the layer it waves at
 * (`capability-registry.skill-visibility.tripwire`) proves VISIBILITY, never
 * that a visible row is also ROUTABLE. So the hole between "the row is visible"
 * and "the row reaches the index" was covered by nobody.
 *
 * ── THE CLAIM, AT THE SEAM WHERE IT IS ACTUALLY LOST ────────────────────────
 * `SYNAP_CORE_DEFINITION` declares `tools: []`. Its skills therefore have no
 * `tools` row, so `buildVerbStates` is never called for them and they surface
 * through `listCapabilities`'s SKILL branch as `kind:"skill"` rows. That branch
 * projected no `verbs` array at all, and `foldVerbsByIntent` iterates
 * `c.verbs ?? []` — so a skill row contributed ZERO matches, however it was
 * annotated. Verified live 2026-10-01: `intent:"send_message"` returned only
 * `gmail_send`; the always-installed `messaging.send` was absent.
 *
 * So this file drives the REAL reader end-to-end (PGlite → real
 * `listCapabilities` → real `foldVerbsByIntent`), and asserts the VALUE
 * ARRIVES under the verb's own id. A hand-built fixture is deliberately NOT
 * used for the reachability assertion — building the row here would rebuild the
 * very hole.
 *
 * ── WHAT IT DOES NOT COVER (measured, not implied) ──────────────────────────
 *
 * a. THE IS-NATIVE MANIFEST PATH IS NOT EXERCISED. `fetchISNativeCapabilities`
 *    is stubbed to degrade to `[]` (its documented behaviour when the IS is
 *    unreachable) so the registry read is deterministic. This file therefore
 *    says NOTHING about a `builtin-tool` row produced from the IS manifest. The
 *    two are different populations: a Synap Core verb is a `skill` row, an
 *    IS-native tool is a `builtin-tool` row with no verb catalog at all. If
 *    someone later gives an IS-native row verbs, THIS guard will not see it.
 *
 * b. IT PROVES THE INDEX, NOT THE AUTHORIZATION. An intent resolving to a verb
 *    is ROUTING. That the verb then passes its own gate is a separate claim,
 *    asserted separately in "governance is not widened by being routable" below
 *    over `projectRunnableActions` + `runPosture` — the same predicates the
 *    run door and the actions door use. It does NOT invoke the execute door
 *    itself; that is `execute-capability`'s own suite.
 *
 * c. IT COVERS THE POD'S OWN BUILTINS, NOT THE CP'S TEMPLATES. `web-read`
 *    (`tools: []`, two `code` skills with `fetch_record` / `capture_into_pod`)
 *    is the same shape from the OTHER producer, in another repository. It is
 *    covered by `synap-control-plane-api/src/seeds/capability-template-intent-
 *    coverage.test.ts` against the same vocabulary. The row shape this file
 *    asserts is producer-independent, but the SET of definitions is not.
 *
 * d. NON-VACUITY IS ASSERTED PER DIRECTION. A `kind` filter, a visibility
 *    predicate, or a dedup that dropped the row would each yield `[]` and read
 *    exactly like "the verb declares no intent". The positive controls below
 *    assert the machinery can return a match at all, and the companion test
 *    asserts an UNANNOTATED skill is still absent — so a fold that indexed
 *    everything indiscriminately fails here too.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      query: (sql: string, params?: unknown[]) => Promise<unknown>;
      exec: (sql: string) => Promise<unknown>;
    },
    db: null as unknown,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
  };
  return state;
});

vi.mock("../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const db = await h.init();
  return { ...actual, db, getDb: async () => db };
});
// Deterministic read: the IS-native manifest fetch degrades to `[]` when the IS
// is unreachable (its documented behaviour). See "what it does not cover" (a).
vi.mock("@synap/intelligence-client", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getDefaultActiveService: async () => {
      throw new Error("no IS in test");
    },
  };
});

import * as schema from "@synap/database/schema";
import type { PgTable } from "drizzle-orm/pg-core";
import { pgliteSchemaDdl } from "../../__tests__/pglite-ddl.js";
import { listCapabilities } from "./capability-registry.js";
import { foldVerbsByIntent } from "./capability-intent-index.js";
import { projectRunnableActions } from "./action-projection.js";
import { runPosture } from "./run-posture.js";

const U = randomUUID();
const WS = randomUUID();
const PACK = randomUUID();

const q = (sql: string, params: unknown[] = []) =>
  h.client!.query(sql, params) as Promise<{ rows: Array<Record<string, any>> }>;

/**
 * One tool-less capability skill — the exact shape that was invisible.
 * `requires` is absent by construction: there is no tool row to hang a verb
 * catalog on, so the skill row is the only carrier of an intent there can be.
 */
async function toollessSkill(opts: {
  name: string;
  kind?: "builtin" | "code";
  intent?: string;
  approved?: boolean;
  status?: string;
  readOnly?: boolean;
}): Promise<string> {
  const id = randomUUID();
  const metadata = opts.readOnly ? { readOnly: true } : {};
  await q(
    `insert into skills (id, name, kind, status, approved, scope, workspace_id, user_id, metadata, intent)
     values ($1,$2,$3,$4,$5,'pod',$6,$7,$8::jsonb,$9)`,
    [
      id,
      opts.name,
      opts.kind ?? "builtin",
      opts.status ?? "active",
      opts.approved ?? true,
      WS,
      U,
      JSON.stringify(metadata),
      opts.intent ?? null,
    ]
  );
  await q(
    `insert into links (from_type, from_id, to_type, to_id, link_type) values ('skill',$1,'capability',$2,'member_of')`,
    [id, PACK]
  );
  return id;
}

/** The real reader + the real fold. No fixture row is built anywhere here. */
async function indexForThisCaller(): Promise<{
  index: Map<string, Array<{ verbId: string }>>;
  caps: Awaited<ReturnType<typeof listCapabilities>>;
}> {
  const caps = await listCapabilities(
    { workspaceId: WS, userId: U },
    { limit: null }
  );
  return { index: foldVerbsByIntent(caps), caps };
}

beforeAll(async () => {
  await h.init();
  const s = schema as unknown as Record<string, PgTable>;
  await h.client!.exec(
    pgliteSchemaDdl([
      s.tools!,
      s.skills!,
      s.vaultGrants!,
      s.links!,
      s.secrets!,
      s.capabilities!,
      s.intelligenceCommands!,
      s.workspaces!,
      s.workspaceMembers!,
      s.podMembers!,
      s.users!,
      s.projectMembers!,
      s.governanceRules!,
    ])
  );
  await q(`insert into users (id, email) values ($1,'u@x')`, [U]);
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'WS',$2,'{}'::jsonb)`,
    [WS, U]
  );
  await q(
    `insert into workspace_members (workspace_id, user_id, role) values ($1,$2,'editor')`,
    [WS, U]
  );
  await q(`insert into capabilities (id, name) values ($1,'Synap Core')`, [
    PACK,
  ]);

  // The corpus, mirroring SYNAP_CORE_DEFINITION's annotated members plus
  // `web-read`'s two CODE skills — the two tool-less producers, so a fix that
  // special-cased `kind:"builtin"` fails the third test rather than shipping.
  await toollessSkill({ name: "messaging.send", intent: "send_message" });
  await toollessSkill({ name: "entity.query", intent: "list_records" });
  await toollessSkill({
    name: "read_public_url",
    kind: "code",
    intent: "fetch_record",
  });
  await toollessSkill({
    name: "capture_public_url",
    kind: "code",
    intent: "capture_into_pod",
  });
  // Deliberately UNANNOTATED (they are the pod-internal exemptions recorded in
  // the sibling tripwire's INTENTIONALLY_UNROUTABLE table).
  await toollessSkill({ name: "document.read" });
  await toollessSkill({ name: "channel.create" });
});

describe("a tool-less skill's intent REACHES the reverse index", () => {
  it("POSITIVE CONTROL: the reader sees the skill row and the fold CAN return a match", async () => {
    // The scan must not be vacuous. Two independent vacuity routes exist here —
    // the row being invisible to `listCapabilities` (a floor/filter change), and
    // the fold returning `[]` for everything (the index not serving at all). A
    // bare "the verb is absent" assertion passes under EITHER, so prove the
    // machinery is live before trusting a reachability result.
    const { index, caps } = await indexForThisCaller();

    const row = caps.find((c) => c.name === "entity.query");
    expect(row, "the skill row never reached the reader at all").toBeDefined();
    expect(row!.kind).toBe("skill");

    // The fold can return a match for a row that DOES declare one.
    const hits = index.get("list_records") ?? [];
    expect(
      hits.map((h) => h.verbId),
      "the index returned nothing for a verb that declares an intent — every " +
        "reachability assertion below would be vacuous"
    ).toContain("entity.query");
  });

  it("a BUILTIN tool-less verb reaches the index under its own verb id", async () => {
    // The exact shape and the exact slug from the live defect.
    const { index } = await indexForThisCaller();
    const hits = index.get("send_message") ?? [];
    expect(
      hits.map((h) => h.verbId),
      "`messaging.send` declares send_message but is absent from the index — " +
        "an agent asking to send a message can only reach the vendor verb"
    ).toContain("messaging.send");
  });

  it("a CODE tool-less verb reaches it too — the claim is about the shape, not the kind", async () => {
    // `web-read`'s two skills are `kind:'code'` with `tools: []`. If the fix
    // special-cased `builtin`, this would be the row that still disappears —
    // and a fix that special-cased a kind is exactly the symptom-chasing this
    // tripwire exists to prevent.
    const { index } = await indexForThisCaller();
    for (const [verb, intent] of [
      ["read_public_url", "fetch_record"],
      ["capture_public_url", "capture_into_pod"],
    ] as const) {
      const hits = index.get(intent) ?? [];
      expect(
        hits.map((h) => h.verbId),
        `${verb} (kind:code, no tool) declares ${intent} but never reaches the index`
      ).toContain(verb);
    }
  });

  it("the index reports a REAL run posture, not a synthesised 'auto'", async () => {
    // A match that claims `auto` for a verb the gate would PROPOSE would be a
    // far worse defect than the invisibility this file fixes: an agent reading
    // it would run ungoverned. Assert the two predicates the doors actually use
    // still hold for a verb that is now routable.
    const { caps } = await indexForThisCaller();

    // `messaging.send` is a WRITE builtin: no grant, not read-only → propose.
    const send = caps.find((c) => c.name === "messaging.send")!;
    expect(runPosture({ verbId: send.name, skillKind: send.skillKind })).toBe(
      "propose"
    );

    // `entity.query` is a READ builtin (READ_ONLY_BUILTIN_VERBS) → auto, and its
    // action carries that same posture through the projection the actions door
    // reads. A verb becoming routable must not change what it is allowed to do.
    const actions = projectRunnableActions(caps);
    const query = actions.find((a) => a.verbId === "entity.query");
    expect(query, "entity.query is not a runnable action at all").toBeDefined();
    expect(query!.governance).toBe("auto");
    // And the mirror: the declared intent now rides the action, so the actions
    // door's intent filter and the index agree on the same concrete verb id.
    expect(query!.intent).toBe("list_records");
  });

  it("an UNANNOTATED skill is still absent — reachability must not become a blanket", async () => {
    // The other direction, and the one a careless fix breaks: making skill rows
    // carry a verb must NOT put a verb with no declared intent into the index.
    // `foldVerbsByIntent`'s contract is "declares none ⇒ absent, never guessed".
    const { index } = await indexForThisCaller();
    const everyIndexedVerb = [...index.values()].flatMap((m) =>
      m.map((h) => h.verbId)
    );
    expect(everyIndexedVerb).not.toContain("document.read");
    expect(everyIndexedVerb).not.toContain("channel.create");
  });
});
