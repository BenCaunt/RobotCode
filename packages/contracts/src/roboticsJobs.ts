import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, ProjectId, ThreadId } from "./baseSchemas.ts";

const Key = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }));

export const RoboticsJobProjectInput = Schema.Struct({ projectId: ProjectId });
export type RoboticsJobProjectInput = typeof RoboticsJobProjectInput.Type;

export const RoboticsJobEnsureInput = Schema.Struct({
  ...RoboticsJobProjectInput.fields,
  definitionId: Key,
  idempotencyKey: Key,
  threadId: Schema.optionalKey(ThreadId),
});
export type RoboticsJobEnsureInput = typeof RoboticsJobEnsureInput.Type;

export const RoboticsJobInput = Schema.Struct({ ...RoboticsJobProjectInput.fields, jobId: Key });
export type RoboticsJobInput = typeof RoboticsJobInput.Type;

export const RoboticsJobRestartInput = Schema.Struct({
  ...RoboticsJobInput.fields,
  idempotencyKey: Key,
});
export type RoboticsJobRestartInput = typeof RoboticsJobRestartInput.Type;

export const RoboticsJobListInput = Schema.Struct({
  ...RoboticsJobProjectInput.fields,
  before: Schema.optionalKey(PositiveInt),
  limit: Schema.optionalKey(Limit),
});
export type RoboticsJobListInput = typeof RoboticsJobListInput.Type;

export const RoboticsJobLogsInput = Schema.Struct({
  ...RoboticsJobInput.fields,
  after: Schema.optionalKey(NonNegativeInt),
  limit: Schema.optionalKey(Limit),
});
export type RoboticsJobLogsInput = typeof RoboticsJobLogsInput.Type;

export const RoboticsJobDefinitionSummary = Schema.Struct({
  definitionId: Key,
  label: Key,
  hostId: Key,
  robotId: Schema.NullOr(Key),
  sessionId: Schema.NullOr(Key),
  resourceClaims: Schema.Array(Key),
});
export type RoboticsJobDefinitionSummary = typeof RoboticsJobDefinitionSummary.Type;
export const RoboticsJobDefinitions = Schema.Array(RoboticsJobDefinitionSummary);

export const RoboticsJobState = Schema.Literals([
  "starting",
  "running",
  "stopping",
  "stopped",
  "failed",
  "unknown",
]);
export type RoboticsJobState = typeof RoboticsJobState.Type;

export const RoboticsJob = Schema.Struct({
  ...RoboticsJobDefinitionSummary.fields,
  ...RoboticsJobInput.fields,
  threadId: Schema.NullOr(ThreadId),
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  envRefs: Schema.Array(Schema.String),
  desiredState: Schema.Literals(["running", "stopped"]),
  state: RoboticsJobState,
  createdAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  endedAt: Schema.NullOr(IsoDateTime),
  pid: Schema.NullOr(PositiveInt),
  exitCode: Schema.NullOr(Schema.Int),
  restartPolicy: Schema.Literal("manual"),
});
export type RoboticsJob = typeof RoboticsJob.Type;

export const RoboticsJobList = Schema.Struct({
  jobs: Schema.Array(RoboticsJob),
  nextBefore: Schema.NullOr(PositiveInt),
});
export type RoboticsJobList = typeof RoboticsJobList.Type;

export const RoboticsJobLogChunk = Schema.Struct({
  sequence: PositiveInt,
  timestamp: IsoDateTime,
  source: Schema.Literals(["stdout", "stderr"]),
  text: Schema.String,
});
export type RoboticsJobLogChunk = typeof RoboticsJobLogChunk.Type;

export const RoboticsJobLogs = Schema.Struct({
  chunks: Schema.Array(RoboticsJobLogChunk),
  nextAfter: NonNegativeInt,
  discarded: Schema.Boolean,
});
export type RoboticsJobLogs = typeof RoboticsJobLogs.Type;

export class RoboticsJobError extends Schema.TaggedError<RoboticsJobError>()("RoboticsJobError", {
  reason: Schema.Literals([
    "configuration",
    "conflict",
    "definition-not-found",
    "idempotency-conflict",
    "job-not-found",
    "storage",
    "supervision",
    "unknown-process",
  ]),
  jobId: Schema.optionalKey(Key),
  resource: Schema.optionalKey(Key),
}) {
  override get message(): string {
    switch (this.reason) {
      case "configuration":
        return "The managed job configuration could not be loaded.";
      case "conflict":
        return this.resource
          ? `An existing managed job holds resource ${this.resource}.`
          : "A managed job for this definition is already active.";
      case "definition-not-found":
        return "The managed job definition is unavailable in this project.";
      case "idempotency-conflict":
        return "This idempotency key already belongs to another managed job request.";
      case "job-not-found":
        return "The managed job does not exist in this project.";
      case "storage":
        return "Managed job storage is unavailable.";
      case "supervision":
        return "The execution environment could not supervise the managed process.";
      case "unknown-process":
        return "The managed process needs reconciliation before it can be replaced.";
    }
  }
}
