/**
 * `entity_create` output — the optional `systemData` passthrough.
 *
 * WHY IT EXISTS: `entities.system_data` is the lane for machine state a
 * producer stamps on a row (a generator's run mark, a source cursor, an
 * idempotency stamp another worker reads back). `EntityRepository.create` has
 * always accepted it, but neither `materializeEntity` nor the automation
 * `entity_create` node did — so a config-expressed generator had nowhere to put
 * per-entity state except `properties`, where it is schema-validated and shows
 * up in the user-facing property editor. This wires the existing column all the
 * way out to the node config.
 *
 * Contract under test:
 *   - `systemData` ABSENT → byte-identical to before: the key is not passed at
 *     all, and `EntityRepository.create` applies its own `{}` default.
 *   - `systemData` PRESENT → forwarded verbatim to `materializeEntity`, with
 *     templates already resolved — the WHOLE node `config` goes through
 *     `deepResolveTemplates`, exactly like `properties`, so nesting depth is
 *     irrelevant.
 *   - non-object (string / array / null) → IGNORED, never coerced. `system_data`
 *     is a jsonb OBJECT column; a scalar there would be a shape violation the
 *     readers of the column are not written for.
 *   - gate PROPOSED → carried on the proposal payload so a force-propose
 *     workspace does not silently lose the stamp.
 *   - CREATE-ONLY: `entity_update` has no counterpart, deliberately (an update
 *     must not clobber a stamp written by a different producer).
 *
 * WHAT THIS PROVES / DOES NOT: db, body service and materializer are mocked, so
 * this locks CONTROL FLOW and the exact arguments crossing each door. The
 * materializer→repository half is covered separately below by a prototype spy.
 * Neither proves the actual Postgres column write — that needs a live-PG run.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// The `@synap/database` mock below spreads the ORIGINAL module, so this class
// reference is the real one — spying on its prototype is the door
// `materializeEntity` actually goes through.
import { EntityRepository } from "@synap/database";
import type { StepContext } from "../automation-executor.js";

const mocks = vi.hoisted(() => ({
  setBody: vi.fn(),
  materializeEntity: vi.fn(),
  gate: vi.fn(),
  selectRows: [] as unknown[][],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  class EntityBodyService {
    constructor(_db: unknown, _eventRepo: unknown) {}
    setBody = mocks.setBody;
  }
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve(
              mocks.selectRows.length ? mocks.selectRows.shift() : []
            ),
        }),
      }),
    }),
  };
  return {
    ...actual,
    db,
    EntityBodyService,
    materializeEntity: mocks.materializeEntity,
  };
});

vi.mock("../../utils/automation-governance.js", () => ({
  checkAutomationWriteOrPropose: mocks.gate,
}));

// Import AFTER the mocks so the executor picks up the mocked exports.
const { executeOutputStep } = await import("../automation-executor.js");

const OWNER = "user-owner";
const WORKSPACE = "ws-1";

const context = (
  steps: Record<string, { output: unknown }> = {}
): StepContext =>
  ({
    trigger: { payload: {} },
    steps,
    automation: { id: "auto-1", state: {} },
  }) as unknown as StepContext;

const automationContext = {
  automationRunId: "run-1",
  automationId: "auto-1",
  chainDepth: 0,
  rootRunId: "root-run-1",
  chainAutomationIds: [] as string[],
};

const runEntityCreate = (
  config: Record<string, unknown>,
  steps: Record<string, { output: unknown }> = {}
) =>
  executeOutputStep(
    { outputType: "entity_create", config },
    context(steps),
    WORKSPACE,
    automationContext,
    OWNER,
    OWNER,
    { nodeId: "node-ec", stepRunId: "sr-1" }
  );

describe("entity_create — systemData passthrough", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectRows = [];
    mocks.gate.mockResolvedValue({ granted: true });
    mocks.materializeEntity.mockImplementation(
      async (input: Record<string, unknown>) => ({
        entity: {
          id: (input.id as string) ?? "db-minted-id",
          title: input.title ?? "Untitled",
        },
        reused: false,
      })
    );
  });

  it("ABSENT — the key is not passed at all (repo's {} default applies)", async () => {
    mocks.selectRows = [[{ userType: "human" }]];

    await runEntityCreate({
      profileSlug: "report",
      title: "No stamp",
      properties: { status: "draft" },
    });

    const input = mocks.materializeEntity.mock.calls[0][0];
    expect(input).not.toHaveProperty("systemData");
  });

  it("PRESENT — forwarded verbatim to materializeEntity", async () => {
    mocks.selectRows = [[{ userType: "human" }]];

    await runEntityCreate({
      profileSlug: "report",
      title: "Stamped",
      properties: { status: "draft" },
      systemData: { generatedBy: "weekly-report", cursor: 42 },
    });

    const input = mocks.materializeEntity.mock.calls[0][0];
    expect(input.systemData).toEqual({
      generatedBy: "weekly-report",
      cursor: 42,
    });
    // …and it stays OUT of the user-facing properties.
    expect(input.properties).toEqual({ status: "draft" });
  });

  it("resolves templates inside it, at depth, the same way properties are", async () => {
    mocks.selectRows = [[{ userType: "human" }]];

    await runEntityCreate(
      {
        profileSlug: "report",
        title: "Templated stamp",
        systemData: {
          run: "{{steps.gen.output.runId}}",
          nested: { period: "week of {{steps.gen.output.week}}" },
        },
      },
      { gen: { output: { runId: "run-xyz", week: "2026-W30" } } }
    );

    expect(mocks.materializeEntity.mock.calls[0][0].systemData).toEqual({
      run: "run-xyz",
      nested: { period: "week of 2026-W30" },
    });
  });

  it("IGNORES a non-object value rather than coercing it", async () => {
    for (const bad of ["nope", ["a"], 7]) {
      vi.clearAllMocks();
      mocks.gate.mockResolvedValue({ granted: true });
      mocks.materializeEntity.mockResolvedValue({
        entity: { id: "e", title: "t" },
        reused: false,
      });
      mocks.selectRows = [[{ userType: "human" }]];

      await runEntityCreate({
        profileSlug: "report",
        title: "Bad stamp",
        systemData: bad,
      });

      expect(mocks.materializeEntity.mock.calls[0][0]).not.toHaveProperty(
        "systemData"
      );
    }
  });

  it("PROPOSED gate — carried on the proposal payload, not dropped", async () => {
    mocks.gate.mockResolvedValue({ proposed: true, proposalId: "prop-1" });

    await runEntityCreate({
      profileSlug: "report",
      title: "Pending",
      systemData: { generatedBy: "weekly-report" },
    });

    expect(mocks.gate.mock.calls[0][0].data).toMatchObject({
      profileSlug: "report",
      systemData: { generatedBy: "weekly-report" },
    });
    expect(mocks.materializeEntity).not.toHaveBeenCalled();
  });

  it("proposal payload is UNCHANGED when systemData is absent", async () => {
    mocks.gate.mockResolvedValue({ proposed: true, proposalId: "prop-1" });

    await runEntityCreate({ profileSlug: "report", title: "Pending" });

    expect(mocks.gate.mock.calls[0][0].data).not.toHaveProperty("systemData");
  });
});

/**
 * The other half of the door: `materializeEntity` → `EntityRepository.create`.
 * Spied on the PROTOTYPE rather than `vi.mock`ed by path — the materializer
 * imports the repository by a package-internal specifier a cross-package mock
 * id does not intercept (same rationale as
 * `materialize-entity-provenance.test.ts`, which this mirrors).
 */
describe("materializeEntity — systemData forwarding", () => {
  const createSpy = vi.spyOn(EntityRepository.prototype, "create");
  let materializeEntity: typeof import("@synap/database").materializeEntity;

  beforeEach(async () => {
    // `materializeEntity` itself is mocked in the module registry above, so the
    // REAL implementation has to be pulled from the actual module.
    const actual =
      await vi.importActual<typeof import("@synap/database")>(
        "@synap/database"
      );
    materializeEntity = actual.materializeEntity;
    createSpy.mockReset();
    createSpy.mockResolvedValue({ id: "e-1", title: "Weekly report" } as never);
  });

  afterEach(() => {
    createSpy.mockReset();
  });

  const run = (systemData?: Record<string, unknown>) =>
    materializeEntity(
      {
        profileSlug: "report",
        title: "Weekly report",
        userId: "user-1",
        ...(systemData ? { systemData } : {}),
      },
      {
        db: {} as never,
        eventRepo: {} as never,
        provenance: { createdByKind: "system", createdByUserId: "user-1" },
      }
    );

  it("forwards systemData into EntityRepository.create", async () => {
    await run({ generatedBy: "weekly-report" });
    expect(createSpy.mock.calls[0][0]).toMatchObject({
      systemData: { generatedBy: "weekly-report" },
    });
  });

  it("passes systemData: undefined when the caller states none (repo defaults to {})", async () => {
    await run();
    expect(createSpy.mock.calls[0][0].systemData).toBeUndefined();
  });
});
