/**
 * A capability's page when its ACCESS to the service is off (a member tool row
 * the run gate refuses, `card.toolsOff`): the REAL `CapabilityObject` against a
 * tRPC stub answering the container, the catalog card and its composition.
 *
 * Founder dogfood 2026-10-30: Hetzner Cloud read "6 of 6 on" while its
 * `hetzner_cloud` tool row was off, every run was refused, and no screen
 * offered to turn it on. Pinned here: the mark says so, the page names the
 * access, and its switch reaches `tools.setApproved` with that row's id.
 */
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const CAP = "11111111-1111-4111-8111-111111111111";
const TOOL = "d26aa29b-45f0-494b-9ebf-388da2bb9528";

const h = vi.hoisted(() => ({
  card: null as unknown,
  /** `capabilities.containers.get`'s answer; null = Hetzner, not an add-on. */
  container: null as unknown,
  approveCalls: [] as unknown[],
  switches: new Map<string, (on: boolean) => void>(),
}));

vi.mock("../../../../lib/trpc", async () => {
  const query = (data: () => unknown) => ({
    useQuery: () => ({
      data: data(),
      isLoading: false,
      isSuccess: true,
      isError: false,
      error: null,
      refetch: () => undefined,
    }),
  });
  return {
    trpc: {
      presence: (
        await import("../../presence/__tests__/trpc-double")
      ).presenceTrpcDouble(),
      useUtils: () => ({}),
      capabilities: {
        containers: {
          get: query(
            () =>
              h.container ?? {
                capability: {
                  id: CAP,
                  name: "Hetzner Cloud",
                  workspaceId: null,
                },
                extends: null,
                addOns: [],
              }
          ),
        },
        catalog: query(() => [h.card]),
        compositions: query(() => [
          {
            id: CAP,
            name: "Hetzner Cloud",
            description: null,
            members: [],
            health: { status: "unknown", failedRuns: 0, stuckRuns: 0 },
            gaps: [],
          },
        ]),
        setToolEnabled: {
          useMutation: () => ({ mutate: vi.fn(), isPending: false }),
        },
        // "Turn all on", reached through the presence door (`useEnableMany`).
        enableMany: {
          useMutation: () => ({ mutate: vi.fn(), isPending: false }),
        },
      },
      tools: {
        setApproved: {
          // Reached through the presence door (`useSetToolApproved`).
          useMutation: () => ({
            mutate: (input: unknown) => h.approveCalls.push(input),
            mutateAsync: async (input: unknown) => h.approveCalls.push(input),
            isPending: false,
          }),
        },
      },
      governanceRules: {
        // Each action asks first, the pod's answer when no rule names it.
        actionModes: {
          useQuery: (input: { actions: string[] }) => ({
            data: {
              modes: input.actions.map((action) => ({
                action,
                mode: "ask",
                ruleId: null,
                mayRunOnItsOwn: true,
              })),
            },
            isLoading: false,
            isSuccess: true,
            isError: false,
            error: null,
          }),
        },
        setActionMode: {
          useMutation: () => ({ mutate: vi.fn(), isPending: false }),
        },
      },
      workspaces: { list: query(() => []) },
    },
  };
});

/* Record each switch's handler under its accessible name, render the real one. */
vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  const Switch = (props: Record<string, unknown>) => {
    const name = props["aria-label"];
    if (typeof name === "string" && typeof props.onValueChange === "function")
      h.switches.set(name, props.onValueChange as (on: boolean) => void);
    return createElement(real.Switch, props as never);
  };
  return { ...real, Switch };
});

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../../../../lib/exit-link", () => ({
  ExitLink: ({ label }: { label: string }) => <span>{label}</span>,
}));
vi.mock("../use-reauth", () => ({ useReauthOnUnauthorized: () => undefined }));
vi.mock("./tool-runs", () => ({ ToolRuns: () => null }));

import { ObjectPage } from "../object-page";
import { CapabilityObject } from "./capability-object";
import { addOnParentHref } from "../../../(admin)/tools/_lib/tools-model";
import type { ObjectFrame } from "./object-frame";

const FRAME: ObjectFrame = {
  loading: (label) => <p>{label}</p>,
  failure: ({ failure }) => <p>{failure.title}</p>,
  object: (props) => <ObjectPage {...props} />,
};

const verb = (verbId: string) => ({
  verbId,
  skillId: `skill-${verbId}`,
  label: verbId,
  description: null,
  type: "action" as const,
  enabled: true,
});

/** The catalog card the pod sends: every action on; `toolsOff` as given. */
function hetzner(toolsOff?: Array<{ id: string; name: string }>) {
  return {
    id: CAP,
    key: CAP,
    name: "Hetzner Cloud",
    source: "installed",
    status: "ready",
    verbs: [verb("hcloud_create_server"), verb("hcloud_list_servers")],
    anatomy: { tools: ["hetzner_cloud"], skills: [] },
    installParams: [],
    ...(toolsOff ? { toolsOff } : {}),
    nextAction: toolsOff
      ? {
          kind: "enable",
          hint: "Its access to the service is off, so none of its actions can run. Turn it on to use it.",
        }
      : { kind: "run", hint: "Run one of its actions." },
  };
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const render = (viewerIsPodAdmin = true) =>
  renderToStaticMarkup(
    <CapabilityObject
      id={CAP}
      frame={FRAME}
      viewerIsPodAdmin={viewerIsPodAdmin}
    />
  );

beforeEach(() => {
  h.approveCalls.length = 0;
  h.switches.clear();
  h.container = null;
});

describe("a capability whose access to the service is off", () => {
  it("is marked 'Access off', never 'On', though every action is on", () => {
    h.card = hetzner([{ id: TOOL, name: "hetzner_cloud" }]);
    const page = text(render());
    expect(page).toContain("Access off");
    expect(page).toContain("Access to Hetzner cloud");
    expect(page).toContain("every run is refused");
  });

  it("its switch turns the access on: tools.setApproved with that row's id", async () => {
    h.card = hetzner([{ id: TOOL, name: "hetzner_cloud" }]);
    render();
    const turnOn = h.switches.get("Turn on access to Hetzner cloud");
    expect(turnOn, "the access switch was rendered").toBeTypeOf("function");
    turnOn!(true);
    await vi.waitFor(() =>
      expect(h.approveCalls).toEqual([{ id: TOOL, approved: true }])
    );
  });

  it("someone who cannot change it reads who can, and gets no switch", () => {
    h.card = hetzner([{ id: TOOL, name: "hetzner_cloud" }]);
    const page = text(render(false));
    expect(page).toContain("A pod admin turns it on.");
    expect(h.switches.has("Turn on access to Hetzner cloud")).toBe(false);
  });

  it("access on: no access section and no 'Access off' mark", () => {
    h.card = hetzner();
    const html = render();
    expect(html).not.toContain("data-capability-access");
    expect(text(html)).not.toContain("Access off");
  });
});

/* ── Add-ons (founder decision D6) ─────────────────────────────────────── */

const BASE = "22222222-2222-4222-8222-222222222222";
const ADDON = "33333333-3333-4333-8333-333333333333";

describe("a base tool with add-ons", () => {
  it("shows them in their own Add-ons card, each a door to its own page", () => {
    h.card = hetzner();
    h.container = {
      capability: { id: CAP, name: "Hetzner Cloud", workspaceId: null },
      extends: null,
      addOns: [
        {
          id: ADDON,
          name: "Snapshots",
          description: "Schedule server snapshots",
          workspaceId: null,
        },
      ],
    };
    const html = render();
    expect(html).toContain("data-addons");
    const page = text(html);
    expect(page).toContain("Add-ons");
    expect(page).toContain("Snapshots");
    expect(page).toContain("Schedule server snapshots");
    expect(page).toContain("runs through Hetzner Cloud’s access");
  });

  it("a tool with no add-on draws no Add-ons card", () => {
    h.card = hetzner();
    const html = render();
    // No description on the row: the header keeps the pod's sentence alone.
    expect(html).not.toContain("data-capability-description");
    expect(html).not.toContain("data-addons");
    expect(text(html)).not.toContain("Add-on of");
  });
});

describe("an add-on's page", () => {
  it("names its parent tool, linked to the parent's page", () => {
    h.card = hetzner();
    h.container = {
      capability: {
        id: CAP,
        name: "Hetzner Cloud",
        description: "Enriches one person from a public LinkedIn profile link.",
        workspaceId: null,
      },
      extends: { id: BASE, name: "Apify" },
      addOns: [],
    };
    const html = render();
    // Its own page says what it does, not only its parent's card.
    expect(html).toContain("data-capability-description");
    expect(text(html)).toContain(
      "Enriches one person from a public LinkedIn profile link."
    );
    expect(html).toContain(`href="${addOnParentHref(BASE)}"`);
    expect(addOnParentHref(BASE)).toContain(BASE);
    const page = text(html);
    expect(page).toContain("Add-on of");
    expect(page).toContain("Apify");
    expect(page).toContain("It runs through Apify’s access");
    expect(html).not.toContain("data-addons");
  });
});
