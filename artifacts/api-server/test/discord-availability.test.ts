import { test } from "node:test";
import assert from "node:assert/strict";
import { retryAfterMs } from "../src/lib/discord-availability";

test("retryAfterMs: uses Retry-After in seconds", () => {
  const h = new Headers({ "retry-after": "5" });
  assert.equal(retryAfterMs(h, 1_000), 5_000);
});

test("retryAfterMs: falls back when the header is missing", () => {
  const h = new Headers();
  assert.equal(retryAfterMs(h, 1_234), 1_234);
});

test("retryAfterMs: clamps an absurdly large value", () => {
  const h = new Headers({ "retry-after": "999999" });
  assert.equal(retryAfterMs(h, 1_000), 60_000);
});

test("retryAfterMs: clamps a zero or negative value up to the floor", () => {
  const h = new Headers({ "retry-after": "0" });
  assert.equal(retryAfterMs(h, 1_000), 250);
});

test("retryAfterMs: accepts an HTTP-date form", () => {
  const future = new Date(Date.now() + 3_000).toUTCString();
  const h = new Headers({ "retry-after": future });
  const ms = retryAfterMs(h, 1_000);
  assert.ok(ms > 2_000 && ms <= 3_100, `expected ~3000ms, got ${ms}`);
});

test("retryAfterMs: an unparseable value falls back", () => {
  const h = new Headers({ "retry-after": "not-a-number-or-date" });
  assert.equal(retryAfterMs(h, 777), 777);
});
