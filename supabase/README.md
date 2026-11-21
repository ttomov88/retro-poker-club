# Supabase setup

- `migrations/` — every database change, in order (tables, rules, functions, backups). Applied to the live project `retro-poker-club` (Frankfurt).
- `functions/claim/index.ts` — the "First time here?" function (invite code → password). Deployed with JWT verification off; it checks the invite code itself.
- Project settings used: email/password sign-in, TOTP MFA (default on), pg_cron for the daily backup.
