/**
 * W15 — a Cal.com booking is a LEAD, never a deal. Drives a real booking
 * payload through the mapper, the capture-graph op builder
 * (`buildCaptureGraphOperations`, the one the submit door files) and the REAL
 * composite materializer (`materializeCompositeGraph`, the one approval and
 * auto-apply run), against an in-memory entity + facet store that mirrors the
 * facet door's two observable rules:
 *   - `attachFacet` on a role the entity already wears returns that facet
 *     UNCHANGED (`FacetRepository.attach`'s unique-violation path);
 *   - `updateFacet` is compare-and-set on `expectedStatus` (`moveStatus`).
 *
 * NOT covered here (no PGlite harness reaches the entities router + lifecycle
 * door + materializer together): the real SQL of the facet door, governance,
 * and identity resolution — the "existing person" cases pin `existingEntityId`
 * exactly as `submitCaptureGraph`'s `resolveIdentity` step does on an email hit.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ declared: true }));

const LEAD_ORDER = [
  "new",
  "researching",
  "outreach",
  "engaged",
  "qualified",
  "nurturing",
  "converted",
  "disqualified",
];

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  class FakeResolver {
    async getEffectiveLifecycle() {
      if (!h.declared) return null;
      return {
        propertySlug: "leadStage",
        propertyDefId: "d-lead",
        declaredOnProfileId: "p-lead",
        unclassified: [],
        options: LEAD_ORDER.map((key) => ({
          key,
          category:
            key === "converted"
              ? "done"
              : key === "disqualified"
                ? "lost"
                : key === "new"
                  ? "open"
                  : key === "nurturing"
                    ? "paused"
                    : "active",
        })),
      };
    }
    async getEffectiveProperties() {
      return [
        { slug: "leadStage", constraints: { enum: LEAD_ORDER } },
        { slug: "notes", constraints: {} },
      ];
    }
  }
  return { ...actual, ProfileResolutionService: FakeResolver };
});

import {
  mapBookingToGraph,
  type CalBookingPayload,
} from "./map-booking-to-graph.js";
import { buildCaptureGraphOperations } from "../capture-agent/submit-capture-graph.js";
import { materializeCompositeGraph } from "../../utils/materialize-composite.js";

/** A real BOOKING_CREATED payload shape (Cal.com webhook `payload`). */
const BOOKING: CalBookingPayload = {
  uid: "bk_w15",
  title: "Intro call",
  startTime: "2026-10-14T09:00:00Z",
  endTime: "2026-10-14T09:30:00Z",
  status: "ACCEPTED",
  videoCallData: { url: "https://cal.com/video/abc" },
  attendees: [
    { name: "Ada Lovelace", email: "ada@analytical.io", timeZone: "UTC" },
  ],
};

type Facet = {
  id: string;
  entityId: string;
  profileId: string;
  workspaceId: null;
  status: string | null;
  properties: Record<string, unknown>;
};

function store() {
  const entities = new Map<string, { id: string; profileSlug: string }>();
  const facets: Facet[] = [];
  const relations: Array<{ sourceId: string; targetId: string; type: string }> =
    [];
  let n = 0;
  const entityCaller = {
    create: vi.fn(async (input: { profileSlug: string }) => {
      const id = `ent-${++n}`;
      entities.set(id, { id, profileSlug: input.profileSlug });
      return { id };
    }),
    attachFacet: vi.fn(
      async (input: {
        entityId: string;
        profileSlug: string;
        status?: string;
        properties?: Record<string, unknown>;
      }) => {
        const existing = facets.find(
          (f) =>
            f.entityId === input.entityId &&
            f.profileId === `p-${input.profileSlug}`
        );
        if (existing) {
          return {
            status: "attached",
            facetId: existing.id,
            facet: { ...existing },
          };
        }
        const facet: Facet = {
          id: `fac-${++n}`,
          entityId: input.entityId,
          profileId: `p-${input.profileSlug}`,
          workspaceId: null,
          status: input.status ?? null,
          properties: { ...(input.properties ?? {}) },
        };
        facets.push(facet);
        return { status: "attached", facetId: facet.id, facet: { ...facet } };
      }
    ),
    updateFacet: vi.fn(
      async (input: {
        facetId: string;
        status: string;
        expectedStatus: string | null;
        properties: Record<string, unknown>;
      }) => {
        const f = facets.find((x) => x.id === input.facetId)!;
        if ((f.status ?? null) !== input.expectedStatus) {
          throw new Error("CONFLICT");
        }
        f.status = input.status;
        f.properties = { ...f.properties, ...input.properties };
        return { status: "updated" };
      }
    ),
  };
  const relationCaller = {
    create: vi.fn(
      async (input: {
        sourceEntityId: string;
        targetEntityId: string;
        type: string;
      }) => {
        relations.push({
          sourceId: input.sourceEntityId,
          targetId: input.targetEntityId,
          type: input.type,
        });
        return { id: `rel-${++n}` };
      }
    ),
  };
  return { entities, facets, relations, entityCaller, relationCaller };
}

async function applyBooking(
  s: ReturnType<typeof store>,
  existingPersonId?: string
) {
  const graph = mapBookingToGraph(BOOKING);
  if (existingPersonId) {
    // What submitCaptureGraph's resolveIdentity step does on an email hit.
    graph.entities.find((e) => e.ref === "person")!.existingEntityId =
      existingPersonId;
  }
  const operations = await buildCaptureGraphOperations({} as never, {
    entities: graph.entities,
    relations: graph.relations,
    projectId: null,
    workspaceId: null,
  });
  return materializeCompositeGraph(
    operations,
    s.entityCaller,
    s.relationCaller,
    undefined,
    { facetCaller: s.entityCaller }
  );
}

function seedPerson(s: ReturnType<typeof store>, leadStage?: string) {
  s.entities.set("person-ada", { id: "person-ada", profileSlug: "person" });
  if (leadStage) {
    s.facets.push({
      id: "fac-ada-lead",
      entityId: "person-ada",
      profileId: "p-lead",
      workspaceId: null,
      status: leadStage,
      properties: { leadStage },
    });
  }
}

beforeEach(() => {
  h.declared = true;
});

describe("Cal.com booking → lead (W15)", () => {
  it("a new attendee becomes a lead at engaged, the call is linked to them, and no deal exists", async () => {
    const s = store();
    await applyBooking(s);

    const created = s.entityCaller.create.mock.calls.map(
      (c) => (c[0] as { profileSlug: string }).profileSlug
    );
    expect(created).not.toContain("deal");
    expect(created.sort()).toEqual(["company", "event", "person"]);

    const person = [...s.entities.values()].find(
      (e) => e.profileSlug === "person"
    )!;
    const event = [...s.entities.values()].find(
      (e) => e.profileSlug === "event"
    )!;
    const lead = s.facets.filter((f) => f.profileId === "p-lead");
    expect(lead).toHaveLength(1);
    expect(lead[0]).toMatchObject({
      entityId: person.id,
      status: "engaged",
      properties: { leadStage: "engaged" },
    });
    expect(s.relations).toContainEqual({
      sourceId: event.id,
      targetId: person.id,
      type: "attended_by",
    });
    expect(s.relations.some((r) => r.type === "linked_to_deal")).toBe(false);
  });

  it("an existing lead at qualified stays qualified; only the event is recorded", async () => {
    const s = store();
    seedPerson(s, "qualified");
    await applyBooking(s, "person-ada");

    expect(s.facets.find((f) => f.id === "fac-ada-lead")).toMatchObject({
      status: "qualified",
      properties: { leadStage: "qualified" },
    });
    expect(s.entityCaller.updateFacet).not.toHaveBeenCalled();
    expect(s.facets.filter((f) => f.profileId === "p-lead")).toHaveLength(1);
    const event = [...s.entities.values()].find(
      (e) => e.profileSlug === "event"
    )!;
    expect(s.relations).toContainEqual({
      sourceId: event.id,
      targetId: "person-ada",
      type: "attended_by",
    });
  });

  it("a disqualified lead is not resurrected", async () => {
    const s = store();
    seedPerson(s, "disqualified");
    await applyBooking(s, "person-ada");
    expect(s.facets.find((f) => f.id === "fac-ada-lead")?.status).toBe(
      "disqualified"
    );
    expect(s.entityCaller.updateFacet).not.toHaveBeenCalled();
  });

  it("a lead at outreach moves FORWARD to engaged through the facet door (CAS on outreach)", async () => {
    const s = store();
    seedPerson(s, "outreach");
    await applyBooking(s, "person-ada");
    expect(s.entityCaller.updateFacet).toHaveBeenCalledWith(
      expect.objectContaining({
        facetId: "fac-ada-lead",
        status: "engaged",
        expectedStatus: "outreach",
      })
    );
    expect(s.facets.find((f) => f.id === "fac-ada-lead")).toMatchObject({
      status: "engaged",
      properties: { leadStage: "engaged" },
    });
  });

  it("an existing person who is not a lead yet gains the lead role at engaged", async () => {
    const s = store();
    seedPerson(s);
    await applyBooking(s, "person-ada");
    expect(
      s.facets.find(
        (f) => f.entityId === "person-ada" && f.profileId === "p-lead"
      )
    ).toMatchObject({ status: "engaged" });
  });

  it("with the lead lifecycle NOT declared yet, the select's order still decides (new → engaged, qualified kept)", async () => {
    h.declared = false;
    const a = store();
    seedPerson(a, "new");
    await applyBooking(a, "person-ada");
    expect(
      a.facets.find((f) => f.id === "fac-ada-lead")?.properties.leadStage
    ).toBe("engaged");

    const b = store();
    seedPerson(b, "qualified");
    await applyBooking(b, "person-ada");
    expect(b.entityCaller.updateFacet).not.toHaveBeenCalled();
  });
});
