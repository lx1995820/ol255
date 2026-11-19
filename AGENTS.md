# Project Guide

## Architecture

Court Pulse is a Chinese-language NBA2KOL2 5v5 tracker adapted from the user's uploaded website. Preserve the original visual identity and plain HTML/CSS/JavaScript approach rather than replacing it with a starter template.

- `index.html`: public leaderboard, player lookup, monthly predictions.
- `admin.html`: Identity login, invitation acceptance, recovery, and game management.
- `portal.js`: shared rendering, authentication flows, API calls and public refresh.
- `portal.css`: original responsive visual styling.
- `enhancements.css`: login layout, accessible focus, loading and error states.
- `netlify/functions/api.mts`: public reads and role-protected CRUD endpoints.
- `db/schema.ts`, `db/index.ts`: Drizzle schema and Netlify Database adapter.
- `netlify/database/migrations/`: schema and one-time import of uploaded records.
- `vite.config.ts`, `netlify.toml`: two-page bundling and deployment configuration.

## Conventions

Use descriptive identifiers, ES modules, TypeScript for Functions, and Chinese user-facing copy. Escape user-controlled strings before inserting HTML. Validate all input on the server, allow only known fields, and check the server-controlled Identity `admin` role for every admin endpoint. Do not expose credentials, a shared default password, or unprotected writes. Use `@netlify/identity`, never deprecated Identity widgets.

Use Netlify Database with `drizzle-orm@beta` and `drizzle-kit@beta`. Update `db/schema.ts` and generate a migration for every database schema change. Do not re-import seed records on runtime requests. Memory-only objects may be used for derived statistics, never durable data. Do not publish source attachments, old server code, or local database files.

## Operational Decisions

The administrator must be invited and assigned the `admin` role in Netlify Identity. There is intentionally no public signup or automatic first-user promotion. Auth callback links can land on the index page and are redirected to the admin page with their callback intact. The original `/public.html` URL redirects to `/`.

Pretty URLs are explicitly disabled to keep `/admin.html` stable and avoid conflicting extensionless redirects. Local development uses `npm run dev:netlify` on port 8889, proxying Vite on port 5173; do not make the Vite `dev` script invoke Netlify recursively.

Public player averages include all records; monthly awards filter the current month. Original numeric IDs are preserved by the import migration and the database identity sequence is advanced past them. Runtime inserts use the database-generated identity rather than timestamps.

Do not run local build, test, type-check, or development-server commands in this environment; platform deployment validates the project. Read the relevant Netlify skill before implementing platform features. The Identity activation marker in `.netlify/features/` must remain tracked.
