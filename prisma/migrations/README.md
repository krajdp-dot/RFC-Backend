# Migrations

This repo has been managed with `prisma db push` (see `npm run prisma:push`),
so there is no migration history to build on — Phase 10 is the first change
shipped as an explicit SQL file, because it alters a table that already has
rows in every deployed database.

Pick whichever matches how your database is managed.

**Still using `db push` (what this repo has done so far)**

```bash
npm run prisma:push
```

`schema.prisma` already contains the new fields and the index, so this is
sufficient. The SQL file is then just documentation of what changed.

**Applying the SQL directly (a live database you'd rather not let Prisma diff)**

```bash
psql "$DATABASE_URL" -f prisma/migrations/20260919090000_phase10_user_membership/migration.sql
```

Every statement is `IF NOT EXISTS`, so re-running it is harmless.

**Adopting `prisma migrate` from here on**

Baseline first, so Prisma doesn't try to recreate tables that already exist:

```bash
npx prisma migrate resolve --applied 20260919090000_phase10_user_membership
npx prisma migrate deploy
```

## What Phase 10 changed

`user_businesses` gains `updatedAt`, `invitedBy` and `disabledAt`, plus a
`(businessId, role)` index. Nothing is dropped or renamed, and existing rows
stay valid: `updatedAt` backfills to the current timestamp, `invitedBy` and
`disabledAt` are nullable, and a NULL `disabledAt` means active.
