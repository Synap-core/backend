import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SynapLockup, SynapMark } from "./synap-mark";
import { ReceiverIdentityProvider, ReceiverShell } from "../receiver-shell";
import { opensHome } from "../../../lib/route-policy";

/**
 * Pod admin drew a fake logo: a small primary square with the letter "S", in
 * the console's bar and on every receiver page. The real mark is one vector
 * path with the brand gradient; and the lockup is the door to Home only for
 * a reader the server found to be a member or an admin.
 */
describe("SynapMark: the real mark, not a letter", () => {
  it("draws the mark's path with its own gradient", () => {
    const out = renderToStaticMarkup(<SynapMark />);
    expect(out).toContain("<svg");
    expect(out).toContain('viewBox="0 0 724 1584"');
    expect(out).toContain("<radialGradient");
    expect(out).not.toMatch(/>\s*S\s*</);
  });

  it("two marks on one page never share a gradient id", () => {
    const out = renderToStaticMarkup(
      <>
        <SynapMark />
        <SynapMark />
      </>
    );
    const ids = [...out.matchAll(/<radialGradient id="([^"]+)"/g)].map(
      (m) => m[1]
    );
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    for (const id of ids) expect(out).toContain(`url(#${id})`);
  });

  it("is decorative beside the wordmark, named when alone", () => {
    expect(renderToStaticMarkup(<SynapMark />)).toContain('aria-hidden="true"');
    expect(renderToStaticMarkup(<SynapMark label="Synap" />)).toContain(
      'aria-label="Synap"'
    );
  });
});

describe("SynapLockup: a door only when given one", () => {
  it("with an href the mark and the wordmark are ONE link", () => {
    const out = renderToStaticMarkup(<SynapLockup href="/home" />);
    expect(out.match(/<a\b/g) ?? []).toHaveLength(1);
    expect(out).toContain('href="/home"');
    expect(out).toContain(">Synap<");
  });

  it("without one it is plain brand", () => {
    const out = renderToStaticMarkup(<SynapLockup />);
    expect(out).not.toContain("<a");
    expect(out).toContain(">Synap<");
  });
});

describe("the receiver header: the mark leads Home only for a member", () => {
  it("a member or an admin gets the door to Home", () => {
    const out = renderToStaticMarkup(
      <ReceiverShell canGoHome>
        <p>body</p>
      </ReceiverShell>
    );
    expect(out).toContain('href="/home"');
    expect(out).toContain("<svg");
    expect(out).not.toMatch(/>\s*S\s*</);
  });

  it("the route's provider says it once for every card on the page", () => {
    const out = renderToStaticMarkup(
      <ReceiverIdentityProvider canGoHome>
        <ReceiverShell>
          <p>body</p>
        </ReceiverShell>
      </ReceiverIdentityProvider>
    );
    expect(out).toContain('href="/home"');
  });

  it("anyone else sees the mark as plain brand, never a door", () => {
    const out = renderToStaticMarkup(
      <ReceiverShell>
        <p>body</p>
      </ReceiverShell>
    );
    expect(out).not.toContain('href="/home"');
    expect(out).toContain("<svg");
    expect(out).toContain(">Synap<");
  });
});

describe("opensHome: decided from the role the server asked", () => {
  it("a member and an admin open Home", () => {
    expect(opensHome("admin")).toBe(true);
    expect(opensHome("member")).toBe(true);
  });

  it("an unanswered probe, or none, offers no door", () => {
    expect(opensHome("unavailable")).toBe(false);
    expect(opensHome(null)).toBe(false);
  });
});
