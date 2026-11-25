import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import type { ConsoleRole } from "../../../lib/route-policy";
import { en } from "./copy";
import {
  effectiveConsoleRole,
  MEMBER_PREVIEW_KEY,
  MemberPreviewBanner,
  MemberPreviewProvider,
  useMemberPreview,
  type MemberPreview,
} from "./member-preview";
import { useConsoleRole } from "./side-nav-role";

function RoleProbe() {
  return <span data-role={useConsoleRole()} />;
}

function draw(realRole: ConsoleRole, initialOn: boolean): string {
  return renderToStaticMarkup(
    <MemberPreviewProvider realRole={realRole} initialOn={initialOn}>
      <MemberPreviewBanner />
      <RoleProbe />
    </MemberPreviewProvider>
  );
}

describe("effectiveConsoleRole: a preview only ever shrinks the role", () => {
  it.each([
    ["admin", false, "admin"],
    ["admin", true, "member"],
    ["member", false, "member"],
    ["member", true, "member"],
  ] as const)("%s, preview %s → %s", (real, preview, offered) => {
    expect(effectiveConsoleRole(real, preview)).toBe(offered);
  });
});

describe("MemberPreviewProvider", () => {
  it("offers an admin previewing the member console, under the banner", () => {
    const out = draw("admin", true);
    expect(out).toContain('data-role="member"');
    expect(out).toContain(en["memberPreview.title"]);
    // The banner says whose data it is: the operator's own, never a member's.
    expect(out).toContain(en["memberPreview.body"]);
    expect(out).toContain(en["memberPreview.stop"]);
  });

  it("leaves an admin's console as it is when the preview is off", () => {
    const out = draw("admin", false);
    expect(out).toContain('data-role="admin"');
    expect(out).not.toContain(en["memberPreview.title"]);
  });

  it("gives a member nothing to preview, and never more than a member", () => {
    const out = draw("member", true);
    expect(out).toContain('data-role="member"');
    expect(out).not.toContain(en["memberPreview.title"]);
  });
});

describe("the preview never reaches the pod", () => {
  const realWindow = (globalThis as { window?: unknown }).window;
  const realDocument = (globalThis as { document?: unknown }).document;
  afterEach(() => {
    (globalThis as { window?: unknown }).window = realWindow;
    (globalThis as { document?: unknown }).document = realDocument;
  });

  it("is kept in this tab's sessionStorage only, never a cookie a request carries", () => {
    const store = new Map<string, string>();
    const doc = { cookie: "" };
    (globalThis as { window?: unknown }).window = {
      sessionStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    };
    (globalThis as { document?: unknown }).document = doc;
    let preview: MemberPreview | null = null;
    function Grab() {
      preview = useMemberPreview();
      return null;
    }
    renderToStaticMarkup(
      <MemberPreviewProvider realRole="admin">
        <Grab />
      </MemberPreviewProvider>
    );
    expect(preview).not.toBeNull();
    preview!.set(true);
    expect(store.get(MEMBER_PREVIEW_KEY)).toBe("1");
    expect(doc.cookie).toBe("");
  });

  /**
   * The choice is named in ONE file. If the proxy, the tRPC link or any
   * server route read it, a preview could change what the pod returns; a
   * second reader shows up here by existing. Scans every non-test source of
   * the app (derived, not listed). Does NOT see a reader that rebuilds the
   * key from parts.
   */
  it("is read by no other file of the console", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === ".next") continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name))
          files.push(path);
      }
    };
    for (const top of ["app", "lib", "proxy.ts"]) {
      const path = join(root, top);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
    const readers = files
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return (
          src.includes(MEMBER_PREVIEW_KEY) || src.includes("MEMBER_PREVIEW_KEY")
        );
      })
      .map((f) => relative(root, f));
    // Non-vacuity: the scan saw the console, and still sees the one owner.
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.endsWith("proxy.ts"))).toBe(true);
    expect(readers).toEqual(["app/(admin)/components/member-preview.tsx"]);
  });
});
