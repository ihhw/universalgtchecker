/**
 * Account/claim audit trail — every entry is a real state transition, logged
 * at the moment it happened. Never logs a password, refresh token, XSTS
 * token, Authorization header, cookie, or device-code secret: `meta` is a
 * plain string/number/boolean record and callers must only pass
 * display-safe values (an account id, a masked email, a gamertag, an error
 * reason string) — never a credential.
 */

export type AuditEvent =
  | "ACCOUNT_CREATION_STARTED"
  | "ACCOUNT_CREATION_AWAITING_USER"
  | "ACCOUNT_CREATION_CONFIRMED"
  | "ACCOUNT_AUTH_STARTED"
  | "ACCOUNT_AUTH_SUCCESS"
  | "ACCOUNT_AUTH_FAILED"
  | "ACCOUNT_REFRESH_SUCCESS"
  | "ACCOUNT_REFRESH_FAILED"
  | "ACCOUNT_CONNECTED"
  | "ACCOUNT_DISCONNECTED"
  | "ACCOUNT_SELECTED_FOR_CLAIM"
  | "CLAIM_STARTED"
  | "CLAIM_CONFIRMED"
  | "CLAIM_FAILED";

export interface AuditEntry {
  id: number;
  ts: number;
  event: AuditEvent;
  meta: Record<string, string | number | boolean>;
}

const MAX_ENTRIES = 500;
const entries: AuditEntry[] = [];
let nextId = 1;

const SECRET_KEY_PATTERN = /token|secret|password|authorization|cookie|refresh/i;

export function logAudit(event: AuditEvent, meta: Record<string, string | number | boolean> = {}): void {
  // Defence in depth: drop any field whose key name suggests it could hold a
  // credential, even though every call site is expected to never pass one.
  const safeMeta: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (SECRET_KEY_PATTERN.test(k)) continue;
    safeMeta[k] = v;
  }
  const entry: AuditEntry = { id: nextId++, ts: Date.now(), event, meta: safeMeta };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

export function listAudit(afterId = 0, limit = 200): AuditEntry[] {
  const out = entries.filter((e) => e.id > afterId);
  return out.length > limit ? out.slice(out.length - limit) : out;
}
