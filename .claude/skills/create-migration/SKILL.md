---
name: create-migration
description: Create a new Prisma migration with the correct naming convention and regenerate the Prisma client afterward
---

Create a new Prisma migration for this project.

Steps:

1. If the user hasn't provided a migration name, ask for a short snake_case description of the schema change (e.g. `add_flake_window_size`, `add_ci_run_env_field`).
2. Confirm the schema changes in `prisma/schema.prisma` are saved and correct before proceeding.
3. Run: `npx prisma migrate dev --name <migration_name>`
4. Run: `npm run db:generate` to regenerate the Prisma client.
5. Show the path of the generated migration file and summarize what changed.
6. Remind the user to commit both `prisma/schema.prisma` and the new migration directory (`prisma/migrations/<timestamp>_<name>/`).

Rules:

- Migration names must be snake_case, lowercase, descriptive (e.g. `add_testrail_run_id`, not `update` or `fix`)
- Always run `db:generate` after `migrate dev` — the Prisma client is stale until regenerated
- If `migrate dev` fails due to drift, suggest `npx prisma migrate resolve` or `db:reset` and explain the tradeoff
