---
name: Gamertag Codegen Manual Patching
description: The generated type files are manually patched, not regenerated via orval
---

## Pattern
Orval codegen is NOT run after changes — files are patched manually. Four places must stay in sync whenever the type enum or schema changes:

1. `lib/api-spec/openapi.yaml` — source of truth (enum values, field descriptions)
2. `lib/api-zod/src/generated/types/` -- `generationMode.ts`, `generationConfig.ts`, `gamertagSearchInput.ts`, `gamertagResult.ts` (+ `gamertagResultPolicy.ts`), `gamertagSession.ts`
3. `lib/api-zod/src/generated/api.ts` -- zod schemas (StartGamertagSearchBody, and the session/result objects repeated in Start/Get/Cancel responses)
4. `lib/api-client-react/src/generated/api.schemas.ts` -- TypeScript interfaces + const enums

**Why:** Running orval requires config setup and can overwrite custom patches. Manual patching is faster and safer for incremental additions.

## Current contract
- `GenerationMode` enum lists every mode id (see `MODE_IDS` in `gamertag-generator.ts`); `GenerationConfig = { mode, params? }`.
- `GamertagSearchInput = { config, rate, runEthanPolicyCheck? }`. The legacy format fields are gone; everything about generation lives in `config`.
- `GamertagResult` carries `status`, `alertable` and a nested `policy: { status, message? }` (Double Check).
- `GamertagSession` carries `mode` and `label`.

## Endpoints not in the OpenAPI spec (called via raw fetch)
- pause/resume, claim, `/gamertag/validate`, `/gamertag/config/validate`, `/activity*`, `/settings/webhook*`, `/status`, `/bot/heartbeat`
