/**
 * Discord generation mode catalog for the UI.
 *
 * This describes which controls to show for each mode. It contains no
 * validation of usernames: the server (`/api/discord/config/validate` and the
 * search endpoint) is the only authority on what is valid.
 */

import { CATEGORIES, type Field, type ModeDef, type Params, type TemplateDef } from "@/lib/modes";

export { CATEGORIES };
export type { Params, TemplateDef };

export const DISCORD_LENGTH_MIN = 2;
export const DISCORD_LENGTH_MAX = 32;

const WORD_SOURCE: Field = {
  kind: "select", key: "source", label: "Word source",
  options: [
    { value: "all", label: "All words" },
    { value: "dictionary", label: "Dictionary words" },
    { value: "fragments", label: "Short fragments" },
    { value: "custom", label: "My own words" },
  ],
};
const EXCLUDE: Field = { kind: "chars", key: "exclude", label: "Excluded characters", placeholder: "e.g. 0oi" };
const REQUIRE: Field = { kind: "chars", key: "require", label: "Required characters", placeholder: "e.g. 7" };
const LENGTH: Field = { kind: "range", key: "length", label: "Length" };

const len = (n: number): Params => ({ minLength: n, maxLength: n });

export const DISCORD_MODES: ModeDef[] = [
  // ── Basic ───────────────────────────────────────────────────────────────
  {
    id: "random", label: "Random", category: "basic", summary: "Any allowed characters",
    fields: [LENGTH, { kind: "chars", key: "pool", label: "Character pool", placeholder: "Blank = a-z and 0-9" }, REQUIRE, EXCLUDE],
    defaults: len(6),
  },
  {
    id: "letters", label: "Letters", category: "basic", summary: "Letters only",
    fields: [LENGTH, { kind: "chars", key: "allowed", label: "Allowed letters", placeholder: "Blank = all letters" }, EXCLUDE],
    defaults: len(6),
  },
  {
    id: "numbers", label: "Numbers", category: "basic", summary: "Digits only",
    fields: [LENGTH, { kind: "chars", key: "digits", label: "Digits", placeholder: "Blank = 0-9" }, EXCLUDE],
    defaults: len(6),
  },
  {
    id: "mixed", label: "Mixed", category: "basic", summary: "Letters and numbers",
    fields: [
      LENGTH,
      { kind: "int", key: "minLetters", label: "Minimum letters", min: 0, max: 32 },
      { kind: "int", key: "maxLetters", label: "Maximum letters", min: 0, max: 32 },
      { kind: "int", key: "minNumbers", label: "Minimum numbers", min: 0, max: 32 },
      { kind: "int", key: "maxNumbers", label: "Maximum numbers", min: 0, max: 32 },
      { kind: "chars", key: "allowed", label: "Allowed characters", placeholder: "Blank = a-z and 0-9" },
      EXCLUDE,
    ],
    defaults: { ...len(6), minLetters: 1, maxLetters: 32, minNumbers: 1, maxNumbers: 32 },
  },

  // ── Pattern ─────────────────────────────────────────────────────────────
  {
    id: "repetitive", label: "Repetitive", category: "pattern", summary: "Repeated characters or blocks",
    fields: [
      { kind: "select", key: "source", label: "Repeat", options: [{ value: "fixed", label: "A character or block I enter" }, { value: "random", label: "A random block" }] },
      { kind: "text", key: "unit", label: "Character or block", maxLength: 32, mono: true, placeholder: "ab", when: (p) => p["source"] !== "random" },
      { kind: "int", key: "repeat", label: "Repeat count", min: 1, max: 32 },
      { kind: "int", key: "unitLength", label: "Block length", min: 1, max: 7, when: (p) => p["source"] === "random" },
      {
        kind: "select", key: "unitType", label: "Characters", when: (p) => p["source"] === "random",
        options: [{ value: "letters", label: "Letters" }, { value: "mixed", label: "Letters and numbers" }, { value: "numbers", label: "Numbers" }],
      },
      { ...EXCLUDE, when: (p) => p["source"] === "random" },
    ],
    defaults: { source: "fixed", unit: "ab", repeat: 3, unitLength: 1, unitType: "letters" },
  },
  {
    id: "sequential", label: "Sequential", category: "pattern", summary: "abc, bcd, cde",
    fields: [
      { kind: "int", key: "length", label: "Sequence length", min: 2, max: 32 },
      { kind: "select", key: "charset", label: "Characters", options: [{ value: "letters", label: "Letters" }, { value: "mixed", label: "Letters then numbers" }, { value: "numbers", label: "Numbers" }] },
      { kind: "select", key: "direction", label: "Direction", options: [{ value: "up", label: "Ascending" }, { value: "down", label: "Descending" }, { value: "both", label: "Both" }] },
      { kind: "chars", key: "start", label: "Starting character", placeholder: "Blank = random" },
    ],
    defaults: { length: 4, charset: "letters", direction: "up" },
  },
  {
    id: "alternating", label: "Alternating", category: "pattern", summary: "a1a1, abab, a2b2",
    fields: [
      LENGTH,
      { kind: "chars", key: "odd", label: "Odd positions", placeholder: "Blank = letters" },
      { kind: "chars", key: "even", label: "Even positions", placeholder: "Blank = numbers" },
      { kind: "toggle", key: "repeatPair", label: "Repeat the same pair", hint: "On: a1a1. Off: a1b2." },
      EXCLUDE,
    ],
    defaults: { ...len(6), repeatPair: true },
  },
  {
    id: "pattern", label: "Pattern", category: "pattern", summary: "llnn, lnln",
    note: "L = letter, N = number, X = any allowed character.",
    fields: [
      { kind: "text", key: "pattern", label: "Pattern", maxLength: 32, mono: true, placeholder: "LLNN" },
      { kind: "chars", key: "pool", label: "Allowed characters for X", placeholder: "Blank = a-z and 0-9" },
      EXCLUDE,
    ],
    defaults: { pattern: "LLNN" },
  },
  {
    id: "symbol", label: "Symbol", category: "pattern", summary: "ab.7cd, ab_7cd",
    note: "Inserts one period or underscore into a random block. A period never leads or trails; an underscore can.",
    fields: [
      LENGTH,
      { kind: "select", key: "separator", label: "Separator", options: [{ value: "both", label: "Period or underscore" }, { value: "dot", label: "Period (.)" }, { value: "underscore", label: "Underscore (_)" }] },
      { kind: "chars", key: "pool", label: "Character pool", placeholder: "Blank = a-z and 0-9" },
      EXCLUDE,
    ],
    defaults: { ...len(5), separator: "both" },
  },

  // ── Advanced (word-based) ──────────────────────────────────────────────
  {
    id: "word", label: "Word", category: "advanced", summary: "word, word12, 12word",
    note: "Uses the built-in word lists, or your own words. Set digits to 0 for plain words.",
    fields: [
      WORD_SOURCE,
      { kind: "int", key: "minWordLength", label: "Minimum word length", min: 2, max: 32 },
      { kind: "int", key: "maxWordLength", label: "Maximum word length", min: 2, max: 32 },
      { kind: "int", key: "minDigits", label: "Minimum digits", min: 0, max: 12 },
      { kind: "int", key: "maxDigits", label: "Maximum digits", min: 0, max: 12 },
      { kind: "select", key: "position", label: "Digit position", options: [{ value: "suffix", label: "At the end" }, { value: "prefix", label: "At the start" }, { value: "both", label: "Both" }] },
      { kind: "textarea", key: "words", label: "Custom words", placeholder: "Optional. Separate with spaces or commas.", rows: 2, when: (p) => p["source"] === "custom" },
      EXCLUDE,
    ],
    defaults: { source: "all", minWordLength: 3, maxWordLength: 8, minDigits: 0, maxDigits: 2, position: "suffix" },
  },
  {
    id: "word_pair", label: "Word Pair", category: "advanced", summary: "eastcoast, night_owl",
    fields: [
      WORD_SOURCE,
      { kind: "select", key: "separator", label: "Separator", options: [{ value: "none", label: "None" }, { value: "underscore", label: "Underscore (_)" }, { value: "dot", label: "Period (.)" }] },
    ],
    defaults: { source: "all", separator: "none" },
  },
  {
    id: "word_num_word", label: "Mix", category: "advanced", summary: "fire7wolf, nova.42.sky",
    note: "The highest-yield mode: two words joined by digits, with a random separator.",
    fields: [
      WORD_SOURCE,
      { kind: "int", key: "minDigits", label: "Minimum digits", min: 1, max: 6 },
      { kind: "int", key: "maxDigits", label: "Maximum digits", min: 1, max: 6 },
      { kind: "select", key: "separator", label: "Separator", options: [{ value: "mixed", label: "Mixed (none, _ or .)" }, { value: "none", label: "None" }, { value: "underscore", label: "Underscore (_)" }, { value: "dot", label: "Period (.)" }] },
    ],
    defaults: { source: "all", minDigits: 1, maxDigits: 2, separator: "mixed" },
  },
  {
    id: "templates", label: "Templates", category: "advanced", summary: "Saved starting points",
    fields: [],
    defaults: {},
  },

  // ── Input ───────────────────────────────────────────────────────────────
  {
    id: "list", label: "List", category: "input", summary: "Check your own names",
    note: "One username per line. Invalid entries are reported, never changed.",
    fields: [
      { kind: "lines", key: "names", label: "Usernames", upload: true },
      { kind: "toggle", key: "skipInvalid", label: "Skip invalid entries", hint: "Otherwise the list must be fully valid to start." },
      { kind: "toggle", key: "shuffle", label: "Shuffle order" },
    ],
    defaults: { names: [], skipInvalid: false, shuffle: false },
  },
];

export const DISCORD_MODE_BY_ID: Record<string, ModeDef> = Object.fromEntries(DISCORD_MODES.map((m) => [m.id, m]));

/** Built-in starting points. Applying one selects its mode and fills in its settings. */
export const DISCORD_BUILTIN_TEMPLATES: TemplateDef[] = [
  { id: "l4", label: "4 letters", hint: "abcd", mode: "letters", params: len(4) },
  { id: "n4", label: "4 numbers", hint: "1234", mode: "numbers", params: len(4) },
  { id: "c5", label: "5 characters", hint: "a1b2c", mode: "mixed", params: { ...len(5), minLetters: 1, maxLetters: 32, minNumbers: 1, maxNumbers: 32 } },
  { id: "sym", label: "Symbol pattern", hint: "ab.7cd", mode: "symbol", params: { ...len(5), separator: "both" } },
  { id: "wd", label: "Word + digits", hint: "word12", mode: "word", params: { source: "all", minWordLength: 3, maxWordLength: 8, minDigits: 1, maxDigits: 2, position: "suffix" } },
  { id: "sw", label: "Short words", hint: "3 to 5 letters", mode: "word", params: { source: "all", minWordLength: 3, maxWordLength: 5, minDigits: 0, maxDigits: 0, position: "suffix" } },
  { id: "wp", label: "Word pair", hint: "eastcoast", mode: "word_pair", params: { source: "all", separator: "none" } },
  { id: "mix", label: "Mix (highest yield)", hint: "fire7wolf", mode: "word_num_word", params: { source: "all", minDigits: 1, maxDigits: 2, separator: "mixed" } },
];

/** Params safe to keep in browser storage (large lists are excluded). */
export function discordPersistableParams(mode: string, params: Params): Params {
  if (mode !== "list") return params;
  return Object.fromEntries(Object.entries(params).filter(([key]) => key !== "names"));
}

export function discordDefaultParamsByMode(): Record<string, Params> {
  return Object.fromEntries(DISCORD_MODES.map((m) => [m.id, { ...m.defaults }]));
}
