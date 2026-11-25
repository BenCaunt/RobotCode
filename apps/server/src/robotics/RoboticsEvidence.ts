import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

import * as Model from "./RoboticsEvidenceModel.ts";

type Record = typeof Model.EvidenceRecord.Type;
type Kind = Record["kind"];
type Experiment = typeof Model.Experiment.Type;
type Intervention = typeof Model.Intervention.Type;
type ForKind<K extends Kind> = Extract<Record, { readonly kind: K }>;
type RecordKey = typeof Model.EvidenceRecordKey.Type;
type Failure = RoboticsEvidenceError | RoboticsEvidenceStorageError;
type Method<S extends Schema.Schema<unknown>, A> = (input: S["Type"]) => Effect.Effect<A, Failure>;

export class RoboticsEvidenceError extends Schema.TaggedError<
  RoboticsEvidenceError,
  { readonly brand: unique symbol }
>()("RoboticsEvidenceError", {
  category: Schema.Literals([
    "invalid",
    "missing",
    "conflict",
    "invalid-state",
    "expired",
    "recording-changed",
    "limit-exceeded",
    "reset-unverified",
  ]),
}) {
  override get message(): string {
    return `Robotics evidence request rejected (${this.category}).`;
  }
}

export class RoboticsEvidenceStorageError extends Schema.TaggedError<
  RoboticsEvidenceStorageError,
  { readonly brand: unique symbol }
>()("RoboticsEvidenceStorageError", { cause: Schema.Defect() }) {
  override get message(): string {
    return "Unable to read or write robotics evidence.";
  }
}

export class ExperimentResetVerifier extends Context.Service<
  ExperimentResetVerifier,
  {
    readonly verify: (
      experiment: Experiment,
      intervention: Intervention,
    ) => Effect.Effect<Option.Option<Experiment["evidence"][number]>>;
  }
>()("t3/robotics/RoboticsEvidence/ExperimentResetVerifier") {}

export class RoboticsEvidence extends Context.Service<
  RoboticsEvidence,
  {
    readonly get: Method<typeof Model.EvidenceRecordKey, Record>;
    readonly list: Method<
      typeof Model.ListEvidenceRecords,
      { readonly items: ReadonlyArray<Record>; readonly nextCursor: string | null }
    >;
    readonly addAnnotation: (
      input: typeof Model.AddAnnotation.Type,
      verify?: Effect.Effect<void, RoboticsEvidenceError>,
    ) => Effect.Effect<typeof Model.Annotation.Type, Failure>;
    readonly editAnnotation: Method<typeof Model.EditAnnotation, typeof Model.Annotation.Type>;
    readonly planExperiment: Method<typeof Model.PlanExperiment, Experiment>;
    readonly changeExperiment: Method<typeof Model.ChangeExperiment, Experiment>;
    readonly requestIntervention: Method<typeof Model.RequestIntervention, Intervention>;
    readonly respondIntervention: Method<typeof Model.RespondIntervention, Intervention>;
    readonly resumeExperiment: Method<typeof Model.ResumeExperiment, Experiment>;
  }
>()("t3/robotics/RoboticsEvidence") {}

function readInput<S extends Schema.Constraint & { readonly DecodingServices: never }>(
  schema: S,
  value: S["Type"],
) {
  return Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(value).pipe(
    Effect.mapError(() => new RoboticsEvidenceError({ category: "invalid" })),
  );
}

const storageError = (cause: SqlError.SqlError | Schema.SchemaError) =>
  new RoboticsEvidenceStorageError({ cause });
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Model.EvidenceRecord));
const encode = Schema.encodeEffect(Schema.fromJsonString(Model.EvidenceRecord));

function change<T extends Record>(record: T, now: number, patch: Partial<T>): T {
  return { ...record, ...patch, revision: record.revision + 1, updatedAtMs: now };
}

function visible(record: Record, now: number): Record {
  if (
    record.kind === "intervention" &&
    (record.status === "pending" || record.status === "responded") &&
    record.expiresAtMs <= now
  ) {
    return { ...record, status: "expired" };
  }
  return record;
}

function isKind<K extends Kind>(record: Record, kind: K): record is ForKind<K> {
  return record.kind === kind;
}

const unique = <T>(items: ReadonlyArray<T>, key: (item: T) => string) =>
  Array.from(new Map(items.map((item) => [key(item), item])).values());

const evidenceKey = (item: Experiment["evidence"][number]) =>
  JSON.stringify([item.artifactId, item.version]);

const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const fingerprint = Effect.fn("RoboticsEvidence.fingerprint")(function* (request: object) {
  const json = yield* encodeRequest(request).pipe(Effect.mapError(storageError));
  const bytes = new TextEncoder().encode(json);
  const hash = yield* Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", bytes),
    catch: (cause) => new RoboticsEvidenceStorageError({ cause }),
  });
  return Buffer.from(hash).toString("hex");
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;
  const verifier = yield* Effect.serviceOption(ExperimentResetVerifier);

  const read = Effect.fn("RoboticsEvidence.read")(function* <K extends Kind>(
    projectId: string,
    kind: K,
    id: string,
  ) {
    const rows = yield* sql<{ readonly record_json: string }>`
      SELECT record_json FROM robotics_evidence_records
      WHERE project_id = ${projectId} AND kind = ${kind} AND id = ${id}
    `.pipe(Effect.mapError(storageError));
    const row = rows[0];
    if (!row) return yield* new RoboticsEvidenceError({ category: "missing" });
    const record = yield* decode(row.record_json).pipe(Effect.mapError(storageError));
    if (!isKind(record, kind) || record.projectId !== projectId || record.id !== id) {
      return yield* new RoboticsEvidenceStorageError({ cause: "Mismatched robotics record key" });
    }
    return record;
  });

  const findCreated = Effect.fn("RoboticsEvidence.findCreated")(function* <K extends Kind>(
    projectId: string,
    kind: K,
    key: string,
    hash: string,
  ) {
    const rows = yield* sql<{ readonly id: string; readonly request_hash: string }>`
      SELECT id, request_hash FROM robotics_evidence_records
      WHERE project_id = ${projectId} AND kind = ${kind} AND request_key = ${key}
    `.pipe(Effect.mapError(storageError));
    const row = rows[0];
    if (!row) return Option.none<ForKind<K>>();
    if (row.request_hash !== hash)
      return yield* new RoboticsEvidenceError({ category: "conflict" });
    return Option.some(yield* read(projectId, kind, row.id));
  });

  const insert = Effect.fn("RoboticsEvidence.insert")(function* <T extends Record>(
    record: T,
    key: string,
    hash: string,
  ) {
    const json = yield* encode(record).pipe(
      Effect.mapError(() => new RoboticsEvidenceError({ category: "limit-exceeded" })),
    );
    yield* sql`
      INSERT INTO robotics_evidence_records
        (project_id, kind, id, request_key, request_hash, revision, record_json)
      VALUES (${record.projectId}, ${record.kind}, ${record.id}, ${key}, ${hash},
              ${record.revision}, ${json})
    `.pipe(Effect.mapError(storageError));
    return record;
  });

  const save = Effect.fn("RoboticsEvidence.save")(function* <T extends Record>(record: T) {
    const json = yield* encode(record).pipe(
      Effect.mapError(() => new RoboticsEvidenceError({ category: "limit-exceeded" })),
    );
    const rows = yield* sql`
      UPDATE robotics_evidence_records
      SET revision = ${record.revision}, record_json = ${json}
      WHERE project_id = ${record.projectId} AND kind = ${record.kind} AND id = ${record.id}
        AND revision = ${record.revision - 1}
      RETURNING id
    `.pipe(Effect.mapError(storageError));
    if (rows.length === 0) return yield* new RoboticsEvidenceError({ category: "conflict" });
    return record;
  });

  const atomic = <A, E extends Failure>(effect: Effect.Effect<A, E>) =>
    sql
      .withTransaction(effect)
      .pipe(Effect.mapError((cause) => (SqlError.isSqlError(cause) ? storageError(cause) : cause)));

  const header = (id: string, projectId: string, time: number) => ({
    projectId,
    id,
    revision: 1,
    createdAtMs: time,
    updatedAtMs: time,
  });
  const newId = random
    .uuidV4()
    .pipe(Effect.mapError((cause) => new RoboticsEvidenceStorageError({ cause })));

  const newRecord = Effect.fn("RoboticsEvidence.newRecord")(function* <K extends Kind>(
    kind: K,
    input: { readonly projectId: string; readonly idempotencyKey: string },
    build: (head: ReturnType<typeof header>) => ForKind<K>,
    verify?: Effect.Effect<void, RoboticsEvidenceError>,
  ) {
    const hash = yield* fingerprint(input);
    if (verify) {
      const prior = yield* findCreated(input.projectId, kind, input.idempotencyKey, hash);
      if (Option.isSome(prior)) return prior.value;
      yield* verify;
    }
    return yield* atomic(
      Effect.gen(function* () {
        const prior = yield* findCreated(input.projectId, kind, input.idempotencyKey, hash);
        if (Option.isSome(prior)) return prior.value;
        const now = yield* Clock.currentTimeMillis;
        const id = yield* newId;
        return yield* insert(build(header(id, input.projectId, now)), input.idempotencyKey, hash);
      }),
    );
  });

  const closeIntervention = Effect.fn("RoboticsEvidence.closeIntervention")(function* (
    experiment: Experiment,
    now: number,
  ) {
    if (!experiment.activeInterventionId) return;
    const intervention = yield* read(
      experiment.projectId,
      "intervention",
      experiment.activeInterventionId,
    );
    const status = intervention.expiresAtMs <= now ? "expired" : "canceled";
    yield* save(change(intervention, now, { status }));
  });

  const checkResume = Effect.fn("RoboticsEvidence.checkResume")(function* (
    input: typeof Model.ResumeExperiment.Type,
  ) {
    const experiment = yield* read(input.projectId, "experiment", input.id);
    const intervention = yield* read(input.projectId, "intervention", input.interventionId);
    const now = yield* Clock.currentTimeMillis;
    if (experiment.revision !== input.expectedRevision) {
      return yield* new RoboticsEvidenceError({ category: "conflict" });
    }
    if (intervention.expiresAtMs <= now || (experiment.deadlineMs ?? 0) <= now) {
      return yield* new RoboticsEvidenceError({ category: "expired" });
    }
    if (
      experiment.state !== "waiting-for-human" ||
      experiment.activeInterventionId !== intervention.id ||
      intervention.experimentId !== experiment.id ||
      intervention.status !== "responded" ||
      intervention.response?.value !== "action-completed"
    ) {
      return yield* new RoboticsEvidenceError({ category: "invalid-state" });
    }
    if (experiment.retries >= experiment.limits.maxRetries) {
      return yield* new RoboticsEvidenceError({ category: "limit-exceeded" });
    }
    return { experiment, intervention, now };
  });

  return RoboticsEvidence.of({
    get: Effect.fn("RoboticsEvidence.get")(function* (request: RecordKey) {
      const input = yield* readInput(Model.EvidenceRecordKey, request);
      const record = yield* read(input.projectId, input.kind, input.id);
      return visible(record, yield* Clock.currentTimeMillis);
    }),
    list: Effect.fn("RoboticsEvidence.list")(function* (request) {
      const input = yield* readInput(Model.ListEvidenceRecords, request);
      const limit = input.limit ?? 25;
      const rows = yield* sql<{ readonly record_json: string }>`
        SELECT record_json FROM robotics_evidence_records
        WHERE project_id = ${input.projectId} AND kind = ${input.kind} AND id > ${input.after ?? ""}
          ${input.viewerOnly ? sql`AND json_type(record_json, '$.recordingSource') = 'object'` : sql``}
        ORDER BY id LIMIT ${limit + 1}
      `.pipe(Effect.mapError(storageError));
      const now = yield* Clock.currentTimeMillis;
      const records = yield* Effect.forEach(rows.slice(0, limit), (row) =>
        decode(row.record_json).pipe(Effect.mapError(storageError)),
      );
      return {
        items: records.map((record) => visible(record, now)),
        nextCursor: rows.length > limit ? (records.at(-1)?.id ?? null) : null,
      };
    }),
    addAnnotation: Effect.fn("RoboticsEvidence.addAnnotation")(function* (request, verify) {
      const input = yield* readInput(Model.AddAnnotation, request);
      return yield* newRecord(
        "annotation",
        input,
        (head) => ({
          ...head,
          kind: "annotation",
          selection: input.selection,
          authorId: input.authorId,
          comment: input.comment,
          ...(input.recordingSource ? { recordingSource: input.recordingSource } : {}),
          status: "open",
          replies: [],
        }),
        verify,
      );
    }),
    editAnnotation: Effect.fn("RoboticsEvidence.editAnnotation")(function* (request) {
      const {
        projectId,
        id,
        expectedRevision,
        change: edit,
      } = yield* readInput(Model.EditAnnotation, request);
      const record = yield* read(projectId, "annotation", id);
      const now = yield* Clock.currentTimeMillis;
      if (edit.type === "reply") {
        const prior = record.replies.find((reply) => reply.id === edit.id);
        if (prior?.authorId === edit.authorId && prior.comment === edit.comment) return record;
        if (prior || record.revision !== expectedRevision) {
          return yield* new RoboticsEvidenceError({ category: "conflict" });
        }
        return yield* save(
          change(record, now, {
            replies: [
              ...record.replies,
              { id: edit.id, authorId: edit.authorId, comment: edit.comment, createdAtMs: now },
            ],
          }),
        );
      }
      if (record.revision !== expectedRevision) {
        return yield* new RoboticsEvidenceError({ category: "conflict" });
      }
      if (edit.type === "status") return yield* save(change(record, now, { status: edit.status }));
      return yield* save(change(record, now, { handoffThreadId: edit.threadId }));
    }),
    planExperiment: Effect.fn("RoboticsEvidence.planExperiment")(function* (request) {
      const { idempotencyKey, ...details } = yield* readInput(Model.PlanExperiment, request);
      return yield* newRecord("experiment", { ...details, idempotencyKey }, (head) => ({
        ...head,
        ...details,
        kind: "experiment",
        state: "planned",
        retries: 0,
        jobs: [],
        leases: [],
        streams: [],
        evidence: [],
        metrics: [],
      }));
    }),
    changeExperiment: Effect.fn("RoboticsEvidence.changeExperiment")(function* (request) {
      const {
        projectId,
        id,
        expectedRevision,
        change: edit,
      } = yield* readInput(Model.ChangeExperiment, request);
      return yield* atomic(
        Effect.gen(function* () {
          const record = yield* read(projectId, "experiment", id);
          if (record.revision !== expectedRevision) {
            return yield* new RoboticsEvidenceError({ category: "conflict" });
          }
          const now = yield* Clock.currentTimeMillis;
          if (edit.type === "evidence") {
            return yield* save(
              change(record, now, {
                evidence: unique([...record.evidence, ...edit.evidence], evidenceKey),
                jobs: [...new Set([...record.jobs, ...edit.jobs])],
                leases: [...new Set([...record.leases, ...edit.leases])],
                streams: [...new Set([...record.streams, ...edit.streams])],
                metrics: unique([...record.metrics, ...edit.metrics], (metric) => metric.name),
              }),
            );
          }
          if (edit.type === "start" && record.state === "planned") {
            const deadlineMs = now + record.limits.maxDurationMs;
            if (!Number.isSafeInteger(deadlineMs)) {
              return yield* new RoboticsEvidenceError({ category: "limit-exceeded" });
            }
            return yield* save(
              change(record, now, { state: "running", startedAtMs: now, deadlineMs }),
            );
          }
          const active = record.state === "running" || record.state === "waiting-for-human";
          if (edit.type === "stop" && active) {
            yield* closeIntervention(record, now);
            return yield* save(
              change(record, now, { state: "stopping", activeInterventionId: undefined }),
            );
          }
          if (
            edit.type === "finish" &&
            (active ||
              record.state === "stopping" ||
              (record.state === "planned" && edit.outcome.status === "canceled"))
          ) {
            yield* closeIntervention(record, now);
            return yield* save(
              change(record, now, {
                state: edit.outcome.status,
                outcome: edit.outcome,
                activeInterventionId: undefined,
              }),
            );
          }
          return yield* new RoboticsEvidenceError({ category: "invalid-state" });
        }),
      );
    }),
    requestIntervention: Effect.fn("RoboticsEvidence.requestIntervention")(function* (request) {
      const { idempotencyKey, ...details } = yield* readInput(Model.RequestIntervention, request);
      const hash = yield* fingerprint(details);
      return yield* atomic(
        Effect.gen(function* () {
          const prior = yield* findCreated(details.projectId, "intervention", idempotencyKey, hash);
          if (Option.isSome(prior)) return prior.value;
          const experiment = yield* read(details.projectId, "experiment", details.experimentId);
          const now = yield* Clock.currentTimeMillis;
          if (details.expiresAtMs <= now || (experiment.deadlineMs ?? 0) <= now) {
            return yield* new RoboticsEvidenceError({ category: "expired" });
          }
          if (details.expiresAtMs > (experiment.deadlineMs ?? 0)) {
            return yield* new RoboticsEvidenceError({ category: "invalid" });
          }
          if (experiment.state !== "running" && experiment.state !== "waiting-for-human") {
            return yield* new RoboticsEvidenceError({ category: "invalid-state" });
          }
          if (experiment.activeInterventionId) {
            const current = yield* read(
              experiment.projectId,
              "intervention",
              experiment.activeInterventionId,
            );
            if (
              current.expiresAtMs > now &&
              (current.status === "pending" || current.response?.value === "action-completed")
            ) {
              return yield* new RoboticsEvidenceError({ category: "conflict" });
            }
            if (current.expiresAtMs <= now)
              yield* save(change(current, now, { status: "expired" }));
          }
          const id = yield* newId;
          const intervention = yield* insert(
            {
              ...header(id, details.projectId, now),
              ...details,
              kind: "intervention",
              robotId: experiment.robotId,
              status: "pending",
            } satisfies Intervention,
            idempotencyKey,
            hash,
          );
          yield* save(
            change(experiment, now, {
              state: "waiting-for-human",
              activeInterventionId: intervention.id,
            }),
          );
          return intervention;
        }),
      );
    }),
    respondIntervention: Effect.fn("RoboticsEvidence.respondIntervention")(function* (request) {
      const { projectId, id, actorId, deliveryId, value } = yield* readInput(
        Model.RespondIntervention,
        request,
      );
      return yield* atomic(
        Effect.gen(function* () {
          const record = yield* read(projectId, "intervention", id);
          const now = yield* Clock.currentTimeMillis;
          if (record.response?.deliveryId === deliveryId) {
            if (record.response.actorId === actorId && record.response.value === value) {
              return record.expiresAtMs <= now && record.status === "responded"
                ? ({ ...record, status: "expired" } satisfies Intervention)
                : record;
            }
            return yield* new RoboticsEvidenceError({ category: "conflict" });
          }
          const experiment = yield* read(projectId, "experiment", record.experimentId);
          if (record.expiresAtMs <= now || (experiment.deadlineMs ?? 0) <= now) {
            return yield* new RoboticsEvidenceError({ category: "expired" });
          }
          if (
            record.status !== "pending" ||
            experiment.state !== "waiting-for-human" ||
            experiment.activeInterventionId !== record.id ||
            !record.allowedResponses.includes(value)
          ) {
            return yield* new RoboticsEvidenceError({ category: "invalid-state" });
          }
          return yield* save(
            change(record, now, {
              status: "responded",
              response: { actorId, deliveryId, value, receivedAtMs: now },
            }),
          );
        }),
      );
    }),
    resumeExperiment: Effect.fn("RoboticsEvidence.resumeExperiment")(function* (request) {
      const input = yield* readInput(Model.ResumeExperiment, request);
      if (Option.isNone(verifier)) {
        return yield* new RoboticsEvidenceError({ category: "reset-unverified" });
      }
      const before = yield* checkResume(input);
      const verification = yield* verifier.value.verify(before.experiment, before.intervention);
      if (Option.isNone(verification)) {
        return yield* new RoboticsEvidenceError({ category: "reset-unverified" });
      }
      const evidence = verification.value;
      return yield* atomic(
        Effect.gen(function* () {
          const { experiment, intervention, now } = yield* checkResume(input);
          if (intervention.revision !== before.intervention.revision) {
            return yield* new RoboticsEvidenceError({ category: "conflict" });
          }
          yield* save(change(intervention, now, { status: "consumed" }));
          return yield* save(
            change(experiment, now, {
              state: "running",
              retries: experiment.retries + 1,
              activeInterventionId: undefined,
              evidence: unique([...experiment.evidence, evidence], evidenceKey),
            }),
          );
        }),
      );
    }),
  });
});

export const layer = Layer.effect(RoboticsEvidence, make);
