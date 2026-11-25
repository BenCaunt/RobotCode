import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ManagedJobs from "../../../robotics/managedJobs.ts";
import * as RobotRegistry from "../../../robotics/RobotRegistry.ts";
import * as RoboticsAnnotationService from "../../../robotics/RoboticsAnnotationService.ts";
import { assertNotLinked } from "../../linkOrigin.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { assertFullAccess, assertLiveCaller, readCaller } from "../../threadAccess.ts";
import { RoboticsToolkit } from "./tools.ts";

const projectCaller = Effect.fn("RoboticsMcp.projectCaller")(function* (write: boolean) {
  const context = yield* readCaller();
  const caller = context.caller;
  if (caller === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_credential_required",
      message: "Robotics tools require a conversation in the target project.",
    });
  }
  yield* assertNotLinked(context, "access this project's robotics resources");
  yield* assertLiveCaller(context);
  if (write) {
    const message =
      "Changing robotics processes or sessions requires a live full-access conversation.";
    if (context.scope.runtimeModeCeiling && context.scope.runtimeModeCeiling !== "full-access") {
      return yield* new OrchestratorMcpFailure({ code: "capability_denied", message });
    }
    yield* assertFullAccess(context, message);
  }
  return caller;
});

const domainFailure = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

export const layer = McpToolAccess.toLayer(RoboticsToolkit, {
  t3_robotics_annotation_get: McpToolAccess.readsAsCaller(
    Effect.fn("RoboticsMcp.readAnnotation")(function* ({ annotationId }) {
      const { projectId } = yield* projectCaller(false);
      const annotations = yield* RoboticsAnnotationService.RoboticsAnnotationService;
      return yield* annotations
        .get({ projectId, annotationId })
        .pipe(Effect.mapError(domainFailure));
    }),
  ),
  t3_robotics_job_list: McpToolAccess.readsAsCaller(
    Effect.fn("RoboticsMcp.listJobs")(function* (input) {
      const { projectId } = yield* projectCaller(false);
      const jobs = yield* ManagedJobs.ManagedJobs;
      const page = yield* jobs.list({ projectId, ...input }).pipe(Effect.mapError(domainFailure));
      const definitions = yield* jobs
        .definitions({ projectId })
        .pipe(Effect.mapError(domainFailure));
      return { ...page, definitions };
    }),
  ),
  t3_robotics_job_inspect: McpToolAccess.readsAsCaller(
    Effect.fn("RoboticsMcp.inspectJob")(function* (input) {
      const { projectId } = yield* projectCaller(false);
      const jobs = yield* ManagedJobs.ManagedJobs;
      const job = yield* jobs
        .inspect({ projectId, jobId: input.jobId })
        .pipe(Effect.mapError(domainFailure));
      const logs = yield* jobs
        .logs({
          projectId,
          ...input,
          limit: Math.min(input.limit ?? 20, 20),
        })
        .pipe(Effect.mapError(domainFailure));
      return { job, logs };
    }),
  ),
  t3_robotics_job_manage: McpToolAccess.actsAsCaller(
    Effect.fn("RoboticsMcp.manageJob")(function* ({ action }) {
      const caller = yield* projectCaller(true);
      const jobs = yield* ManagedJobs.ManagedJobs;
      const { projectId } = caller;
      if (action.type === "stop") {
        return yield* jobs
          .stop({ projectId, jobId: action.jobId })
          .pipe(Effect.mapError(domainFailure));
      }
      if (action.type === "restart") {
        return yield* jobs
          .restart({
            projectId,
            jobId: action.jobId,
            idempotencyKey: action.idempotencyKey,
          })
          .pipe(Effect.mapError(domainFailure));
      }
      const run = action.type === "ensure" ? jobs.ensure : jobs.start;
      return yield* run({
        projectId,
        threadId: caller.id,
        definitionId: action.definitionId,
        idempotencyKey: action.idempotencyKey,
      }).pipe(Effect.mapError(domainFailure));
    }),
  ),
  t3_robotics_robot_list: McpToolAccess.readsAsCaller(
    Effect.fn("RoboticsMcp.listRobots")(function* ({ robotId }) {
      const { projectId } = yield* projectCaller(false);
      const robots = yield* RobotRegistry.RobotRegistry;
      return yield* (
        robotId === undefined
          ? robots.list({ projectId })
          : robots.inspect({ projectId, robotId }).pipe(Effect.map((robot) => [robot]))
      ).pipe(Effect.mapError(domainFailure));
    }),
  ),
  t3_robotics_robot_session: McpToolAccess.actsAsCaller(
    Effect.fn("RoboticsMcp.manageSession")(function* ({ action, robotId }) {
      const { projectId } = yield* projectCaller(true);
      const robots = yield* RobotRegistry.RobotRegistry;
      const run = action === "connect" ? robots.connect : robots.cancel;
      return yield* run({ projectId, robotId }).pipe(Effect.mapError(domainFailure));
    }),
  ),
});
