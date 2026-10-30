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
  approveCalls: [] as unknown[],
  switches: new Map<string, (on: boolean) => void>(),
}));

vi.mock("../../../../lib/trpc", () => {
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
      useUtils: () => ({}),
      capabilities: {
        containers: {
          get: query(() => ({
            capability: { id: CAP, name: "Hetzner Cloud", workspaceId: null },
          })),
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
      },
      tools: {
        setApproved: {
          useMutation: () => ({
            mutate: (input: unknown) => h.approveCalls.push(input),
            isPending: false,
          }),
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
});

describe("a capability whose access to the service is off", () => {
  it("is marked 'Access off', never 'On', though every action is on", () => {
    h.card = hetzner([{ id: TOOL, name: "hetzner_cloud" }]);
    const page = text(render());
    expect(page).toContain("Access off");
    expect(page).toContain("Access to Hetzner cloud");
    expect(page).toContain("every run is refused");
  });

  it("its switch turns the access on: tools.setApproved with that row's id", () => {
    h.card = hetzner([{ id: TOOL, name: "hetzner_cloud" }]);
    render();
    const turnOn = h.switches.get("Turn on access to Hetzner cloud");
    expect(turnOn, "the access switch was rendered").toBeTypeOf("function");
    turnOn!(true);
    expect(h.approveCalls).toEqual([{ id: TOOL, approved: true }]);
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
