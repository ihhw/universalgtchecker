import { test } from "node:test";
import assert from "node:assert/strict";
import { compileGeneration } from "../src/lib/gamertag-generator";
import { validateXboxGamertag } from "../src/lib/xbox-validation";

// Mirrors previewSamples() in routes/gamertag.ts: draws a bounded number of
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

test("preview samples: valid config produces samples that are all valid, unique Xbox gamertags", () => {
  const outcome = compileGeneration({ mode: "letters", params: { minLength: 4, maxLength: 4, case: "upper" } });
  assert.equal(outcome.ok, true);
  const samples = previewSamples(outcome);
  assert.ok(samples.length > 0);
  assert.equal(new Set(samples).size, samples.length, "samples must be unique");
  for (const s of samples) assert.equal(validateXboxGamertag(s).valid, true, `${s} should be a valid gamertag`);
});

test("preview samples: invalid config produces no samples", () => {
  const outcome = compileGeneration({ mode: "letters", params: { minLength: 999, maxLength: 999 } });
  assert.equal(outcome.ok, false);
  assert.deepEqual(previewSamples(outcome), []);
});

test("preview samples: a deterministic (fixed) mode produces exactly one sample", () => {
  const outcome = compileGeneration({ mode: "repetitive", params: { source: "fixed", unit: "AB", repeat: 2 } });
  assert.equal(outcome.ok, true);
  const samples = previewSamples(outcome);
  assert.deepEqual(samples, ["ABAB"]);
});

test("preview samples: list mode previews from the provided names", () => {
  const outcome = compileGeneration({ mode: "list", params: { names: ["ABCD", "WXYZ", "QQQQ"] } });
  assert.equal(outcome.ok, true);
  const samples = previewSamples(outcome);
  assert.deepEqual(new Set(samples), new Set(["ABCD", "WXYZ", "QQQQ"]));
});
