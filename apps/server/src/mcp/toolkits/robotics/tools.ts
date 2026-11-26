import {
  OrchestratorMcpFailure,
  RobotListResult,
  RobotSessionInput,
  RobotSummary,
  RoboticsAnnotation,
  RoboticsAnnotationGetInput,
  RoboticsJob,
  RoboticsJobDefinitions,
  RoboticsJobEnsureInput,
  RoboticsJobInput,
  RoboticsJobList,
  RoboticsJobListInput,
  RoboticsJobLogs,
  RoboticsJobLogsInput,
  RoboticsJobRestartInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedJobs from "../../../robotics/managedJobs.ts";
import * as RobotRegistry from "../../../robotics/RobotRegistry.ts";
import * as RoboticsAnnotationService from "../../../robotics/RoboticsAnnotationService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ManagedJobs.ManagedJobs,
    RobotRegistry.RobotRegistry,
  ],
};

const JobList = Tool.make("t3_robotics_job_list", {
  ...shared,
  description:
    "List managed processes in this conversation's project and available operator-approved definitions.",
  parameters: RoboticsJobListInput.mapFields((fields) => ({
    before: fields.before,
    limit: fields.limit,
  })),
  success: Schema.Struct({
    jobs: RoboticsJobList.fields.jobs,
    nextBefore: RoboticsJobList.fields.nextBefore,
    definitions: RoboticsJobDefinitions,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const JobInspect = Tool.make("t3_robotics_job_inspect", {
  ...shared,
  description:
    "Read a managed process and a bounded page of its logs by job ID. Use nextAfter as the next log cursor.",
  parameters: RoboticsJobLogsInput.mapFields((fields) => ({
    jobId: fields.jobId,
    after: fields.after,
    limit: fields.limit,
  })),
  success: Schema.Struct({ job: RoboticsJob, logs: RoboticsJobLogs }),
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const JobManage = Tool.make("t3_robotics_job_manage", {
  ...shared,
  description:
    "Ensure, start, stop, or restart an operator-approved non-actuating process. Reuse idempotencyKey after a lost reply. Ensure can reuse a running process. Start refuses a duplicate.",
  parameters: Schema.Struct({
    action: Schema.Union([
      Schema.Struct({
        type: Schema.Literals(["ensure", "start"]),
        definitionId: RoboticsJobEnsureInput.fields.definitionId,
        idempotencyKey: RoboticsJobEnsureInput.fields.idempotencyKey,
      }),
      Schema.Struct({ type: Schema.Literal("stop"), jobId: RoboticsJobInput.fields.jobId }),
      Schema.Struct({
        type: Schema.Literal("restart"),
        jobId: RoboticsJobInput.fields.jobId,
        idempotencyKey: RoboticsJobRestartInput.fields.idempotencyKey,
      }),
    ]),
  }),
  success: RoboticsJob,
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const RobotList = Tool.make("t3_robotics_robot_list", {
  ...shared,
  description:
    "List configured robots, their last readiness probe state and their liveView stream in this conversation's project. Set robotId to read a single robot.",
  parameters: Schema.Struct({ robotId: Schema.optionalKey(RobotSessionInput.fields.robotId) }),
  success: RobotListResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const RobotSession = Tool.make("t3_robotics_robot_session", {
  ...shared,
  description:
    "Connect to a configured robot or cancel its readiness session. Observe progress with t3_robotics_robot_list.",
  parameters: Schema.Struct({
    robotId: RobotSessionInput.fields.robotId,
    action: Schema.Literals(["connect", "cancel"]),
  }),
  success: RobotSummary,
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const AnnotationRead = Tool.make("t3_robotics_annotation_get", {
  ...shared,
  dependencies: [...shared.dependencies, RoboticsAnnotationService.RoboticsAnnotationService],
  description:
    "Read a saved Rerun annotation by ID in this conversation's project, including its recording version, timeline, and selection.",
  parameters: Schema.Struct({ annotationId: RoboticsAnnotationGetInput.fields.annotationId }),
  success: RoboticsAnnotation,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const RoboticsToolkit = Toolkit.make(
  JobList,
  JobInspect,
  JobManage,
  RobotList,
  RobotSession,
  AnnotationRead,
);
