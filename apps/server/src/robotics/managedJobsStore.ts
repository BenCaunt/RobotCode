// @effect-diagnostics nodeBuiltinImport:off -- SQLite operations are synchronous inside each registry transaction.
import * as NodeSqlite from "node:sqlite";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  RoboticsJob,
  RoboticsJobError,
  type RoboticsJobListInput,
  RoboticsJobLogChunk,
  type RoboticsJobLogsInput,
} from "@t3tools/contracts";

const decodeJob = Schema.decodeUnknownSync(Schema.fromJsonString(RoboticsJob));
const decodeLogChunk = Schema.decodeUnknownSync(RoboticsJobLogChunk);
const LOG_CHUNK_LIMIT = 256;
const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface JobRequest {
  readonly projectId: string;
  readonly key: string;
  readonly fingerprint: string;
}

export interface StoredJob {
  readonly job: RoboticsJob;
  readonly identity: string | null;
  readonly bootId: string | null;
}

export class ManagedJobsStore {
  readonly #db: NodeSqlite.DatabaseSync;

  constructor(filename: string) {
    const db = new NodeSqlite.DatabaseSync(filename);
    try {
      db.exec(`
        PRAGMA busy_timeout = 2000;
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS jobs (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          project_id TEXT NOT NULL,
          definition_id TEXT NOT NULL,
          record TEXT NOT NULL,
          identity TEXT,
          boot_id TEXT
        );
        CREATE INDEX IF NOT EXISTS jobs_project ON jobs(project_id, sequence);
        CREATE TABLE IF NOT EXISTS claims (
          resource TEXT PRIMARY KEY,
          job_id TEXT NOT NULL REFERENCES jobs(id)
        );
        CREATE TABLE IF NOT EXISTS active_jobs (
          project_id TEXT NOT NULL,
          definition_id TEXT NOT NULL,
          job_id TEXT NOT NULL REFERENCES jobs(id),
          PRIMARY KEY(project_id, definition_id)
        );
        CREATE TABLE IF NOT EXISTS requests (
          project_id TEXT NOT NULL,
          key TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          job_id TEXT NOT NULL REFERENCES jobs(id),
          PRIMARY KEY(project_id, key)
        );
        CREATE TABLE IF NOT EXISTS log_chunks (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id TEXT NOT NULL REFERENCES jobs(id),
          timestamp TEXT NOT NULL,
          source TEXT NOT NULL,
          text TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS log_chunks_job ON log_chunks(job_id, sequence);
        CREATE TABLE IF NOT EXISTS log_discarded (
          job_id TEXT PRIMARY KEY REFERENCES jobs(id),
          through INTEGER NOT NULL
        );
      `);
      db.exec("BEGIN IMMEDIATE");
      if (db.prepare("PRAGMA user_version").get()?.user_version === 0) {
        db.exec(`
          ALTER TABLE jobs ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
          UPDATE jobs SET archived = 1
          WHERE json_extract(record, '$.state') = 'stopped' AND sequence NOT IN (
            SELECT MAX(sequence) FROM jobs WHERE json_extract(record, '$.state') = 'stopped'
            GROUP BY project_id, definition_id
          );
          CREATE INDEX jobs_by_view ON jobs(project_id, archived, sequence);
          CREATE INDEX jobs_latest_stopped ON jobs(project_id, definition_id, sequence)
            WHERE archived = 0 AND json_extract(record, '$.state') = 'stopped';

          CREATE TRIGGER jobs_archive_stopped AFTER UPDATE OF record ON jobs
          WHEN json_extract(NEW.record, '$.state') = 'stopped'
            AND json_extract(OLD.record, '$.state') != 'stopped'
          BEGIN
            UPDATE jobs SET archived = 1
            WHERE project_id = NEW.project_id AND definition_id = NEW.definition_id
              AND archived = 0 AND json_extract(record, '$.state') = 'stopped'
              AND sequence < NEW.sequence;
          END;
          PRAGMA user_version = 1;
        `);
      }
      db.exec("COMMIT");
    } catch (cause) {
      db.close();
      throw cause;
    }
    this.#db = db;
  }

  close() {
    this.#db.close();
  }

  transaction<A>(act: () => A): A {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = act();
      this.#db.exec("COMMIT");
      return result;
    } catch (cause) {
      this.#db.exec("ROLLBACK");
      throw cause;
    }
  }

  inspect(projectId: string, jobId: string): StoredJob {
    const row = this.#db
      .prepare("SELECT record, identity, boot_id FROM jobs WHERE project_id = ? AND id = ?")
      .get(projectId, jobId);
    if (row === undefined) throw new RoboticsJobError({ reason: "job-not-found", jobId });
    return {
      job: decodeJob(row.record),
      identity: typeof row.identity === "string" ? row.identity : null,
      bootId: typeof row.boot_id === "string" ? row.boot_id : null,
    };
  }

  list(input: RoboticsJobListInput) {
    const limit = input.limit ?? 50;
    const filters = { current: "AND archived = 0", archived: "AND archived = 1" };
    const viewFilter = input.view === undefined ? "" : filters[input.view];
    const rows = this.#db
      .prepare(`
        SELECT sequence, record FROM jobs WHERE project_id = ? AND sequence < ? ${viewFilter}
        ORDER BY sequence DESC LIMIT ?
      `)
      .all(input.projectId, input.before ?? Number.MAX_SAFE_INTEGER, limit + 1);
    const page = rows.slice(0, limit);
    return {
      ...(input.view === undefined
        ? {}
        : {
            hasArchived:
              this.#db
                .prepare("SELECT 1 FROM jobs WHERE project_id = ? AND archived = 1 LIMIT 1")
                .get(input.projectId) !== undefined,
          }),
      jobs: page.map((row) => decodeJob(row.record)),
      nextBefore: rows.length > limit ? Number(page.at(-1)?.sequence) : null,
    };
  }

  activeJobs() {
    return this.#db
      .prepare("SELECT project_id, job_id FROM active_jobs")
      .all()
      .map((row) => this.inspect(String(row.project_id), String(row.job_id)));
  }

  active(projectId: string, definitionId: string) {
    const row = this.#db
      .prepare("SELECT job_id FROM active_jobs WHERE project_id = ? AND definition_id = ?")
      .get(projectId, definitionId);
    return typeof row?.job_id === "string" ? this.inspect(projectId, row.job_id).job : undefined;
  }

  receipt(request: JobRequest) {
    const row = this.#db
      .prepare("SELECT fingerprint, job_id FROM requests WHERE project_id = ? AND key = ?")
      .get(request.projectId, request.key);
    if (row === undefined) return undefined;
    if (row.fingerprint !== request.fingerprint) {
      throw new RoboticsJobError({ reason: "idempotency-conflict" });
    }
    return this.inspect(request.projectId, String(row.job_id)).job;
  }

  remember(request: JobRequest, jobId: string) {
    this.#db
      .prepare("INSERT INTO requests (project_id, key, fingerprint, job_id) VALUES (?, ?, ?, ?)")
      .run(request.projectId, request.key, request.fingerprint, jobId);
  }

  reserve(job: RoboticsJob, bootId: string | null) {
    for (const resource of job.resourceClaims) {
      const row = this.#db
        .prepare(
          "SELECT jobs.id AS job_id, jobs.project_id FROM claims JOIN jobs ON jobs.id = claims.job_id WHERE claims.resource = ?",
        )
        .get(resource);
      if (typeof row?.job_id === "string") {
        throw new RoboticsJobError({
          reason: "conflict",
          resource,
          ...(row.project_id === job.projectId ? { jobId: row.job_id } : {}),
        });
      }
    }
    this.#db
      .prepare(
        "INSERT INTO jobs (id, project_id, definition_id, record, boot_id) VALUES (?, ?, ?, ?, ?)",
      )
      .run(job.jobId, job.projectId, job.definitionId, JSON.stringify(job), bootId);
    this.#db
      .prepare("INSERT INTO active_jobs (project_id, definition_id, job_id) VALUES (?, ?, ?)")
      .run(job.projectId, job.definitionId, job.jobId);
    for (const resource of job.resourceClaims) {
      this.#db
        .prepare("INSERT INTO claims (resource, job_id) VALUES (?, ?)")
        .run(resource, job.jobId);
    }
  }

  update(job: RoboticsJob, identity?: string | null) {
    this.#db
      .prepare("UPDATE jobs SET record = ?, identity = COALESCE(?, identity) WHERE id = ?")
      .run(JSON.stringify(job), identity ?? null, job.jobId);
    if (job.state === "stopped" || job.state === "failed") {
      this.#db.prepare("DELETE FROM claims WHERE job_id = ?").run(job.jobId);
      this.#db.prepare("DELETE FROM active_jobs WHERE job_id = ?").run(job.jobId);
    }
    return job;
  }

  logs(input: RoboticsJobLogsInput) {
    const after = input.after ?? 0;
    const chunks = this.#db
      .prepare(`
        SELECT sequence, timestamp, source, text FROM log_chunks
        WHERE job_id = ? AND sequence > ? ORDER BY sequence LIMIT ?
      `)
      .all(input.jobId, after, input.limit ?? 32)
      .map((row) => decodeLogChunk(row));
    const discarded = this.#db
      .prepare("SELECT through FROM log_discarded WHERE job_id = ?")
      .get(input.jobId);
    const through = Number(discarded?.through ?? 0);
    return {
      chunks,
      nextAfter: chunks.at(-1)?.sequence ?? Math.max(through, after),
      discarded: through > after,
    };
  }

  appendLogs(
    jobId: string,
    source: RoboticsJobLogChunk["source"],
    timestamp: string,
    chunks: ReadonlyArray<string>,
  ) {
    this.transaction(() => {
      const insert = this.#db.prepare(`
        INSERT INTO log_chunks (job_id, source, timestamp, text) VALUES (?, ?, ?, ?)
      `);
      for (const chunk of chunks) insert.run(jobId, source, timestamp, chunk);
      const oldest = this.#db
        .prepare(`
          SELECT sequence FROM log_chunks WHERE job_id = ?
          ORDER BY sequence DESC LIMIT 1 OFFSET ?
        `)
        .get(jobId, LOG_CHUNK_LIMIT);
      if (typeof oldest?.sequence !== "number") return;
      this.#markDiscarded(jobId, oldest.sequence);
      this.#db
        .prepare("DELETE FROM log_chunks WHERE job_id = ? AND sequence <= ?")
        .run(jobId, oldest.sequence);
    });
  }

  pruneLogs(now: number) {
    this.transaction(() => {
      const before = DateTime.formatIso(DateTime.makeUnsafe(now - LOG_RETENTION_MS));
      const expired = this.#db
        .prepare(
          "SELECT job_id, MAX(sequence) AS through FROM log_chunks WHERE timestamp < ? GROUP BY job_id",
        )
        .all(before);
      for (const row of expired) this.#markDiscarded(String(row.job_id), Number(row.through));
      this.#db.prepare("DELETE FROM log_chunks WHERE timestamp < ?").run(before);
    });
  }

  #markDiscarded(jobId: string, through: number) {
    this.#db
      .prepare(`
      INSERT INTO log_discarded (job_id, through) VALUES (?, ?)
      ON CONFLICT(job_id) DO UPDATE SET through = MAX(through, excluded.through)
    `)
      .run(jobId, through);
  }
}
