/**
 * Entity FILL on the deep-import mapping path.
 *
 * Regression cover for the "hollow knowledge import" defect: markdown imports
 * produced excellent titles with `properties: {}` and no body, because
 *   (1) the structuring model was never told which properties a profile has
 *       (`propertyHints` was always undefined — see the capture-router test),
 *   (2) the mapper dropped the model's own `content` field, and
 *   (3) nothing validated the ops, so an entity missing a REQUIRED property
 *       (e.g. `knowledge` needs `knowledgeForm`) reached
 *       `EntityRepository.create` at apply and threw, aborting the WHOLE
 *       composite proposal.
 *
 * These tests pin (2) and (3) on the mapping function itself — the dry-run
 * against a deployed pod cannot prove a local change.
 */

import { describe, it, expect, vi } from "vitest";
import {
  deepStructureImportItems,
  type StructureCapableClient,
} from "../import-deep.js";
import type { ImportItem } from "../import-items.js";

const deps = { logger: { warn: () => {} } };

const item = (over: Partial<ImportItem> = {}): ImportItem =>
  ({
    title: "Source note",
    body: "Some real prose from the memory file.",
    path: [],
    links: [],
    ...over,
  }) as ImportItem;

/** A client that returns exactly the entities given, with no relations. */
const clientReturning = (
  entities: Array<Record<string, unknown>>
): StructureCapableClient =>
  ({
    structure: vi.fn(async () => ({
      entities,
      relations: [],
    })),
  }) as unknown as StructureCapableClient;

const createOps = (ops: Array<Record<string, unknown>>) =>
  ops.filter((o) => o.op === "create_entity");

describe("deep import — model-supplied content reaches the op", () => {
  it("carries the entity's `content` field onto the create_entity op", async () => {
    const body =
      "The claim, spelled out in full prose across more than one sentence. " +
      "It is the thing that makes recall useful.";
    const res = await deepStructureImportItems(
      [item()],
      clientReturning([
        {
          tempId: "t1",
          profileSlug: "knowledge",
          title: "feed.post fails open when ctx.workspaceId is undefined",
          content: body,
          properties: { ek_type: "gotcha", ek_claim: "feed.post fails open" },
          confidence: 0.9,
        },
      ]),
      { validSlugs: new Set(["knowledge", "note"]), includeProvenance: false },
      deps
    );

    const ops = createOps(
      res.operations as unknown as Array<Record<string, unknown>>
    );
    expect(ops).toHaveLength(1);
    expect(ops[0].profileSlug).toBe("knowledge");
    expect(ops[0].content).toBe(body);
    expect(ops[0].properties).toEqual({
      ek_type: "gotcha",
      ek_claim: "feed.post fails open",
      knowledgeForm: "caution",
    });
    expect(res.stats.documentCount).toBe(1);
  });

  it("still prefers a long description when the model emits no content", async () => {
    const long = "x".repeat(1200);
    const res = await deepStructureImportItems(
      [item()],
      clientReturning([
        {
          tempId: "t1",
          profileSlug: "note",
          title: "A note",
          description: long,
          properties: {},
          confidence: 0.9,
        },
      ]),
      { validSlugs: new Set(["note"]), includeProvenance: false },
      deps
    );
    const ops = createOps(
      res.operations as unknown as Array<Record<string, unknown>>
    );
    expect(ops[0].content).toBe(long);
  });
});

describe("deep import — schema preflight", () => {
  /** Rejects `knowledge` unless it carries the canonical knowledgeForm. */
  const knowledgeValidator = async ({
    profileSlug,
    properties,
  }: {
    profileSlug: string;
    properties?: Record<string, unknown>;
  }) => {
    if (profileSlug !== "knowledge") return { valid: true, errors: [] };
    const errors: string[] = [];
    if (!properties?.knowledgeForm)
      errors.push("Property 'knowledgeForm' is required");
    return { valid: errors.length === 0, errors };
  };

  it("degrades an un-materializable entity to a note, preserving title + body", async () => {
    const body = "The prose that backs this headline.";
    const res = await deepStructureImportItems(
      [item()],
      clientReturning([
        {
          tempId: "t1",
          profileSlug: "knowledge",
          title: "Sovereign single-user pod 403 risk on own workspace",
          content: body,
          properties: {}, // hollow — exactly what the live import produced
          confidence: 0.9,
        },
      ]),
      {
        validSlugs: new Set(["knowledge", "note"]),
        includeProvenance: false,
        validateEntity: knowledgeValidator,
      },
      deps
    );

    const ops = createOps(
      res.operations as unknown as Array<Record<string, unknown>>
    );
    expect(ops).toHaveLength(1);
    // NOT filed as hollow knowledge (which would throw at apply)…
    expect(ops[0].profileSlug).toBe("note");
    // …and NOT fabricated into a made-up claim.
    expect(ops[0].properties).toEqual({});
    // The title and the prose both survive.
    expect(ops[0].title).toBe(
      "Sovereign single-user pod 403 risk on own workspace"
    );
    expect(ops[0].content).toBe(body);

    expect(res.stats.degradedToNote).toBe(1);
    expect(res.stats.degradedByProfile).toEqual({ knowledge: 1 });
    expect(res.stats.byType).toEqual({ note: 1 });
  });

  it("keeps the typed profile when the required properties ARE present", async () => {
    const res = await deepStructureImportItems(
      [item()],
      clientReturning([
        {
          tempId: "t1",
          profileSlug: "knowledge",
          title: "Judgement call: throw on out-of-scope channel",
          properties: {
            ek_type: "decision",
            ek_claim: "Throw on out-of-scope channel; don't fall back.",
          },
          confidence: 0.9,
        },
      ]),
      {
        validSlugs: new Set(["knowledge", "note"]),
        includeProvenance: false,
        validateEntity: knowledgeValidator,
      },
      deps
    );

    const ops = createOps(
      res.operations as unknown as Array<Record<string, unknown>>
    );
    expect(ops[0].profileSlug).toBe("knowledge");
    expect(ops[0].properties).toMatchObject({
      ek_type: "decision",
      knowledgeForm: "insight",
    });
    expect(res.stats.degradedToNote).toBe(0);
    expect(res.stats.degradedByProfile).toEqual({});
  });

  it("without a validator, behaviour is unchanged (hollow op still emitted)", async () => {
    const res = await deepStructureImportItems(
      [item()],
      clientReturning([
        {
          tempId: "t1",
          profileSlug: "knowledge",
          title: "Hollow",
          properties: {},
          confidence: 0.9,
        },
      ]),
      { validSlugs: new Set(["knowledge", "note"]), includeProvenance: false },
      deps
    );
    const ops = createOps(
      res.operations as unknown as Array<Record<string, unknown>>
    );
    expect(ops[0].profileSlug).toBe("knowledge");
    expect(res.stats.degradedToNote).toBe(0);
  });

  it("never runs the preflight on an entity already typed as note", async () => {
    const validateEntity = vi.fn(async () => ({ valid: true, errors: [] }));
    await deepStructureImportItems(
      [item()],
      clientReturning([
        {
          tempId: "t1",
          profileSlug: "note",
          title: "Plain",
          properties: {},
          confidence: 0.9,
        },
      ]),
      {
        validSlugs: new Set(["note"]),
        includeProvenance: false,
        validateEntity,
      },
      deps
    );
    expect(validateEntity).not.toHaveBeenCalled();
  });
});
