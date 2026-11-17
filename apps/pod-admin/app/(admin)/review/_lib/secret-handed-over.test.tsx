/**
 * What became of a handed-over secret, RENDERED (react-dom/server; node has
 * no DOM to click, so Button hands its press handler to the test and the
 * confirmation's props are recorded):
 *  - a grant still readable offers Take back; a STANDING one (the agent held
 *    it before this ask) asks first, naming that the agent loses its earlier
 *    access; a new grant is taken back at once;
 *  - a grant that only ran out reads "Used up" or "Ended", never "Taken
 *    back"; "Ended" with no time has nothing trailing.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProvideSecretUse } from "../../../_lib/request/api";

const { state, buttons, confirm, revoked } = vi.hoisted(() => ({
  state: { use: null as unknown },
  buttons: [] as Array<{ children?: unknown; onPress?: () => void }>,
  confirm: { props: null as null | Record<string, unknown> },
  revoked: [] as unknown[],
}));

vi.mock("@heroui/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@heroui/react")>();
  const { createElement } = await import("react");
  return {
    ...actual,
    Button: (props: { children?: unknown; onPress?: () => void }) => {
      buttons.push(props);
      return createElement(
        "button",
        { type: "button" },
        props.children as never
      );
    },
  };
});

vi.mock("../../components/confirm-modal", () => ({
  ConfirmModal: (props: Record<string, unknown>) => {
    confirm.props = props;
    return null;
  },
}));

vi.mock("../../../../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      focusSessions: { provideSecretUse: { invalidate() {} } },
    }),
    focusSessions: {
      provideSecretUse: {
        useQuery: () => ({
          data: { status: "ok", use: state.use },
          isLoading: false,
          isError: false,
          refetch() {},
        }),
      },
    },
    secretsVault: {
      revokeGrant: {
        useMutation: () => ({
          mutate: (input: unknown) => revoked.push(input),
          isPending: false,
        }),
      },
    },
  },
}));

import { SecretHandedOver } from "./secret-handed-over";
import { en as REQUEST_EN } from "../../../_lib/request/copy";

const USE: ProvideSecretUse = {
  grantId: "g1",
  secretId: "s1",
  secretName: "GITHUB_TOKEN",
  agentUserId: "a1",
  agentName: "Claude Code",
  uses: "session",
  expiresAt: "2026-11-16T15:00:00.000Z",
  revokedAt: null,
  active: true,
  useCount: 2,
  maxUses: null,
  lastUsedAt: "2026-11-16T14:02:00.000Z",
  takeBack: { door: "secretsVault.revokeGrant", grantId: "g1" },
};

function render(use: ProvideSecretUse): string {
  state.use = use;
  return renderToStaticMarkup(
    <SecretHandedOver
      slot={{ sessionId: "sess", expectedLabel: "GitHub token" }}
      onDone={() => {}}
    />
  );
}

const takeBack = () =>
  buttons.find((b) => b.children === REQUEST_EN["secret.takeBack"]);

/** The state line's own words: its mark, then its text. */
const stateLine = (html: string) => {
  const at = html.indexOf("data-secret-use=");
  return html.slice(at, html.indexOf("</p>", at));
};

beforeEach(() => {
  buttons.length = 0;
  revoked.length = 0;
  confirm.props = null;
});

describe("SecretHandedOver — Take back", () => {
  it("a STANDING grant asks first, naming that the agent loses its earlier access", () => {
    render({ ...USE, uses: "standing", expiresAt: null });
    // Pressing Take back revokes nothing by itself: it opens the confirm.
    takeBack()!.onPress!();
    expect(revoked).toEqual([]);
    expect(confirm.props).not.toBeNull();
    const title = String(confirm.props!.title);
    expect(title).toContain("GITHUB_TOKEN");
    expect(title).toContain("Claude Code");
    // The consequence: the access it held BEFORE this request ends too.
    expect(String(confirm.props!.consequence)).toBe(
      REQUEST_EN["secret.takeBackStanding"].replace("{agent}", "Claude Code")
    );
    expect(confirm.props!.confirmLabel).toBe(REQUEST_EN["secret.takeBack"]);
    // Confirming takes back THAT grant.
    (confirm.props!.onConfirm as () => void)();
    expect(revoked).toEqual([{ grantId: "g1" }]);
  });

  it("a grant made for this ask is taken back at once, with no confirm", () => {
    const html = render(USE);
    expect(stateLine(html)).toContain('data-secret-use="active"');
    takeBack()!.onPress!();
    expect(revoked).toEqual([{ grantId: "g1" }]);
    expect(confirm.props).toBeNull();
  });
});

describe("SecretHandedOver — a grant that ended", () => {
  it("a one-read grant read once: Used up, never Taken back, no Take back offered", () => {
    const line = stateLine(
      render({
        ...USE,
        uses: "once",
        active: false,
        takeBack: null,
        useCount: 1,
        maxUses: 1,
      })
    );
    expect(line).toContain('data-secret-use="usedUp"');
    expect(line).toContain(`>${REQUEST_EN["secret.usedUp"]}<`);
    expect(line).not.toContain(REQUEST_EN["secret.takenBack"]);
    expect(takeBack()).toBeUndefined();
  });

  it("ended with no time reads 'Ended', with nothing trailing", () => {
    const line = stateLine(
      render({
        ...USE,
        active: false,
        takeBack: null,
        useCount: 0,
        lastUsedAt: null,
        expiresAt: null,
      })
    );
    expect(line).toContain('data-secret-use="ended"');
    expect(line).toContain(`>${REQUEST_EN["secret.endedNoTime"]}<`);
    expect(line).not.toMatch(/>Ended\s+</);
  });

  it("revoked: Taken back", () => {
    const line = stateLine(
      render({
        ...USE,
        active: false,
        takeBack: null,
        revokedAt: "2026-11-16T14:30:00.000Z",
      })
    );
    expect(line).toContain('data-secret-use="takenBack"');
    expect(line).toContain(`>${REQUEST_EN["secret.takenBack"]}<`);
  });
});
