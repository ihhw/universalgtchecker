import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeProxy } from "../src/lib/discord-proxy-store";

test("normalizeProxy: host:port", () => {
  const r = normalizeProxy("1.2.3.4:8080");
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.url, "http://1.2.3.4:8080");
});

test("normalizeProxy: host:port:user:pass", () => {
  const r = normalizeProxy("1.2.3.4:8080:bob:secret");
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.url, "http://bob:secret@1.2.3.4:8080");
});

test("normalizeProxy: user:pass@host:port", () => {
  const r = normalizeProxy("bob:secret@1.2.3.4:8080");
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.url, "http://bob:secret@1.2.3.4:8080");
});

test("normalizeProxy: password containing a colon is preserved", () => {
  const r = normalizeProxy("1.2.3.4:8080:bob:se:cret");
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.url, "http://bob:se%3Acret@1.2.3.4:8080");
});

test("normalizeProxy: an http:// URL is passed through", () => {
  const r = normalizeProxy("http://1.2.3.4:8080");
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.url, "http://1.2.3.4:8080");
});

test("normalizeProxy: SOCKS proxies are rejected with a clear reason", () => {
  const r = normalizeProxy("socks5://1.2.3.4:1080");
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : "", /SOCKS/);
});

test("normalizeProxy: garbage is rejected", () => {
  assert.equal(normalizeProxy("not a proxy").ok, false);
  assert.equal(normalizeProxy("1.2.3.4:notaport").ok, false);
});

test("normalizeProxy: blank and comment lines are silently skipped", () => {
  const blank = normalizeProxy("");
  assert.equal(blank.ok, false);
  assert.equal(!blank.ok && blank.error, "");
  const comment = normalizeProxy("# a comment");
  assert.equal(comment.ok, false);
  assert.equal(!comment.ok && comment.error, "");
});
