import { RoboticsAnnotationCreateInput, RoboticsAnnotationCursor } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const Id = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256));
const Note = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096));
const TimeMs = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const Version = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128));
const Evidence = Schema.Struct({ artifactId: Id, version: Version });
const EvidenceList = Schema.Array(Evidence).check(Schema.isMaxLength(64));

const RecordHeader = {
  id: Id,
  projectId: Id,
  revision: Revision,
  createdAtMs: TimeMs,
  updatedAtMs: TimeMs,
};
const CreationKey = { projectId: Id, idempotencyKey: Id };
const Selection = Schema.Struct({
  recording: Evidence,
  ...RoboticsAnnotationCursor.fields,
  timeType: Schema.optional(RoboticsAnnotationCursor.fields.timeType),
  view: Schema.optional(Evidence),
  excerpt: Schema.optional(Evidence),
}).check(Schema.makeFilter(({ start, end }) => end === undefined || BigInt(start) <= BigInt(end)));
const AnnotationDetails = {
  selection: Selection,
  authorId: Id,
  comment: Note,
  recordingSource: Schema.optional(
    Schema.Struct({
      path: RoboticsAnnotationCreateInput.fields.recording.fields.path,
      recordingId: RoboticsAnnotationCreateInput.fields.recording.fields.recordingId,
      threadId: RoboticsAnnotationCreateInput.fields.threadId,
    }),
  ),
};
const Reply = Schema.Struct({ id: Id, authorId: Id, comment: Note, createdAtMs: TimeMs });

export const AddAnnotation = Schema.Struct({ ...CreationKey, ...AnnotationDetails });
export const Annotation = Schema.Struct({
  ...RecordHeader,
  ...AnnotationDetails,
  kind: Schema.Literal("annotation"),
  status: Schema.Literals(["open", "resolved"]),
  replies: Schema.Array(Reply).check(Schema.isMaxLength(100)),
  handoffThreadId: Schema.optional(Id),
});
const EditKey = { projectId: Id, id: Id, expectedRevision: Revision };
export const EditAnnotation = Schema.Struct({
  ...EditKey,
  change: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("reply"),
      id: Id,
      authorId: Id,
      comment: Note,
    }),
    Schema.Struct({ type: Schema.Literal("status"), status: Annotation.fields.status }),
    Schema.Struct({ type: Schema.Literal("linkHandoff"), threadId: Id }),
  ]),
});

const Provenance = Schema.Struct({
  gitRevision: Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i)),
  dirtyTree: Schema.optional(Evidence),
  configuration: Evidence,
  calibration: Schema.optional(Evidence),
  initialState: Note,
  seeds: Schema.Array(Schema.Int).check(Schema.isMaxLength(64)),
});
const ExperimentDetails = {
  objective: Note,
  robotId: Id,
  hostId: Id,
  mode: Schema.Literal("simulation"),
  provenance: Provenance,
  limits: Schema.Struct({ maxDurationMs: Revision, maxRetries: TimeMs }),
};
const TerminalOutcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("completed"), summary: Note }),
  Schema.Struct({ status: Schema.Literals(["failed", "canceled", "unknown"]), summary: Note }),
]);

export const PlanExperiment = Schema.Struct({ ...CreationKey, ...ExperimentDetails });
export const Experiment = Schema.Struct({
  ...RecordHeader,
  ...ExperimentDetails,
  kind: Schema.Literal("experiment"),
  state: Schema.Literals([
    "planned",
    "running",
    "stopping",
    "waiting-for-human",
    "completed",
    "failed",
    "canceled",
    "unknown",
  ]),
  retries: TimeMs,
  startedAtMs: Schema.optional(TimeMs),
  deadlineMs: Schema.optional(TimeMs),
  activeInterventionId: Schema.optional(Id),
  outcome: Schema.optional(TerminalOutcome),
  jobs: Schema.Array(Id).check(Schema.isMaxLength(64)),
  leases: Schema.Array(Id).check(Schema.isMaxLength(64)),
  streams: Schema.Array(Id).check(Schema.isMaxLength(64)),
  evidence: EvidenceList,
  metrics: Schema.Array(Schema.Struct({ name: Id, value: Schema.Finite, unit: Id })).check(
    Schema.isMaxLength(64),
  ),
});
export const ChangeExperiment = Schema.Struct({
  ...EditKey,
  change: Schema.Union([
    Schema.Struct({ type: Schema.Literal("start") }),
    Schema.Struct({ type: Schema.Literal("stop") }),
    Schema.Struct({ type: Schema.Literal("finish"), outcome: TerminalOutcome }),
    Schema.Struct({
      type: Schema.Literal("evidence"),
      evidence: EvidenceList,
      jobs: Experiment.fields.jobs,
      leases: Experiment.fields.leases,
      streams: Experiment.fields.streams,
      metrics: Experiment.fields.metrics,
    }),
  ]),
});

const ResponseChoice = Schema.Literals(["acknowledged", "action-completed", "assistance-needed"]);
const InterventionDetails = {
  experimentId: Id,
  evidence: EvidenceList,
  requestedAction: Note,
  urgency: Schema.Literals(["routine", "urgent"]),
  expiresAtMs: TimeMs,
  allowedResponses: Schema.Array(ResponseChoice).check(Schema.isNonEmpty(), Schema.isMaxLength(3)),
};
const Response = Schema.Struct({
  value: ResponseChoice,
  actorId: Id,
  deliveryId: Id,
  receivedAtMs: TimeMs,
});
export const RequestIntervention = Schema.Struct({ ...CreationKey, ...InterventionDetails });
export const Intervention = Schema.Struct({
  ...RecordHeader,
  ...InterventionDetails,
  kind: Schema.Literal("intervention"),
  robotId: Id,
  status: Schema.Literals(["pending", "responded", "consumed", "expired", "canceled"]),
  response: Schema.optional(Response),
});
export const RespondIntervention = Schema.Struct({
  projectId: Id,
  id: Id,
  value: ResponseChoice,
  actorId: Id,
  deliveryId: Id,
});
export const ResumeExperiment = Schema.Struct({ ...EditKey, interventionId: Id });
export const EvidenceRecord = Schema.Union([Annotation, Experiment, Intervention]);
export const EvidenceRecordKey = Schema.Struct({
  projectId: Id,
  id: Id,
  kind: Schema.Literals(["annotation", "experiment", "intervention"]),
});
export const ListEvidenceRecords = Schema.Struct({
  projectId: Id,
  kind: EvidenceRecordKey.fields.kind,
  viewerOnly: Schema.optional(Schema.Literal(true)),
  after: Schema.optional(Id),
  limit: Schema.optional(Revision.check(Schema.isLessThanOrEqualTo(100))),
});
