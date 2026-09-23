/**
 * Single source of truth for local Xbox gamertag validation.
 *
 * Every code path that generates, accepts or forwards a gamertag (generators,
 * list input, verification, claiming, the search workers) must go through
 * `validateXboxGamertag` rather than re-implementing these rules.
 *
 * Rules:
 *   - 3 to 15 characters
 *   - first character is a letter
 *   - only A-Z, a-z, 0-9 and space
 *   - a space cannot be first, last, or repeated back to back
 *
 * Invalid input is reported, never silently corrected.
 */

export const GAMERTAG_MIN = 3;
export const GAMERTAG_MAX = 15;

export interface GamertagValidation {
  valid: boolean;
  username: string;
  errors: string[];
}

export function validateXboxGamertag(input: unknown): GamertagValidation {
  if (typeof input !== "string" || input.trim() === "") {
    return { valid: false, username: typeof input === "string" ? input : "", errors: ["Gamertag cannot be empty."] };
  }

  const username = input;
  const errors: string[] = [];

  if (username.length < GAMERTAG_MIN) {
    errors.push(`Gamertag must be at least ${GAMERTAG_MIN} characters.`);
  }
  if (username.length > GAMERTAG_MAX) {
    errors.push(`Gamertag must be at most ${GAMERTAG_MAX} characters.`);
  }
  if (!/^[A-Za-z]/.test(username)) {
    errors.push("Gamertag must start with a letter.");
  }
  if (/[^A-Za-z0-9 ]/.test(username)) {
    errors.push("Special characters are not allowed.");
  }
  if (username.startsWith(" ")) {
    errors.push("Gamertag cannot start with a space.");
  }
  if (username.endsWith(" ")) {
    errors.push("Gamertag cannot end with a space.");
  }
  if (/ {2,}/.test(username)) {
    errors.push("Gamertag cannot contain consecutive spaces.");
  }

  return { valid: errors.length === 0, username, errors };
}
