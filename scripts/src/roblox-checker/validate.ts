/**
 * Single source of truth for local Roblox username validation.
 *
 * Rules (per Roblox's own signup requirements):
 *   - 3 to 20 characters
 *   - only A-Z, a-z, 0-9 and a single underscore
 *   - at most one underscore, and it cannot be the first or last character
 *
 * This mirrors xbox-validation.ts: invalid input is reported, never silently
 * corrected, and every generator/checker goes through this rather than
 * re-implementing the rules. Anything this file doesn't rule out (e.g.
 * whether an all-digit name is accepted) is left to Roblox's own API to
 * decide rather than guessed at here.
 */

export const ROBLOX_USERNAME_MIN = 3;
export const ROBLOX_USERNAME_MAX = 20;

export interface RobloxUsernameValidation {
  valid: boolean;
  username: string;
  errors: string[];
}

export function validateRobloxUsername(input: unknown): RobloxUsernameValidation {
  if (typeof input !== "string" || input.trim() === "") {
    return {
      valid: false,
      username: typeof input === "string" ? input : "",
      errors: ["Username cannot be empty."],
    };
  }

  const username = input;
  const errors: string[] = [];

  if (username.length < ROBLOX_USERNAME_MIN) {
    errors.push(`Username must be at least ${ROBLOX_USERNAME_MIN} characters.`);
  }
  if (username.length > ROBLOX_USERNAME_MAX) {
    errors.push(`Username must be at most ${ROBLOX_USERNAME_MAX} characters.`);
  }
  if (/[^A-Za-z0-9_]/.test(username)) {
    errors.push("Only letters, numbers and a single underscore are allowed.");
  }
  if ((username.match(/_/g) ?? []).length > 1) {
    errors.push("Only one underscore is allowed.");
  }
  if (username.startsWith("_")) {
    errors.push("Username cannot start with an underscore.");
  }
  if (username.endsWith("_")) {
    errors.push("Username cannot end with an underscore.");
  }

  return { valid: errors.length === 0, username, errors };
}
