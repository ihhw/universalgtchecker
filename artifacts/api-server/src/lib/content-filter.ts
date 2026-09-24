/**
 * Xbox gamertag content filter.
 *
 * Xbox's policy engine scans the gamertag as a single string of uppercase
 * characters (spaces and punctuation stripped) and rejects it if any known
 * blocked substring is found. This pre-check lets us skip HTTP requests for
 * tags that Xbox would always refuse, improving accuracy and saving rate-limit
 * budget.
 *
 * Scope: this list is deliberately narrow — slurs, hate/extremist terms, and
 * self-harm terms only. It is not a general profanity filter: mild swearing,
 * sexual references and most short/ambiguous fragments are left to Xbox's own
 * policy check (Double Check) rather than pre-filtered here, since blocking
 * them locally has a much higher false-positive rate against ordinary short
 * gamertags and words. Removing entries from this remaining list is a
 * deliberate choice not made lightly; ask rather than editing it further.
 *
 * ── Normalization rules ───────────────────────────────────────────────────────
 * Before substring-matching, four normalized variants of the gamertag are
 * generated to catch leet/phonetic substitutions:
 *   1. Raw uppercase (original)
 *   2. V → U  (CVM→CUM, KVM→KUM, SVCK→SUCK — V and U are phonetic equivalents)
 *   3. X → U  (FXK→FUK — X used as wildcard vowel)
 *   4. V → U  AND  X → U  (CVXK→CUUK → catches combined substitutions)
 * Additionally, C → S normalization on variant 2/4 catches SVCK→SUCK type patterns.
 */

// Every entry is compared against the UPPERCASE gamertag as a substring.
const BLOCKED_SUBSTRINGS: readonly string[] = [
  // ── Slurs ──────────────────────────────────────────────────────────────
  "NIGGA", "NIGGER", "NEGRO",
  "CHINK", "SPICK", "KIKE",
  "FAG", "FAGT", "FGT",

  // ── Hate / extremism ─────────────────────────────────────────────────────
  "KKK",
  "NAZI", "NSDAP",
  "ISIS", "ISIL",

  // ── Self-harm ─────────────────────────────────────────────────────────────
  "KYS", "KMS",
];

// De-duplicate and sort by length descending so longer patterns are checked first.
const PATTERNS: readonly string[] = [...new Set(BLOCKED_SUBSTRINGS)].sort(
  (a, b) => b.length - a.length
);

/**
 * Generate normalized variants of a gamertag to catch leet/phonetic
 * substitutions:
 *   - V → U  (CVM→CUM, KVM→KUM, SVCK→SUCK — V/U are phonetic equivalents)
 *   - X → U  (FXK→FUK — X used as blank wildcard vowel)
 *   - Combined V→U + X→U
 *   - Combined V→U + C→S (catches SVCK→SUCK after V→U gives SUCK)
 *
 * Returns an array of unique strings (including the original) to check.
 */
function generateVariants(upper: string): string[] {
  const vToU    = upper.replace(/V/g, "U");
  const xToU    = upper.replace(/X/g, "U");
  const vxToU   = vToU.replace(/X/g, "U");
  const cToS    = upper.replace(/C/g, "S");
  const vxCToS  = vxToU.replace(/C/g, "S");

  return [...new Set([upper, vToU, xToU, vxToU, cToS, vxCToS])];
}

/**
 * Returns true if the gamertag would likely be rejected by Xbox's content
 * filter.  The check is case-insensitive and treats the whole gamertag as one
 * token (no spaces in a gamertag to split on).
 *
 * Multiple normalized variants (V→U, X→U, C→S combinations) are checked so
 * that leet/phonetic substitutions are caught even if not listed explicitly.
 */
export function isBlockedByContentFilter(gamertag: string): boolean {
  const upper    = gamertag.toUpperCase();
  const variants = generateVariants(upper);
  return variants.some((v) => PATTERNS.some((p) => v.includes(p)));
}
