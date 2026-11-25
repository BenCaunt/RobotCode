import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  RoboticsJob,
  RoboticsJobDefinitions,
  RoboticsJobEnsureInput,
  RoboticsJobError,
  RoboticsJobInput,
  RoboticsJobList,
  RoboticsJobListInput,
  RoboticsJobLogs,
  RoboticsJobLogsInput,
  RoboticsJobProjectInput,
  RoboticsJobRestartInput,
} from "./roboticsJobs.ts";
import {
  RobotListInput,
  RobotRegistryRpcError,
  RobotSessionInput,
  RobotSummary,
} from "./robotRegistry.ts";

import {
  RoboticsAnnotation,
  RoboticsAnnotationCreateInput,
  RoboticsAnnotationGetInput,
  RoboticsAnnotationList,
  RoboticsAnnotationListInput,
  RoboticsAnnotationRpcError,
} from "./roboticsAnnotation.ts";

export const ROBOTICS_WS_METHODS = {
  roboticsJobDefinitions: "robotics.job.definitions",
  roboticsJobList: "robotics.job.list",
  roboticsJobInspect: "robotics.job.inspect",
  roboticsJobEnsure: "robotics.job.ensure",
  roboticsJobStart: "robotics.job.start",
  roboticsJobStop: "robotics.job.stop",
  roboticsJobRestart: "robotics.job.restart",
  roboticsJobLogs: "robotics.job.logs",
  roboticsJobWatchLogs: "robotics.job.watchLogs",
  roboticsAnnotationCreate: "robotics.annotation.create",
  roboticsAnnotationGet: "robotics.annotation.get",
  roboticsAnnotationList: "robotics.annotation.list",
  roboticsRobotList: "robotics.robot.list",
  roboticsRobotInspect: "robotics.robot.inspect",
  roboticsRobotConnect: "robotics.robot.connect",
  roboticsRobotCancel: "robotics.robot.cancel",
} as const;

const jobError = Schema.Union([RoboticsJobError, EnvironmentAuthorizationError]);
const annotationError = Schema.Union([RoboticsAnnotationRpcError, EnvironmentAuthorizationError]);
const robotError = Schema.Union([RobotRegistryRpcError, EnvironmentAuthorizationError]);

export const roboticsRpcs = [
  Rpc.make(ROBOTICS_WS_METHODS.roboticsJobDefinitions, {
    payload: RoboticsJobProjectInput,
    success: RoboticsJobDefinitions,
    error: jobError,
  }),
  Rpc.make(ROBOTICS_WS_METHODS.roboticsJobList, {
    payload: RoboticsJobListInput,
    success: RoboticsJobList,
    error: jobError,
  }),
  Rpc.make(ROBOTICS_WS_METHODS.roboticsJobInspect, {
    payload: RoboticsJobInput,
    success: RoboticsJob,
    error: jobError,
  }),
  Rpc.make(ROBOTICS_WS_METHODS.roboticsJobEnsure, {
    payload: RoboticsJobEnsureInput,
    success: RoboticsJob,
    error: jobError,
  }),
  Rpc.make(ROBOTICS_WS_METHODS.roboticsJobStart, {
    payload: RoboticsJobEnsureInput,
    success: RoboticsJob,
    error: jobError,
  }),
  Rpc.make(ROBOTICS_WS_METHODS.roboticsJobStop, {
    payload: RoboticsJobInput,
    success: RoboticsJob,
    error: jobError,
  }),
  Rpc.make(ROBOTICS_WS_METHODS.roboticsJobRestart, {
    payload: RoboticsJobRestartInput,
    success: RoboticsJob,
    error: jobError,
  }),
  Rpc.make(ROBOTICS_WS_METHODS.roboticsJobLogs, {
    payload: RoboticsJobLogsInput,
    success: RoboticsJobLogs,
    error: jobError,
  }),
  Rpc.make(ROBOTICS_WS_METHODS.roboticsJobWatchLogs, {
    payload: RoboticsJobLogsInput,
    success: RoboticsJobLogs,
    error: jobError,
    stream: true,
  }),
  Rpc.make(ROBOTICS_WS_METHODS.roboticsAnnotationCreate, {
    payload: RoboticsAnnotationCreateInput,
    success: RoboticsAnnotation,
    error: annotationError,
  }),
  Rpc.make(ROBOTICS_WS_METHODS.roboticsAnnotationGet, {
    payload: RoboticsAnnotationGetInput,
    success: RoboticsAnnotation,
    error: annotationError,
  }),
  Rpc.make(ROBOTICS_WS_METHODS.roboticsAnnotationList, {
    payload: RoboticsAnnotationListInput,
    success: RoboticsAnnotationList,
    error: annotationError,
  }),
  Rpc.make(ROBOTICS_WS_METHODS.roboticsRobotList, {
    payload: RobotListInput,
    success: Schema.Array(RobotSummary),
    error: robotError,
  }),
  Rpc.make(ROBOTICS_WS_METHODS.roboticsRobotInspect, {
    payload: RobotSessionInput,
    success: RobotSummary,
    error: robotError,
  }),
  Rpc.make(ROBOTICS_WS_METHODS.roboticsRobotConnect, {
    payload: RobotSessionInput,
    success: RobotSummary,
    error: robotError,
  }),
  Rpc.make(ROBOTICS_WS_METHODS.roboticsRobotCancel, {
    payload: RobotSessionInput,
    success: RobotSummary,
    error: robotError,
  }),
] as const;
