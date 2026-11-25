import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const RobotId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/u));

export const RobotListInput = Schema.Struct({ projectId: ProjectId });
export type RobotListInput = typeof RobotListInput.Type;

export const RobotSessionInput = Schema.Struct({ projectId: ProjectId, robotId: RobotId });
export type RobotSessionInput = typeof RobotSessionInput.Type;

const RobotSessionSnapshot = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  state: Schema.Literals(["disconnected", "connecting", "ready", "degraded", "blocked"]),
  phase: Schema.Literals([
    "loadingInstructions",
    "settingUp",
    "checkingReadiness",
    "monitoring",
    "cancelled",
  ]),
  reason: Schema.NullOr(
    Schema.Literals([
      "instructionsUnavailable",
      "setupFailed",
      "readinessUnavailable",
      "cancelled",
    ]),
  ),
  startedAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastReadyAt: Schema.NullOr(IsoDateTime),
});
export type RobotSessionSnapshot = typeof RobotSessionSnapshot.Type;

export const RobotSummary = Schema.Struct({
  robotId: RobotId,
  projectId: ProjectId,
  displayName: TrimmedNonEmptyString,
  knownHosts: Schema.Array(TrimmedNonEmptyString),
  initPath: Schema.NullOr(TrimmedNonEmptyString),
  session: Schema.NullOr(RobotSessionSnapshot),
});
export type RobotSummary = typeof RobotSummary.Type;

export const RobotListResult = Schema.Array(RobotSummary);

export const RobotRegistryErrorReason = Schema.Literals([
  "invalidRegistry",
  "registryUnavailable",
  "robotNotFound",
]);

export class RobotRegistryRpcError extends Schema.TaggedError<
  RobotRegistryRpcError,
  { readonly brand: unique symbol }
>()("RobotRegistryRpcError", { reason: RobotRegistryErrorReason, message: Schema.String }) {}
