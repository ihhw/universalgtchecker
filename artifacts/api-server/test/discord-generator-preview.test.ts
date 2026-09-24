import { test } from "node:test";
import assert from "node:assert/strict";
import { compileGeneration, MODE_IDS } from "../src/lib/discord-generator";
import { validateDiscordUsername } from "../src/lib/discord-validation";

// Mirrors previewSamples() in routes/discord.ts: draws a bounded number of
// names from a compiled generator for the live preview shown while a
// generation config is being edited.
const PREVIEW_SAMPLES = 8;
const PREVIEW_DRAWS = 40;

function previewSamples(outcome: ReturnType<typeof compileGeneration>): string[] {
  if (!outcome.ok || !outcome.create) return [];
  const gen = outcome.create();
  const seen = new Set<string>();
  for (let i = 0; i < PREVIEW_DRAWS && seen.size < PREVIEW_SAMPLES; i++) {
    const s = gen.next();
    if (s === null) break;
    seen.add(s);
  }
  return [...seen];
}

test("preview samples: valid config produces samples that are all valid, unique Discord usernames", () => {
  const outcome = compileGeneration({ mode: "letters", params: { minLength: 6, maxLength: 6 } });
  assert.equal(outcome.ok, true);
  const samples = previewSamples(outcome);
  assert.ok(samples.length > 0);
  assert.equal(new Set(samples).size, samples.length, "samples must be unique");
  for (const s of samples) assert.equal(validateDiscordUsername(s).valid, true, `${s} should be a valid username`);
});

test("preview samples: invalid config produces no samples", () => {
  const outcome = compileGeneration({ mode: "letters", params: { minLength: 999, maxLength: 999 } });
  assert.equal(outcome.ok, false);
  assert.deepEqual(previewSamples(outcome), []);
});

test("preview samples: a deterministic (fixed) mode produces exactly one sample", () => {
  const outcome = compileGeneration({ mode: "repetitive", params: { source: "fixed", unit: "ab", repeat: 2 } });
  assert.equal(outcome.ok, true);
  const samples = previewSamples(outcome);
  assert.deepEqual(samples, ["abab"]);
});

test("preview samples: list mode previews from the provided names", () => {
  const outcome = compileGeneration({ mode: "list", params: { names: ["abcd", "wxyz", "qqqq"] } });
  assert.equal(outcome.ok, true);
  const samples = previewSamples(outcome);
  assert.deepEqual(new Set(samples), new Set(["abcd", "wxyz", "qqqq"]));
});

test("symbol mode: never places a period first or last", () => {
  const outcome = compileGeneration({ mode: "symbol", params: { minLength: 4, maxLength: 6, separator: "dot" } });
  assert.equal(outcome.ok, true);
  assert.ok(outcome.create);
  const gen = outcome.create!();
  for (let i = 0; i < 100; i++) {
    const s = gen.next();
    if (s === null) break;
    assert.equal(validateDiscordUsername(s).valid, true, `${s} should be valid`);
    assert.ok(s.includes("."), `${s} should contain a period`);
  }
});

test("numbers mode: an all-digit username is accepted (Discord allows it, unlike Xbox)", () => {
  const outcome = compileGeneration({ mode: "numbers", params: { minLength: 5, maxLength: 5 } });
  assert.equal(outcome.ok, true);
  const samples = previewSamples(outcome);
  assert.ok(samples.length > 0);
  for (const s of samples) assert.match(s, /^[0-9]{5}$/);
});

test("word_num_word mode: produces two words separated by digits", () => {
  const outcome = compileGeneration({
    mode: "word_num_word",
    params: { source: "all", minDigits: 2, maxDigits: 2, separator: "none" },
  });
  assert.equal(outcome.ok, true);
  const samples = previewSamples(outcome);
  assert.ok(samples.length > 0);
  for (const s of samples) assert.equal(validateDiscordUsername(s).valid, true);
});

test("every mode id compiles with its defaults-adjacent minimal params", () => {
  const extraParams: Partial<Record<(typeof MODE_IDS)[number], Record<string, unknown>>> = {
    repetitive: { source: "fixed", unit: "ab" },
    pattern: { pattern: "LLNN" },
  };
  for (const mode of MODE_IDS) {
    if (mode === "list") continue; // requires explicit names
    const outcome = compileGeneration({ mode, params: extraParams[mode] ?? {} });
    assert.equal(outcome.ok, true, `${mode} should compile: ${outcome.errors.join(", ")}`);
  }
});
