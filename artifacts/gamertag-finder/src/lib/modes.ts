/**
 * Generation mode catalog for the UI.
 *
 * This describes which controls to show for each mode. It contains no
 * validation of gamertags: the server (`/api/gamertag/config/validate` and the
 * search endpoint) is the only authority on what is valid.
 */

export type Params = Record<string, unknown>;

export type CategoryId = "basic" | "pattern" | "advanced" | "input";

export const CATEGORIES: { id: CategoryId; label: string }[] = [
  { id: "basic", label: "Basic" },
  { id: "pattern", label: "Pattern" },
  { id: "advanced", label: "Advanced" },
  { id: "input", label: "Input" },
];

interface FieldBase {
  key: string;
  label: string;
  hint?: string;
  placeholder?: string;
  /** Show this field only when the predicate is true for the current params. */
  when?: (p: Params) => boolean;
}

export type Field =
  /** Writes minLength and maxLength. */
  | (FieldBase & { kind: "range" })
  | (FieldBase & { kind: "int"; min: number; max: number })
  | (FieldBase & { kind: "text"; maxLength: number; mono?: boolean })
  /** Letters and numbers only (server-validated). */
  | (FieldBase & { kind: "chars" })
  | (FieldBase & { kind: "select"; options: { value: string; label: string }[] })
  | (FieldBase & { kind: "toggle" })
  | (FieldBase & { kind: "textarea"; rows?: number })
  /** One entry per line, stored as string[]. */
  | (FieldBase & { kind: "lines"; upload?: boolean })
  | (FieldBase & { kind: "rules" })
  | (FieldBase & { kind: "counts" });

export interface ModeDef {
  id: string;
  label: string;
  category: CategoryId;
  summary: string;
  /** Shown above the fields (rules the user should know). */
  note?: string;
  fields: Field[];
  defaults: Params;
}

const CASE: Field = {
  kind: "select", key: "case", label: "Case",
  options: [
    { value: "upper", label: "Uppercase" },
    { value: "lower", label: "Lowercase" },
    { value: "mixed", label: "Mixed case" },
  ],
};
const EXCLUDE: Field = { kind: "chars", key: "exclude", label: "Excluded characters", placeholder: "e.g. 0OI" };
const REQUIRE: Field = { kind: "chars", key: "require", label: "Required characters", placeholder: "e.g. 7" };
const LENGTH: Field = { kind: "range", key: "length", label: "Length" };
const FILL_TYPE: Field = {
  kind: "select", key: "fillType", label: "Generated characters",
  options: [
    { value: "mixed", label: "Letters and numbers" },
    { value: "letters", label: "Letters" },
    { value: "numbers", label: "Numbers" },
  ],
};

const len = (n: number): Params => ({ minLength: n, maxLength: n });

export const MODES: ModeDef[] = [
  // ── Basic ───────────────────────────────────────────────────────────────
  {
    id: "random", label: "Random", category: "basic", summary: "Any allowed characters",
    fields: [LENGTH, { kind: "chars", key: "pool", label: "Character pool", placeholder: "Blank = A-Z and 0-9" }, REQUIRE, EXCLUDE],
    defaults: len(4),
  },
  {
    id: "letters", label: "Letters", category: "basic", summary: "Letters only",
    fields: [LENGTH, { kind: "chars", key: "allowed", label: "Allowed letters", placeholder: "Blank = all letters" }, EXCLUDE, CASE],
    defaults: { ...len(4), case: "upper" },
  },
  {
    id: "numbers", label: "Numbers", category: "basic", summary: "A letter, then numbers",
    note: "Xbox gamertags must start with a letter, so a pure-number gamertag cannot be generated. This mode creates a letter followed by numbers, such as A123.",
    fields: [
      LENGTH,
      { kind: "chars", key: "leadingLetters", label: "First letter", placeholder: "Blank = any letter" },
      { kind: "chars", key: "digits", label: "Digits", placeholder: "Blank = 0-9" },
      EXCLUDE,
    ],
    defaults: len(4),
  },
  {
    id: "mixed", label: "Mixed", category: "basic", summary: "Letters and numbers",
    fields: [
      LENGTH,
      { kind: "int", key: "minLetters", label: "Minimum letters", min: 1, max: 15 },
      { kind: "int", key: "maxLetters", label: "Maximum letters", min: 1, max: 15 },
      { kind: "int", key: "minNumbers", label: "Minimum numbers", min: 0, max: 14 },
      { kind: "int", key: "maxNumbers", label: "Maximum numbers", min: 0, max: 14 },
      { kind: "chars", key: "allowed", label: "Allowed characters", placeholder: "Blank = A-Z and 0-9" },
      EXCLUDE,
    ],
    defaults: { ...len(4), minLetters: 1, minNumbers: 1 },
  },

  // ── Pattern ─────────────────────────────────────────────────────────────
  {
    id: "repetitive", label: "Repetitive", category: "pattern", summary: "Repeated characters or blocks",
    fields: [
      { kind: "select", key: "source", label: "Repeat", options: [{ value: "fixed", label: "A character or block I enter" }, { value: "random", label: "A random block" }] },
      { kind: "text", key: "unit", label: "Character or block", maxLength: 15, mono: true, placeholder: "A or AB", when: (p) => p["source"] !== "random" },
      { kind: "int", key: "repeat", label: "Repeat count", min: 1, max: 15 },
      { kind: "int", key: "unitLength", label: "Block length", min: 1, max: 7, when: (p) => p["source"] === "random" },
      {
        kind: "select", key: "unitType", label: "Characters", when: (p) => p["source"] === "random",
        options: [{ value: "letters", label: "Letters" }, { value: "mixed", label: "Letters and numbers" }],
      },
      { ...EXCLUDE, when: (p) => p["source"] === "random" },
    ],
    defaults: { source: "fixed", unit: "A", repeat: 4, unitLength: 1, unitType: "letters" },
  },
  {
    id: "sequential", label: "Sequential", category: "pattern", summary: "ABC, BCD, CDE",
    note: "Pure-number sequences are not generated because the first character must be a letter.",
    fields: [
      { kind: "int", key: "length", label: "Sequence length", min: 3, max: 15 },
      { kind: "select", key: "charset", label: "Characters", options: [{ value: "letters", label: "Letters" }, { value: "mixed", label: "Letters then numbers" }] },
      { kind: "select", key: "direction", label: "Direction", options: [{ value: "up", label: "Ascending" }, { value: "down", label: "Descending" }, { value: "both", label: "Both" }] },
      { kind: "chars", key: "start", label: "Starting character", placeholder: "Blank = random" },
    ],
    defaults: { length: 4, charset: "letters", direction: "up" },
  },
  {
    id: "alternating", label: "Alternating", category: "pattern", summary: "A1A1, ABAB, A2B2",
    fields: [
      LENGTH,
      { kind: "chars", key: "odd", label: "Odd positions", placeholder: "Blank = letters" },
      { kind: "chars", key: "even", label: "Even positions", placeholder: "Blank = numbers" },
      { kind: "toggle", key: "repeatPair", label: "Repeat the same pair", hint: "On: A1A1. Off: A1B2." },
      EXCLUDE,
    ],
    defaults: { ...len(4), repeatPair: true },
  },
  {
    id: "mirrored", label: "Mirrored", category: "pattern", summary: "ABBA, ABCCBA",
    fields: [LENGTH, { kind: "chars", key: "pool", label: "Character pool", placeholder: "Blank = A-Z and 0-9" }, REQUIRE, EXCLUDE],
    defaults: len(4),
  },
  {
    id: "palindrome", label: "Palindrome", category: "pattern", summary: "ABA, ABCBA",
    fields: [LENGTH, { kind: "chars", key: "pool", label: "Character pool", placeholder: "Blank = A-Z and 0-9" }, REQUIRE, EXCLUDE],
    defaults: len(5),
  },
  {
    id: "grouped", label: "Double / Triple", category: "pattern", summary: "AABB, AAABBB",
    fields: [
      { kind: "int", key: "groups", label: "Number of groups", min: 1, max: 15 },
      { kind: "int", key: "groupSize", label: "Group size", min: 2, max: 5, hint: "2 = double, 3 = triple" },
      { kind: "select", key: "charType", label: "Characters", options: [{ value: "letters", label: "Letters" }, { value: "mixed", label: "Letters and numbers" }] },
      EXCLUDE,
    ],
    defaults: { groups: 2, groupSize: 2, charType: "letters" },
  },
  {
    id: "block", label: "Block / Chunk", category: "pattern", summary: "AB12AB12, XY7XY7",
    fields: [
      { kind: "text", key: "block", label: "Block", maxLength: 15, mono: true, placeholder: "Blank = random block" },
      { kind: "int", key: "repeat", label: "Repeat count", min: 1, max: 15 },
      { kind: "int", key: "totalLength", label: "Total length", min: 0, max: 15, hint: "0 = use the repeat count" },
      { kind: "int", key: "blockLength", label: "Random block length", min: 1, max: 7, when: (p) => !p["block"] },
      {
        kind: "select", key: "blockType", label: "Random block characters", when: (p) => !p["block"],
        options: [{ value: "mixed", label: "Letters and numbers" }, { value: "letters", label: "Letters" }],
      },
    ],
    defaults: { block: "", repeat: 2, totalLength: 0, blockLength: 3, blockType: "mixed" },
  },
  {
    id: "pattern", label: "Pattern", category: "pattern", summary: "LLNN, LNLN",
    note: "L = letter, N = number, X = any allowed character. A pattern cannot start with N.",
    fields: [
      { kind: "text", key: "pattern", label: "Pattern", maxLength: 15, mono: true, placeholder: "LLNN" },
      { kind: "chars", key: "pool", label: "Allowed characters for X", placeholder: "Blank = A-Z and 0-9" },
      EXCLUDE,
    ],
    defaults: { pattern: "LLNN" },
  },
  {
    id: "combination", label: "Combination", category: "pattern", summary: "Prefix, pattern, suffix",
    note: "L = letter, N = number, X = any allowed character.",
    fields: [
      { kind: "text", key: "prefix", label: "Prefix", maxLength: 15, mono: true, placeholder: "X" },
      { kind: "text", key: "pattern", label: "Pattern", maxLength: 15, mono: true, placeholder: "LLN" },
      { kind: "int", key: "repeat", label: "Repeat pattern", min: 1, max: 15 },
      { kind: "text", key: "suffix", label: "Suffix", maxLength: 15, mono: true, placeholder: "7" },
      REQUIRE, EXCLUDE,
    ],
    defaults: { prefix: "X", pattern: "LLN", repeat: 1, suffix: "7" },
  },
  {
    id: "prefix", label: "Prefix", category: "pattern", summary: "SJ + generated",
    fields: [
      { kind: "text", key: "prefix", label: "Prefix", maxLength: 15, mono: true, placeholder: "SJ" },
      FILL_TYPE,
      { kind: "int", key: "fillMin", label: "Minimum generated", min: 1, max: 14 },
      { kind: "int", key: "fillMax", label: "Maximum generated", min: 1, max: 14 },
      EXCLUDE,
    ],
    defaults: { prefix: "SJ", fillType: "mixed", fillMin: 2, fillMax: 2 },
  },
  {
    id: "suffix", label: "Suffix", category: "pattern", summary: "Generated + 7",
    note: "The generated part always starts with a letter.",
    fields: [
      { kind: "text", key: "suffix", label: "Suffix", maxLength: 15, mono: true, placeholder: "7" },
      FILL_TYPE,
      { kind: "int", key: "fillMin", label: "Minimum generated", min: 1, max: 14 },
      { kind: "int", key: "fillMax", label: "Maximum generated", min: 1, max: 14 },
      EXCLUDE,
    ],
    defaults: { suffix: "7", fillType: "mixed", fillMin: 3, fillMax: 3 },
  },
  {
    id: "prefix_suffix", label: "Prefix + Suffix", category: "pattern", summary: "Prefix, middle, suffix",
    note: "The middle pattern uses L = letter, N = number, X = any allowed character.",
    fields: [
      { kind: "text", key: "prefix", label: "Prefix", maxLength: 15, mono: true, placeholder: "X" },
      { kind: "text", key: "pattern", label: "Middle pattern", maxLength: 15, mono: true, placeholder: "LLN" },
      { kind: "text", key: "suffix", label: "Suffix", maxLength: 15, mono: true, placeholder: "7" },
      { kind: "chars", key: "pool", label: "Allowed characters for X", placeholder: "Blank = A-Z and 0-9" },
      EXCLUDE,
    ],
    defaults: { prefix: "X", pattern: "LLN", suffix: "7" },
  },

  // ── Advanced ────────────────────────────────────────────────────────────
  {
    id: "customizable", label: "Customizable", category: "advanced", summary: "Full control over characters",
    fields: [
      LENGTH,
      {
        kind: "select", key: "base", label: "Start from",
        options: [{ value: "both", label: "Letters and numbers" }, { value: "letters", label: "Letters only" }, { value: "added", label: "Only the characters I add" }],
      },
      { kind: "chars", key: "remove", label: "Remove", placeholder: "e.g. 0OI", hint: "These characters never appear." },
      { kind: "chars", key: "add", label: "Add", placeholder: "e.g. X7K", hint: "Added to the pool where compatible." },
      { kind: "chars", key: "shouldHave", label: "Should have", placeholder: "e.g. A7", hint: "Every result contains each of these." },
      { kind: "chars", key: "shouldntHave", label: "Shouldn't have", placeholder: "e.g. 0OI", hint: "None of these may appear." },
      { kind: "counts", key: "exactCounts", label: "Exact character counts" },
    ],
    defaults: { ...len(6), base: "both", exactCounts: [] },
  },
  {
    id: "position", label: "Character Position", category: "advanced", summary: "Rules for specific positions",
    fields: [
      LENGTH,
      { kind: "rules", key: "rules", label: "Position rules" },
      { kind: "chars", key: "pool", label: "Allowed characters", placeholder: "Blank = A-Z and 0-9" },
      EXCLUDE,
    ],
    defaults: { ...len(6), rules: [] },
  },
  {
    id: "charset", label: "Character Set", category: "advanced", summary: "Choose the character set",
    fields: [
      LENGTH,
      {
        kind: "select", key: "set", label: "Set",
        options: [{ value: "both", label: "Letters and numbers" }, { value: "letters", label: "Letters" }, { value: "numbers", label: "Numbers" }, { value: "custom", label: "Selected characters" }],
      },
      { kind: "chars", key: "chars", label: "Characters", placeholder: "e.g. ABX7", when: (p) => p["set"] === "custom" },
      EXCLUDE,
    ],
    defaults: { ...len(4), set: "both" },
  },
  {
    id: "vowel_consonant", label: "Vowel / Consonant", category: "advanced", summary: "VCVC, CVCV, VCCV",
    note: "V = vowel, C = consonant. Separate several patterns with commas.",
    fields: [
      { kind: "text", key: "patterns", label: "Patterns", maxLength: 200, mono: true, placeholder: "VCVC, CVCV" },
      CASE,
      EXCLUDE,
    ],
    defaults: { patterns: "VCVC, CVCV", case: "upper" },
  },
  {
    id: "word_number", label: "Word + Number", category: "advanced", summary: "WORD1, WORD99",
    note: "Uses the built-in word list, or your own words. Set digits to 0 for plain words.",
    fields: [
      { kind: "int", key: "minWordLength", label: "Minimum word length", min: 2, max: 14 },
      { kind: "int", key: "maxWordLength", label: "Maximum word length", min: 2, max: 14 },
      { kind: "int", key: "minDigits", label: "Minimum digits", min: 0, max: 12 },
      { kind: "int", key: "maxDigits", label: "Maximum digits", min: 0, max: 12 },
      CASE,
      { kind: "textarea", key: "words", label: "Custom words", placeholder: "Optional. Separate with spaces or commas.", rows: 2 },
      EXCLUDE,
    ],
    defaults: { minWordLength: 4, maxWordLength: 8, minDigits: 1, maxDigits: 2, case: "upper" },
  },
  {
    id: "number_affix", label: "Number Prefix/Suffix", category: "advanced", summary: "Numbers around a word",
    note: "Numbers can't come first, because the first character must be a letter. They go after the first letter or at the end.",
    fields: [
      {
        kind: "select", key: "position", label: "Number position",
        options: [{ value: "suffix", label: "At the end" }, { value: "after-first", label: "After the first letter" }, { value: "both", label: "Both" }],
      },
      { kind: "int", key: "minDigits", label: "Minimum digits", min: 1, max: 12 },
      { kind: "int", key: "maxDigits", label: "Maximum digits", min: 1, max: 12 },
      { kind: "int", key: "minWordLength", label: "Minimum word length", min: 2, max: 14 },
      { kind: "int", key: "maxWordLength", label: "Maximum word length", min: 2, max: 14 },
      CASE,
      { kind: "textarea", key: "words", label: "Custom words", placeholder: "Optional. Separate with spaces or commas.", rows: 2 },
      EXCLUDE,
    ],
    defaults: { position: "suffix", minDigits: 1, maxDigits: 2, minWordLength: 4, maxWordLength: 8, case: "upper" },
  },
  {
    id: "templates", label: "Templates", category: "advanced", summary: "Saved starting points",
    fields: [],
    defaults: {},
  },

  // ── Input ───────────────────────────────────────────────────────────────
  {
    id: "list", label: "List", category: "input", summary: "Check your own names",
    note: "One gamertag per line. Invalid entries are reported, never changed.",
    fields: [
      { kind: "lines", key: "names", label: "Gamertags", upload: true },
      { kind: "toggle", key: "skipInvalid", label: "Skip invalid entries", hint: "Otherwise the list must be fully valid to start." },
      { kind: "toggle", key: "shuffle", label: "Shuffle order" },
    ],
    defaults: { names: [], skipInvalid: false, shuffle: false },
  },
];

export const MODE_BY_ID: Record<string, ModeDef> = Object.fromEntries(MODES.map((m) => [m.id, m]));

export interface TemplateDef {
  id: string;
  label: string;
  hint: string;
  mode: string;
  params: Params;
}

/** Built-in starting points. Applying one selects its mode and fills in its settings. */
export const BUILTIN_TEMPLATES: TemplateDef[] = [
  { id: "l3", label: "3 letters", hint: "ABC", mode: "letters", params: { ...len(3), case: "upper" } },
  { id: "l4", label: "4 letters", hint: "ABCD", mode: "letters", params: { ...len(4), case: "upper" } },
  { id: "ln3", label: "Letter + 3 numbers", hint: "A123", mode: "numbers", params: len(4) },
  { id: "c4", label: "4 characters", hint: "A1B2", mode: "mixed", params: { ...len(4), minLetters: 1, minNumbers: 1 } },
  { id: "pairs", label: "Double pairs", hint: "AABB", mode: "grouped", params: { groups: 2, groupSize: 2, charType: "letters" } },
  { id: "pal5", label: "5-character palindrome", hint: "ABCBA", mode: "palindrome", params: len(5) },
  { id: "cvcv", label: "Pronounceable", hint: "CVCV, VCVC", mode: "vowel_consonant", params: { patterns: "CVCV, VCVC", case: "upper" } },
  { id: "wd", label: "Word + digits", hint: "WORD12", mode: "word_number", params: { minWordLength: 4, maxWordLength: 8, minDigits: 1, maxDigits: 2, case: "upper" } },
  { id: "sw", label: "Short words", hint: "3 to 5 letters", mode: "word_number", params: { minWordLength: 3, maxWordLength: 5, minDigits: 0, maxDigits: 0, case: "upper" } },
  { id: "aw", label: "All words", hint: "Word list", mode: "word_number", params: { minWordLength: 4, maxWordLength: 12, minDigits: 0, maxDigits: 0, case: "upper" } },
];

/** Params safe to keep in browser storage (large lists are excluded). */
export function persistableParams(mode: string, params: Params): Params {
  if (mode !== "list") return params;
  return Object.fromEntries(Object.entries(params).filter(([key]) => key !== "names"));
}

export function defaultParamsByMode(): Record<string, Params> {
  return Object.fromEntries(MODES.map((m) => [m.id, { ...m.defaults }]));
}
