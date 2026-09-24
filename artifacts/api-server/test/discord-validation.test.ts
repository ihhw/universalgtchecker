import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDiscordUsername } from "../src/lib/discord-validation";

test("validateDiscordUsername: accepts a normal lowercase username", () => {
  const v = validateDiscordUsername("nova.wolf");
  assert.equal(v.valid, true);
  assert.deepEqual(v.errors, []);
});

test("validateDiscordUsername: rejects too short", () => {
  assert.equal(validateDiscordUsername("a").valid, false);
});

test("validateDiscordUsername: rejects too long", () => {
  assert.equal(validateDiscordUsername("a".repeat(33)).valid, false);
});

test("validateDiscordUsername: rejects uppercase and other disallowed characters", () => {
  assert.equal(validateDiscordUsername("Nova").valid, false);
  assert.equal(validateDiscordUsername("nova wolf").valid, false);
  assert.equal(validateDiscordUsername("nova!wolf").valid, false);
});

test("validateDiscordUsername: rejects a leading or trailing period", () => {
  assert.equal(validateDiscordUsername(".nova").valid, false);
  assert.equal(validateDiscordUsername("nova.").valid, false);
});

test("validateDiscordUsername: rejects consecutive periods", () => {
  assert.equal(validateDiscordUsername("nova..wolf").valid, false);
});

test("validateDiscordUsername: allows a leading or trailing underscore", () => {
  assert.equal(validateDiscordUsername("_nova").valid, true);
  assert.equal(validateDiscordUsername("nova_").valid, true);
});

test("validateDiscordUsername: allows an all-digit username (unlike Xbox)", () => {
  assert.equal(validateDiscordUsername("123456").valid, true);
});
