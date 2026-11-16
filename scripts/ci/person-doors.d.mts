/** Types for person-doors.mjs — see that file for the check it runs. */

export const GENERATED_DTS: string;
export const LIST_FILE: string;
export const MIN_MUTATIONS: number;

export interface PersonSurface {
  repo: string;
  dirs: string[];
  minFiles: number;
}
export const SURFACES: PersonSurface[];

export interface PersonDoorList {
  agentOnly: Record<string, string>;
  noPersonDoorYet: string[];
}

export interface PersonDoorSide {
  mutations: string[];
  list: PersonDoorList;
}

export interface PersonDoorVerdict {
  ok: boolean;
  broken: string | null;
  added: string[];
  delisted: string[];
  nowReached: string[];
  notMine: string[];
  gaps: string[];
}

export function parseCoreMutations(dts: string): string[];
export function dottedPaths(source: string, into?: Set<string>): Set<string>;
export function scanSurfaces(
  root: string,
  surfaces?: PersonSurface[]
): { paths: Set<string>; files: Record<string, number> };
export function parseList(text: string): PersonDoorList;
export function decide(input: {
  head: PersonDoorSide;
  base: PersonDoorSide;
  reached: Set<string>;
}): PersonDoorVerdict;
