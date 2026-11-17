/**
 * A secret asked for, RENDERED (react-dom/server):
 *  - with no secret in the vault there is nothing to give: the card says so
 *    ("You have no secrets…"), and no Give verb is drawn;
 *  - with one, the verb names how long ("Give for this session") and the
 *    no-secrets line is absent.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SecretProvide } from "./secret-provide";
import type { SecretSheet } from "./provide-options";
import type { ProvideControlProps } from "./ask-kit";
import { en as REQUEST_EN } from "../../../_lib/request/copy";

const SHEET: SecretSheet = {
  kind: "secret",
  name: "GITHUB_TOKEN",
  choices: [],
  initialRef: null,
  expectedGranteeId: "a1",
  grant: {
    status: "will_grant",
    agentUserId: "a1",
    agentName: "Claude Code",
    minutes: 60,
    uses: "session",
  },
  agentName: "Claude Code",
  purpose: {
    for: "Merging the delivery PR",
    tool: "gh",
    action: "merge",
    on: "Synap-core/backend",
  },
  uses: "session",
} as SecretSheet;

const noop = () => {};
const PROPS = {
  slot: {} as ProvideControlProps["slot"],
  control: {
    mode: "provide",
    kind: "secret",
  } as ProvideControlProps["control"],
  busy: false,
  pending: false,
  onAnswer: () => null,
  onAttest: noop,
  attesting: false,
  onHandBack: noop,
  handingBack: false,
  onProvide: noop,
  onStale: noop,
  onFailure: noop,
  onConnected: noop,
} satisfies ProvideControlProps;

const render = (sheet: SecretSheet) =>
  renderToStaticMarkup(<SecretProvide {...PROPS} sheet={sheet} />);

describe("SecretProvide", () => {
  it("an empty vault: says there is nothing to hand over, and draws no Give", () => {
    const html = render(SHEET);
    expect(html).toContain("data-secret-none");
    expect(html).toContain(REQUEST_EN["secret.none"]);
    expect(html).not.toContain(REQUEST_EN["secret.giveSession"]);
  });

  it("a secret to pick: the verb names how long, and no empty-vault line", () => {
    const html = render({
      ...SHEET,
      choices: [
        {
          ref: "vault://s1",
          name: "GITHUB_TOKEN",
          type: "api_key",
          standingGrant: null,
        },
      ],
      initialRef: "vault://s1",
    } as SecretSheet);
    expect(html).not.toContain("data-secret-none");
    expect(html).toContain(REQUEST_EN["secret.giveSession"]);
  });
});
