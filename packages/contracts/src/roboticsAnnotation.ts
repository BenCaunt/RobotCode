import * as Schema from "effect/Schema";

import {
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const AnnotationId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const RecordingPath = TrimmedNonEmptyString.check(Schema.isMaxLength(1_024));
const RecordingId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const RecordingVersion = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const Timestamp = Schema.String.check(Schema.isPattern(/^-?(?:0|[1-9][0-9]{0,18})$/));
const Comment = TrimmedNonEmptyString.check(Schema.isMaxLength(4_096));

const Recording = Schema.Struct({
  path: RecordingPath,
  recordingId: RecordingId,
  version: RecordingVersion,
});
const ViewText = Schema.String.check(Schema.isMaxLength(256));
const View = Schema.Struct({
  viewId: AnnotationId,
  name: ViewText,
  class: ViewText,
  origin: ViewText,
  visible: Schema.Boolean,
});
const orderedInterval = Schema.makeFilter(
  ({ start, end }: { readonly start: string; readonly end?: string | undefined }) =>
    end === undefined || BigInt(start) <= BigInt(end),
);

export const RoboticsAnnotationCursor = Schema.Struct({
  timeline: AnnotationId,
  timeType: Schema.Literals(["sequence", "duration", "timestamp"]),
  start: Timestamp,
  end: Schema.optional(Timestamp),
  entityPaths: Schema.Array(AnnotationId).check(Schema.isMaxLength(64)),
  imageRegion: Schema.optional(
    Schema.Struct({
      x: NonNegativeInt,
      y: NonNegativeInt,
      width: PositiveInt,
      height: PositiveInt,
    }),
  ),
  views: Schema.optional(Schema.Array(View).check(Schema.isMaxLength(32))),
}).check(orderedInterval);

export const RoboticsAnnotationCreateInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optional(ThreadId),
  idempotencyKey: AnnotationId,
  recording: Recording,
  ...RoboticsAnnotationCursor.fields,
  comment: Comment,
}).check(orderedInterval);
export type RoboticsAnnotationCreateInput = typeof RoboticsAnnotationCreateInput.Type;

export const RoboticsAnnotationGetInput = Schema.Struct({
  projectId: ProjectId,
  annotationId: AnnotationId,
});
export type RoboticsAnnotationGetInput = typeof RoboticsAnnotationGetInput.Type;

export const RoboticsAnnotationListInput = Schema.Struct({
  projectId: ProjectId,
  after: Schema.optional(AnnotationId),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(10))),
});
export type RoboticsAnnotationListInput = typeof RoboticsAnnotationListInput.Type;

const AnnotationSummary = Schema.Struct({
  ...RoboticsAnnotationGetInput.fields,
  threadId: Schema.optional(ThreadId),
  recording: Schema.Struct({ ...Recording.fields, artifactId: AnnotationId }),
  timeline: RoboticsAnnotationCursor.fields.timeline,
  timeType: RoboticsAnnotationCursor.fields.timeType,
  start: RoboticsAnnotationCursor.fields.start,
  end: RoboticsAnnotationCursor.fields.end,
  status: Schema.Literals(["open", "resolved"]),
  createdAtMs: NonNegativeInt,
}).check(orderedInterval);

export const RoboticsAnnotation = Schema.Struct({
  ...AnnotationSummary.fields,
  ...RoboticsAnnotationCursor.fields,
  authorId: AnnotationId,
  comment: Comment,
}).check(orderedInterval);
export type RoboticsAnnotation = typeof RoboticsAnnotation.Type;

export const RoboticsAnnotationList = Schema.Struct({
  items: Schema.Array(AnnotationSummary).check(Schema.isMaxLength(10)),
  nextCursor: Schema.NullOr(AnnotationId),
});
export type RoboticsAnnotationList = typeof RoboticsAnnotationList.Type;

export class RoboticsAnnotationRpcError extends Schema.TaggedError<
  RoboticsAnnotationRpcError,
  { readonly brand: unique symbol }
>()("RoboticsAnnotationRpcError", {
  category: Schema.Literals(["invalid", "missing", "conflict", "recording-changed", "unavailable"]),
}) {
  override get message(): string {
    return `Recording annotation could not be completed (${this.category}).`;
  }
}
