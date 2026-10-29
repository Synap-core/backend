/**
 * The parameters a message takes, read from its text by the type checker.
 *
 * `ParamsOf<"{n, plural, one {# idea} other {# ideas}} in {space}">` is
 * `{ n: number; space: string | number }`: a plural argument is a number, a
 * select argument a string, a printed one either. A message with no argument
 * takes none. It reads the same subset {@link parseMessage} accepts; the two
 * agree on every message that parses.
 */
import type { ParamValue } from "./message.js";
import type { NounParams } from "./noun.js";

type Space = " " | "\n" | "\t" | "\r";
type TrimStart<S extends string> = S extends `${Space}${infer R}`
  ? TrimStart<R>
  : S;
type TrimEnd<S extends string> = S extends `${infer R}${Space}`
  ? TrimEnd<R>
  : S;
type Trim<S extends string> = TrimStart<TrimEnd<S>>;

/** No parameters yet. */
type None = Record<never, never>;

/**
 * Text up to the `}` that closes the current branch (or the end):
 * `[params found, text after that }]`.
 */
type WalkText<S extends string, P> = S extends `${infer Before}}${infer After}`
  ? Before extends `${string}{${infer Inside}`
    ? ThenText<WalkArgument<`${Inside}}${After}`, P>>
    : [P, After]
  : [P, ""];

type ThenText<R> = R extends [infer P, infer Rest extends string]
  ? WalkText<Rest, P>
  : never;

/** After an argument's `{`: `[params found, text after its closing }]`. */
type WalkArgument<S extends string, P> = S extends `${infer Head}}${infer Rest}`
  ? Head extends `${infer Name},${infer Spec}`
    ? WalkSpec<Trim<Name>, TrimStart<`${Spec}}${Rest}`>, P>
    : [P & Record<Trim<Head>, ParamValue>, Rest]
  : [P, ""];

type WalkSpec<
  Name extends string,
  S extends string,
  P,
> = S extends `plural${infer O}`
  ? TrimStart<O> extends `,${infer Options}`
    ? WalkOptions<Options, P & Record<Name, number>>
    : [P, ""]
  : S extends `select${infer O}`
    ? TrimStart<O> extends `,${infer Options}`
      ? WalkOptions<Options, P & Record<Name, string>>
      : [P, ""]
    : [P, ""];

/** `sel {…} sel {…} }`: `[params found, text after the argument's }]`. */
type WalkOptions<S extends string, P> =
  TrimStart<S> extends `}${infer Rest}`
    ? [P, Rest]
    : TrimStart<S> extends `${string}{${infer Body}`
      ? ThenOptions<WalkText<Body, P>>
      : [P, ""];

type ThenOptions<R> = R extends [infer P, infer Rest extends string]
  ? WalkOptions<Rest, P>
  : never;

type Flatten<T> = { [K in keyof T]: T[K] };

/**
 * A message reading any member of the noun bundle (`obj`, `Obj`, `objs`,
 * `objG`, `objV`) takes the whole bundle, typed as `nounParams` returns it:
 * a translation may read a member English does not (`catalogProblems`), so
 * the caller always passes all of them.
 */
type WithNounBundle<P> =
  Extract<keyof P, keyof NounParams> extends never
    ? P
    : Omit<P, keyof NounParams> & NounParams;

/**
 * The parameter object message `M` takes. A widened `string` (a catalog not
 * declared `as const`) gives a loose record: declare catalogs `as const`.
 */
export type ParamsOf<M extends string> = string extends M
  ? Readonly<Record<string, ParamValue>>
  : Flatten<WithNounBundle<WalkText<M, None>[0]>>;

/** The rest-arguments `t(key, …)` takes for message `M`. */
export type ParamsArgs<M extends string> = string extends M
  ? [params?: Readonly<Record<string, ParamValue>>]
  : keyof ParamsOf<M> extends never
    ? [params?: undefined]
    : [params: ParamsOf<M>];
