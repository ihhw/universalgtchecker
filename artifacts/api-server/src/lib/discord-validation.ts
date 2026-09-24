/**
 * Single source of truth for local Discord username validation.
 *
 * Every code path that generates, accepts or forwards a Discord username
 * (generators, list input, verification, the search workers) must go
 * through `validateDiscordUsername` rather than re-implementing these rules.
 *
 * Rules (Discord's "unique username" system):
 *   - 2 to 32 characters
 *   - only lowercase a-z, 0-9, underscore (_) and period (.)
 *   - cannot start or end with a period
 *   - cannot contain two periods in a row
 *
 * Invalid input is reported, never silently corrected.
 */

export const DISCORD_USERNAME_MIN = 2;
export const DISCORD_USERNAME_MAX = 32;

export interface DiscordUsernameValidation {
  valid: boolean;
  username: string;
  errors: string[];
}

export function validateDiscordUsername(input: unknown): DiscordUsernameValidation {
  if (typeof input !== "string" || input.trim() === "") {
    return { valid: false, username: typeof input === "string" ? input : "", errors: ["Username cannot be empty."] };
  }

  const username = input;
  const errors: string[] = [];

  if (username.length < DISCORD_USERNAME_MIN) {
    errors.push(`Username must be at least ${DISCORD_USERNAME_MIN} characters.`);
  }
  if (username.length > DISCORD_USERNAME_MAX) {
    errors.push(`Username must be at most ${DISCORD_USERNAME_MAX} characters.`);
  }
  if (/[^a-z0-9_.]/.test(username)) {
    errors.push("Only lowercase letters, numbers, underscores and periods are allowed.");
  }
  if (username.startsWith(".")) {
    errors.push("Username cannot start with a period.");
  }
  if (username.endsWith(".")) {
    errors.push("Username cannot end with a period.");
  }
  if (/\.{2,}/.test(username)) {
    errors.push("Username cannot contain two periods in a row.");
  }

  return { valid: errors.length === 0, username, errors };
}
