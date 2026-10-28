import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A page a link arrives at draws its card through `ReceiverShell`, which hands
 * its children to a bare HeroUI `<Card>`: the card has NO padding of its own.
 * The padding comes from the card's sections (`CardHeader`, `CardBody`), so the
 * first thing inside `<ReceiverShell>` must be one of them.
 *
 * The defect (2026-10-28, founder): the key request page (`/keys/requests/[id]`)
 * passed a bare `<div>` and a `<p>`, and its title and text sat on the card's
 * edge in every state, while every other receiver page was padded.
 *
 * Scanned: every source file under `app/` that renders `<ReceiverShell` (the set
 * is derived, never listed). Allowed first children: `<CardBody`, `<CardHeader`,
 * or a `{…}` expression.
 *
 * NOT covered, stated: a `{…}` expression is a hand-off to another component
 * (`{children}`, `{stage === …}`), and this scan does not follow it into that
 * component. A hand-off that renders bare markup passes here.
 */

const APP_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "app");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry))
      out.push(full);
  }
  return out;
}

/** The first child of each `<ReceiverShell …>` opening tag in `src`. */
export function receiverFirstChildren(src: string): string[] {
  const out: string[] = [];
  const open = /<ReceiverShell\b/g;
  let m: RegExpExecArray | null;
  while ((m = open.exec(src))) {
    let i = m.index + m[0].length;
    let depth = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    if (src[i - 1] === "/") continue; // self-closing: no children
    const next = /^\s*(\S{1,24})/.exec(src.slice(i + 1));
    out.push(next ? next[1]! : "");
  }
  return out;
}

const ALLOWED = /^(<CardBody\b|<CardHeader\b|\{)/;

describe("receiver pages pad their card", () => {
  const files = sourceFiles(APP_DIR).filter(
    (f) =>
      readFileSync(f, "utf8").includes("<ReceiverShell") &&
      !f.endsWith("receiver-shell.tsx")
  );

  it("finds the receiver pages (non-vacuous)", () => {
    // 11 files rendered a ReceiverShell on 2026-10-28; fewer than 5 means the
    // scan stopped seeing them.
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(files.some((f) => f.includes(join("keys", "requests")))).toBe(true);
  });

  it("the scanner reads a first child, and refuses a bare element", () => {
    expect(
      receiverFirstChildren(
        '<ReceiverShell width="md">\n  <CardBody>x</CardBody>'
      )
    ).toEqual(["<CardBody>x</CardBody>"]);
    expect(
      receiverFirstChildren(
        '<ReceiverShell a={{ b: 1 }} requested={<span />}>\n<div className="x">'
      )
    ).toEqual(["<div"]);
    expect(ALLOWED.test("<div")).toBe(false);
  });

  it("every <ReceiverShell> starts with a padded card section", () => {
    const bare = files.flatMap((f) =>
      receiverFirstChildren(readFileSync(f, "utf8"))
        .filter((child) => !ALLOWED.test(child))
        .map((child) => `${relative(APP_DIR, f)}: ${child}`)
    );
    expect(bare).toEqual([]);
  });
});
