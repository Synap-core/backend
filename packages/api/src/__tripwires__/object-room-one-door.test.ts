import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, relative } from "path";

/**
 * TRIPWIRE — an object's ONE linked channel has ONE mint (Documents v2).
 *
 * Every document / entity has exactly one conversation, its object room: a
 * GROUP channel stamped `context_object_type IN ('document','entity')`, minted
 * race-safely by `ChannelRepository.ensureObjectChannel` against the 0279
 * unique index. Before it, four doors minted "the channel about X" with three
 * different keys — one of them a NEW owner-private THREAD per comment
 * (`chat.createDocumentComment` / `createEntityComment`, retired), so a
 * comment never reached the object's conversation and other members got
 * NOT_FOUND opening it.
 *
 * What it catches: a raw `.insert(channels)` whose values stamp a LITERAL
 * `contextObjectType: "document" | "entity"` (the retired doors' shape), or
 * any insert of a GROUP channel carrying a context object, outside the door.
 * The allowed exceptions are the door itself and the private "Ask AI" thread
 * (a SUB_THREAD under the room, `services/comments/object-channel.ts`).
 *
 * What it CANNOT see: an insert whose values are built in a variable and
 * spread in, or a stamp written by a later UPDATE. Behaviour is pinned by
 * `services/comments/comments.pglite.test.ts` (one room under a race).
 */

const ALLOWLIST_SUFFIXES = [
  join("repositories", "channel-repository.ts"), // the door
  join("services", "comments", "object-channel.ts"), // private sub-thread
  // A SESSION's room is a GROUP stamped `focus_session` — its own one mint,
  // roster-only visibility (channel-visibility.ts), not an object room.
  join("services", "focus-sessions", "ensure-session-channel.ts"),
];

const INSERT =
  /\.insert\(\s*channels\s*\)\s*\.values\(\s*\{([\s\S]{0,1200}?)\}\s*\)/g;
const LITERAL_OBJECT_STAMP = /contextObjectType:\s*["'](document|entity)["']/;
const GROUP_WITH_CONTEXT =
  /channelType:\s*ChannelType\.GROUP[\s\S]*contextObjectType:|contextObjectType:[\s\S]*channelType:\s*ChannelType\.GROUP/;

function tsFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(p, acc);
    else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      acc.push(p);
    }
  }
  return acc;
}

export function offendingInserts(source: string): string[] {
  const hits: string[] = [];
  for (const m of source.matchAll(INSERT)) {
    const values = m[1];
    if (LITERAL_OBJECT_STAMP.test(values) || GROUP_WITH_CONTEXT.test(values)) {
      hits.push(values.trim().slice(0, 120));
    }
  }
  return hits;
}

describe("tripwire: object rooms have one mint", () => {
  const roots = [
    join(process.cwd(), "src"),
    join(process.cwd(), "..", "database", "src"),
    join(process.cwd(), "..", "jobs", "src"),
  ];
  const files = roots.flatMap((r) => tsFiles(r));

  it("scans a plausible tree, and still sees the retired shape", () => {
    expect(files.length).toBeGreaterThan(500);
    // Self-check: the retired per-comment insert is recognised.
    expect(
      offendingInserts(`await db.insert(channels).values({
        id: channelId,
        channelType: ChannelType.THREAD,
        contextObjectType: "document",
        contextObjectId: input.documentId,
      });`)
    ).toHaveLength(1);
    // …and so is a hand-rolled GROUP room about an object.
    expect(
      offendingInserts(
        `db.insert(channels).values({ channelType: ChannelType.GROUP, contextObjectType: ref.type })`
      )
    ).toHaveLength(1);
  });

  it("no source file mints an object-room-shaped channel outside the door", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (ALLOWLIST_SUFFIXES.some((s) => f.endsWith(s))) continue;
      for (const hit of offendingInserts(readFileSync(f, "utf8"))) {
        offenders.push(`${relative(join(process.cwd(), ".."), f)}: ${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the door itself is where the mint lives (non-vacuity)", () => {
    const door = files.find((f) =>
      f.endsWith(join("repositories", "channel-repository.ts"))
    )!;
    const src = readFileSync(door, "utf8");
    expect(src).toMatch(/async ensureObjectChannel\(/);
    expect(src).toMatch(/channelType:\s*ChannelType\.GROUP/);
  });
});
