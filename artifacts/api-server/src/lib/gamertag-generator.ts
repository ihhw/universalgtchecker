/**
 * Gamertag generation engine.
 *
 * A `GenerationConfig` ({ mode, params }) is compiled once into a generator.
 * Compilation validates every setting and rejects impossible configurations
 * with clear messages, then proves the configuration can actually produce a
 * name before a search starts.
 *
 * Every name returned by a generator has already passed
 * `validateXboxGamertag`, so the Xbox rules (3-15 characters, first character
 * a letter, letters/numbers/single spaces only) cannot be violated by any
 * mode. Invalid candidates are discarded, never silently repaired.
 */

import { WORD_LIST } from "./word-list";
import { GAMERTAG_MAX, GAMERTAG_MIN, validateXboxGamertag } from "./xbox-validation";

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
  "repetitive", "sequential", "alternating", "mirrored", "palindrome", "grouped",
  "block", "pattern", "combination", "prefix", "suffix", "prefix_suffix",
  "customizable", "position", "charset", "vowel_consonant", "word_number", "number_affix",
  "list",
] as const;
export type ModeId = (typeof MODE_IDS)[number];

const SHORT_LABEL: Record<ModeId, string> = {
  random: "RANDOM", letters: "LETTERS", numbers: "NUMBERS", mixed: "MIXED",
  repetitive: "REPEAT", sequential: "SEQUENCE", alternating: "ALTERNATE", mirrored: "MIRROR",
  palindrome: "PALINDROME", grouped: "GROUPS", block: "BLOCK", pattern: "PATTERN",
  combination: "COMBO", prefix: "PREFIX", suffix: "SUFFIX", prefix_suffix: "AFFIX",
  customizable: "CUSTOM", position: "POSITION", charset: "CHARSET", vowel_consonant: "VOWEL",
  word_number: "WORD+NUM", number_affix: "NUM AFFIX", list: "LIST",
};

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
const ALNUM = LETTERS + DIGITS;
const VOWELS = "AEIOU";
const CONSONANTS = [...LETTERS].filter((c) => !VOWELS.includes(c)).join("");

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
const hasLetter = (s: string): boolean => onlyLetters(s).length > 0;
const minus = (set: string, remove: Iterable<string>): string => {
  const r = new Set(remove);
  return [...set].filter((c) => !r.has(c)).join("");
};

type CaseMode = "upper" | "lower" | "mixed";
function applyCase(s: string, mode: CaseMode, rng: Rng): string {
  if (mode === "upper") return s.toUpperCase();
  if (mode === "lower") return s.toLowerCase();
  return [...s].map((c) => (rng() < 0.5 ? c.toLowerCase() : c.toUpperCase())).join("");
}

// ── parameter reader ─────────────────────────────────────────────────────────

const FIELD_LABEL: Record<string, string> = {
  exclude: "Excluded characters",
  require: "Required characters",
  remove: "Remove",
  add: "Add",
  shouldHave: "Should have",
  shouldntHave: "Shouldn't have",
};

interface PosRule { position: number; op: "=" | "!="; char: string }

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

  /** Free text; whitespace is preserved because spaces are valid gamertag characters. */
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

  /** Character set: letters and numbers only, case-insensitive; spaces and commas are ignored. */
  chars(key: string, label = FIELD_LABEL[key] ?? key, def = ""): string {
    const v = this.raw(key);
    if (v === undefined) return def;
    if (typeof v !== "string") {
      this.fail(`${label} must be text.`);
      return def;
    }
    const cleaned = v.replace(/[\s,]/g, "").toUpperCase();
    if (/[^A-Z0-9]/.test(cleaned)) {
      this.fail(`${label} can only contain letters and numbers.`);
      return def;
    }
    return [...new Set(cleaned)].join("");
  }

  /** Length range from minLength/maxLength. A lone minLength means a fixed length. */
  range(def: [number, number]): [number, number] {
    const min = this.int("minLength", "Minimum length", GAMERTAG_MIN, GAMERTAG_MAX, def[0]);
    const max = this.int("maxLength", "Maximum length", GAMERTAG_MIN, GAMERTAG_MAX, this.has("minLength") ? min : def[1]);
    if (min > max) {
      this.fail("Minimum length can't be greater than the maximum length.");
      return [min, min];
    }
    return [min, max];
  }

  private list(key: string, label: string): unknown[] {
    const v = this.raw(key);
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      this.fail(`${label} must be a list.`);
      return [];
    }
    if (v.length > 30) {
      this.fail(`${label} has too many entries (maximum 30).`);
      return [];
    }
    return v;
  }

  exactCounts(key = "exactCounts"): Map<string, number> {
    const out = new Map<string, number>();
    for (const item of this.list(key, "Exact counts")) {
      const o = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
      const ch = typeof o["char"] === "string" ? o["char"].toUpperCase() : "";
      const rawCount = o["count"];
      const count = typeof rawCount === "number" ? rawCount : typeof rawCount === "string" && /^\d+$/.test(rawCount) ? Number(rawCount) : NaN;
      if (!/^[A-Z0-9]$/.test(ch)) {
        this.fail("Each exact count needs a single letter or number.");
        continue;
      }
      if (!Number.isInteger(count) || count < 0 || count > GAMERTAG_MAX) {
        this.fail(`Exact count for "${ch}" must be a whole number from 0 to ${GAMERTAG_MAX}.`);
        continue;
      }
      if (out.has(ch)) {
        this.fail(`"${ch}" has more than one exact count.`);
        continue;
      }
      out.set(ch, count);
    }
    return out;
  }

  positionRules(key = "rules"): PosRule[] {
    const out: PosRule[] = [];
    for (const item of this.list(key, "Position rules")) {
      const o = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
      const rawPos = o["position"];
      const position = typeof rawPos === "number" ? rawPos : typeof rawPos === "string" && /^\d+$/.test(rawPos) ? Number(rawPos) : NaN;
      const ch = typeof o["char"] === "string" ? o["char"].toUpperCase() : "";
      const op = o["op"];
      if (!Number.isInteger(position) || position < 1 || position > GAMERTAG_MAX) {
        this.fail(`Position must be a whole number from 1 to ${GAMERTAG_MAX}.`);
        continue;
      }
      if (op !== "=" && op !== "!=") {
        this.fail(`Position ${position}: choose "is" or "is not".`);
        continue;
      }
      if (!/^[A-Z0-9]$/.test(ch)) {
        this.fail(`Position ${position}: enter a single letter or number.`);
        continue;
      }
      out.push({ position, op, char: ch });
    }
    return out;
  }
}

// ── constraints (required / excluded / exact counts / positions) ─────────────

interface Constraints {
  exclude: Set<string>;
  require: string[];
  exact: Map<string, number>;
  positions: PosRule[];
}

function readConstraints(
  r: Reader,
  o: { exclude?: string[]; require?: string[]; exact?: boolean; positions?: boolean },
): Constraints {
  const exclude = new Set<string>();
  for (const k of o.exclude ?? []) for (const ch of r.chars(k)) exclude.add(ch);
  const require: string[] = [];
  for (const k of o.require ?? []) for (const ch of r.chars(k)) if (!require.includes(ch)) require.push(ch);
  const exactAll = o.exact ? r.exactCounts() : new Map<string, number>();
  const exact = new Map<string, number>();
  for (const [ch, n] of exactAll) {
    if (n === 0) exclude.add(ch); // "exactly zero" is an exclusion
    else exact.set(ch, n);
  }
  return { exclude, require, exact, positions: o.positions ? r.positionRules() : [] };
}

/** Static feasibility checks. Returns the smallest length that can satisfy the constraints. */
function checkConstraints(
  c: Constraints, minLen: number, maxLen: number, pool: string | null, errors: string[],
): number {
  for (const ch of c.require) {
    if (c.exclude.has(ch)) errors.push(`"${ch}" can't be both required and excluded.`);
  }
  for (const ch of c.exact.keys()) {
    if (c.exclude.has(ch)) errors.push(`"${ch}" has an exact count but is also excluded.`);
  }
  if (pool !== null) {
    for (const ch of [...c.require, ...c.exact.keys()]) {
      if (!c.exclude.has(ch) && !pool.includes(ch)) errors.push(`"${ch}" is required but isn't an allowed character.`);
    }
  }

  let total = 0;
  for (const n of c.exact.values()) total += n;
  for (const ch of c.require) if (!c.exact.has(ch)) total += 1;
  if (total > maxLen) {
    errors.push(`The required and exact characters need ${total} positions, but the maximum length is ${maxLen}.`);
  }

  const eq = new Map<number, string>();
  let maxPos = 0;
  for (const p of c.positions) {
    if (p.position > maxLen) errors.push(`Position ${p.position} is beyond the maximum length (${maxLen}).`);
    if (p.op !== "=") continue;
    maxPos = Math.max(maxPos, p.position);
    if (p.position === 1 && !LETTERS.includes(p.char)) errors.push("Xbox gamertags must start with a letter.");
    if (c.exclude.has(p.char)) errors.push(`Position ${p.position} must be "${p.char}", but that character is excluded.`);
    const prev = eq.get(p.position);
    if (prev !== undefined && prev !== p.char) errors.push(`Position ${p.position} can't be both "${prev}" and "${p.char}".`);
    eq.set(p.position, p.char);
  }
  for (const p of c.positions) {
    if (p.op === "!=" && eq.get(p.position) === p.char) {
      errors.push(`Position ${p.position} can't be both "${p.char}" and not "${p.char}".`);
    }
  }
  return Math.max(minLen, total, maxPos);
}

function satisfies(name: string, c: Constraints): boolean {
  const up = name.toUpperCase();
  for (const ch of c.exclude) if (up.includes(ch)) return false;
  for (const ch of c.require) if (!up.includes(ch)) return false;
  for (const [ch, n] of c.exact) {
    let k = 0;
    for (const x of up) if (x === ch) k++;
    if (k !== n) return false;
  }
  for (const p of c.positions) {
    const at = up[p.position - 1];
    if (p.op === "=" ? at !== p.char : at === p.char) return false;
  }
  return true;
}

// ── slot filling ─────────────────────────────────────────────────────────────

type Slot = { fixed: string } | { set: string };
const isFixed = (s: Slot): s is { fixed: string } => "fixed" in s;
const noConstraints = (): Constraints => ({ exclude: new Set(), require: [], exact: new Map(), positions: [] });

function fillSlots(slots: Slot[], c: Constraints, rng: Rng): string | null {
  const n = slots.length;
  const out: (string | null)[] = slots.map((s) => (isFixed(s) ? s.fixed.toUpperCase() : null));

  for (const r of c.positions) {
    if (r.op !== "=") continue;
    const i = r.position - 1;
    if (i >= n) return null;
    const s = slots[i]!;
    if (isFixed(s)) {
      if (out[i] !== r.char) return null;
    } else {
      if (!s.set.includes(r.char)) return null;
      out[i] = r.char;
    }
  }

  const counts = new Map<string, number>();
  for (const ch of out) if (ch !== null) counts.set(ch, (counts.get(ch) ?? 0) + 1);

  const need: string[] = [];
  for (const [ch, cnt] of c.exact) {
    const have = counts.get(ch) ?? 0;
    if (have > cnt) return null;
    for (let k = have; k < cnt; k++) need.push(ch);
  }
  for (const ch of c.require) {
    if (!c.exact.has(ch) && (counts.get(ch) ?? 0) === 0) need.push(ch);
  }

  const free: number[] = [];
  out.forEach((v, i) => { if (v === null) free.push(i); });
  if (need.length > free.length) return null;

  const notAt = (i: number, ch: string): boolean =>
    c.positions.some((r) => r.op === "!=" && r.position - 1 === i && r.char === ch);

  for (const ch of shuffle(need, rng)) {
    const candidates = free.filter((i) => (slots[i] as { set: string }).set.includes(ch) && !notAt(i, ch));
    if (candidates.length === 0) return null;
    const i = candidates[Math.floor(rng() * candidates.length)]!;
    out[i] = ch;
    free.splice(free.indexOf(i), 1);
  }

  for (const i of free) {
    let allowed = "";
    for (const ch of (slots[i] as { set: string }).set) {
      if (!c.exclude.has(ch) && !c.exact.has(ch) && !notAt(i, ch)) allowed += ch;
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

/** A generator over fixed-length-range slot plans with constraints. */
function slotCompiled(
  range: [number, number],
  build: (len: number, rng: Rng) => Slot[] | null,
  c: Constraints,
  opts: { deterministic?: boolean; transform?: (s: string, rng: Rng) => string } = {},
): Compiled {
  return {
    deterministic: opts.deterministic,
    make: (rng) => () => {
      for (let t = 0; t < TRIES; t++) {
        const len = randInt(range[0], range[1], rng);
        const built = build(len, rng);
        if (!built || built.length === 0) continue;
        // The first character is always a letter.
        const first = built[0]!;
        const slots: Slot[] = isFixed(first)
          ? built
          : [{ set: onlyLetters(first.set) }, ...built.slice(1)];
        if (!isFixed(slots[0]!) && (slots[0] as { set: string }).set === "") continue;
        const s = fillSlots(slots, c, rng);
        if (s === null || !satisfies(s, c) || !validateXboxGamertag(s).valid) continue;
        return opts.transform ? opts.transform(s, rng) : s;
      }
      return null;
    },
  };
}

/** A generator over a function that returns a whole candidate (structured modes). */
function directCompiled(
  gen: (rng: Rng) => string | null,
  opts: { deterministic?: boolean } = {},
): Compiled {
  return {
    deterministic: opts.deterministic,
    make: (rng) => () => {
      for (let t = 0; t < TRIES; t++) {
        const s = gen(rng);
        if (s !== null && validateXboxGamertag(s).valid) return s;
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

/** Surface the shared validator's messages for a fixed candidate. */
function requireValidFixed(r: Reader, candidate: string): boolean {
  const v = validateXboxGamertag(candidate);
  if (v.valid) return true;
  for (const e of v.errors) r.fail(`"${candidate}": ${e}`);
  return false;
}

const MUST_START_LETTER = "Xbox gamertags must start with a letter.";

// ── BASIC ────────────────────────────────────────────────────────────────────

function compileRandom(r: Reader): Compiled | null {
  const [minL, maxL] = r.range([4, 4]);
  const pool0 = r.chars("pool", "Character pool", ALNUM) || ALNUM;
  const c = readConstraints(r, { exclude: ["exclude"], require: ["require"] });
  const pool = minus(pool0, c.exclude);
  if (!hasLetter(pool)) r.fail(`The character pool needs at least one letter. ${MUST_START_LETTER}`);
  const effMin = checkConstraints(c, minL, maxL, pool, r.errors);
  if (r.errors.length) return null;
  return slotCompiled([effMin, maxL], (len) => Array.from({ length: len }, () => ({ set: pool })), c);
}

function compileLetters(r: Reader): Compiled | null {
  const [minL, maxL] = r.range([4, 4]);
  const allowed = r.chars("allowed", "Allowed letters", LETTERS) || LETTERS;
  if (/[0-9]/.test(allowed)) r.fail("Letters mode only accepts letters.");
  const c = readConstraints(r, { exclude: ["exclude"] });
  const caseMode = r.oneOf<CaseMode>("case", "Case", ["upper", "lower", "mixed"], "upper");
  const pool = minus(onlyLetters(allowed), c.exclude);
  if (pool === "") r.fail("No letters are left after the exclusions.");
  if (r.errors.length) return null;
  return slotCompiled([minL, maxL], (len) => Array.from({ length: len }, () => ({ set: pool })), noConstraints(), {
    transform: (s, rng) => applyCase(s, caseMode, rng),
  });
}

/**
 * A pure-number gamertag can't exist (the first character must be a letter),
 * so this mode generates one letter followed by numbers, e.g. A123.
 */
function compileNumbers(r: Reader): Compiled | null {
  const [minL, maxL] = r.range([4, 4]);
  const digits = r.chars("digits", "Digits", DIGITS) || DIGITS;
  if (/[A-Z]/.test(digits)) r.fail("Numbers mode only accepts digits after the first letter.");
  const lead = r.chars("leadingLetters", "Leading letters", LETTERS) || LETTERS;
  if (/[0-9]/.test(lead)) r.fail(MUST_START_LETTER);
  const c = readConstraints(r, { exclude: ["exclude"] });
  const digitPool = minus(onlyDigits(digits), c.exclude);
  const leadPool = minus(onlyLetters(lead), c.exclude);
  if (digitPool === "") r.fail("No digits are left after the exclusions.");
  if (leadPool === "") r.fail("No leading letters are left after the exclusions.");
  if (r.errors.length) return null;
  return slotCompiled([minL, maxL], (len) => [
    { set: leadPool },
    ...Array.from({ length: len - 1 }, () => ({ set: digitPool })),
  ], noConstraints());
}

function compileMixed(r: Reader): Compiled | null {
  const [minL, maxL] = r.range([4, 4]);
  const minLetters = r.int("minLetters", "Minimum letters", 1, GAMERTAG_MAX, 1);
  const maxLetters = r.int("maxLetters", "Maximum letters", 1, GAMERTAG_MAX, GAMERTAG_MAX);
  const minNumbers = r.int("minNumbers", "Minimum numbers", 0, GAMERTAG_MAX - 1, 1);
  const maxNumbers = r.int("maxNumbers", "Maximum numbers", 0, GAMERTAG_MAX - 1, GAMERTAG_MAX - 1);
  const pool0 = r.chars("allowed", "Allowed characters", ALNUM) || ALNUM;
  const c = readConstraints(r, { exclude: ["exclude"] });
  const pool = minus(pool0, c.exclude);
  const lettersPool = onlyLetters(pool);
  const digitsPool = onlyDigits(pool);
  if (minLetters > maxLetters) r.fail("Minimum letters can't be greater than maximum letters.");
  if (minNumbers > maxNumbers) r.fail("Minimum numbers can't be greater than maximum numbers.");
  if (lettersPool === "") r.fail(`Allow at least one letter. ${MUST_START_LETTER}`);
  if (minNumbers > 0 && digitsPool === "") r.fail("Numbers are required but no digits are allowed.");
  if (!r.errors.length) {
    let feasible = false;
    for (let len = minL; len <= maxL && !feasible; len++) {
      const lo = Math.max(minLetters, len - maxNumbers, 1);
      const hi = Math.min(maxLetters, len - minNumbers);
      if (lo <= hi) feasible = true;
    }
    if (!feasible) r.fail("The letter and number limits can't be met with this length.");
  }
  if (r.errors.length) return null;
  return slotCompiled([minL, maxL], (len, rng) => {
    const lo = Math.max(minLetters, len - maxNumbers, 1);
    const hi = Math.min(maxLetters, len - minNumbers);
    if (lo > hi) return null;
    const digitCount = len - randInt(lo, hi, rng);
    if (digitCount > 0 && digitsPool === "") return null;
    const digitAt = new Set(shuffle(Array.from({ length: len - 1 }, (_, i) => i + 1), rng).slice(0, digitCount));
    return Array.from({ length: len }, (_, i) => ({ set: digitAt.has(i) ? digitsPool : lettersPool }));
  }, noConstraints());
}

// ── PATTERN ──────────────────────────────────────────────────────────────────

function compileRepetitive(r: Reader): Compiled | null {
  const source = r.oneOf("source", "Source", ["fixed", "random"] as const, "fixed");
  const repeat = r.int("repeat", "Repeat count", 1, GAMERTAG_MAX, 3);
  if (source === "fixed") {
    const unit = r.text("unit", "Character or block", GAMERTAG_MAX);
    if (unit === "") r.fail("Enter a character or block to repeat.");
    if (r.errors.length) return null;
    const full = unit.repeat(repeat);
    if (!requireValidFixed(r, full)) return null;
    return directCompiled(() => full, { deterministic: true });
  }
  const unitLength = r.int("unitLength", "Block length", 1, 7, 1);
  const unitType = r.oneOf("unitType", "Character type", ["letters", "mixed", "numbers"] as const, "letters");
  const c = readConstraints(r, { exclude: ["exclude"] });
  if (unitType === "numbers") {
    r.fail(`${MUST_START_LETTER} A repeated number-only pattern can't be generated.`);
  }
  const total = unitLength * repeat;
  if (total < GAMERTAG_MIN || total > GAMERTAG_MAX) {
    r.fail(`That makes ${total} characters; Xbox gamertags are ${GAMERTAG_MIN}-${GAMERTAG_MAX} characters.`);
  }
  const letters = minus(LETTERS, c.exclude);
  const rest = minus(unitType === "letters" ? LETTERS : ALNUM, c.exclude);
  if (letters === "" || rest === "") r.fail("No characters are left after the exclusions.");
  if (r.errors.length) return null;
  return directCompiled((rng) => {
    let unit = pickChar(letters, rng);
    for (let i = 1; i < unitLength; i++) unit += pickChar(rest, rng);
    return unit.repeat(repeat);
  });
}

function compileSequential(r: Reader): Compiled | null {
  const length = r.int("length", "Sequence length", GAMERTAG_MIN, GAMERTAG_MAX, 4);
  const charset = r.oneOf("charset", "Characters", ["letters", "mixed", "numbers"] as const, "letters");
  const direction = r.oneOf("direction", "Direction", ["up", "down", "both"] as const, "up");
  const start = r.chars("start", "Starting character");
  if (start.length > 1) r.fail("Starting character must be a single character.");
  if (charset === "numbers") {
    r.fail(`${MUST_START_LETTER} A pure-number sequence can't be generated.`);
  }
  if (r.errors.length) return null;

  const alphabet = charset === "letters" ? LETTERS : ALNUM;
  if (length > alphabet.length) {
    r.fail(`A sequence of ${length} doesn't fit in ${charset === "letters" ? "the alphabet" : "A-Z then 0-9"}.`);
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
    if (!LETTERS.includes(start)) {
      r.fail(MUST_START_LETTER);
      return null;
    }
    const idx = alphabet.indexOf(start);
    const names = (direction === "both" ? ["up", "down"] as const : [direction])
      .map((d) => run(idx, d))
      .filter((s): s is string => s !== null);
    if (names.length === 0) {
      r.fail(`A sequence of ${length} starting at ${start} runs past the end of the ${charset === "letters" ? "alphabet" : "characters"}.`);
      return null;
    }
    return finiteCompiled(names);
  }
  return directCompiled((rng) => {
    const dir = direction === "both" ? (rng() < 0.5 ? "up" : "down") : direction;
    const lo = dir === "up" ? 0 : length - 1;
    const hi = dir === "up" ? Math.min(25, alphabet.length - length) : 25;
    if (lo > hi) return null;
    return run(randInt(lo, hi, rng), dir);
  });
}

function compileAlternating(r: Reader): Compiled | null {
  const [minL, maxL] = r.range([4, 4]);
  const oddIn = r.chars("odd", "Odd positions", LETTERS) || LETTERS;
  const evenIn = r.chars("even", "Even positions", DIGITS) || DIGITS;
  const repeatPair = r.bool("repeatPair", true);
  const c = readConstraints(r, { exclude: ["exclude"] });
  const oddSet = minus(oddIn, c.exclude);
  const evenSet = minus(evenIn, c.exclude);
  if (!hasLetter(oddSet)) r.fail(`Position 1 uses the odd-position set, which needs a letter. ${MUST_START_LETTER}`);
  if (evenSet === "") r.fail("The even-position set is empty.");
  if (r.errors.length) return null;
  const oddLetters = onlyLetters(oddSet);
  return directCompiled((rng) => {
    const len = randInt(minL, maxL, rng);
    const x = pickChar(oddLetters, rng);
    const y = pickChar(evenSet, rng);
    let out = "";
    for (let i = 0; i < len; i++) {
      if (i % 2 === 0) out += repeatPair ? x : pickChar(i === 0 ? oddLetters : oddSet, rng);
      else out += repeatPair ? y : pickChar(evenSet, rng);
    }
    return out;
  });
}

function compilePalindromic(r: Reader, mirrored: boolean): Compiled | null {
  const [minL, maxL] = r.range([mirrored ? 4 : 5, mirrored ? 4 : 5]);
  const pool0 = r.chars("pool", "Character pool", ALNUM) || ALNUM;
  const c = readConstraints(r, { exclude: ["exclude"], require: ["require"] });
  const pool = minus(pool0, c.exclude);
  if (!hasLetter(pool)) r.fail(`The character pool needs at least one letter. ${MUST_START_LETTER}`);
  const lengths: number[] = [];
  for (let l = minL; l <= maxL; l++) if (!mirrored || l % 2 === 0) lengths.push(l);
  if (lengths.length === 0) r.fail("Mirrored names need an even length (for example 4 or 6).");
  checkConstraints(c, Math.ceil(minL / 2), Math.ceil(maxL / 2), pool, r.errors);
  if (r.errors.length) return null;
  const halfConstraints: Constraints = { ...noConstraints(), exclude: c.exclude, require: c.require };
  return directCompiled((rng) => {
    const len = lengths[Math.floor(rng() * lengths.length)]!;
    const half = Math.ceil(len / 2);
    const first = { set: onlyLetters(pool) };
    const left = fillSlots([first, ...Array.from({ length: half - 1 }, () => ({ set: pool }))], halfConstraints, rng);
    if (left === null) return null;
    const mirror = [...left].reverse().slice(len % 2 === 1 ? 1 : 0).join("");
    const s = left + mirror;
    return satisfies(s, c) ? s : null;
  });
}

function compileGrouped(r: Reader): Compiled | null {
  const groups = r.int("groups", "Number of groups", 1, GAMERTAG_MAX, 2);
  const size = r.int("groupSize", "Group size", 2, 5, 2);
  const type = r.oneOf("charType", "Character type", ["letters", "mixed", "numbers"] as const, "letters");
  const c = readConstraints(r, { exclude: ["exclude"] });
  if (type === "numbers") r.fail(`${MUST_START_LETTER} Number-only groups can't be generated.`);
  const total = groups * size;
  if (total < GAMERTAG_MIN || total > GAMERTAG_MAX) {
    r.fail(`That makes ${total} characters; Xbox gamertags are ${GAMERTAG_MIN}-${GAMERTAG_MAX} characters.`);
  }
  const letters = minus(LETTERS, c.exclude);
  const rest = minus(type === "letters" ? LETTERS : ALNUM, c.exclude);
  if (letters === "" || rest === "") r.fail("No characters are left after the exclusions.");
  if (r.errors.length) return null;
  return directCompiled((rng) => {
    let prev = "";
    let out = "";
    for (let g = 0; g < groups; g++) {
      const set = g === 0 ? letters : rest;
      let ch = pickChar(set, rng);
      for (let t = 0; t < 10 && ch === prev && set.length > 1; t++) ch = pickChar(set, rng);
      out += ch.repeat(size);
      prev = ch;
    }
    return out;
  });
}

function repeatToLength(unit: string, repeat: number, total: number): string {
  if (total <= 0) return unit.repeat(repeat);
  let out = "";
  while (out.length < total) out += unit;
  return out.slice(0, total);
}

function compileBlock(r: Reader): Compiled | null {
  const block = r.text("block", "Block", GAMERTAG_MAX);
  const repeat = r.int("repeat", "Repeat count", 1, GAMERTAG_MAX, 2);
  const total = r.int("totalLength", "Total length", 0, GAMERTAG_MAX, 0);
  if (block !== "") {
    if (r.errors.length) return null;
    const full = repeatToLength(block, repeat, total);
    if (!requireValidFixed(r, full)) return null;
    return directCompiled(() => full, { deterministic: true });
  }
  const blockLength = r.int("blockLength", "Block length", 1, 7, 3);
  const blockType = r.oneOf("blockType", "Character type", ["letters", "mixed", "numbers"] as const, "mixed");
  if (blockType === "numbers") r.fail(`${MUST_START_LETTER} Number-only blocks can't be generated.`);
  const finalLength = total > 0 ? total : blockLength * repeat;
  if (finalLength < GAMERTAG_MIN || finalLength > GAMERTAG_MAX) {
    r.fail(`That makes ${finalLength} characters; Xbox gamertags are ${GAMERTAG_MIN}-${GAMERTAG_MAX} characters.`);
  }
  if (r.errors.length) return null;
  const rest = blockType === "letters" ? LETTERS : ALNUM;
  return directCompiled((rng) => {
    let unit = pickChar(LETTERS, rng);
    for (let i = 1; i < blockLength; i++) unit += pickChar(rest, rng);
    return repeatToLength(unit, repeat, total);
  });
}

/** Turns a pattern of L / N / X (and spaces) into slots. Returns null after reporting errors. */
function patternSlots(r: Reader, pattern: string, xPool: string, exclude: Set<string>, what: string): Slot[] | null {
  const bad = [...new Set([...pattern].filter((ch) => !"LNX ".includes(ch)))];
  if (bad.length) {
    r.fail(`${what} can only use L, N and X (and spaces). ${bad.map((b) => `"${b}"`).join(", ")} ${bad.length > 1 ? "aren't" : "isn't"} supported.`);
    return null;
  }
  const sets = { L: minus(LETTERS, exclude), N: minus(DIGITS, exclude), X: minus(xPool, exclude) };
  const slots: Slot[] = [];
  for (const ch of pattern) {
    if (ch === " ") slots.push({ fixed: " " });
    else {
      const set = sets[ch as "L" | "N" | "X"];
      if (set === "") {
        r.fail(`No characters are left for "${ch}" after the exclusions.`);
        return null;
      }
      slots.push({ set });
    }
  }
  return slots;
}

function compilePattern(r: Reader): Compiled | null {
  const pattern = r.text("pattern", "Pattern", GAMERTAG_MAX).toUpperCase();
  const xPool = r.chars("pool", "Allowed characters (X)", ALNUM) || ALNUM;
  const c = readConstraints(r, { exclude: ["exclude"] });
  if (pattern === "") r.fail("Enter a pattern such as LLNN.");
  if (pattern.startsWith("N")) r.fail(`Patterns can't start with N. ${MUST_START_LETTER}`);
  if (pattern.startsWith(" ")) r.fail("Gamertag cannot start with a space.");
  if (pattern.length > 0 && (pattern.length < GAMERTAG_MIN || pattern.length > GAMERTAG_MAX)) {
    r.fail(`A pattern must be ${GAMERTAG_MIN}-${GAMERTAG_MAX} characters (yours is ${pattern.length}).`);
  }
  if (r.errors.length) return null;
  const slots = patternSlots(r, pattern, xPool, c.exclude, "A pattern");
  if (!slots) return null;
  return slotCompiled([slots.length, slots.length], () => slots, noConstraints());
}

/** Prefix + pattern (repeated) + suffix. Powers Combination and Prefix + Suffix. */
function compileAffix(r: Reader, withRepeatAndRequire: boolean): Compiled | null {
  const prefix = r.text("prefix", "Prefix", GAMERTAG_MAX).toUpperCase();
  const suffix = r.text("suffix", "Suffix", GAMERTAG_MAX).toUpperCase();
  const pattern = r.text("pattern", "Pattern", GAMERTAG_MAX).toUpperCase();
  const repeat = withRepeatAndRequire ? r.int("repeat", "Pattern repeat", 1, GAMERTAG_MAX, 1) : 1;
  const xPool = r.chars("pool", "Allowed characters (X)", ALNUM) || ALNUM;
  const c = readConstraints(r, { exclude: ["exclude"], require: withRepeatAndRequire ? ["require"] : [] });

  for (const [what, text] of [["prefix", prefix], ["suffix", suffix]] as const) {
    if (/[^A-Z0-9 ]/.test(text)) r.fail(`Special characters are not allowed in the ${what}.`);
    for (const ch of text) if (c.exclude.has(ch)) r.fail(`The ${what} contains "${ch}", which is excluded.`);
  }
  const total = prefix.length + pattern.length * repeat + suffix.length;
  if (total < GAMERTAG_MIN || total > GAMERTAG_MAX) {
    r.fail(`That makes ${total} characters; Xbox gamertags are ${GAMERTAG_MIN}-${GAMERTAG_MAX} characters.`);
  }
  if (prefix !== "") {
    if (!LETTERS.includes(prefix[0]!)) r.fail(prefix[0] === " " ? "Gamertag cannot start with a space." : MUST_START_LETTER);
  } else if (pattern.startsWith("N")) {
    r.fail(`The pattern can't start with N. ${MUST_START_LETTER}`);
  } else if (pattern === "" && suffix !== "" && !LETTERS.includes(suffix[0]!)) {
    r.fail(MUST_START_LETTER);
  }
  if (r.errors.length) return null;

  const middle = patternSlots(r, pattern.repeat(repeat), xPool, c.exclude, "The pattern");
  if (!middle) return null;
  const slots: Slot[] = [
    ...[...prefix].map((ch) => ({ fixed: ch })),
    ...middle,
    ...[...suffix].map((ch) => ({ fixed: ch })),
  ];
  checkConstraints(c, slots.length, slots.length, xPool, r.errors);
  if (r.errors.length) return null;
  return slotCompiled([slots.length, slots.length], () => slots, c, {
    deterministic: slots.every(isFixed),
  });
}

type FillType = "letters" | "numbers" | "mixed";
const fillSet = (type: FillType, exclude: Set<string>): string =>
  minus(type === "letters" ? LETTERS : type === "numbers" ? DIGITS : ALNUM, exclude);

function compilePrefix(r: Reader): Compiled | null {
  const prefix = r.text("prefix", "Prefix", GAMERTAG_MAX).toUpperCase();
  const type = r.oneOf<FillType>("fillType", "Generated characters", ["letters", "numbers", "mixed"], "mixed");
  const fillMin = r.int("fillMin", "Minimum generated characters", 1, GAMERTAG_MAX - 1, 2);
  const fillMax = r.int("fillMax", "Maximum generated characters", 1, GAMERTAG_MAX - 1, r.has("fillMin") ? fillMin : 2);
  const c = readConstraints(r, { exclude: ["exclude"] });
  if (prefix === "") r.fail("Enter a prefix.");
  if (/[^A-Z0-9 ]/.test(prefix)) r.fail("Special characters are not allowed in the prefix.");
  if (prefix !== "" && !LETTERS.includes(prefix[0]!)) r.fail(prefix[0] === " " ? "Gamertag cannot start with a space." : MUST_START_LETTER);
  for (const ch of prefix) if (c.exclude.has(ch)) r.fail(`The prefix contains "${ch}", which is excluded.`);
  if (fillMin > fillMax) r.fail("Minimum generated characters can't be greater than the maximum.");
  if (prefix.length + fillMax > GAMERTAG_MAX) r.fail(`The prefix plus generated characters can't exceed ${GAMERTAG_MAX} characters.`);
  if (prefix.length + fillMin < GAMERTAG_MIN) r.fail(`The prefix plus generated characters must be at least ${GAMERTAG_MIN} characters.`);
  const set = fillSet(type, c.exclude);
  if (set === "") r.fail("No characters are left after the exclusions.");
  if (r.errors.length) return null;
  return slotCompiled([prefix.length + fillMin, prefix.length + fillMax], (len) => [
    ...[...prefix].map((ch) => ({ fixed: ch })),
    ...Array.from({ length: len - prefix.length }, () => ({ set })),
  ], noConstraints());
}

function compileSuffix(r: Reader): Compiled | null {
  const suffix = r.text("suffix", "Suffix", GAMERTAG_MAX).toUpperCase();
  const type = r.oneOf<FillType>("fillType", "Generated characters", ["letters", "numbers", "mixed"], "mixed");
  const fillMin = r.int("fillMin", "Minimum generated characters", 1, GAMERTAG_MAX - 1, 3);
  const fillMax = r.int("fillMax", "Maximum generated characters", 1, GAMERTAG_MAX - 1, r.has("fillMin") ? fillMin : 3);
  const c = readConstraints(r, { exclude: ["exclude"] });
  if (suffix === "") r.fail("Enter a suffix.");
  if (/[^A-Z0-9 ]/.test(suffix)) r.fail("Special characters are not allowed in the suffix.");
  if (suffix.endsWith(" ")) r.fail("Gamertag cannot end with a space.");
  for (const ch of suffix) if (c.exclude.has(ch)) r.fail(`The suffix contains "${ch}", which is excluded.`);
  if (fillMin > fillMax) r.fail("Minimum generated characters can't be greater than the maximum.");
  if (suffix.length + fillMax > GAMERTAG_MAX) r.fail(`The suffix plus generated characters can't exceed ${GAMERTAG_MAX} characters.`);
  if (suffix.length + fillMin < GAMERTAG_MIN) r.fail(`The suffix plus generated characters must be at least ${GAMERTAG_MIN} characters.`);
  const letters = minus(LETTERS, c.exclude);
  // "Numbers" here means one leading letter followed by numbers (e.g. X127).
  const rest = fillSet(type, c.exclude);
  if (letters === "" || rest === "") r.fail("No characters are left after the exclusions.");
  if (r.errors.length) return null;
  return slotCompiled([suffix.length + fillMin, suffix.length + fillMax], (len) => [
    { set: letters },
    ...Array.from({ length: len - suffix.length - 1 }, () => ({ set: rest })),
    ...[...suffix].map((ch) => ({ fixed: ch })),
  ], noConstraints());
}

// ── ADVANCED ─────────────────────────────────────────────────────────────────

function compileCustomizable(r: Reader): Compiled | null {
  const [minL, maxL] = r.range([4, 4]);
  const base = r.oneOf("base", "Start from", ["both", "letters", "added"] as const, "both");
  const add = r.chars("add");
  const have = r.chars("shouldHave");
  const c = readConstraints(r, { exclude: ["remove", "shouldntHave"], require: ["shouldHave"], exact: true });

  const baseSet = base === "both" ? ALNUM : base === "letters" ? LETTERS : "";
  const pool = minus([...new Set(baseSet + add + have + [...c.exact.keys()].join(""))].join(""), c.exclude);

  for (const ch of add) if (c.exclude.has(ch)) r.fail(`"${ch}" is in Add but also removed or forbidden.`);
  if (!hasLetter(pool)) r.fail(`The character pool needs at least one letter. ${MUST_START_LETTER}`);
  const effMin = checkConstraints(c, minL, maxL, pool, r.errors);
  if (r.errors.length) return null;
  return slotCompiled([effMin, maxL], (len) => Array.from({ length: len }, () => ({ set: pool })), c);
}

function compilePosition(r: Reader): Compiled | null {
  const [minL, maxL] = r.range([4, 4]);
  const pool0 = r.chars("pool", "Allowed characters", ALNUM) || ALNUM;
  const c = readConstraints(r, { exclude: ["exclude"], positions: true });
  const pool = minus(pool0, c.exclude);
  for (const p of c.positions) {
    if (p.op === "=" && !c.exclude.has(p.char) && !pool.includes(p.char)) {
      r.fail(`Position ${p.position} must be "${p.char}", which isn't an allowed character.`);
    }
  }
  if (!hasLetter(pool)) r.fail(`The character pool needs at least one letter. ${MUST_START_LETTER}`);
  const effMin = checkConstraints(c, minL, maxL, pool, r.errors);
  if (r.errors.length) return null;
  return slotCompiled([effMin, maxL], (len) => Array.from({ length: len }, () => ({ set: pool })), c);
}

function compileCharset(r: Reader): Compiled | null {
  const [minL, maxL] = r.range([4, 4]);
  const kind = r.oneOf("set", "Character set", ["letters", "numbers", "both", "custom"] as const, "both");
  const custom = r.chars("chars", "Characters");
  const c = readConstraints(r, { exclude: ["exclude"] });
  const base = kind === "letters" ? LETTERS : kind === "numbers" ? DIGITS : kind === "both" ? ALNUM : custom;
  if (kind === "custom" && custom === "") r.fail("Enter the characters to use.");
  const pool = minus(base, c.exclude);
  if (kind === "numbers") {
    r.fail(`${MUST_START_LETTER} Digits alone can't form a gamertag; choose letters or letters and numbers.`);
  } else if (pool !== "" && !hasLetter(pool)) {
    r.fail(`Include at least one letter. ${MUST_START_LETTER}`);
  } else if (pool === "" && !r.errors.length) {
    r.fail("No characters are left after the exclusions.");
  }
  if (r.errors.length) return null;
  return slotCompiled([minL, maxL], (len) => Array.from({ length: len }, () => ({ set: pool })), noConstraints());
}

function compileVowelConsonant(r: Reader): Compiled | null {
  const raw = r.text("patterns", "Patterns", 200) || "VCVC";
  const caseMode = r.oneOf<CaseMode>("case", "Case", ["upper", "lower", "mixed"], "upper");
  const c = readConstraints(r, { exclude: ["exclude"] });
  const patterns = raw.toUpperCase().split(/[\s,;]+/).filter(Boolean);
  if (patterns.length === 0) r.fail("Enter at least one pattern such as VCVC.");
  if (patterns.length > 20) r.fail("Use at most 20 patterns.");
  for (const p of patterns) {
    if (/[^VC]/.test(p)) r.fail(`Pattern "${p}" can only use V (vowel) and C (consonant).`);
    else if (p.length < GAMERTAG_MIN || p.length > GAMERTAG_MAX) r.fail(`Pattern "${p}" must be ${GAMERTAG_MIN}-${GAMERTAG_MAX} characters.`);
  }
  const v = minus(VOWELS, c.exclude);
  const k = minus(CONSONANTS, c.exclude);
  if (!r.errors.length) {
    if (v === "" && patterns.some((p) => p.includes("V"))) r.fail("No vowels are left after the exclusions.");
    if (k === "" && patterns.some((p) => p.includes("C"))) r.fail("No consonants are left after the exclusions.");
  }
  if (r.errors.length) return null;
  const chosen = patterns;
  return {
    make: (rng) => () => {
      for (let t = 0; t < TRIES; t++) {
        const p = chosen[Math.floor(rng() * chosen.length)]!;
        const s = [...p].map((ch) => pickChar(ch === "V" ? v : k, rng)).join("");
        if (validateXboxGamertag(s).valid) return applyCase(s, caseMode, rng);
      }
      return null;
    },
  };
}

function readWordPool(r: Reader): string[] {
  const custom = r.text("words", "Words", 4_000);
  if (custom.trim() === "") return [...WORD_LIST];
  const words = [...new Set(custom.toUpperCase().split(/[\s,;]+/).filter(Boolean))];
  if (words.length > 1_000) r.fail("Use at most 1,000 custom words.");
  for (const w of words) {
    if (!/^[A-Z]+$/.test(w)) r.fail(`Word "${w}" can only contain letters.`);
  }
  return words;
}

/** Word (dictionary or custom) plus digits. Shared by Word + Number and Number Prefix/Suffix. */
function compileWordDigits(r: Reader, positional: boolean): Compiled | null {
  const minW = r.int("minWordLength", "Minimum word length", 2, GAMERTAG_MAX - 1, 4);
  const maxW = r.int("maxWordLength", "Maximum word length", 2, GAMERTAG_MAX - 1, 8);
  // Number Prefix/Suffix always includes numbers; Word + Number allows none (plain words).
  const minD = r.int("minDigits", "Minimum digits", positional ? 1 : 0, 12, 1);
  const maxD = r.int("maxDigits", "Maximum digits", positional ? 1 : 0, 12, 2);
  const position = positional
    ? r.oneOf("position", "Number position", ["suffix", "after-first", "both", "prefix"] as const, "suffix")
    : "suffix";
  const caseMode = r.oneOf<CaseMode>("case", "Case", ["upper", "lower", "mixed"], "upper");
  const c = readConstraints(r, { exclude: ["exclude"] });
  const words0 = readWordPool(r);

  if (position === "prefix") {
    r.fail(`Numbers can't come first. ${MUST_START_LETTER} Use "after the first letter" or "suffix".`);
  }
  if (minW > maxW) r.fail("Minimum word length can't be greater than the maximum.");
  if (minD > maxD) r.fail("Minimum digits can't be greater than maximum digits.");
  const digitPool = minus(DIGITS, c.exclude);
  if (maxD > 0 && digitPool === "") r.fail("No digits are left after the exclusions.");
  const words = words0.filter((w) => w.length >= minW && w.length <= maxW && ![...w].some((ch) => c.exclude.has(ch)));
  if (!r.errors.length && words.length === 0) r.fail("No words match the length and exclusion settings.");
  const multiplier = position === "both" ? 2 : 1;
  if (!r.errors.length && !words.some((w) => w.length + minD * multiplier <= GAMERTAG_MAX && w.length + minD * multiplier >= GAMERTAG_MIN)) {
    r.fail(`No word fits within ${GAMERTAG_MAX} characters with that many digits.`);
  }
  if (r.errors.length) return null;

  const byDigits = new Map<number, string[]>();
  for (let d = minD; d <= maxD; d++) {
    const list = words.filter((w) => w.length + d * multiplier <= GAMERTAG_MAX && w.length + d * multiplier >= GAMERTAG_MIN);
    if (list.length) byDigits.set(d, list);
  }
  const counts = [...byDigits.keys()];
  const digitString = (n: number, rng: Rng): string =>
    Array.from({ length: n }, () => pickChar(digitPool, rng)).join("");

  return directCompiled((rng) => {
    const d = counts[Math.floor(rng() * counts.length)]!;
    const list = byDigits.get(d)!;
    const word = applyCase(list[Math.floor(rng() * list.length)]!, caseMode, rng);
    if (d === 0) return word;
    if (position === "after-first") return word[0]! + digitString(d, rng) + word.slice(1);
    if (position === "both") return word[0]! + digitString(d, rng) + word.slice(1) + digitString(d, rng);
    return word + digitString(d, rng);
  });
}

// ── INPUT ────────────────────────────────────────────────────────────────────

function compileList(r: Reader, info: CompileInfo): Compiled | null {
  const raw = r.p["names"];
  const skipInvalid = r.bool("skipInvalid", false);
  const shuffled = r.bool("shuffle", false);
  if (!Array.isArray(raw)) {
    r.fail("Add at least one gamertag to the list.");
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
    const name = item.replace(/\r$/, "");
    if (name.trim() === "") return; // blank lines are ignored
    const v = validateXboxGamertag(name);
    if (!v.valid) {
      invalid++;
      if (problems.length < 10) problems.push(`Line ${i + 1} "${name}": ${v.errors.join(" ")}`);
      return;
    }
    const key = name.toUpperCase();
    if (seen.has(key)) return;
    seen.add(key);
    names.push(name);
  });
  if (invalid > 0 && !skipInvalid) {
    for (const p of problems) r.fail(p);
    if (invalid > problems.length) r.fail(`...and ${invalid - problems.length} more invalid entries.`);
  }
  if (!r.errors.length && names.length === 0) r.fail("The list has no valid gamertags.");
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
  mirrored: (r) => compilePalindromic(r, true),
  palindrome: (r) => compilePalindromic(r, false),
  grouped: compileGrouped,
  block: compileBlock,
  pattern: compilePattern,
  combination: (r) => compileAffix(r, true),
  prefix: compilePrefix,
  suffix: compileSuffix,
  prefix_suffix: (r) => compileAffix(r, false),
  customizable: compileCustomizable,
  position: compilePosition,
  charset: compileCharset,
  vowel_consonant: compileVowelConsonant,
  word_number: (r) => compileWordDigits(r, false),
  number_affix: (r) => compileWordDigits(r, true),
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

  // Prove the configuration can produce at least one valid name.
  const probe = toGenerator(compiled, rng);
  let produced = 0;
  for (let i = 0; i < PROBE; i++) {
    const s = probe.next();
    if (s === null) break;
    produced++;
  }
  if (produced === 0) {
    return { ...fail(["No valid gamertag can be generated from these settings. Check the length, required characters and exclusions."]), info };
  }

  return {
    ok: true,
    errors: [],
    label: SHORT_LABEL[mode as ModeId],
    info,
    create: (r = Math.random) => toGenerator(compiled, r),
  };
}
