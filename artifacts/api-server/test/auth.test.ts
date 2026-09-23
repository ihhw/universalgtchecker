import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setup, control, until } from "./helpers";

const { mock } = await setup({ account: false });
const auth = await import("../src/lib/xbox-auth");

after(() => { mock.server.close(); });

test("device code sign-in → Xbox Live → XSTS → XUID, with masked email and no tokens exposed", async () => {
  mock.state.devicePendingPolls = 1;
  const dc = await auth.startDeviceCodeFlow();
  assert.equal(dc.status, "pending");
  assert.equal(dc.userCode, "MOCK1234");

  // Sign-in asks for the Xbox scope plus OpenID scopes (for the email).
  const dcReq = mock.state.log.find((l) => l.endpoint === "devicecode");
  assert.match(String((dcReq?.body as Record<string, string>)["scope"]), /^XboxLive\.signin offline_access openid profile email$/);

  await until(() => auth.getActiveAccountStatus().ready, 8_000);
  const st = auth.getActiveAccountStatus();
  assert.equal(st.connected, true);
  assert.equal(st.ready, true);
  assert.equal(st.stage, "ready");
  assert.equal(st.gamertag, "OldTag");
  assert.equal(st.maskedEmail, "te•••@e•••.com");
  assert.equal(st.maskedXuid, "2533••••••••0001");

  // XSTS was requested ONLY for http://xboxlive.com (the claim host's audience).
  const rps = mock.state.log.filter((l) => l.endpoint === "xsts").map((l) => (l.body as { RelyingParty: string }).RelyingParty);
  assert.deepEqual([...new Set(rps)], ["http://xboxlive.com"]);

  // Nothing token-like reaches the status object or the device-code state.
  const json = JSON.stringify({ st, dc: auth.getDeviceCodeState(), list: auth.getAccountInfoList() });
  for (const secret of ["ms-at-", "rt-", "xbl-user-", "xsts|", "dev-code-1", "tester.person@"]) {
    assert.ok(!json.includes(secret), `status leaked ${secret}`);
  }

  // Claim context: header uses the http://xboxlive.com XSTS token + the XUID.
  const ctx = await auth.getClaimContext();
  assert.ok(ctx.ok);
  if (ctx.ok) {
    assert.match(ctx.authHeader, /^XBL3\.0 x=uhs-1;xsts\|http:\/\/xboxlive\.com\|/);
    assert.equal(ctx.xuid, "2533274900000001");
  }

  // Auth file: 0600, holds the refresh token + masked email, never the raw email.
  const stat = fs.statSync(".xbox-auth.json");
  assert.equal(stat.mode & 0o777, 0o600);
  const file = fs.readFileSync(".xbox-auth.json", "utf8");
  assert.ok(!file.includes("tester.person@"));
  assert.ok(file.includes("te•••@e•••.com"));
});

test("XSTS XErr 2148916233 (no Xbox profile) → NOT READY with the real reason", async () => {
  await control(mock.url, { queues: { xsts: [{ status: 401, body: { XErr: 2148916233, Message: "" } }] } });
  const r = await auth.refreshActiveIdentity(); // forces a new XSTS
  assert.equal(r.ok, false);
  const st = auth.getActiveAccountStatus();
  assert.equal(st.ready, false);
  assert.equal(st.stage, "xsts");
  assert.equal(st.code, "2148916233");
  assert.match(st.reason ?? "", /no Xbox profile/);
  const ctx = await auth.getClaimContext();
  assert.equal(ctx.ok, true, "the next successful XSTS makes it ready again");
  assert.equal(auth.getActiveAccountStatus().ready, true);
});

test("XSTS child account XErr 2148916238 → reason explains family requirement", async () => {
  await control(mock.url, { queues: { xsts: [{ status: 401, body: { XErr: 2148916238 } }] } });
  await auth.refreshActiveIdentity();
  const st = auth.getActiveAccountStatus();
  assert.equal(st.code, "2148916238");
  assert.match(st.reason ?? "", /child account/);
});

test("Xbox Live user-token failure → stage xbox_live", async () => {
  // Invalidate the cached user token path: XSTS 401 triggers a fresh XBL call, which fails.
  await control(mock.url, { queues: { xsts: [{ status: 401, body: {} }], xbl: [{ status: 400, body: {} }] } });
  await auth.refreshActiveIdentity();
  const st = auth.getActiveAccountStatus();
  assert.equal(st.ready, false);
  assert.equal(st.stage, "xbox_live");
  assert.match(st.reason ?? "", /HTTP 400/);
});

test("Microsoft network failure → stage microsoft, reason says network", async () => {
  await control(mock.url, { queues: { xsts: [{ status: 401, body: {} }], token: [{ drop: true }] } });
  await auth.refreshActiveIdentity();
  const st = auth.getActiveAccountStatus();
  assert.equal(st.stage, "microsoft");
  assert.match(st.reason ?? "", /network/);
  assert.equal(st.connected, true, "a transient failure keeps the account");
});

test("revoked refresh token (invalid_grant) → NOT READY, reconnect required, token dropped from disk", async () => {
  await control(mock.url, { queues: { xsts: [{ status: 401, body: {} }], token: [{ status: 400, body: { error: "invalid_grant" } }] } });
  await auth.refreshActiveIdentity();
  const st = auth.getActiveAccountStatus();
  assert.equal(st.connected, false);
  assert.equal(st.ready, false);
  assert.equal(st.code, "invalid_grant");
  assert.match(st.reason ?? "", /Connect Xbox again/);
  const ctx = await auth.getClaimContext();
  assert.equal(ctx.ok, false);
  const file = JSON.parse(fs.readFileSync(".xbox-auth.json", "utf8")) as { accounts: unknown[] };
  assert.equal(file.accounts.length, 0);
});

test("maskEmail / maskXuid never return the full value", () => {
  assert.equal(auth.maskEmail("john.doe@outlook.com"), "jo•••@o•••.com");
  assert.equal(auth.maskEmail("a@b.co"), "a•••@b•••.co");
  assert.equal(auth.maskEmail("not-an-email"), null);
  assert.equal(auth.maskXuid("2533274812345678"), "2533••••••••5678");
});

