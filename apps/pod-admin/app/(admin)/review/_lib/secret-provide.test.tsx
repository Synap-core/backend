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
import { createT } from "@synap-core/types/i18n";
import { ASK_COPY } from "@synap-core/types/ask";
import {
  REQUEST_CATALOGS,
  en as REQUEST_EN,
  jobNoun,
} from "../../../_lib/request/copy";

const t = createT("en", REQUEST_CATALOGS);
const GIVE_SESSION = t("secret.giveSession", jobNoun("en"));

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
    expect(html).not.toContain(GIVE_SESSION);
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
    expect(html).toContain(GIVE_SESSION);
  });

  // UX review S11, resolved toward founder G1: the option, its button and the
  // note under them name the session with ONE noun, the vocabulary's.
  it("the grant option, its button and its note say one noun, the vocabulary's", () => {
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
    const noun = jobNoun("en").obj;
    const option = t("secret.usesSession", { ...jobNoun("en"), minutes: 60 });
    expect(option).toContain(noun);
    expect(GIVE_SESSION).toContain(noun);
    expect(html).toContain(option);
    expect(html).toContain(GIVE_SESSION);
    // The note is the shared one (ASK_COPY), in the same noun.
    const note = html.match(/data-secret-grant-note=""[^>]*>([^<]*)</)?.[1];
    expect(note!.startsWith(ASK_COPY.provideGrantNote("Claude Code", 60))).toBe(
      true
    );
    expect(note).toContain(noun);
    expect(`${option} ${GIVE_SESSION} ${note}`).not.toMatch(/\bsession\b/i);
  });
});
