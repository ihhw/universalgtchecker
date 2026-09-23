/**
 * Purely cosmetic suggestions for the Account Creator — a starting point the
 * user can accept, edit or ignore on Microsoft's own signup page. Nothing
 * here is sent anywhere; it only fills the two text fields shown before the
 * user opens signup.live.com and creates the account themselves.
 */

const ADJECTIVES = ["swift", "quiet", "bold", "amber", "cedar", "lunar", "cobalt", "ember", "quartz", "violet", "maple", "arctic"];
const NOUNS = ["falcon", "harbor", "meadow", "ridge", "summit", "beacon", "orbit", "willow", "canyon", "atlas", "cipher", "drift"];

function randomInt(max: number): number {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return arr[0]! % max;
}

/** A plausible email local-part (no domain — the user picks that on Microsoft's page). */
export function suggestEmailLocalPart(): string {
  const a = ADJECTIVES[randomInt(ADJECTIVES.length)];
  const n = NOUNS[randomInt(NOUNS.length)];
  const digits = String(randomInt(10_000)).padStart(4, "0");
  return `${a}.${n}${digits}`;
}

const PASSWORD_CHARS = {
  lower: "abcdefghijkmnopqrstuvwxyz", // no l
  upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",  // no I, O
  digits: "23456789",                 // no 0, 1
  symbols: "!@#$%^&*-_=+",
};

/** A strong random password: 20 chars, guaranteed at least one of each class. */
export function generateStrongPassword(length = 20): string {
  const all = PASSWORD_CHARS.lower + PASSWORD_CHARS.upper + PASSWORD_CHARS.digits + PASSWORD_CHARS.symbols;
  const pick = (set: string) => set[randomInt(set.length)]!;
  const required = [pick(PASSWORD_CHARS.lower), pick(PASSWORD_CHARS.upper), pick(PASSWORD_CHARS.digits), pick(PASSWORD_CHARS.symbols)];
  const rest = Array.from({ length: Math.max(0, length - required.length) }, () => pick(all));
  const chars = [...required, ...rest];
  // Fisher-Yates shuffle so the required characters aren't always at the front.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}
