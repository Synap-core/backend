/**
 * REACTIONS → RULES (decision D1), on PGlite: every rule the reactor applies —
 * built-in and declared — gets ONE row in the pod's rule list, through the rule
 * door, and the person's pause of that row is what the reactor reads.
 *
 *  - the first pass seeds one row per rule (prose, `metadata.rule.reaction`,
 *    the seed stamp, no automation), owned by the pod owner — or by the
 *    relation's author for a declared rule;
 *  - a second pass changes nothing (idempotent);
 *  - the owner's pause wins: a draft the pass did not retire stays paused,
 *    and the reactor reads it paused (`reactionEnabledStates`);
 *  - the owner's edit wins: an edited intent is kept;
 *  - an undeclared rule is retired (a draft, remembered), and re-activated
 *    when declared again; a row its owner deleted is not recreated.
 *
 * Stubbed, each proven elsewhere: the rule door (a stateful fake writing the
 * row exactly as `createRuleGoverned` stamps it, as workers.pglite does), the
 * pod owner's resolution.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client, { schema }) };
});

async function insertRule(input: {
  userId: string;
  intent: string;
  scope: unknown;
  seed?: unknown;
  reaction?: unknown;
}): Promise<string> {
  const id = randomUUID();
  await h.client!.query(
    `insert into skills (id, user_id, name, category, kind, scope, status, approved, metadata)
     values ($1, $2, 'rule', 'rule', 'instruction', 'pod', 'active', true, $3::jsonb)`,
    [
      id,
      input.userId,
      JSON.stringify({
        rule: {
          v: 1,
          intent: input.intent,
          scope: input.scope,
          seed: input.seed,
          reaction: input.reaction,
          behaviours: [],
        },
      }),
    ]
  );
  return id;
}
vi.mock("../../rules/create.js", () => ({
  createRuleGoverned: vi.fn(
    async (input: Parameters<typeof insertRule>[0]) => ({
      status: "created",
      ruleId: await insertRule(input),
      automationIds: [],
    })
  ),
}));
vi.mock("../../rules/update.js", () => ({
  // As the real door: the whole blob rebuilt, the seed and reaction kept.
  updateRuleGoverned: vi.fn(
    async (input: {
      ruleId: string;
      intent: string;
      draft?: boolean;
      seed?: unknown;
    }) => {
      await h.client!.query(
        `update skills set metadata = jsonb_set(
           jsonb_set(metadata, '{rule,intent}', to_jsonb($2::text)),
           '{rule,seed}', coalesce($3::jsonb, metadata->'rule'->'seed'))
         where id = $1`,
        [
          input.ruleId,
          input.intent,
          input.seed ? JSON.stringify(input.seed) : null,
        ]
      );
      await h.client!.query(
        input.draft
          ? `update skills set metadata = jsonb_set(metadata, '{rule,draft}', 'true') where id = $1`
          : `update skills set metadata = metadata #- '{rule,draft}' where id = $1`,
        [input.ruleId]
      );
      return {
        status: "updated",
        ruleId: input.ruleId,
        automationIds: [],
        draft: input.draft === true,
      };
    }
  ),
}));
vi.mock("../../capabilities/pod-owner.js", () => ({
  resolvePodOwnerUserId: async () => "u-owner",
}));
// The compile pass joins the relation source itself; here the declared rules
// come from the test's own source, so the relation read is emptied.
vi.mock("../relation-reactions.js", () => ({
  relationReactionSource: {
    id: "relation-reactions",
    subjectTypes: [],
    list: async () => [],
  },
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { skills, podSettings } from "@synap/database";
import {
  BUILT_IN_REACTIONS,
  registerReactionSource,
  registerReactionStateSource,
  listReactions,
  resetReactionRegistryForTests,
  type ReactionDeclaration,
} from "@synap/jobs/utils/reactions.js";
import {
  convergeReactionRules,
  reactionRuleIntent,
  setReactionRuleOn,
} from "../reaction-rules-compile.js";
import { reactionEnabledStates } from "../reaction-rule-rows.js";
import { updateRuleGoverned } from "../../rules/update.js";

const OWNER = "u-owner";
const AUTHOR = "u-author";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const def =
      type.startsWith("timestamp") && c.hasDefault
        ? " default now()"
        : type === "jsonb" && c.hasDefault
          ? " default '{}'::jsonb"
          : "";
    const pk = c.primary
      ? type === "uuid"
        ? " primary key default gen_random_uuid()"
        : " primary key"
      : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const declared: ReactionDeclaration = {
  id: "declared:rollup:rel:post:campaign",
  title:
    "When every post part of a campaign is done, the campaign moves to its next status",
  when: {
    subjectType: "entity",
    category: ["done", "lost"],
    profileSlug: ["post"],
  },
  via: {
    link: "relation",
    relation: "part_of",
    parent: "target",
    relationDefId: "rel",
    sourceProfileId: "post",
    targetProfileId: "campaign",
  },
  do: { effect: "roll_up" },
  order: 100,
  source: "declared",
  enabled: true,
  declaredOn: {
    kind: "relation",
    relation: "part_of",
    relationName: "Part of",
    source: { profileId: "post", slug: "post", name: "Post" },
    target: { profileId: "campaign", slug: "campaign", name: "Campaign" },
    workspaceId: null,
    userId: AUTHOR,
  },
};

let declaring: ReactionDeclaration[] = [];

const rowsOf = async (reactionId: string) =>
  (
    await q<{
      id: string;
      user_id: string;
      metadata: { rule: Record<string, unknown> };
    }>(
      `select id, user_id, metadata from skills where metadata->'rule'->'reaction'->>'id' = $1`,
      [reactionId]
    )
  ).rows;

const statusOf = (
  outcomes: Awaited<ReturnType<typeof convergeReactionRules>>["outcomes"],
  id: string
) => outcomes.find((o) => o.reactionId === id)?.status;

beforeAll(async () => {
  for (const t of [skills, podSettings]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
});

beforeEach(async () => {
  await h.client!.exec("delete from skills; delete from pod_settings;");
  vi.mocked(updateRuleGoverned).mockClear();
  resetReactionRegistryForTests();
  declaring = [declared];
  registerReactionSource({
    id: "test-declared",
    subjectTypes: ["entity"],
    list: async () => declaring,
  });
});

describe("the compile pass seeds one rule row per reaction", () => {
  it("built-in and declared, each a prose rule marked with its reaction, owned and stamped", async () => {
    const r = await convergeReactionRules();
    expect(r.status).toBe("applied");
    for (const b of BUILT_IN_REACTIONS) {
      expect(statusOf(r.outcomes, b.id)).toBe("created");
      const [row] = await rowsOf(b.id);
      expect(row!.user_id).toBe(OWNER);
      expect(row!.metadata.rule).toMatchObject({
        intent: reactionRuleIntent(b),
        reaction: { id: b.id },
        seed: { template: "reaction-rule", key: b.id },
      });
      expect(row!.metadata.rule.sentence).toBeUndefined();
    }
    const [own] = await rowsOf(declared.id);
    expect(own!.user_id).toBe(AUTHOR);
  });

  it("is idempotent: a second pass creates and updates nothing", async () => {
    await convergeReactionRules();
    const again = await convergeReactionRules();
    expect(new Set(again.outcomes.map((o) => o.status))).toEqual(
      new Set(["unchanged"])
    );
    expect(updateRuleGoverned).not.toHaveBeenCalled();
    expect(await rowsOf(declared.id)).toHaveLength(1);
  });
});

describe("the owner wins", () => {
  it("their pause stays paused across passes, and the reactor reads it paused", async () => {
    await convergeReactionRules();
    const paused = await setReactionRuleOn({
      userId: OWNER,
      reactionId: "builtin:stopped-run-needs-you",
      on: false,
    });
    expect(paused.status).toBe("updated");
    const r = await convergeReactionRules();
    expect(statusOf(r.outcomes, "builtin:stopped-run-needs-you")).toBe(
      "owner_choice"
    );
    registerReactionStateSource(() => reactionEnabledStates());
    const list = await listReactions();
    expect(
      list.find((x) => x.id === "builtin:stopped-run-needs-you")!.enabled
    ).toBe(false);
    expect(list.find((x) => x.id === declared.id)!.enabled).toBe(true);

    await setReactionRuleOn({
      userId: OWNER,
      reactionId: "builtin:stopped-run-needs-you",
      on: true,
    });
    expect(
      (await listReactions()).find(
        (x) => x.id === "builtin:stopped-run-needs-you"
      )!.enabled
    ).toBe(true);
  });

  it("their edit is kept: an edited intent is not overwritten", async () => {
    await convergeReactionRules();
    const [row] = await rowsOf(declared.id);
    await q(
      `update skills set metadata = jsonb_set(metadata, '{rule,intent}', '"My own words."') where id = $1`,
      [row!.id]
    );
    const r = await convergeReactionRules();
    expect(statusOf(r.outcomes, declared.id)).toBe("kept");
    expect((await rowsOf(declared.id))[0]!.metadata.rule.intent).toBe(
      "My own words."
    );
  });

  it("a row its owner deleted is not recreated", async () => {
    await convergeReactionRules();
    await q(
      `delete from skills where metadata->'rule'->'reaction'->>'id' = $1`,
      [declared.id]
    );
    const r = await convergeReactionRules();
    expect(statusOf(r.outcomes, declared.id)).toBe("owner_choice");
    expect(await rowsOf(declared.id)).toHaveLength(0);
  });
});

describe("declarations come and go", () => {
  it("an undeclared rule is retired (a draft), and re-activated when declared again", async () => {
    await convergeReactionRules();
    declaring = [];
    const off = await convergeReactionRules();
    expect(statusOf(off.outcomes, declared.id)).toBe("retired");
    expect((await rowsOf(declared.id))[0]!.metadata.rule.draft).toBe(true);
    // Retired by the pass, not paused by its owner: a later pass leaves it.
    const still = await convergeReactionRules();
    expect(statusOf(still.outcomes, declared.id)).toBeUndefined();

    declaring = [declared];
    const on = await convergeReactionRules();
    expect(statusOf(on.outcomes, declared.id)).toBe("reactivated");
    expect((await rowsOf(declared.id))[0]!.metadata.rule.draft).toBeUndefined();
  });

  it("a declaration whose words move is restamped (an untouched row takes the update)", async () => {
    await convergeReactionRules();
    declaring = [{ ...declared, title: "Campaigns finish with their posts" }];
    const r = await convergeReactionRules();
    expect(statusOf(r.outcomes, declared.id)).toBe("updated");
    expect((await rowsOf(declared.id))[0]!.metadata.rule.intent).toMatch(
      /^Campaigns finish with their posts\./
    );
  });
});
