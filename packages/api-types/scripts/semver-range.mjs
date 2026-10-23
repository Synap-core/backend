/**
 * semver-range — does a published version satisfy a consumer's pinned range?
 *
 * Three answers, never two: `true`, `false`, or `null` = "could not evaluate
 * this range". The old check shelled out to `npx semver` and read ANY failure
 * of that command (no network, npx refusing in a pnpm workspace) as "does not
 * satisfy" — on 2026-10-21 CI reported `^1.25.7` as unsatisfied by 1.31.0.
 * A failed evaluation is not a verdict; the caller says so in words.
 *
 * Covers the range forms consumers actually pin: `1.2.3`, `=1.2.3`, `^1.2.3`,
 * `~1.2.3`, `>=1.2.3`, `*`. Anything else (a prerelease, `||`, a hyphen range,
 * `workspace:`) returns `null`.
 */

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;

function parse(v) {
  const m = VERSION.exec(String(v).trim());
  return m ? m.slice(1, 4).map(Number) : null;
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/** @returns {boolean | null} */
export function satisfiesRange(version, range) {
  const v = parse(version);
  const r = String(range).trim();
  if (!v) return null;
  if (r === "*" || r === "") return true;
  const m = /^(\^|~|>=|=)?(.+)$/.exec(r);
  const op = m[1] ?? "=";
  const base = parse(m[2]);
  if (!base) return null;
  if (op === "=") return compare(v, base) === 0;
  if (compare(v, base) < 0) return false;
  if (op === ">=") return true;
  const [major, minor] = base;
  if (op === "~") return v[0] === major && v[1] === minor;
  // `^`: the left-most non-zero part is fixed (npm semver).
  if (major > 0) return v[0] === major;
  if (minor > 0) return v[0] === 0 && v[1] === minor;
  return compare(v, base) === 0;
}
