import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const RobotId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/u));

// Pin the bridge's rerun-sdk to this version. The embedded viewer warns on a mismatched stream.
export const RERUN_VIEWER_VERSION = "0.43.2";

export const RobotLiveView = Schema.Struct({
  url: Schema.String.check(
    Schema.isMaxLength(512),
    Schema.isPattern(/^rerun\+https?:\/\/[^\s/?#@]+\/proxy$/u),
  ).annotate({ description: "Rerun gRPC stream, e.g. rerun+http://127.0.0.1:9876/proxy" }),
});
export type RobotLiveView = typeof RobotLiveView.Type;

export const RobotListInput = Schema.Struct({ projectId: ProjectId });
export type RobotListInput = typeof RobotListInput.Type;

export const RobotSessionInput = Schema.Struct({ projectId: ProjectId, robotId: RobotId });
export type RobotSessionInput = typeof RobotSessionInput.Type;

const RobotSessionSnapshot = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  state: Schema.Literals([
    "disconnected",
    "connecting",
    "ready",
    "unverified",
    "degraded",
    "blocked",
  ]),
  phase: Schema.Literals([
    "loadingInstructions",
    "settingUp",
    "checkingReadiness",
    "setupComplete",
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

export function isActiveRobotSession(session: RobotSessionSnapshot | null): boolean {
  return session !== null && session.state !== "disconnected" && session.state !== "blocked";
}

export const RobotSummary = Schema.Struct({
  robotId: RobotId,
  projectId: ProjectId,
  displayName: TrimmedNonEmptyString,
  knownHosts: Schema.Array(TrimmedNonEmptyString),
  initPath: Schema.NullOr(TrimmedNonEmptyString),
  liveView: Schema.optionalKey(RobotLiveView),
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
