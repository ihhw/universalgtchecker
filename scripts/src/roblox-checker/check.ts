/**
 * Roblox availability check, cross-verified across two independent Roblox
 * endpoints before a result is ever reported as a confirmed hit.
 *
 *   1. Primary — auth.roblox.com/v1/usernames/validate: the same call
 *      roblox.com/signup makes as you type. code 0 = available, code 1 =
 *      taken. `request.context=Signup` is reverse-engineered (Roblox
 *      doesn't publish this API); if Roblox changes it, requests degrade to
 *      an unrecognized response and get reported "unknown" rather than a
 *      false hit — never silently mis-parsed as available.
 *
 *   2. Secondary — users.roblox.com/v1/usernames/users: an independent
 *      username -> user lookup. Only consulted to confirm a primary
 *      "available" result. If it disagrees (finds an existing user), the
 *      result is downgraded to "unknown" for manual review instead of
 *      reported as a hit — this is the same "double check before trusting
 *      an available result" shape as this project's existing Xbox checker.
 *
 * Any candidate that never gets code 0 + a clean secondary confirmation is
 * "unknown", never "available" — false positives are worse than a slower
 * scan.
 */

export type Verdict = "available" | "taken" | "unknown";

export interface CheckResult {
  username: string;
  verdict: Verdict;
  detail: string;
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function field(body: unknown, key: string): unknown {
  if (body && typeof body === "object" && key in body) {
    return (body as Record<string, unknown>)[key];
  }
  return undefined;
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, ...init.headers },
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function checkSignupValidate(
  username: string,
  retries: number,
): Promise<{ code: number | null; message: string }> {
  const url =
    `https://auth.roblox.com/v1/usernames/validate` +
    `?request.username=${encodeURIComponent(username)}` +
    `&request.birthday=2000-01-01&request.context=Signup`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { status, body } = await fetchJson(url, { method: "GET" }, 8000);
      if (status === 429) {
        await sleep(4000 * (attempt + 1));
        continue;
      }
      if (status !== 200 || !body) return { code: null, message: `http ${status}` };
      const code = field(body, "code");
      const message = field(body, "message");
      return {
        code: typeof code === "number" ? code : null,
        message: typeof message === "string" ? message : "",
      };
    } catch {
      await sleep(1000 * (attempt + 1));
    }
  }
  return { code: null, message: "no response" };
}

async function checkUsernameLookup(username: string, retries: number): Promise<{ found: boolean | null }> {
  const url = "https://users.roblox.com/v1/usernames/users";

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { status, body } = await fetchJson(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
        },
        8000,
      );
      if (status === 429) {
        await sleep(4000 * (attempt + 1));
        continue;
      }
      const data = status === 200 ? field(body, "data") : undefined;
      if (!Array.isArray(data)) return { found: null };
      const match = data.some(
        (u) => typeof field(u, "name") === "string" && (field(u, "name") as string).toLowerCase() === username.toLowerCase(),
      );
      return { found: match };
    } catch {
      await sleep(1000 * (attempt + 1));
    }
  }
  return { found: null };
}

export async function checkRobloxUsername(username: string, retries = 3): Promise<CheckResult> {
  const primary = await checkSignupValidate(username, retries);

  if (primary.code === 1) {
    return { username, verdict: "taken", detail: primary.message || "signup validation: taken" };
  }
  if (primary.code !== 0) {
    return { username, verdict: "unknown", detail: primary.message || "signup validation: inconclusive" };
  }

  const secondary = await checkUsernameLookup(username, retries);
  if (secondary.found === false) {
    return { username, verdict: "available", detail: "confirmed by signup validation + username lookup" };
  }
  if (secondary.found === true) {
    return {
      username,
      verdict: "unknown",
      detail: "signup validation said available but username lookup found a match — needs manual review",
    };
  }
  return {
    username,
    verdict: "unknown",
    detail: "signup validation said available but the confirmation lookup failed",
  };
}
