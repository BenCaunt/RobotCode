import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE robotics_evidence_records (
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('annotation', 'experiment', 'intervention')),
      id TEXT NOT NULL,
      request_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      record_json TEXT NOT NULL CHECK (json_valid(record_json)),
      PRIMARY KEY (project_id, kind, id),
      UNIQUE (project_id, kind, request_key)
    ) WITHOUT ROWID
  `;
});
