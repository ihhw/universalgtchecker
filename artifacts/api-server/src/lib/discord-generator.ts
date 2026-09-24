/**
 * Discord username generation engine.
 *
 * A `GenerationConfig` ({ mode, params }) is compiled once into a generator.
 * Compilation validates every setting and rejects impossible configurations
 * with clear messages, then proves the configuration can actually produce a
 * name before a search starts.
 *
 * Every name returned by a generator has already passed
 * `validateDiscordUsername`, so Discord's rules (2-32 characters, lowercase
 * a-z/0-9/_/., no leading or trailing period, no double period) cannot be
 * violated by any mode. Invalid candidates are discarded, never silently
 * repaired.
 */

import { ALL_WORDS, DICTIONARY_WORDS, FRAGMENT_WORDS } from "./discord-word-list";
import { DISCORD_USERNAME_MAX, DISCORD_USERNAME_MIN, validateDiscordUsername } from "./discord-validation";

export type Rng = () => number;

export interface Generator {
  /** Next candidate, or null when the source is exhausted (finite modes). */
  next(): string | null;
}

export interface CompileInfo {
  /** Number of distinct names (List mode). */
  count?: number;
  /** Invalid list entries skipped because "skip invalid" was chosen. */
  skipped?: number;
}

export interface CompileOutcome {
  ok: boolean;
  errors: string[];
  /** Short mode label used in the live feed. */
  label: string;
  info: CompileInfo;
  create?: (rng?: Rng) => Generator;
}

export const MODE_IDS = [
  "random", "letters", "numbers", "mixed",
  "repetitive", "sequential", "alternating", "pattern", "symbol",
  "word", "word_pair", "word_num_word",
  "list",
] as const;
export type ModeId = (typeof MODE_IDS)[number];

const SHORT_LABEL: Record<ModeId, string> = {
  random: "RANDOM", letters: "LETTERS", numbers: "NUMBERS", mixed: "MIXED",
  repetitive: "REPEAT", sequential: "SEQUENCE", alternating: "ALTERNATE",
  pattern: "PATTERN", symbol: "SYMBOL",
  word: "WORD", word_pair: "WORD PAIR", word_num_word: "MIX",
  list: "LIST",
};

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";
const ALNUM = LETTERS + DIGITS;

const TRIES = 80;          // attempts per generated name
const PROBE = 25;          // names drawn when proving a config can generate
const MAX_LIST = 20_000;   // List mode size cap
const MAX_TEXT = 64;

// ── small helpers ────────────────────────────────────────────────────────────

const randInt = (min: number, max: number, rng: Rng): number =>
  min + Math.floor(rng() * (max - min + 1));

const pickChar = (set: string, rng: Rng): string => set[Math.floor(rng() * set.length)]!;

function shuffle<T>(items: T[], rng: Rng): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

const onlyLetters = (s: string): string => [...s].filter((c) => LETTERS.includes(c)).join("");
const onlyDigits = (s: string): string => [...s].filter((c) => DIGITS.includes(c)).join("");
const minus = (set: string, remove: Iterable<string>): string => {
  const r = new Set(remove);
  return [...set].filter((c) => !r.has(c)).join("");
};

// ── parameter reader ─────────────────────────────────────────────────────────

const FIELD_LABEL: Record<string, string> = {
  exclude: "Excluded characters",
  require: "Required characters",
};

class Reader {
  errors: string[] = [];
  constructor(readonly p: Record<string, unknown>) {}

  private raw(key: string): unknown {
    const v = this.p[key];
    return v === "" || v === null ? undefined : v;
  }
  has(key: string): boolean {
    return this.raw(key) !== undefined;
  }
  fail(msg: string): void {
    this.errors.push(msg);
  }

  int(key: string, label: string, min: number, max: number, def: number): number {
    const v = this.raw(key);
    if (v === undefined) return def;
    const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
    if (!Number.isInteger(n) || n < min || n > max) {
      this.fail(`${label} must be a whole number from ${min} to ${max}.`);
      return def;
    }
    return n;
  }

  bool(key: string, def: boolean): boolean {
    const v = this.raw(key);
    return typeof v === "boolean" ? v : def;
  }

  text(key: string, label: string, max = MAX_TEXT): string {
    const v = this.raw(key);
    if (v === undefined) return "";
    if (typeof v !== "string") {
      this.fail(`${label} must be text.`);
      return "";
    }
    if (v.length > max) {
      this.fail(`${label} is too long (maximum ${max} characters).`);
      return "";
    }
    return v;
  }

  oneOf<T extends string>(key: string, label: string, options: readonly T[], def: T): T {
    const v = this.raw(key);
    if (v === undefined) return def;
    if (typeof v === "string" && (options as readonly string[]).includes(v)) return v as T;
    this.fail(`${label} must be one of: ${options.join(", ")}.`);
    return def;
  }

  /** Character set: lowercase letters, numbers, underscore and period; spaces and commas ignored. */
  chars(key: string, label = FIELD_LABEL[key] ?? key, def = ""): string {
    const v = this.raw(key);
    if (v === undefined) return def;
    if (typeof v !== "string") {
      this.fail(`${label} must be text.`);
      return def;
    }
    const cleaned = v.replace(/[\s,]/g, "").toLowerCase();
    if (/[^a-z0-9_.]/.test(cleaned)) {
      this.fail(`${label} can only contain lowercase letters, numbers, underscores and periods.`);
      return def;
    }
    return [...new Set(cleaned)].join("");
  }

  /** Length range from minLength/maxLength. A lone minLength means a fixed length. */
  range(def: [number, number]): [number, number] {
    const min = this.int("minLength", "Minimum length", DISCORD_USERNAME_MIN, DISCORD_USERNAME_MAX, def[0]);
    const max = this.int("maxLength", "Maximum length", DISCORD_USERNAME_MIN, DISCORD_USERNAME_MAX, this.has("minLength") ? min : def[1]);
    if (min > max) {
      this.fail("Minimum length can't be greater than the maximum length.");
      return [min, min];
    }
    return [min, max];
  }
}

// ── constraints (required / excluded) ─────────────────────────────────────────

interface Constraints {
  exclude: Set<string>;
  require: string[];
}

function readConstraints(r: Reader, o: { exclude?: string[]; require?: string[] }): Constraints {
  const exclude = new Set<string>();
  for (const k of o.exclude ?? []) for (const ch of r.chars(k)) exclude.add(ch);
  const require: string[] = [];
  for (const k of o.require ?? []) for (const ch of r.chars(k)) if (!require.includes(ch)) require.push(ch);
  return { exclude, require };
}

function checkConstraints(c: Constraints, minLen: number, maxLen: number, pool: string | null, errors: string[]): number {
  for (const ch of c.require) {
    if (c.exclude.has(ch)) errors.push(`"${ch}" can't be both required and excluded.`);
  }
  if (pool !== null) {
    for (const ch of c.require) {
      if (!c.exclude.has(ch) && !pool.includes(ch)) errors.push(`"${ch}" is required but isn't an allowed character.`);
    }
  }
  if (c.require.length > maxLen) {
    errors.push(`The required characters need ${c.require.length} positions, but the maximum length is ${maxLen}.`);
  }
  return Math.max(minLen, c.require.length);
}

function satisfies(name: string, c: Constraints): boolean {
  for (const ch of c.exclude) if (name.includes(ch)) return false;
  for (const ch of c.require) if (!name.includes(ch)) return false;
  return true;
}

// ── slot filling ─────────────────────────────────────────────────────────────

type Slot = { fixed: string } | { set: string };
const isFixed = (s: Slot): s is { fixed: string } => "fixed" in s;
const noConstraints = (): Constraints => ({ exclude: new Set(), require: [] });

function fillSlots(slots: Slot[], c: Constraints, rng: Rng): string | null {
  const n = slots.length;
  const out: (string | null)[] = slots.map((s) => (isFixed(s) ? s.fixed : null));

  const counts = new Map<string, number>();
  for (const ch of out) if (ch !== null) counts.set(ch, (counts.get(ch) ?? 0) + 1);

  const need: string[] = [];
  for (const ch of c.require) {
    if ((counts.get(ch) ?? 0) === 0) need.push(ch);
  }

  const free: number[] = [];
  out.forEach((v, i) => { if (v === null) free.push(i); });
  if (need.length > free.length) return null;

  for (const ch of shuffle(need, rng)) {
    const candidates = free.filter((i) => (slots[i] as { set: string }).set.includes(ch));
    if (candidates.length === 0) return null;
    const i = candidates[Math.floor(rng() * candidates.length)]!;
    out[i] = ch;
    free.splice(free.indexOf(i), 1);
  }

  for (const i of free) {
    let allowed = "";
    for (const ch of (slots[i] as { set: string }).set) {
      if (!c.exclude.has(ch)) allowed += ch;
    }
    if (allowed === "") return null;
    out[i] = pickChar(allowed, rng);
  }
  return out.join("");
}

// ── compiled forms ───────────────────────────────────────────────────────────

interface Compiled {
  /** Produces exactly one name (then the generator ends). */
  deterministic?: boolean;
  make: (rng: Rng) => () => string | null;
}

function slotCompiled(range: [number, number], build: (len: number, rng: Rng) => Slot[] | null, c: Constraints): Compiled {
  return {
    make: (rng) => () => {
      for (let t = 0; t < TRIES; t++) {
        const len = randInt(range[0], range[1], rng);
        const built = build(len, rng);
        if (!built || built.length === 0) continue;
        const s = fillSlots(built, c, rng);
        if (s === null || !satisfies(s, c) || !validateDiscordUsername(s).valid) continue;
        return s;
      }
      return null;
    },
  };
}

function directCompiled(gen: (rng: Rng) => string | null, opts: { deterministic?: boolean } = {}): Compiled {
  return {
    deterministic: opts.deterministic,
    make: (rng) => () => {
      for (let t = 0; t < TRIES; t++) {
        const s = gen(rng);
        if (s !== null && validateDiscordUsername(s).valid) return s;
      }
      return null;
    },
  };
}

function finiteCompiled(names: string[], shuffled = false): Compiled {
  return {
    make: (rng) => {
      const order = shuffled ? shuffle(names, rng) : names;
      let i = 0;
      return () => (i < order.length ? order[i++]! : null);
    },
  };
}

function requireValidFixed(r: Reader, candidate: string): boolean {
  const v = validateDiscordUsername(candidate);
  if (v.valid) return true;
  for (const e of v.errors) r.fail(`"${candidate}": ${e}`);
  return false;
}

// ── BASIC ────────────────────────────────────────────────────────────────────

function compileRandom(r: Reader): Compiled | null {
  const [minL, maxL] = r.range([6, 6]);
  const pool0 = r.chars("pool", "Character pool", ALNUM) || ALNUM;
  const c = readConstraints(r, { exclude: ["exclude"], require: ["require"] });
  const pool = minus(pool0, c.exclude);
  if (pool === "") r.fail("No characters are left after the exclusions.");
  const effMin = checkConstraints(c, minL, maxL, pool, r.errors);
  if (r.errors.length) return null;
  return slotCompiled([effMin, maxL], (len) => Array.from({ length: len }, () => ({ set: pool })), c);
}

function compileLetters(r: Reader): Compiled | null {
  const [minL, maxL] = r.range([6, 6]);
  const allowed = r.chars("allowed", "Allowed letters", LETTERS) || LETTERS;
  if (/[0-9_.]/.test(allowed)) r.fail("Letters mode only accepts letters.");
  const c = readConstraints(r, { exclude: ["exclude"] });
  const pool = minus(onlyLetters(allowed), c.exclude);
  if (pool === "") r.fail("No letters are left after the exclusions.");
  if (r.errors.length) return null;
  return slotCompiled([minL, maxL], (len) => Array.from({ length: len }, () => ({ set: pool })), noConstraints());
}

function compileNumbers(r: Reader): Compiled | null {
  const [minL, maxL] = r.range([6, 6]);
  const digits = r.chars("digits", "Digits", DIGITS) || DIGITS;
  if (/[a-z_.]/.test(digits)) r.fail("Numbers mode only accepts digits.");
  const c = readConstraints(r, { exclude: ["exclude"] });
  const pool = minus(onlyDigits(digits), c.exclude);
  if (pool === "") r.fail("No digits are left after the exclusions.");
  if (r.errors.length) return null;
  return slotCompiled([minL, maxL], (len) => Array.from({ length: len }, () => ({ set: pool })), noConstraints());
}

function compileMixed(r: Reader): Compiled | null {
  const [minL, maxL] = r.range([6, 6]);
  const minLetters = r.int("minLetters", "Minimum letters", 0, DISCORD_USERNAME_MAX, 1);
  const maxLetters = r.int("maxLetters", "Maximum letters", 0, DISCORD_USERNAME_MAX, DISCORD_USERNAME_MAX);
  const minNumbers = r.int("minNumbers", "Minimum numbers", 0, DISCORD_USERNAME_MAX, 1);
  const maxNumbers = r.int("maxNumbers", "Maximum numbers", 0, DISCORD_USERNAME_MAX, DISCORD_USERNAME_MAX);
  const pool0 = r.chars("allowed", "Allowed characters", ALNUM) || ALNUM;
  const c = readConstraints(r, { exclude: ["exclude"] });
  const pool = minus(pool0, c.exclude);
  const lettersPool = onlyLetters(pool);
  const digitsPool = onlyDigits(pool);
  if (minLetters > maxLetters) r.fail("Minimum letters can't be greater than maximum letters.");
  if (minNumbers > maxNumbers) r.fail("Minimum numbers can't be greater than maximum numbers.");
  if (minLetters > 0 && lettersPool === "") r.fail("Letters are required but no letters are allowed.");
  if (minNumbers > 0 && digitsPool === "") r.fail("Numbers are required but no digits are allowed.");
  if (!r.errors.length) {
    let feasible = false;
    for (let len = minL; len <= maxL && !feasible; len++) {
      const lo = Math.max(minLetters, len - maxNumbers, 0);
      const hi = Math.min(maxLetters, len - minNumbers);
      if (lo <= hi) feasible = true;
    }
    if (!feasible) r.fail("The letter and number limits can't be met with this length.");
  }
  if (r.errors.length) return null;
  return slotCompiled([minL, maxL], (len, rng) => {
    const lo = Math.max(minLetters, len - maxNumbers, 0);
    const hi = Math.min(maxLetters, len - minNumbers);
    if (lo > hi) return null;
    const letterCount = randInt(lo, hi, rng);
    const digitCount = len - letterCount;
    if (letterCount > 0 && lettersPool === "") return null;
    if (digitCount > 0 && digitsPool === "") return null;
    const letterAt = new Set(shuffle(Array.from({ length: len }, (_, i) => i), rng).slice(0, letterCount));
    return Array.from({ length: len }, (_, i) => ({ set: letterAt.has(i) ? lettersPool : digitsPool }));
  }, noConstraints());
}

// ── PATTERN ──────────────────────────────────────────────────────────────────

function compileRepetitive(r: Reader): Compiled | null {
  const source = r.oneOf("source", "Source", ["fixed", "random"] as const, "fixed");
  const repeat = r.int("repeat", "Repeat count", 1, DISCORD_USERNAME_MAX, 3);
  if (source === "fixed") {
    const unit = r.text("unit", "Character or block", DISCORD_USERNAME_MAX);
    if (unit === "" ) r.fail("Enter a character or block to repeat.");
    if (r.errors.length) return null;
    const full = unit.toLowerCase().repeat(repeat);
    if (!requireValidFixed(r, full)) return null;
    return directCompiled(() => full, { deterministic: true });
  }
  const unitLength = r.int("unitLength", "Block length", 1, 7, 1);
  const unitType = r.oneOf("unitType", "Character type", ["letters", "mixed", "numbers"] as const, "letters");
  const c = readConstraints(r, { exclude: ["exclude"] });
  const total = unitLength * repeat;
  if (total < DISCORD_USERNAME_MIN || total > DISCORD_USERNAME_MAX) {
    r.fail(`That makes ${total} characters; Discord usernames are ${DISCORD_USERNAME_MIN}-${DISCORD_USERNAME_MAX} characters.`);
  }
  const set = minus(unitType === "letters" ? LETTERS : unitType === "numbers" ? DIGITS : ALNUM, c.exclude);
  if (set === "") r.fail("No characters are left after the exclusions.");
  if (r.errors.length) return null;
  return directCompiled((rng) => {
    let unit = "";
    for (let i = 0; i < unitLength; i++) unit += pickChar(set, rng);
    return unit.repeat(repeat);
  });
}

function compileSequential(r: Reader): Compiled | null {
  const length = r.int("length", "Sequence length", DISCORD_USERNAME_MIN, DISCORD_USERNAME_MAX, 4);
  const charset = r.oneOf("charset", "Characters", ["letters", "mixed", "numbers"] as const, "letters");
  const direction = r.oneOf("direction", "Direction", ["up", "down", "both"] as const, "up");
  const start = r.chars("start", "Starting character");
  if (start.length > 1) r.fail("Starting character must be a single character.");
  if (r.errors.length) return null;

  const alphabet = charset === "letters" ? LETTERS : charset === "numbers" ? DIGITS : ALNUM;
  if (length > alphabet.length) {
    r.fail(`A sequence of ${length} doesn't fit in the chosen characters.`);
    return null;
  }
  const run = (idx: number, dir: "up" | "down"): string | null => {
    const out: string[] = [];
    for (let k = 0; k < length; k++) {
      const at = dir === "up" ? idx + k : idx - k;
      if (at < 0 || at >= alphabet.length) return null;
      out.push(alphabet[at]!);
    }
    return out.join("");
  };

  if (start) {
    const idx = alphabet.indexOf(start);
    if (idx < 0) {
      r.fail("Starting character isn't part of the chosen character set.");
      return null;
    }
    const names = (direction === "both" ? ["up", "down"] as const : [direction])
      .map((d) => run(idx, d))
      .filter((s): s is string => s !== null);
    if (names.length === 0) {
      r.fail(`A sequence of ${length} starting at ${start} runs past the end of the character set.`);
      return null;
    }
    return finiteCompiled(names);
  }
  return directCompiled((rng) => {
    const dir = direction === "both" ? (rng() < 0.5 ? "up" : "down") : direction;
    const lo = dir === "up" ? 0 : length - 1;
    const hi = dir === "up" ? alphabet.length - length : alphabet.length - 1;
    if (lo > hi) return null;
    return run(randInt(lo, hi, rng), dir);
  });
}

function compileAlternating(r: Reader): Compiled | null {
  const [minL, maxL] = r.range([6, 6]);
  const oddIn = r.chars("odd", "Odd positions", LETTERS) || LETTERS;
  const evenIn = r.chars("even", "Even positions", DIGITS) || DIGITS;
  const repeatPair = r.bool("repeatPair", true);
  const c = readConstraints(r, { exclude: ["exclude"] });
  const oddSet = minus(oddIn, c.exclude);
  const evenSet = minus(evenIn, c.exclude);
  if (oddSet === "") r.fail("The odd-position set is empty.");
  if (evenSet === "") r.fail("The even-position set is empty.");
  if (r.errors.length) return null;
  return directCompiled((rng) => {
    const len = randInt(minL, maxL, rng);
    const x = pickChar(oddSet, rng);
    const y = pickChar(evenSet, rng);
    let out = "";
    for (let i = 0; i < len; i++) {
      if (i % 2 === 0) out += repeatPair ? x : pickChar(oddSet, rng);
      else out += repeatPair ? y : pickChar(evenSet, rng);
    }
    return out;
  });
}

/** Turns a pattern of L / N / X into slots. Returns null after reporting errors. */
function patternSlots(r: Reader, pattern: string, xPool: string, exclude: Set<string>): Slot[] | null {
  const bad = [...new Set([...pattern].filter((ch) => !"LNX".includes(ch)))];
  if (bad.length) {
    r.fail(`Pattern can only use L, N and X. ${bad.map((b) => `"${b}"`).join(", ")} ${bad.length > 1 ? "aren't" : "isn't"} supported.`);
    return null;
  }
  const sets = { L: minus(LETTERS, exclude), N: minus(DIGITS, exclude), X: minus(xPool, exclude) };
  const slots: Slot[] = [];
  for (const ch of pattern) {
    const set = sets[ch as "L" | "N" | "X"];
    if (set === "") {
      r.fail(`No characters are left for "${ch}" after the exclusions.`);
      return null;
    }
    slots.push({ set });
  }
  return slots;
}

function compilePattern(r: Reader): Compiled | null {
  const pattern = r.text("pattern", "Pattern", DISCORD_USERNAME_MAX).toUpperCase();
  const xPool = r.chars("pool", "Allowed characters (X)", ALNUM) || ALNUM;
  const c = readConstraints(r, { exclude: ["exclude"] });
  if (pattern === "") r.fail("Enter a pattern such as LLNN.");
  if (pattern.length > 0 && (pattern.length < DISCORD_USERNAME_MIN || pattern.length > DISCORD_USERNAME_MAX)) {
    r.fail(`A pattern must be ${DISCORD_USERNAME_MIN}-${DISCORD_USERNAME_MAX} characters (yours is ${pattern.length}).`);
  }
  if (r.errors.length) return null;
  const slots = patternSlots(r, pattern, xPool, c.exclude);
  if (!slots) return null;
  return slotCompiled([slots.length, slots.length], () => slots, noConstraints());
}

/** One separator (period or underscore) inserted into an alphanumeric block. */
function compileSymbol(r: Reader): Compiled | null {
  const [minL, maxL] = r.range([4, 6]);
  const separator = r.oneOf("separator", "Separator", ["dot", "underscore", "both"] as const, "both");
  const pool0 = r.chars("pool", "Character pool", ALNUM) || ALNUM;
  const c = readConstraints(r, { exclude: ["exclude"] });
  const pool = minus(pool0, c.exclude);
  if (pool === "") r.fail("No characters are left after the exclusions.");
  if (r.errors.length) return null;
  return directCompiled((rng) => {
    const len = randInt(minL, maxL, rng);
    let body = "";
    for (let i = 0; i < len; i++) body += pickChar(pool, rng);
    const sep = separator === "both" ? (rng() < 0.5 ? "." : "_") : separator === "dot" ? "." : "_";
    // A period cannot lead or trail the username; an underscore can.
    const lo = sep === "." ? 1 : 0;
    const hi = sep === "." ? len - 1 : len;
    if (lo > hi) return null;
    const pos = randInt(lo, hi, rng);
    return body.slice(0, pos) + sep + body.slice(pos);
  });
}

// ── ADVANCED (word-based) ───────────────────────────────────────────────────

type WordSource = "fragments" | "dictionary" | "all" | "custom";

function readWordPool(r: Reader, source: WordSource): string[] {
  if (source === "custom") {
    const custom = r.text("words", "Words", 4_000);
    const words = [...new Set(custom.toLowerCase().split(/[\s,;]+/).filter(Boolean))];
    if (words.length > 1_000) r.fail("Use at most 1,000 custom words.");
    for (const w of words) {
      if (!/^[a-z]+$/.test(w)) r.fail(`Word "${w}" can only contain letters.`);
    }
    return words;
  }
  if (source === "fragments") return [...FRAGMENT_WORDS];
  if (source === "dictionary") return [...DICTIONARY_WORDS];
  return [...ALL_WORDS];
}

const WORD_SOURCE_FIELD = ["fragments", "dictionary", "all", "custom"] as const;

function compileWord(r: Reader): Compiled | null {
  const source = r.oneOf("source", "Word source", WORD_SOURCE_FIELD, "all");
  const minW = r.int("minWordLength", "Minimum word length", 2, DISCORD_USERNAME_MAX, 3);
  const maxW = r.int("maxWordLength", "Maximum word length", 2, DISCORD_USERNAME_MAX, 8);
  const minD = r.int("minDigits", "Minimum digits", 0, 12, 0);
  const maxD = r.int("maxDigits", "Maximum digits", 0, 12, 2);
  const position = r.oneOf("position", "Digit position", ["suffix", "prefix", "both"] as const, "suffix");
  const c = readConstraints(r, { exclude: ["exclude"] });
  const words0 = readWordPool(r, source);

  if (minW > maxW) r.fail("Minimum word length can't be greater than the maximum.");
  if (minD > maxD) r.fail("Minimum digits can't be greater than maximum digits.");
  const digitPool = minus(DIGITS, c.exclude);
  if (maxD > 0 && digitPool === "") r.fail("No digits are left after the exclusions.");
  const words = words0.filter((w) => w.length >= minW && w.length <= maxW && ![...w].some((ch) => c.exclude.has(ch)));
  if (!r.errors.length && words.length === 0) r.fail("No words match the length and exclusion settings.");
  const multiplier = position === "both" ? 2 : 1;
  if (!r.errors.length && !words.some((w) => w.length + minD * multiplier <= DISCORD_USERNAME_MAX)) {
    r.fail(`No word fits within ${DISCORD_USERNAME_MAX} characters with that many digits.`);
  }
  if (r.errors.length) return null;

  const byDigits = new Map<number, string[]>();
  for (let d = minD; d <= maxD; d++) {
    const list = words.filter((w) => w.length + d * multiplier <= DISCORD_USERNAME_MAX);
    if (list.length) byDigits.set(d, list);
  }
  const counts = [...byDigits.keys()];
  if (counts.length === 0) {
    r.fail(`No word fits within ${DISCORD_USERNAME_MAX} characters with that many digits.`);
    return null;
  }
  const digitString = (n: number, rng: Rng): string =>
    Array.from({ length: n }, () => pickChar(digitPool, rng)).join("");

  return directCompiled((rng) => {
    const d = counts[Math.floor(rng() * counts.length)]!;
    const list = byDigits.get(d)!;
    const word = list[Math.floor(rng() * list.length)]!;
    if (d === 0) return word;
    if (position === "prefix") return digitString(d, rng) + word;
    if (position === "both") return digitString(d, rng) + word + digitString(d, rng);
    return word + digitString(d, rng);
  });
}

function compileWordPair(r: Reader): Compiled | null {
  const source = r.oneOf("source", "Word source", ["fragments", "dictionary", "all"] as const, "all");
  const separator = r.oneOf("separator", "Separator", ["none", "underscore", "dot"] as const, "none");
  const words = readWordPool(r, source);
  if (words.length < 2) r.fail("Need at least two words to pair.");
  if (r.errors.length) return null;
  const sep = separator === "underscore" ? "_" : separator === "dot" ? "." : "";
  const k = words.length;
  return directCompiled((rng) => {
    const a = Math.floor(rng() * k);
    let b = Math.floor(rng() * (k - 1));
    if (b >= a) b += 1;
    return words[a]! + sep + words[b]!;
  });
}

function compileWordNumWord(r: Reader): Compiled | null {
  const source = r.oneOf("source", "Word source", ["fragments", "dictionary", "all"] as const, "all");
  const minD = r.int("minDigits", "Minimum digits", 1, 6, 1);
  const maxD = r.int("maxDigits", "Maximum digits", 1, 6, 2);
  const separator = r.oneOf("separator", "Separator", ["none", "underscore", "dot", "mixed"] as const, "mixed");
  const words = readWordPool(r, source);
  if (words.length < 2) r.fail("Need at least two words.");
  if (minD > maxD) r.fail("Minimum digits can't be greater than maximum digits.");
  if (r.errors.length) return null;
  const k = words.length;
  const seps = separator === "mixed" ? (["", "_", "."] as const) : ([separator === "underscore" ? "_" : separator === "dot" ? "." : ""] as const);
  return directCompiled((rng) => {
    const a = Math.floor(rng() * k);
    let b = Math.floor(rng() * (k - 1));
    if (b >= a) b += 1;
    const d = randInt(minD, maxD, rng);
    const digits = Array.from({ length: d }, () => pickChar(DIGITS, rng)).join("");
    const sep = seps[Math.floor(rng() * seps.length)]!;
    return words[a]! + sep + digits + sep + words[b]!;
  });
}

// ── INPUT ────────────────────────────────────────────────────────────────────

function compileList(r: Reader, info: CompileInfo): Compiled | null {
  const raw = r.p["names"];
  const skipInvalid = r.bool("skipInvalid", false);
  const shuffled = r.bool("shuffle", false);
  if (!Array.isArray(raw)) {
    r.fail("Add at least one username to the list.");
    return null;
  }
  if (raw.length > MAX_LIST) {
    r.fail(`The list is too long (maximum ${MAX_LIST.toLocaleString("en-US")} names).`);
    return null;
  }
  const seen = new Set<string>();
  const names: string[] = [];
  const problems: string[] = [];
  let invalid = 0;
  raw.forEach((item, i) => {
    if (typeof item !== "string") {
      invalid++;
      if (problems.length < 10) problems.push(`Line ${i + 1}: entries must be text.`);
      return;
    }
    const name = item.replace(/\r$/, "").trim().toLowerCase();
    if (name === "") return; // blank lines are ignored
    const v = validateDiscordUsername(name);
    if (!v.valid) {
      invalid++;
      if (problems.length < 10) problems.push(`Line ${i + 1} "${name}": ${v.errors.join(" ")}`);
      return;
    }
    if (seen.has(name)) return;
    seen.add(name);
    names.push(name);
  });
  if (invalid > 0 && !skipInvalid) {
    for (const p of problems) r.fail(p);
    if (invalid > problems.length) r.fail(`...and ${invalid - problems.length} more invalid entries.`);
  }
  if (!r.errors.length && names.length === 0) r.fail("The list has no valid usernames.");
  info.count = names.length;
  info.skipped = skipInvalid ? invalid : 0;
  if (r.errors.length) return null;
  return finiteCompiled(names, shuffled);
}

// ── entry point ──────────────────────────────────────────────────────────────

const COMPILERS: Record<ModeId, (r: Reader, info: CompileInfo) => Compiled | null> = {
  random: compileRandom,
  letters: compileLetters,
  numbers: compileNumbers,
  mixed: compileMixed,
  repetitive: compileRepetitive,
  sequential: compileSequential,
  alternating: compileAlternating,
  pattern: compilePattern,
  symbol: compileSymbol,
  word: compileWord,
  word_pair: compileWordPair,
  word_num_word: compileWordNumWord,
  list: compileList,
};

function toGenerator(c: Compiled, rng: Rng): Generator {
  const inner = c.make(rng);
  if (!c.deterministic) return { next: inner };
  let done = false;
  return {
    next: () => {
      if (done) return null;
      done = true;
      return inner();
    },
  };
}

/**
 * Validate and compile a generation config. On success `create()` returns a
 * fresh generator; on failure `errors` explains what to change.
 */
export function compileGeneration(config: unknown, rng: Rng = Math.random): CompileOutcome {
  const fail = (errors: string[]): CompileOutcome => ({
    ok: false, errors: [...new Set(errors)], label: "", info: {},
  });

  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return fail(["Choose a generation mode."]);
  }
  const { mode, params } = config as { mode?: unknown; params?: unknown };
  if (typeof mode !== "string" || !(MODE_IDS as readonly string[]).includes(mode)) {
    return fail(["Choose a valid generation mode."]);
  }
  if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
    return fail(["Mode settings must be an object."]);
  }

  const reader = new Reader((params ?? {}) as Record<string, unknown>);
  const info: CompileInfo = {};
  const compiled = COMPILERS[mode as ModeId](reader, info);
  if (reader.errors.length > 0 || !compiled) {
    return { ...fail(reader.errors.length ? reader.errors : ["This configuration isn't valid."]), info };
  }

  const probe = toGenerator(compiled, rng);
  let produced = 0;
  for (let i = 0; i < PROBE; i++) {
    const s = probe.next();
    if (s === null) break;
    produced++;
  }
  if (produced === 0) {
    return { ...fail(["No valid username can be generated from these settings. Check the length, required characters and exclusions."]), info };
  }

  return {
    ok: true,
    errors: [],
    label: SHORT_LABEL[mode as ModeId],
    info,
    create: (r = Math.random) => toGenerator(compiled, r),
  };
}
