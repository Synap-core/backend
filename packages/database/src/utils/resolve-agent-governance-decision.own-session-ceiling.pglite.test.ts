/**
 * F2 (founder, 2026-10-27) — an agent's bookkeeping of its OWN focus session
 * does not spend, nor wait on, the daily write ceiling (rung 2.56). Every other
 * write still does.
 *
 * Real `resolveAgentGovernanceDecision`, `countAgentWritesTodayUtc` and
 * `isOwnSessionBookkeeping` on PGlite, minimal DDL for the tables they read.
 * "Own" is proven from the session row (owner + roster), so the fixtures below
 * are sessions that differ in exactly one of the two facts.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  countAgentWritesTodayUtc,
  isOwnSessionBookkeeping,
  resolveAgentGovernanceDecision,
} from "./resolve-agent-governance-decision.js";

let pg: PGlite;
let db: any;

const HUMAN = "11111111-1111-4111-8111-111111111111";
const OTHER_HUMAN = "11111111-1111-4111-8111-999999999999";
const AGENT = "22222222-2222-4222-8222-222222222222";
const OTHER_AGENT = "22222222-2222-4222-8222-999999999999";
/** Owned by HUMAN, AGENT on its roster: the agent's own session. */
const OWN = "33333333-3333-4333-8333-333333333333";
/** Owned by HUMAN, but only OTHER_AGENT on its roster. */
const NOT_ON_ROSTER = "33333333-3333-4333-8333-444444444444";
/** AGENT on its roster, but owned by OTHER_HUMAN. */
const OTHER_OWNER = "33333333-3333-4333-8333-555555555555";
const OWN_ROOM = "44444444-4444-4444-8444-333333333333";
const OTHER_ROOM = "44444444-4444-4444-8444-444444444444";
/** A session id the create door just minted: no row yet. */
const FRESH = "33333333-3333-4333-8333-666666666666";
const LIMIT = 3;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE users (
      id text PRIMARY KEY,
      user_type text NOT NULL DEFAULT 'human',
      agent_metadata jsonb,
      agent_type text,
      host_user_id text
    );
    CREATE TYPE governance_principal AS ENUM ('agent','any','class');
    CREATE TYPE governance_scope AS ENUM ('workspace','pod');
    CREATE TYPE governance_target AS ENUM ('action','profile','capability','connection');
    CREATE TYPE governance_verdict AS ENUM ('auto','propose');
    CREATE TABLE governance_rules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      principal_kind governance_principal NOT NULL,
      agent_user_id text,
      principal_class text,
      scope_kind governance_scope NOT NULL,
      workspace_id uuid,
      target_kind governance_target NOT NULL,
      target_pattern text NOT NULL,
      target_profile text,
      verdict governance_verdict NOT NULL,
      source_proposal_id uuid,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      expires_at timestamptz
    );
    CREATE TABLE governance_ceilings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      principal_kind text NOT NULL,
      agent_user_id text,
      principal_class text,
      scope_kind text NOT NULL,
      workspace_id uuid,
      axis text NOT NULL,
      limit_value integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      expires_at timestamptz,
      subject_type text,
      subject_id text
    );
    CREATE TABLE events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_user_id text,
      is_agent boolean,
      proposal_id uuid,
      ceiling_exempt boolean,
      timestamp timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE focus_sessions (
      id uuid PRIMARY KEY,
      user_id text NOT NULL,
      agent_ids text[] DEFAULT '{}',
      channel_id uuid
    );
  `);
  await pg.exec(`
    INSERT INTO users (id, user_type, agent_metadata) VALUES
      ('${HUMAN}', 'human', null),
      ('${AGENT}', 'agent',
        '{"autoApproveFor":["entity.create","focus_session.create","focus_session.update"]}');
    INSERT INTO governance_ceilings (principal_kind, agent_user_id, scope_kind, axis, limit_value)
      VALUES ('agent', '${AGENT}', 'pod', 'daily_write_count', ${LIMIT});
    INSERT INTO focus_sessions (id, user_id, agent_ids, channel_id) VALUES
      ('${OWN}', '${HUMAN}', ARRAY['${AGENT}'], '${OWN_ROOM}'),
      ('${NOT_ON_ROSTER}', '${HUMAN}', ARRAY['${OTHER_AGENT}'], '${OTHER_ROOM}'),
      ('${OTHER_OWNER}', '${OTHER_HUMAN}', ARRAY['${AGENT}'], null);
  `);
  db = drizzle(pg);
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

/** Today's spine for AGENT: `counted` ordinary writes + `exempt` bookkeeping. */
async function seedToday(counted: number, exempt: number): Promise<void> {
  await pg.exec(`DELETE FROM events;`);
  for (let i = 0; i < counted; i++) {
    await pg.exec(
      `INSERT INTO events (agent_user_id, is_agent) VALUES ('${AGENT}', true);`
    );
  }
  for (let i = 0; i < exempt; i++) {
    await pg.exec(
      `INSERT INTO events (agent_user_id, is_agent, ceiling_exempt) VALUES ('${AGENT}', true, true);`
    );
  }
}

const decide = async (
  subjectType: string,
  action: string,
  subjectEntityId: string | null
) =>
  resolveAgentGovernanceDecision({
    db,
    agentUserId: AGENT,
    userId: HUMAN,
    workspaceId: null,
    subjectType,
    action,
    subjectEntityId,
    preferAgentMetadataAutoApproveFor: true,
  });

describe("F2 — own-session bookkeeping and the daily write ceiling", () => {
  describe("at the limit", () => {
    beforeEach(() => seedToday(LIMIT, 0));

    it("an ordinary write is held (propose, DAILY_WRITE_CEILING)", async () => {
      const r = await decide("entity", "create", null);
      expect(r.decision).toBe("propose");
      expect((r as { reasonCode?: string }).reasonCode).toBe(
        "DAILY_WRITE_CEILING"
      );
    });

    it("an update of its OWN session is not held", async () => {
      expect((await decide("focus_session", "update", OWN)).decision).toBe(
        "execute"
      );
    });

    it("starting a session (a freshly minted id) is not held", async () => {
      expect((await decide("focus_session", "create", FRESH)).decision).toBe(
        "execute"
      );
    });

    it("a session the agent is NOT on is held", async () => {
      const r = await decide("focus_session", "update", NOT_ON_ROSTER);
      expect(r.decision).toBe("propose");
    });

    it("a session another person owns is held", async () => {
      const r = await decide("focus_session", "update", OTHER_OWNER);
      expect(r.decision).toBe("propose");
    });

    it("a 'create' naming an EXISTING session it does not own is held", async () => {
      const r = await decide("focus_session", "create", NOT_ON_ROSTER);
      expect(r.decision).toBe("propose");
    });
  });

  describe("the count", () => {
    it("bookkeeping stamped at write time does not spend the budget", async () => {
      await seedToday(LIMIT - 1, 10);
      expect(await countAgentWritesTodayUtc(db, AGENT)).toBe(LIMIT - 1);
      // …so the next ordinary write still runs.
      expect((await decide("entity", "create", null)).decision).toBe("execute");
    });

    it("unstamped rows (every row before 0365) still count", async () => {
      await seedToday(LIMIT, 0);
      expect(await countAgentWritesTodayUtc(db, AGENT)).toBe(LIMIT);
    });
  });

  describe("isOwnSessionBookkeeping (the write-time stamp's proof)", () => {
    const own = (
      subjectType: string,
      action: string,
      subjectId: string | null,
      who: { userId?: string; agentUserId?: string } = {}
    ) =>
      isOwnSessionBookkeeping(db, {
        userId: who.userId ?? HUMAN,
        agentUserId: who.agentUserId ?? AGENT,
        subjectType,
        action,
        subjectId,
      });

    it("own session: update and create (row exists) are bookkeeping", async () => {
      expect(await own("focus_session", "update", OWN)).toBe(true);
      expect(await own("focus_session", "create", OWN)).toBe(true);
    });

    it("its own session's room is bookkeeping; another room is not", async () => {
      expect(await own("channel", "update", OWN_ROOM)).toBe(true);
      expect(await own("channel", "update", OTHER_ROOM)).toBe(false);
    });

    it("never: another agent, another owner, another action, another subject", async () => {
      expect(
        await own("focus_session", "update", OWN, { agentUserId: OTHER_AGENT })
      ).toBe(false);
      expect(
        await own("focus_session", "update", OWN, { userId: OTHER_HUMAN })
      ).toBe(false);
      expect(await own("focus_session", "assign_agent", OWN)).toBe(false);
      expect(await own("focus_session", "delete", OWN)).toBe(false);
      expect(await own("entity", "update", OWN)).toBe(false);
      expect(await own("focus_session", "update", null)).toBe(false);
      // An update of a session that does not exist is not "own".
      expect(await own("focus_session", "update", FRESH)).toBe(false);
    });
  });
});
