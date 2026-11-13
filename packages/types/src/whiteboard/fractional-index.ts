/**
 * The tldraw 2.4.6 index key: a fractional index (dgreensp's base-62
 * "implementing fractional indexing", the algorithm `@tldraw/utils`
 * `getIndexAbove` runs). A shape's `index` orders it among its siblings and
 * tldraw's store REFUSES a record whose index is not a valid key
 * (`T.indexKey` → `validateOrder`), so a record written outside the editor
 * must carry one of these, above the parent's current top.
 *
 * Only "the key above" is ported: the place door appends shapes on top of
 * what a parent holds. Same digits, same integer-length rule, same trailing-zero
 * refusal, so a key made here sorts exactly where tldraw would put it.
 */

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** The first index tldraw hands out (`ZERO_INDEX_KEY`). */
export const ZERO_INDEX_KEY = "a0";
const SMALLEST_INTEGER = "A00000000000000000000000000";

function integerLength(head: string): number {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - 97 + 2;
  if (head >= "A" && head <= "Z") return 90 - head.charCodeAt(0) + 2;
  throw new Error(`Invalid index key head: ${head}`);
}

function integerPart(index: string): string {
  const len = integerLength(index.charAt(0));
  if (len > index.length) throw new Error(`invalid index: ${index}`);
  return index.slice(0, len);
}

function incrementInteger(x: string): string | undefined {
  if (x.length !== integerLength(x.charAt(0)))
    throw new Error(`invalid integer part of index key: ${x}`);
  const [head, ...digs] = x.split("");
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]) + 1;
    if (d === DIGITS.length) {
      digs[i] = "0";
    } else {
      digs[i] = DIGITS.charAt(d);
      carry = false;
    }
  }
  if (!carry) return head + digs.join("");
  if (head === "Z") return "a0";
  if (head === "z") return undefined;
  const h = String.fromCharCode(head.charCodeAt(0) + 1);
  if (h > "a") digs.push("0");
  else digs.pop();
  return h + digs.join("");
}

/** The midpoint between `a` and the top (dgreensp `midpoint(a, undefined)`). */
function midpointAbove(a: string): string {
  if (a.slice(-1) === "0") throw new Error("trailing zero");
  const digitA = a ? DIGITS.indexOf(a.charAt(0)) : 0;
  if (DIGITS.length - digitA > 1) {
    return DIGITS.charAt(Math.round(0.5 * (digitA + DIGITS.length)));
  }
  return DIGITS.charAt(digitA) + midpointAbove(a.slice(1));
}

/** Is `key` an index tldraw accepts (`validateIndexKey`)? */
export function isValidIndexKey(key: unknown): key is string {
  if (typeof key !== "string" || key.length === 0) return false;
  if (key === SMALLEST_INTEGER) return false;
  try {
    // Exactly tldraw's `validateOrder`: the head and length, no trailing zero
    // (it does not check the other characters, so neither does this).
    const i = integerPart(key);
    return key.slice(i.length).slice(-1) !== "0";
  } catch {
    return false;
  }
}

/**
 * The index key just above `below` (`getIndexAbove`); `ZERO_INDEX_KEY` when
 * there is nothing below. Throws on a key tldraw would refuse.
 */
export function indexAbove(below?: string | null): string {
  if (below === undefined || below === null) return ZERO_INDEX_KEY;
  if (!isValidIndexKey(below)) throw new Error(`invalid index: ${below}`);
  const ia = integerPart(below);
  const fa = below.slice(ia.length);
  const next = incrementInteger(ia);
  return next === undefined ? ia + midpointAbove(fa) : next;
}
