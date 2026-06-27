/**
 * Guard for `db:push`: refuse to run when `DATABASE_MIGRATION_URL` is set.
 *
 * `drizzle-kit push` force-syncs the schema and can drop columns, so it is
 * only for throwaway databases (the local Docker container and the CI test
 * container). `DATABASE_MIGRATION_URL` is the dedicated migration credential
 * for a persistent database, so its presence means a persistent DB is in
 * scope, where only versioned `db:migrate` is safe. Exits 1 to block the push
 * before drizzle-kit can touch the database.
 */
if (process.env.DATABASE_MIGRATION_URL) {
  console.error(
    "Refusing `db:push`: DATABASE_MIGRATION_URL is set, which targets a " +
      "persistent database. `push` force-syncs and can drop columns; use " +
      "`db:migrate` for persistent databases. Unset DATABASE_MIGRATION_URL " +
      "to push a throwaway/local database.",
  );
  process.exit(1);
}
