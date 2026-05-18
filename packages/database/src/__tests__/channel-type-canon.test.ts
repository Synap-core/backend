/**
 * Drift-Guard: Channel V2 canonical type vocabulary.
 *
 * Synap's channel system V2 specifies 6 canonical channelTypes. The pod
 * previously drifted into 4 types + a `thread_kind` discriminator, masking
 * the loss of `personal` and `sub_thread` behind a side-column. This test
 * fails if the TS enum drifts from the spec, if ThreadKind is ever
 * re-introduced, or if the migration vocabulary diverges from the TS enum.
 *
 * Spec: synap-team-docs/content/team/platform/channel-system.mdx
 */

import { describe, test, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ChannelType } from "../schema/channels.js";
import * as channelsSchema from "../schema/channels.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Canonical V2 spec — the single source of truth this test guards.
const SPEC_CHANNEL_TYPES = [
  "personal",
  "thread",
  "sub_thread",
  "feed",
  "external",
  "agent_collab",
] as const;

describe("Channel V2 type vocabulary — drift guard", () => {
  test("ChannelType TS enum matches the V2 spec — 6 canonical types", () => {
    const tsValues = Object.values(ChannelType).sort();
    const specValues = [...SPEC_CHANNEL_TYPES].sort();
    expect(tsValues).toEqual(specValues);
  });

  test("ThreadKind enum is not re-introduced on the channels schema", () => {
    expect("ThreadKind" in channelsSchema).toBe(false);
  });

  test("baseline schema declares channel_type without re-introducing thread_kind", () => {
    const baselinePath = path.join(
      __dirname,
      "../../migrations/0000_baseline_schema.sql"
    );
    const sql = readFileSync(baselinePath, "utf-8");

    // channel_type column must exist on channels (text, no CHECK — see 0023 notes).
    expect(sql).toMatch(/"channel_type"\s+text/);

    // thread_kind was dropped in 0010 — must not reappear in the baseline.
    expect(sql).not.toMatch(/thread_kind/);
  });

  test("0023_channel_v2_restore migration references all 6 canonical channel types", () => {
    // 0000_baseline_schema.sql has no CHECK constraint on channel_type (it's
    // a plain TEXT column — Drizzle's `enum:[]` is TS-only). The migration
    // that restores the V2 vocabulary is 0023; this is where the 6 canonical
    // values must collectively appear (4 documented as pre-existing in the
    // header, plus the 2 new ones — `personal` and `sub_thread` — added via
    // backfill UPDATEs).
    const migrationPath = path.join(
      __dirname,
      "../../migrations/0023_channel_v2_restore.sql"
    );
    const sql = readFileSync(migrationPath, "utf-8");

    for (const value of SPEC_CHANNEL_TYPES) {
      expect(
        sql.includes(value),
        `Migration 0023 must reference canonical channelType "${value}" ` +
          `(header doc or backfill UPDATE). Drift detected.`
      ).toBe(true);
    }
  });

  test("Drizzle column declaration includes every canonical type in its enum tuple", () => {
    const schemaPath = path.join(__dirname, "../schema/channels.ts");
    const source = readFileSync(schemaPath, "utf-8");

    // Find the channel_type column declaration block.
    const match = source.match(
      /channelType:\s*text\("channel_type",\s*\{\s*enum:\s*\[([\s\S]*?)\]/
    );
    expect(
      match,
      "Could not locate channel_type column enum tuple in channels.ts"
    ).not.toBeNull();

    const enumBlock = match![1];
    for (const value of SPEC_CHANNEL_TYPES) {
      expect(
        enumBlock.includes(`ChannelType.${tokenFor(value)}`) ||
          enumBlock.includes(`"${value}"`),
        `Drizzle channel_type enum tuple is missing canonical value "${value}".`
      ).toBe(true);
    }
  });
});

// Maps a canonical value (e.g. "sub_thread") to its TS enum key ("SUB_THREAD").
function tokenFor(value: string): string {
  return value.toUpperCase();
}
