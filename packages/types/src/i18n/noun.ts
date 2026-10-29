/**
 * A noun as a value with grammar, and the NOUN BUNDLE a message reads it
 * through (research 7b8070fd §2.3, option C3).
 *
 * French agrees with a noun ("Tâche créée", "Projet créé", "l’idée"), so a
 * sentence cannot take a noun as a bare word: it takes the noun's forms and
 * grammar as one fixed set of params, the bundle:
 *
 *   obj   the singular mid-sentence ("tâche", "UI design")
 *   Obj   the singular at the start of a sentence ("Tâche")
 *   objs  the plural mid-sentence ("tâches")
 *   objG  the gender: "f" | "m" | "n" (n: no grammar known, the neutral phrasing)
 *   objV  "yes" when it starts with a vowel sound (French elides: "l’idée";
 *         English writes "an"), else "no"
 *
 * A message reading ANY member takes the whole bundle (`ParamsOf`), and a
 * translation may read any member when English reads one (`catalogProblems`):
 * English says "Deleted {obj}", French selects on `objG` and `objV`. The
 * vocabulary builds a bundle with `nounParams(resolveNoun(kind))`.
 */

/** A noun's grammatical gender; `n` = unknown (a kind a person defined), read as the neutral phrasing. */
export type NounGender = "f" | "m" | "n";

/** A noun in one locale: its forms and the grammar a sentence agrees with. */
export interface Noun {
  /** The singular, label-cased ("Task", "Tâche", "UI design"). */
  readonly one: string;
  /** The plural, label-cased ("Tasks", "Tâches"). */
  readonly other: string;
  readonly gender: NounGender;
  /** Starts with a vowel sound: French elides the article, English writes "an". */
  readonly elides: boolean;
}

/** The params of the noun bundle: what `nounParams(noun)` returns. */
export interface NounParams {
  readonly obj: string;
  readonly Obj: string;
  readonly objs: string;
  readonly objG: NounGender;
  readonly objV: "yes" | "no";
}

/** The bundle's member names: a message reading one of them takes them all. */
export const NOUN_BUNDLE_MEMBERS = [
  "obj",
  "Obj",
  "objs",
  "objG",
  "objV",
] as const satisfies readonly (keyof NounParams)[];

// Every NounParams member is listed above: a member added to one and not the
// other stops the build.
type _EveryMemberListed =
  Exclude<keyof NounParams, (typeof NOUN_BUNDLE_MEMBERS)[number]> extends never
    ? true
    : never;
const _everyMemberListed: _EveryMemberListed = true;
void _everyMemberListed;
