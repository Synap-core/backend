/**
 * "ANY LINK → DATA", end to end — the founder's acceptance criterion as ONE
 * chain on a real Postgres (PGlite, every table of the Drizzle schema):
 *
 *   An Instagram carousel kept from the phone ends in the Library with its
 *   images stored, its caption read, findable by search, readable by the AI,
 *   and buildable into the Brand space.
 *
 * Every step goes through the REAL door, in the order a person meets them:
 *   1. keep        `addToLibrary` (library.add) → a light-read job is queued;
 *   2. auto read   the job (`runLibraryLightReadJob`, real deps) → the real
 *                  `readUrl` → the built-in ladder: Instagram is never fetched
 *                  by the pod → `needs_file` + blocked `needs_reader`; the
 *                  billed reader is NOT run on its own;
 *   3. offers      `libraryReaders` (library.readers) → the installed, turned-on
 *                  Apify reader (real skill/tool/container rows declaring IG
 *                  urls) is `ready`, billed to the account;
 *   4. tap         `libraryReadWith` (library.readWith) on the list → one job
 *                  carrying the reader;
 *   5. read        that job → `readUrl` → `executeCapability` (THE VERB RUN IS
 *                  FAKED here) → caption + 3 slides + a video → media copied by
 *                  the real copy door into real (local-fs) storage, the video
 *                  transcribed (IS faked), the read stamped and stored;
 *   6. search      `searchLibraryWithReadText` (library.search) by a caption
 *                  word AND by a word only the stored read text holds;
 *   7. AI          the `ask` Library lane (`searchLibraryForAsk`) returns it,
 *                  with a snippet of the read text and who read it;
 *   8. target      `curateLibrary` group.update workspaceId → the Brand space
 *                  (real membership check);
 *   9. Build       `buildLibraryGroup` with the production deps' storage read
 *                  → structured from the STORED read (caption + transcript),
 *                  filed into Brand, the copied slides handed on as
 *                  `media-urls`; the entity copy takes those bytes from the
 *                  Library (`imageFromLibraryCopy`) — the CDN is never asked
 *                  again, the reader never runs again.
 *
 * Faked, and only at their seams: the network (`safePublicFetch` /
 * `safeExternalFetch` — a URL table serving real PNG / MP4 magic bytes, every
 * request counted), the Apify verb run (`executeCapability`), the IS
 * (transcript, summary, structurer — remote services), the search index
 * (Typesense: a fake index fed by the real `search-index` jobs, matching the
 * real stored read text), the job queue (`getBoss().send` records jobs; the
 * test runs them), and the pod event log (append no-op). Storage is the REAL
 * local-fs provider on a temp dir.
 *
 * Negative controls (each mutation grep-verified, then restored sha-identical):
 *   - `libraryReadWith` enqueuing its job WITHOUT the reader → steps 4, 5, 6,
 *     7, 9 red (the job reads automatically: needs_reader, no verb run, no
 *     media, nothing to find, Build refused);
 *   - Build's `withLibraryMedia` handing nothing on → step 9 red only.
 * Not covered here: the entity media-copy RUNNER after approval (its own
 * suites); step 9 calls the hand-off door it consults first.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      query: <T = Record<string, any>>(
        sql: string,
        params?: unknown[]
      ) => Promise<{ rows: T[] }>;
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
    storageDir: "",
    /** Jobs sent to pg-boss, by queue. */
    jobs: [] as Array<{ queue: string; data: Record<string, unknown> }>,
    /** Every outbound request the pod made, by URL. */
    fetched: [] as string[],
    /** The web: URL → bytes + content type. */
    web: new Map<string, { bytes: Uint8Array; type: string }>(),
    /** What the Apify verb run was asked, and what it answers. */
    verbRuns: [] as Array<Record<string, unknown>>,
    verbAnswer: null as unknown,
    /** Documents the search-index jobs upserted (the fake index's corpus). */
    indexed: new Set<string>(),
    transcribed: 0,
  };
  return state;
});

vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const db = await h.init();
  return {
    ...actual,
    db,
    getDb: async () => db,
    // The pod's event log (a separate store); the rows under test are real.
    eventRepository: { append: async () => undefined },
  };
});

// Storage: the REAL local-fs provider, on a temp dir.
vi.mock("@synap/storage", async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  h.storageDir = mkdtempSync(join(tmpdir(), "any-link-e2e-"));
  return {
    ...actual,
    storage: new actual.LocalStorageProvider({ rootDir: h.storageDir }),
  };
});

// The job queue: record; the test runs the light-read jobs itself.
vi.mock("@synap/jobs", () => ({
  getBoss: () => ({
    send: async (queue: string, data: Record<string, unknown>) => {
      h.jobs.push({ queue, data });
      if (queue === "search-index" && typeof data.documentId === "string") {
        h.indexed.add(data.documentId);
      }
      return randomUUID();
    },
  }),
}));

// THE NETWORK: a URL table; anything else is an error (and is recorded).
vi.mock("@synap/shared-utils", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const serve = async (url: string | URL) => {
    const u = String(url);
    h.fetched.push(u);
    const page = h.web.get(u);
    if (!page) throw new Error(`unexpected outbound request: ${u}`);
    return new Response(new Uint8Array(page.bytes), {
      status: 200,
      headers: {
        "content-type": page.type,
        "content-length": String(page.bytes.byteLength),
      },
    });
  };
  return { ...actual, safePublicFetch: serve, safeExternalFetch: serve };
});

// THE APIFY VERB RUN: the reader verb's execution (the vendor) is faked.
vi.mock("../../capabilities/execute-capability.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    executeCapability: async (input: Record<string, unknown>) => {
      h.verbRuns.push(input);
      return {
        kind: "run",
        result: h.verbAnswer,
        correlationId: `corr-${h.verbRuns.length}`,
      };
    },
  };
});

// THE IS (a remote service): transcript; the summary call is down.
vi.mock("../../../utils/intelligence-routing.js", () => ({
  resolveIntelligenceService: async () => ({
    client: {
      transcribe: async () => {
        h.transcribed++;
        return {
          ok: true,
          text: "We shot this at golden hour in Lisbon with a borrowed lens.",
          language: "en",
        };
      },
    },
  }),
}));
vi.mock("../../mail-feed/generate.js", () => ({
  generateViaIS: async () => null,
}));
vi.mock("@synap/intelligence-client", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getDefaultActiveService: async () => {
      throw new Error("no IS in test");
    },
  };
});

// THE SEARCH INDEX (Typesense): a fake index over what the real search-index
// jobs upserted, matching the REAL stored read text of each document.
vi.mock("@synap/search", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    searchService: {
      searchCollection: async (
        collection: string,
        q: string,
        opts: { userId: string; limit: number; libraryOnly?: boolean }
      ) => {
        if (collection !== "documents") return { results: [] };
        const { storage } = await import("@synap/storage");
        const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
        const results: Array<{ id: string }> = [];
        for (const id of h.indexed) {
          const { rows } = await h.client!.query<{
            user_id: string;
            metadata: any;
          }>(`select user_id, metadata from documents where id = $1`, [id]);
          const row = rows[0];
          if (!row || row.user_id !== opts.userId) continue;
          if (opts.libraryOnly && !row.metadata?.importItem) continue;
          const key = row.metadata?.importRead?.textKey;
          const text =
            typeof key === "string"
              ? (await storage.downloadBuffer(key)).toString("utf-8")
              : "";
          const hay = `${row.metadata?.importItem?.title ?? ""}\n${text}`;
          if (terms.some((t) => hay.toLowerCase().includes(t))) {
            results.push({ id });
          }
        }
        return { results: results.slice(0, opts.limit) };
      },
    },
  };
});

import * as schema from "@synap/database/schema";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { pgliteTableDdl } from "../../../__tests__/pglite-ddl.js";
import { invalidateUrlReaderCache } from "../../capabilities/url-readers.js";
import { addToLibrary } from "../add.js";
import { runLibraryLightReadJob } from "../light-read-queue.js";
import { libraryReaders, libraryReadWith } from "../readers.js";
import { curateLibrary } from "../curate.js";
import { listLibraryItems } from "../read-model.js";
import { searchLibraryWithReadText } from "../search.js";
import { searchLibraryForAsk } from "../ask-lane.js";
import { buildLibraryGroup } from "../build.js";
import { loadLibraryGroup } from "../groups.js";
import {
  defaultImportBuildDeps,
  type ImportBuildDeps,
} from "../../imports/build.js";
import type { SubmitCaptureGraphInput } from "../../capture-agent/submit-capture-graph.js";
import { imageFromLibraryCopy } from "../../media-copy/library-handoff.js";
import { mp4Head, png } from "../../media-copy/__tests__/fixtures.js";

const q = <T = Record<string, any>>(sql: string, params: unknown[] = []) =>
  h.client!.query<T>(sql, params);

const U = randomUUID();
const CONTENT_WS = randomUUID(); // where the Apify pack is installed
const BRAND_WS = randomUUID(); // the Brand space the list builds into
const CONTAINER = randomUUID();
const READER = "capture_social_post";

const IG = "https://www.instagram.com/p/C4r0usEl99/";
const CDN = "https://scontent-cdg4-1.cdninstagram.com/v/t51";
const SLIDES = [`${CDN}/s1.png`, `${CDN}/s2.png`, `${CDN}/s3.png`];
const VIDEO = `${CDN}/clip.mp4`;
const SLIDE_BYTES = [png(1080, 1350), png(1080, 1351), png(1080, 1352)];
const VIDEO_BYTES = new Uint8Array([
  ...mp4Head("isom"),
  ...new Uint8Array(2048).fill(7),
]);

// The caption runs past the summary's 400 characters, so a word of the
// spoken transcript lives ONLY in the stored read text (never in the row).
const CAPTION = [
  "Terracotta and sage: the palette for our autumn drop.",
  "Slide two shows the serif we chose for every headline, set tight.",
  "Slide three is the grid we use for product shots on a warm paper ground.",
  "Everything is shot on film, scanned flat, and never filtered.",
  "Swipe to the end for the reel where we talk through why each colour earned its place.",
  "Save this if you are building a brand that should feel calm and handmade.",
].join(" ");

let ITEM = "";
let GROUP = "";

function rawApifyRead() {
  return {
    status: "ok",
    title: "Autumn palette — carousel",
    author: "studio.north",
    authorUrl: "https://www.instagram.com/studio.north/",
    siteName: "Instagram",
    text: CAPTION,
    publishedAt: "2026-10-10T12:00:00.000Z",
    media: [
      ...SLIDES.map((url, i) => ({
        url,
        kind: "image",
        role: i === 0 ? "cover" : "slide",
        order: i,
      })),
      { url: VIDEO, kind: "video", role: "slide", order: 3, durationSec: 12 },
    ],
    fields: { likes: 1204, comments: 37 },
  };
}

async function itemMeta(): Promise<Record<string, any>> {
  const { rows } = await q(`select metadata from documents where id = $1`, [
    ITEM,
  ]);
  return rows[0]!.metadata;
}

const lightReadJobs = () =>
  h.jobs.filter((j) => j.queue === "library-light-read");

beforeAll(async () => {
  await h.init();
  // Every table of the schema (columns only; see pglite-ddl.ts).
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(pgliteTableDdl(t));
  await h.client!.exec(
    `create unique index library_groups_user_key_unique on library_groups (user_id, key)`
  );

  await q(`insert into users (id, email) values ($1, 'founder@example.com')`, [
    U,
  ]);
  for (const [id, name] of [
    [CONTENT_WS, "Content"],
    [BRAND_WS, "Brand Library"],
  ] as const) {
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1, $2, $3, '{}'::jsonb)`,
      [id, name, U]
    );
    await q(
      `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`,
      [id, U]
    );
  }

  // The INSTALLED, TURNED-ON Apify pack in the Content space: container +
  // credentialed tool + the reader verb declaring Instagram post URLs.
  await q(
    `insert into capabilities (id, workspace_id, created_by, name, approved, template_key, metadata)
     values ($1, $2, $3, 'Apify — Web Scraping', true, 'apify', '{"templateKey":"apify","contentHash":"hash-apify"}'::jsonb)`,
    [CONTAINER, CONTENT_WS, U]
  );
  const toolId = randomUUID();
  await q(
    `insert into tools (id, name, kind, approved, status, workspace_id, created_by, credential_ref, capabilities)
     values ($1, 'apify_api', 'api', true, 'active', $2, $3, 'vault://11111111-1111-4111-8111-111111111111', $4::jsonb)`,
    [
      toolId,
      CONTENT_WS,
      U,
      JSON.stringify([
        { id: READER, label: "Read a post", kind: "read", govDefault: "auto" },
      ]),
    ]
  );
  const skillId = randomUUID();
  await q(
    `insert into skills (id, name, kind, status, approved, scope, workspace_id, user_id, metadata, url_patterns, intent)
     values ($1, $2, 'code', 'active', true, 'pod', $3, $4, '{"readOnly":true}'::jsonb, $5, 'read_webpage')`,
    [
      skillId,
      READER,
      CONTENT_WS,
      U,
      ["instagram.com/p/*", "instagram.com/reel/*"],
    ]
  );
  for (const [ft, fid, tt, tid, lt] of [
    ["skill", skillId, "tool", toolId, "requires"],
    ["tool", toolId, "capability", CONTAINER, "member_of"],
    ["skill", skillId, "capability", CONTAINER, "member_of"],
  ] as const) {
    await q(
      `insert into links (from_type, from_id, to_type, to_id, link_type) values ($1, $2, $3, $4, $5)`,
      [ft, fid, tt, tid, lt]
    );
  }
  invalidateUrlReaderCache();

  // The web the CDN serves (real magic bytes).
  SLIDES.forEach((url, i) =>
    h.web.set(url, { bytes: SLIDE_BYTES[i]!, type: "image/png" })
  );
  h.web.set(VIDEO, { bytes: VIDEO_BYTES, type: "video/mp4" });
  h.verbAnswer = rawApifyRead();
}, 120_000);

afterAll(() => {
  if (h.storageDir) rmSync(h.storageDir, { recursive: true, force: true });
});

describe("an Instagram carousel kept from the phone → Library → search → AI → Brand", () => {
  it("1. keep: library.add stages it and queues its light read — the pod fetches nothing", async () => {
    const kept = await addToLibrary({
      userId: U,
      request: { items: [{ kind: "url", url: IG }], device: "relay" },
    });
    expect(kept.staged).toHaveLength(1);
    ITEM = kept.staged[0]!.itemId;
    expect(lightReadJobs().map((j) => j.data)).toEqual([
      { userId: U, itemId: ITEM },
    ]);
    // P1: the pod never requests an Instagram page (staging card included).
    expect(h.fetched).toEqual([]);
  });

  it("2. the automatic read: needs a reader — the billed reader never runs by itself", async () => {
    await runLibraryLightReadJob(lightReadJobs()[0]!.data as never);
    const read = (await itemMeta()).importRead;
    expect(read.status).toBe("needs_file");
    expect(read.blocked).toMatchObject({ reason: "needs_reader" });
    expect(read.reader.id).toMatch(/^builtin/);
    expect(h.verbRuns).toEqual([]);
    expect(h.fetched).toEqual([]);
  });

  it("3. library.readers: the installed, turned-on Apify reader is ready, billed to the account", async () => {
    const { offers } = await libraryReaders({ userId: U, itemId: ITEM });
    const apify = offers.find((o) => o.readerId === READER);
    expect(apify).toMatchObject({
      state: "ready",
      billing: "account",
      verbId: READER,
      capabilityId: CONTAINER,
    });
  });

  it("4. the person groups it and taps “Read with Apify” on the list: one job carrying the reader", async () => {
    const created = await curateLibrary({
      userId: U,
      ops: [
        {
          op: "group.create",
          name: "Branding inspiration",
          itemIds: [ITEM],
          note: "Pull out the palette, the type and the photo style.",
        },
      ],
    });
    GROUP = created.createdGroupIds[0]!;
    const before = lightReadJobs().length;
    const tapped = await libraryReadWith({
      userId: U,
      groupId: GROUP,
      readerId: READER,
    });
    expect(tapped).toEqual({ queued: 1, overBudget: 0, skipped: 0 });
    const job = lightReadJobs().slice(before);
    expect(job.map((j) => j.data)).toEqual([
      { userId: U, itemId: ITEM, force: true, reader: READER },
    ]);
  });

  it("5. the job reads it with Apify: caption read, reader stamped, every slide and the video stored in the pod", async () => {
    await runLibraryLightReadJob(lightReadJobs().at(-1)!.data as never);

    // The verb ran ONCE, for this URL, in the space its pack lives in.
    expect(h.verbRuns).toHaveLength(1);
    expect(h.verbRuns[0]).toMatchObject({
      verbId: READER,
      parameters: { url: IG },
      userId: U,
      workspaceId: CONTENT_WS,
      observability: "mirror",
    });

    const meta = await itemMeta();
    const read = meta.importRead;
    expect(read.status).toBe("read");
    expect(read.reader).toMatchObject({
      id: READER,
      verbId: READER,
      capabilityId: CONTAINER,
      contentHash: "hash-apify",
      correlationId: "corr-1",
      billed: true,
    });
    expect(read.transcript).toMatchObject({ source: "stt" });

    // The read text is STORED (real storage), caption + the video's speech.
    const { storage } = await import("@synap/storage");
    const text = (await storage.downloadBuffer(read.textKey)).toString("utf-8");
    expect(text).toContain("Terracotta and sage");
    expect(text).toContain("golden hour in Lisbon");
    expect(h.transcribed).toBe(1);

    // Every picture and the video: one stored document each, the bytes the
    // CDN served, each fetched exactly once — and never the IG page.
    const media = meta.importMedia as Array<Record<string, any>>;
    expect(media.map((m) => [m.sourceUrl, m.kind, m.order])).toEqual([
      [SLIDES[0], "image", 0],
      [SLIDES[1], "image", 1],
      [SLIDES[2], "image", 2],
      [VIDEO, "video", 3],
    ]);
    expect(meta.importMediaFailed ?? 0).toBe(0);
    for (const m of media) {
      const { rows } = await q(
        `select storage_key, mime_type, deleted_at from documents where id = $1 and user_id = $2`,
        [m.documentId, U]
      );
      expect(rows[0]!.deleted_at).toBeNull();
      const served = h.web.get(m.sourceUrl)!.bytes;
      const stored = await storage.downloadBuffer(rows[0]!.storage_key);
      expect(Buffer.compare(stored, Buffer.from(served))).toBe(0);
    }
    expect([...h.fetched].sort()).toEqual([...SLIDES, VIDEO].sort());

    // The Library's own read model shows it.
    const page = await listLibraryItems({ userId: U, input: {} });
    const view = page.items.find((i) => i.id === ITEM)!;
    expect(view.read.status).toBe("read");
    expect(view.read.reader?.id).toBe(READER);
    expect(view.media?.map((m) => m.kind)).toEqual([
      "image",
      "image",
      "image",
      "video",
    ]);
  });

  it("6. findable by search: by a caption word, and by a word only its stored read text holds", async () => {
    const byCaption = await searchLibraryWithReadText({
      userId: U,
      q: "terracotta",
      limit: 10,
    });
    expect(byCaption.items.map((i) => i.id)).toContain(ITEM);

    // "Lisbon" is in the transcript only: not the title, not the summary.
    const meta = await itemMeta();
    expect(JSON.stringify(meta.importRead.summary)).not.toMatch(/lisbon/i);
    const bySpeech = await searchLibraryWithReadText({
      userId: U,
      q: "Lisbon",
      limit: 10,
    });
    expect(bySpeech.readTextSearch).toBe("ok");
    expect(bySpeech.items.map((i) => i.id)).toEqual([ITEM]);
  });

  it("7. readable by the AI: the ask Library lane returns it, quoting its read text, saying who read it", async () => {
    const lane = await searchLibraryForAsk({
      userId: U,
      // Content words only the stored read text holds (the lane quotes the
      // summary instead when the summary holds any query word).
      query: "Lisbon golden hour",
      limit: 5,
    });
    expect(lane.readTextSearch).toBe("ok");
    const hit = lane.items.find((i) => i.id === ITEM);
    expect(hit).toMatchObject({
      sourceUrl: IG,
      readStatus: "read",
      snippetFrom: "read_text",
      reader: { id: READER, billed: true },
    });
    expect(hit!.snippet).toMatch(/Lisbon/);
  });

  it("8. the list builds into the Brand space (group.update, membership checked)", async () => {
    await curateLibrary({
      userId: U,
      ops: [{ op: "group.update", groupId: GROUP, workspaceId: BRAND_WS }],
    });
    const group = await loadLibraryGroup({ userId: U, groupId: GROUP });
    expect(group.workspaceId).toBe(BRAND_WS);
  });

  it("9. Build proposes into Brand from the STORED read, hands the copied slides on — the CDN and the reader are never asked again", async () => {
    const fetchedBefore = h.fetched.length;
    const verbRunsBefore = h.verbRuns.length;
    const structured: string[] = [];
    const submitted: SubmitCaptureGraphInput[] = [];
    let depsSpace: string | null | undefined;

    const result = await buildLibraryGroup({
      userId: U,
      groupId: GROUP,
      depsFor: ({ workspaceId }): ImportBuildDeps => {
        depsSpace = workspaceId;
        // The live pod's deps (storage read, the light read for unread
        // items); only the IS, the template match and the governed submit
        // are stood in for.
        const live = defaultImportBuildDeps({
          userId: U,
          workspaceId,
          trpcCtx: {},
        });
        return {
          ...live,
          structure: async ({ text }) => {
            structured.push(text);
            return {
              entities: [
                {
                  tempId: "t1",
                  profileSlug: "brand-asset",
                  title: "Autumn palette",
                  properties: { "asset-role": "inspiration" },
                },
              ],
              relations: [],
            } as never;
          },
          instructionsFor: async (explicit) => explicit || undefined,
          generate: async () => ({}),
          matchTemplates: async () => [],
          countRecent: async () => 0,
          submit: async (input) => {
            submitted.push(input);
            const { rows } = await q<{ id: string }>(
              `insert into proposals (status, proposal_type, target_type, target_id, data, subject_user_id)
               values ('pending', 'create', 'entity', gen_random_uuid(), '{}'::jsonb, $1) returning id`,
              [U]
            );
            return { proposalId: rows[0]!.id, applied: false };
          },
        };
      },
    });

    expect(result.status).toBe("proposed");
    expect(depsSpace).toBe(BRAND_WS);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.workspaceId).toBe(BRAND_WS);

    // Structured from the stored read: the caption AND the speech.
    expect(structured).toHaveLength(1);
    expect(structured[0]).toContain("Terracotta and sage");
    expect(structured[0]).toContain("golden hour in Lisbon");

    // The copied slides ride on the thing it made (the video does not).
    const asset = submitted[0]!.entities.find(
      (e) => (e as { profileSlug?: string }).profileSlug === "brand-asset"
    ) as { properties?: Record<string, unknown> } | undefined;
    expect(asset?.properties?.["media-urls"]).toEqual(SLIDES);

    // The entity media copy takes each slide from the Library's copy.
    for (const [i, url] of SLIDES.entries()) {
      const handed = await imageFromLibraryCopy(U, url);
      expect(handed?.ok).toBe(true);
      expect(Buffer.compare(handed!.bytes, Buffer.from(SLIDE_BYTES[i]!))).toBe(
        0
      );
    }

    // No re-fetch, no second (billed) reader run, anywhere in Build.
    expect(h.fetched.length).toBe(fetchedBefore);
    expect(h.verbRuns.length).toBe(verbRunsBefore);
  });
});
