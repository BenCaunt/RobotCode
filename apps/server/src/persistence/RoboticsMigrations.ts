import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import RoboticsEvidence from "./RoboticsMigrations/001_RoboticsEvidence.ts";
import RobotTelemetryEvents from "./RoboticsMigrations/002_RobotTelemetryEvents.ts";

const table = "robotcode_sql_migrations";
const migrations = {
  "1_RoboticsEvidence": RoboticsEvidence,
  "2_RobotTelemetryEvents": RobotTelemetryEvents,
};
const latestMigrationId = Object.keys(migrations).length;
const legacyOffset = 113;

export function isLegacyRoboticsMigration({ id, name }: { id: number; name: string }) {
  return (
    (id === 114 && name === "RoboticsEvidence") || (id === 115 && name === "RobotTelemetryEvents")
  );
}

export const reconcileLegacyRoboticsMigrations = Effect.fn("reconcileLegacyRoboticsMigrations")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const legacy = sql`(migration_id, name) IN ((114, 'RoboticsEvidence'), (115, 'RobotTelemetryEvents'))`;
    // Move only the ledger entries. The robotics tables and their rows are already in place.
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          CREATE TABLE IF NOT EXISTS ${sql(table)} (
            migration_id INTEGER PRIMARY KEY NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            name VARCHAR(255) NOT NULL
          )
        `;
        yield* sql`
          INSERT INTO ${sql(table)} (migration_id, created_at, name)
          SELECT migration_id - ${legacyOffset}, created_at, name
          FROM effect_sql_migrations WHERE ${legacy}
        `;
        yield* sql`DELETE FROM effect_sql_migrations WHERE ${legacy}`;
      }),
    );
  },
);

export const hasPendingRoboticsMigrations = Effect.fn("hasPendingRoboticsMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${table}`;
  if (tables.length === 0) return true;
  const [row] = yield* sql<{ readonly id: number | null }>`
    SELECT MAX(migration_id) AS id FROM ${sql(table)}
  `;
  return (row?.id ?? 0) < latestMigrationId;
});

export const runRoboticsMigrations = () =>
  Migrator.make({})({ table, loader: Migrator.fromRecord(migrations) });
