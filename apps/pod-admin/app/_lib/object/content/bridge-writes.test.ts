/**
 * Each frame write reaches ITS governed door with the host's stamp, and the
 * pod's answer reaches the frame as what the pod said: applied, sent for
 * review, or refused. Nothing unknown is ever read as "approved".
 */
import { describe, expect, it } from "vitest";
import type { CellFrameWriteRequest } from "@synap-core/types/cell-bridge";
import {
  UNREAD_WRITE_ANSWER,
  readWriteAnswer,
  writeForFrame,
} from "./bridge-writes";
import type { BridgeClient } from "./html-bridge-reads";

const A = "11111111-1111-4111-8111-111111111111";
const B = "33333333-3333-4333-8333-333333333333";
const STAMP = {
  viewContext: { typeKey: "cell:acme:board", viewId: "v-1" },
  source: "user" as const,
};

function recording(answer: unknown | (() => never)) {
  const calls: Array<[string, unknown, unknown]> = [];
  const door = (name: string) => async (input: unknown, options?: unknown) => {
    calls.push([name, input, options]);
    if (typeof answer === "function") return (answer as () => never)();
    return answer;
  };
  const client = {
    entities: {
      create: { mutate: door("entities.create") },
      update: { mutate: door("entities.update") },
      delete: { mutate: door("entities.delete") },
    },
    relations: { create: { mutate: door("relations.create") } },
  } as unknown as BridgeClient;
  return { client, calls };
}

const req = (
  op: CellFrameWriteRequest["op"],
  payload: Record<string, unknown>,
  workspaceId: string | null = "ws-1"
) =>
  ({
    op,
    payload,
    ...STAMP,
    lens: { workspaceId },
  }) as CellFrameWriteRequest;

describe("writeForFrame — each op to its own door, stamped", () => {
  it("create_entity → entities.create, with the host's view and lens", async () => {
    const { client, calls } = recording({
      status: "created",
      entity: { id: A },
    });
    const result = await writeForFrame(
      client,
      req("create_entity", { profileSlug: "deal", title: "Acme" })
    );
    expect(calls).toEqual([
      [
        "entities.create",
        { profileSlug: "deal", title: "Acme", ...STAMP },
        { context: { workspaceId: "ws-1" } },
      ],
    ]);
    expect(result).toEqual({ status: "approved", data: { id: A } });
  });

  it("update_entity → entities.update, carrying expectedStatus", async () => {
    const { client, calls } = recording({ status: "updated" });
    await writeForFrame(
      client,
      req("update_entity", {
        id: A,
        properties: { status: "won" },
        expectedStatus: "open",
      })
    );
    expect(calls[0]).toEqual([
      "entities.update",
      {
        id: A,
        properties: { status: "won" },
        expectedStatus: "open",
        ...STAMP,
      },
      { context: { workspaceId: "ws-1" } },
    ]);
  });

  it("delete_entity → entities.delete, with the view's identity", async () => {
    const { client, calls } = recording({ status: "deleted" });
    await writeForFrame(client, req("delete_entity", { id: A }, null));
    // No space: no header; the pod reads the viewer's own floor.
    expect(calls[0]).toEqual([
      "entities.delete",
      { id: A, ...STAMP },
      undefined,
    ]);
  });

  it("create_relation → relations.create, with the view's identity and the host's space", async () => {
    const { client, calls } = recording({ id: "r-1", status: "created" });
    const result = await writeForFrame(
      client,
      req("create_relation", {
        sourceEntityId: A,
        targetEntityId: B,
        type: "relates_to",
      })
    );
    expect(calls[0]).toEqual([
      "relations.create",
      {
        sourceEntityId: A,
        targetEntityId: B,
        type: "relates_to",
        viewContext: STAMP.viewContext,
        workspaceId: "ws-1",
      },
      undefined,
    ]);
    expect(result).toEqual({ status: "approved", data: { id: "r-1" } });
  });
});

describe("readWriteAnswer — what the pod said", () => {
  it("proposed, with its proposal", () => {
    expect(readWriteAnswer({ status: "proposed", proposalId: "p-1" })).toEqual({
      status: "proposed",
      proposalId: "p-1",
    });
  });

  it("an update whose STATUS MOVE was sent for review is proposed, not applied", () => {
    expect(
      readWriteAnswer({
        status: "updated",
        statusMove: { status: "proposed", proposalId: "p-2" },
      })
    ).toEqual({ status: "proposed", proposalId: "p-2" });
  });

  it("an answer it does not recognise is denied, never approved", () => {
    expect(readWriteAnswer({ status: "queued" })).toEqual({
      status: "denied",
      error: UNREAD_WRITE_ANSWER,
    });
    expect(readWriteAnswer(undefined)).toEqual({
      status: "denied",
      error: UNREAD_WRITE_ANSWER,
    });
  });

  it("a FORBIDDEN refusal is a denial with the pod's sentence", async () => {
    const { client } = recording(() => {
      throw Object.assign(new Error("You may not change this deal."), {
        data: { code: "FORBIDDEN" },
      });
    });
    await expect(
      writeForFrame(client, req("delete_entity", { id: A }))
    ).resolves.toEqual({
      status: "denied",
      error: "You may not change this deal.",
    });
  });

  it("any other failure is thrown on (the frame host denies it with its text)", async () => {
    const { client } = recording(() => {
      throw Object.assign(new Error("boom"), {
        data: { code: "INTERNAL_SERVER_ERROR" },
      });
    });
    await expect(
      writeForFrame(client, req("delete_entity", { id: A }))
    ).rejects.toThrow("boom");
  });
});
