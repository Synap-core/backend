/**
 * The pseudo-locale: English made visibly foreign and longer, to find chrome
 * that skips the catalog (it stays plain ASCII) and layouts that break when a
 * translation runs long (French runs ~15-30 % longer than English).
 *
 * "Delete {name}?" becomes "[Đéļéţé {name}?···]": every letter accented,
 * the message and each branch padded by ~35 % of its text, the whole bracketed.
 * Arguments, plural and select structure are kept, so it formats like English.
 * Use it in the slot of a translation, e.g. `createT("fr", { en, fr:
 * pseudoLocalize(en) })`.
 */
import {
  parseMessage,
  printMessage,
  type MessageAst,
  type MessagePart,
} from "./message.js";
import type { Catalog, MessageCatalog } from "./translator.js";

// prettier-ignore
const ACCENTED: Readonly<Record<string, string>> = {
  a: "á", b: "ƀ", c: "ç", d: "đ", e: "é", f: "ƒ", g: "ĝ", h: "ĥ", i: "í",
  j: "ĵ", k: "ķ", l: "ļ", m: "ɱ", n: "ñ", o: "ó", p: "þ", q: "ǫ", r: "ŕ",
  s: "š", t: "ţ", u: "ú", v: "ṽ", w: "ŵ", x: "ẋ", y: "ý", z: "ž",
  A: "Á", B: "Ɓ", C: "Ç", D: "Đ", E: "É", F: "Ƒ", G: "Ĝ", H: "Ĥ", I: "Í",
  J: "Ĵ", K: "Ķ", L: "Ļ", M: "Ṁ", N: "Ñ", O: "Ó", P: "Þ", Q: "Ǫ", R: "Ŕ",
  S: "Š", T: "Ţ", U: "Ú", V: "Ṽ", W: "Ŵ", X: "Ẋ", Y: "Ý", Z: "Ž",
};

/** Padding added to each level, as a share of its text length. */
const EXPANSION = 0.35;
const PAD = "·";

/**
 * Accent every text run of one level (the message, or one branch) and pad that
 * level at its end, so the words stay readable and arguments stay in place.
 */
function pseudoAst(ast: MessageAst): MessageAst {
  let textLength = 0;
  const out: MessagePart[] = ast.map((part) => {
    if (part.kind === "text") {
      textLength += part.value.length;
      let value = "";
      for (const ch of part.value) value += ACCENTED[ch] ?? ch;
      return { kind: "text", value };
    }
    if (part.kind === "plural" || part.kind === "select") {
      const options: Record<string, MessageAst> = {};
      for (const [selector, branch] of Object.entries(part.options)) {
        options[selector] = pseudoAst(branch);
      }
      return { ...part, options };
    }
    return part;
  });
  const pad = Math.ceil(textLength * EXPANSION);
  if (pad > 0) out.push({ kind: "text", value: PAD.repeat(pad) });
  return out;
}

/** One message in the pseudo-locale. */
export function pseudoLocalizeMessage(message: string): string {
  return `[${printMessage(pseudoAst(parseMessage(message)))}]`;
}

/** The whole source catalog in the pseudo-locale, key for key. */
export function pseudoLocalize<T extends MessageCatalog>(en: T): Catalog<T> {
  const out: Record<string, string> = {};
  for (const [key, message] of Object.entries(en)) {
    out[key] = pseudoLocalizeMessage(message);
  }
  return out as Catalog<T>;
}
