/**
 * An op's declared `externalLinks` are registered through the caller's link
 * door (`options.idempotency.register`) on EVERY resolution path — created,
 * pinned existing, strong-signal deduped — carrying the source-app url and the
 * producing connection. This is what lets an APPROVED connection-sync import
 * land with its provider links immediately (no later sync adoption needed).
 */
import { describe, it, expect, vi } from "vitest";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import { materializeCompositeGraph } from "./materialize-composite.js";

const LINK = {
  provider: "google",
  externalId: "ev1",
  url: "https://www.google.com/calendar/event?eid=ZXYx",
  connectionId: "conn-1",
};

function door() {
  return {
    namespace: "u1:prop-1",
    provider: "import",
    lookup: vi.fn(async () => null),
    register: vi.fn(async () => undefined),
    relationExists: vi.fn(async () => false),
  };
}

const relationCaller = { create: vi.fn(async () => ({ id: "rel" })) };

describe("materializeCompositeGraph — declared externalLinks", () => {
  it("registers the link on a CREATED entity, with url + connection, beside the op key", async () => {
    const idempotency = door();
    const entityCaller = { create: vi.fn(async () => ({ id: "new-ev1" })) };
    const ops: CompositeProposalOperation[] = [
      {
        op: "create_entity",
        ref: "event:ev1",
        profileSlug: "event",
        title: "Acme sync",
        externalLinks: [LINK],
      },
    ];

    await materializeCompositeGraph(
      ops,
      entityCaller,
      relationCaller,
      undefined,
      { idempotency }
    );

    expect(idempotency.register).toHaveBeenCalledWith(
      "new-ev1",
      "google",
      "ev1",
      {
        url: LINK.url,
        connectionId: "conn-1",
      }
    );
    // The op-keyed retry key is still registered (unchanged behaviour).
    expect(idempotency.register).toHaveBeenCalledWith(
      "new-ev1",
      "import",
      "u1:prop-1:event:ev1"
    );
  });

  it("registers the link on a PINNED existing entity (existingEntityId)", async () => {
    const idempotency = door();
    const entityCaller = { create: vi.fn() };
    const ops: CompositeProposalOperation[] = [
      {
        op: "create_entity",
        ref: "person:jelle@acme-corp.io",
        profileSlug: "person",
        title: "Jelle",
        existingEntityId: "existing-person",
        externalLinks: [
          {
            provider: "email",
            externalId: "jelle@acme-corp.io",
            url: null,
            connectionId: "conn-1",
          },
        ],
      },
    ];

    await materializeCompositeGraph(
      ops,
      entityCaller,
      relationCaller,
      undefined,
      { idempotency }
    );

    expect(entityCaller.create).not.toHaveBeenCalled();
    expect(idempotency.register).toHaveBeenCalledWith(
      "existing-person",
      "email",
      "jelle@acme-corp.io",
      {
        url: null,
        connectionId: "conn-1",
      }
    );
  });

  it("registers the link on a strong-signal DEDUPED entity", async () => {
    const idempotency = door();
    const entityCaller = {
      create: vi.fn(async () => ({ id: "matched-person", deduplicated: true })),
    };
    const ops: CompositeProposalOperation[] = [
      {
        op: "create_entity",
        ref: "contact:people/c1",
        profileSlug: "person",
        title: "Jelle",
        externalLinks: [
          {
            provider: "google",
            externalId: "people/c1",
            connectionId: "conn-1",
          },
        ],
      },
    ];

    await materializeCompositeGraph(
      ops,
      entityCaller,
      relationCaller,
      undefined,
      { idempotency }
    );

    expect(idempotency.register).toHaveBeenCalledWith(
      "matched-person",
      "google",
      "people/c1",
      {
        url: null,
        connectionId: "conn-1",
      }
    );
  });

  it("an op without a link door does not throw (links cannot be registered; logged)", async () => {
    const entityCaller = { create: vi.fn(async () => ({ id: "new-ev1" })) };
    const ops: CompositeProposalOperation[] = [
      {
        op: "create_entity",
        ref: "event:ev1",
        profileSlug: "event",
        title: "Acme sync",
        externalLinks: [LINK],
      },
    ];
    await expect(
      materializeCompositeGraph(ops, entityCaller, relationCaller)
    ).resolves.toMatchObject({ created: 1 });
  });
});
