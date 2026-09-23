/**
 * Xbox gamertag content filter.
 *
 * Xbox's policy engine scans the gamertag as a single string of uppercase
 * characters (spaces and punctuation stripped) and rejects it if any known
 * blocked substring is found.  This pre-check lets us skip HTTP requests for
 * tags that Xbox would always refuse, improving accuracy and saving rate-limit
 * budget.
 *
 * The list covers: profanity stems, sexual/violence abbreviations, slur
 * fragments, and patterns Xbox is known to block in short (3-5 char) tags.
 * It is intentionally conservative — false negatives (a blocked tag slipping
 * through) are preferable to false positives (a clean tag being skipped).
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
  // ── Profanity stems (3-4 chars, unambiguous) ─────────────────────────────
  "FKU", "FUK", "FCK", "FUC", "FUQ",
  "SHT", "SH1T",
  "SLT", "SL0T",
  "ASS", "ARS", "AZZ",
  "BST",
  "GFY",
  "KYS", "KMS",
  "WNK", "JRK",
  "TWAT", "CNT",
  "SUCK", "SUCC",

  // ── Sexual / explicit abbreviations (3+ chars) ───────────────────────────
  "VAG", "VGN",
  "COC", "COK", "CKS",
  "DIK", "DIC", "DIQ",
  "PNS", "PNIS",
  "TIT",
  "JZZ", "JIZ", "JZM",
  "CUM", "KUM",
  "SEX", "SEXY",
  "ANAL",

  // ── PUSSY variants ────────────────────────────────────────────────────────
  "PUSSY", "PUSY", "POSY", "PSE",

  // ── Full words (4L, 5L, 4C) ──────────────────────────────────────────────
  "FUCK", "SHIT", "CUNT", "PISS", "COCK", "DICK",
  "SLUT", "BITCH", "WHORE",
  "RAPE", "RAPING", "RAPED",
  "NIGGA", "NIGGER", "NEGRO",
  "CHINK", "SPICK", "KIKE", "WANK",
  "BASTARD",

  // ── Hate / extremism ─────────────────────────────────────────────────────
  "KKK",
  "NAZI", "NSDAP",
  "ISIS", "ISIL",

  // ── Violence / self-harm (4+ chars only — shorter ones false-positive) ───
  "KILL", "DEAD", "BOMB",

  // ── Drug references (4+ chars) ───────────────────────────────────────────
  "WEED", "COKE", "METH", "DRUG",

  // ── Slurs / misc confirmed Xbox blocks ───────────────────────────────────
  "FAG", "FAGT", "FGT",
  "DYK",

  // ── User-specified block list ─────────────────────────────────────────────
  "POC",                    // racial slur abbreviation
  "PSY",                    // flagged by Xbox content policy
  "SLOT", "SLXT",           // SLUT leetspeak variants
  "HELL", "HXLL",           // HELL and vowel-replaced variant
  "FAQ",                    // FUCK phonetic variant
  "FAK",                    // FUCK phonetic variant
  "POSE",                   // user-requested block

  // ── FUCK/SUCK phonetic/leet variants ─────────────────────────────────────
  "SUXK",
  "FOOQ", "FUQQ",
  "FQU", "FCU",
  "FKN", "FKNG",
  "FAKN",
  "FXK", "FXQ",             // X-wildcard FUCK variants

  // ── DK (short for DICK) ──────────────────────────────────────────────────
  "DK",

  // ── Short user-requested blocks (2-3 chars) ───────────────────────────────
  // These have higher false-positive risk on short letter and word modes; user explicitly requested.
  "QM",
  "FQ",
  "FK",
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
