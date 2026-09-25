/**
 * Candidate generation for the Roblox checker.
 *
 * Two modes, matching common "L / C" sniping shorthand:
 *   - "letters": a-z only (the rare, prized 3-5 letter names)
 *   - "chars":   a-z, 0-9 and a single underscore (Roblox's full charset)
 *
 * Candidates are generated lowercase-only. Roblox uniqueness is
 * case-insensitive (you can't register "ABC" if "abc" is taken), so
 * checking every case variant would just be 2^n redundant requests for the
 * same answer — lowercase alone fully covers availability.
 *
 * Both modes walk their space by a deterministic integer index, so a caller
 * can checkpoint by index and resume later without re-generating or
 * re-checking anything already covered.
 */

import { validateRobloxUsername } from "./validate.js";

export type UsernameMode = "letters" | "chars";
export type UsernameLength = 3 | 4 | 5;

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const CHARS = "abcdefghijklmnopqrstuvwxyz0123456789_";

function alphabetFor(mode: UsernameMode): string {
  return mode === "letters" ? LETTERS : CHARS;
}

export function spaceSize(mode: UsernameMode, length: UsernameLength): number {
  return alphabetFor(mode).length ** length;
}

function indexToString(index: number, length: UsernameLength, alphabet: string): string {
  const base = alphabet.length;
  let n = index;
  const chars: string[] = new Array(length);
  for (let i = length - 1; i >= 0; i--) {
    chars[i] = alphabet[n % base];
    n = Math.floor(n / base);
  }
  return chars.join("");
}

/**
 * Walks the full candidate space for (mode, length) in a fixed order,
 * starting at `fromIndex` (inclusive). Yields [index, candidate] pairs.
 *
 * "chars" mode enumerates the raw 37-symbol space and skips any combination
 * that fails validateRobloxUsername (a leading/trailing or doubled
 * underscore) — the skip is a cheap local check, and re-skipping the same
 * invalid indices on a resume costs nothing since no network call is made.
 */
export function* walkCandidates(
  mode: UsernameMode,
  length: UsernameLength,
  fromIndex = 0,
): Generator<[index: number, username: string]> {
  const alphabet = alphabetFor(mode);
  const total = spaceSize(mode, length);
  for (let i = fromIndex; i < total; i++) {
    const candidate = indexToString(i, length, alphabet);
    if (mode === "chars" && !validateRobloxUsername(candidate).valid) continue;
    yield [i, candidate];
  }
}

/** Random, non-repeating draw from the space — for quick exploratory runs over spaces too large to walk exhaustively. */
export function* sampleCandidates(
  mode: UsernameMode,
  length: UsernameLength,
  count: number,
): Generator<string> {
  const alphabet = alphabetFor(mode);
  const total = spaceSize(mode, length);
  const seen = new Set<number>();
  let emitted = 0;
  let attempts = 0;
  const maxAttempts = count * 50 + 10_000;

  while (emitted < count && emitted < total && attempts < maxAttempts) {
    attempts++;
    const i = Math.floor(Math.random() * total);
    if (seen.has(i)) continue;
    seen.add(i);
    const candidate = indexToString(i, length, alphabet);
    if (mode === "chars" && !validateRobloxUsername(candidate).valid) continue;
    emitted++;
    yield candidate;
  }
}
