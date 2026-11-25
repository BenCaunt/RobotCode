import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS robotics_telemetry_events (
      event_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      triggered_at_ms INTEGER NOT NULL,
      event_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS robotics_telemetry_events_project_time
      ON robotics_telemetry_events (project_id, triggered_at_ms DESC, event_id DESC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS robotics_telemetry_events_time
      ON robotics_telemetry_events (triggered_at_ms DESC, event_id DESC)
  `;
});
