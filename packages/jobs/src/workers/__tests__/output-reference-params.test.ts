/**
 * `reference` PARAM RESOLUTION at the two executor call sites.
 *
 * THE DEFECT THIS PINS: `entity_update.entityId` and `channel_message.channelId`
 * were read as bare casts (`config.entityId as string`). A cast is not a parse,
 * so the tagged `reference` value the wire contract already declares
 * (`referenceValueSchema` in `routers/automations.ts`) stringified to
 * "[object Object]" — the rule saved green, fired, and wrote nothing.
 *
 * The claims, in the order they matter:
 *   (1) ADDITIVE GUARANTEE — a bare id string behaves byte-identically at BOTH
 *       sites. This is the one that must not budge; every rule authored before
 *       `reference` existed passes through unchanged.
 *   (2) a `{mode:"bound"}` reference resolves to its target id at both sites.
 *   (3) an unreadable reference FAILS LOUD — no write, no widening, no no-op.
 *   (4) `mode:"ask"` fails with its OWN message naming the missing runtime
 *       disambiguation channel, so the run record says why rather than "not found".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StepContext } from "../automation-executor.js";

const mocks = vi.hoisted(() => ({
  entityUpdate: vi.fn(),
  insertChannelMessage: vi.fn(),
  ensureAutomationRunChannel: vi.fn(),
  emitSideEffects: vi.fn(),
  gate: vi.fn(),
  /** Rows the `select().from().where().limit()` chain resolves to. */
  selectRows: [] as Array<Record<string, unknown>>,
  /** The explicit-channelId scope re-validation row (defined = reachable). */
  channelScopeRow: undefined as { id: string } | undefined,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  class EntityRepository {
    constructor(_db: unknown, _events?: unknown) {}
    update = mocks.entityUpdate;
  }
  class ChannelRepository {
    constructor(_db: unknown) {}
    ensureAutomationRunChannel = mocks.ensureAutomationRunChannel;
    ensureEntityChannel = vi.fn();
    ensureUserPersonalChannel = vi.fn();
    ensureProactiveFeedChannel = vi.fn();
  }
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(mocks.selectRows) }),
      }),
    }),
    query: {
      channels: { findFirst: () => Promise.resolve(mocks.channelScopeRow) },
    },
  };
  return {
    ...actual,
    db,
    EntityRepository,
    ChannelRepository,
    insertChannelMessage: mocks.insertChannelMessage,
  };
});

vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/events")>();
  return { ...actual, emitSideEffects: mocks.emitSideEffects };
});

vi.mock("../../utils/automation-governance.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../utils/automation-governance.js")
    >();
  return { ...actual, checkAutomationWriteOrPropose: mocks.gate };
});

const { executeOutputStep } = await import("../automation-executor.js");

const OWNER = "user-owner";
const WORKSPACE = "ws-1";
const ENTITY = "11111111-1111-4111-8111-111111111111";

const context = (): StepContext => ({
  trigger: { payload: {} },
  steps: {},
  automation: { id: "auto-1", state: {} },
});

const automationContext = {
  automationRunId: "run-1",
  automationId: "auto-1",
  chainDepth: 0,
  rootRunId: "run-1",
  chainAutomationIds: [] as string[],
};

const run = (outputType: string, config: Record<string, unknown>) =>
  executeOutputStep(
    { outputType, config },
    context(),
    WORKSPACE,
    automationContext,
    OWNER,
    OWNER,
    { nodeId: "node-1", stepRunId: "sr-1" }
  );

const runEntityUpdate = (config: Record<string, unknown>) =>
  run("entity_update", { properties: { status: "done" }, ...config });

const runChannelMessage = (config: Record<string, unknown>) =>
  run("channel_message", { content: "hi", ...config });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.gate.mockResolvedValue({ allowed: true });
  mocks.entityUpdate.mockResolvedValue({ id: ENTITY });
  mocks.emitSideEffects.mockResolvedValue(undefined);
  mocks.insertChannelMessage.mockResolvedValue({});
  mocks.ensureAutomationRunChannel.mockResolvedValue({ id: "ch-run" });
  mocks.selectRows = [{ type: "note" }];
  mocks.channelScopeRow = { id: "in-scope" };
});

describe("(1) additive guarantee — a bare id string is untouched", () => {
  it("entity_update.entityId: a bare string still updates that entity", async () => {
    const result = await runEntityUpdate({ entityId: ENTITY });
    expect(mocks.entityUpdate).toHaveBeenCalledWith(
      ENTITY,
      expect.objectContaining({ properties: { status: "done" } }),
      OWNER
    );
    expect(result).toMatchObject({ status: "updated", entityId: ENTITY });
  });

  it("entity_update: a MISSING entityId still throws the same required-ness error (absent is not a reference)", async () => {
    await expect(runEntityUpdate({})).rejects.toThrow(
      "entity_update requires entityId in config"
    );
    expect(mocks.entityUpdate).not.toHaveBeenCalled();
  });

  it("entity_update: an EMPTY-STRING entityId still throws the same required-ness error", async () => {
    await expect(runEntityUpdate({ entityId: "" })).rejects.toThrow(
      "entity_update requires entityId in config"
    );
  });

  it("channel_message.channelId: a bare string still posts to that channel", async () => {
    const result = await runChannelMessage({ channelId: "ch-explicit" });
    expect(mocks.insertChannelMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: "ch-explicit" })
    );
    expect(result).toMatchObject({ status: "sent", channelId: "ch-explicit" });
    expect(mocks.ensureAutomationRunChannel).not.toHaveBeenCalled();
  });

  it("channel_message: an ABSENT channelId still falls through to the run channel (targetless never errors)", async () => {
    const result = await runChannelMessage({});
    expect(mocks.ensureAutomationRunChannel).toHaveBeenCalled();
    expect(result).toMatchObject({ status: "sent", channelId: "ch-run" });
  });

  it("channel_message: the out-of-scope refusal on a bare string is unchanged", async () => {
    mocks.channelScopeRow = undefined;
    await expect(
      runChannelMessage({ channelId: "ch-foreign" })
    ).rejects.toThrow(/ch-foreign is not reachable from workspace ws-1/);
    expect(mocks.insertChannelMessage).not.toHaveBeenCalled();
  });
});

describe("(2) a bound reference resolves to its target", () => {
  it("entity_update: single-target bound reference", async () => {
    const result = await runEntityUpdate({
      entityId: {
        mode: "bound",
        refKind: "entity",
        value: [{ id: ENTITY, label: "Acme" }],
      },
    });
    expect(mocks.entityUpdate).toHaveBeenCalledWith(
      ENTITY,
      expect.anything(),
      OWNER
    );
    expect(result).toMatchObject({ status: "updated", entityId: ENTITY });
  });

  it("channel_message: single-target bound reference (and it is the id, never the label)", async () => {
    const result = await runChannelMessage({
      channelId: {
        mode: "bound",
        refKind: "channel",
        value: [{ id: "ch-bound", label: "#general" }],
      },
    });
    expect(mocks.insertChannelMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: "ch-bound" })
    );
    expect(result).toMatchObject({ channelId: "ch-bound" });
  });

  it("a MULTIPLE-cardinality reference in a single-valued slot throws rather than dropping targets", async () => {
    // Windmill #7800's shape inverted: never quietly act on element [0] and
    // report success for the targets that were silently dropped.
    await expect(
      runEntityUpdate({
        entityId: {
          mode: "bound",
          refKind: "entity",
          value: [
            { id: ENTITY },
            { id: "22222222-2222-4222-8222-222222222222" },
          ],
        },
      })
    ).rejects.toThrow(/2 targets are bound but this action takes exactly one/);
    expect(mocks.entityUpdate).not.toHaveBeenCalled();
  });
});

describe("(3) an unreadable reference fails loud — never a silent no-op", () => {
  it("an EMPTY bound value throws instead of resolving to undefined", async () => {
    await expect(
      runEntityUpdate({
        entityId: { mode: "bound", refKind: "entity", value: [] },
      })
    ).rejects.toThrow(/bound reference with no targets/);
    // The widening this prevents: an `entity_update` that reached the gate with
    // no id, or fell through to the "requires entityId" path as if unconfigured.
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.entityUpdate).not.toHaveBeenCalled();
  });

  it("a target with no usable id throws and names which one", async () => {
    await expect(
      runEntityUpdate({
        entityId: {
          mode: "bound",
          refKind: "entity",
          value: [{ id: ENTITY }, { label: "no id here" }],
        },
      })
    ).rejects.toThrow(/target #2 of 2 carries no usable id/);
  });

  it("an unknown mode throws and names the modes it knows", async () => {
    await expect(
      runEntityUpdate({
        entityId: { mode: "later", refKind: "entity", value: [{ id: ENTITY }] },
      })
    ).rejects.toThrow(/unknown reference mode "later"/);
  });

  it("a bare ARRAY is rejected — a container is never passed through as data", async () => {
    await expect(
      runEntityUpdate({ entityId: [{ id: ENTITY }] })
    ).rejects.toThrow(/a bare array is not a reference value/);
  });

  it("an object with no mode tag throws instead of stringifying to [object Object]", async () => {
    await expect(runEntityUpdate({ entityId: { id: ENTITY } })).rejects.toThrow(
      /unknown reference mode undefined/
    );
  });

  it("channel_message fails loud too — it does NOT fall through to the run channel", async () => {
    // The contract is "a TARGETLESS channel_message never errors". An unreadable
    // target is not targetless; silently redirecting to the run channel would
    // deliver the content somewhere the author never named.
    await expect(
      runChannelMessage({
        channelId: { mode: "bound", refKind: "channel", value: [] },
      })
    ).rejects.toThrow(/bound reference with no targets/);
    expect(mocks.ensureAutomationRunChannel).not.toHaveBeenCalled();
    expect(mocks.insertChannelMessage).not.toHaveBeenCalled();
  });
});

describe("(4) mode:'ask' names the silence", () => {
  it("entity_update: an unbound reference reports the missing runtime question, not 'not found'", async () => {
    const err = await runEntityUpdate({
      entityId: { mode: "ask", refKind: "entity", prompt: "Which client?" },
    }).catch((e: Error) => e);
    expect((err as Error).name).toBe("UnresolvableReferenceError");
    expect((err as Error).message).toContain("entity_update.entityId");
    expect((err as Error).message).toContain("Which client?");
    expect((err as Error).message).toMatch(
      /Nothing can put that question to a human at execution time yet/
    );
    expect(mocks.entityUpdate).not.toHaveBeenCalled();
  });

  it("channel_message: same distinct failure, with no prompt authored", async () => {
    await expect(
      runChannelMessage({ channelId: { mode: "ask", refKind: "channel" } })
    ).rejects.toThrow(/this reference is UNBOUND/);
    expect(mocks.insertChannelMessage).not.toHaveBeenCalled();
  });
});
