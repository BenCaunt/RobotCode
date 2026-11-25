import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import * as Stream from "effect/Stream";
import { msg } from "gt-i18n";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createRoboticsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    definitions: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "robotics:job-definitions",
      tag: WS_METHODS.roboticsJobDefinitions,
    }),
    jobs: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "robotics:jobs",
      tag: WS_METHODS.roboticsJobList,
      refreshIntervalMs: 5_000,
    }),
    ensure: createEnvironmentRpcCommand(runtime, {
      label: "robotics:ensure-job",
      tag: WS_METHODS.roboticsJobEnsure,
    }),
    stop: createEnvironmentRpcCommand(runtime, {
      label: "robotics:stop-job",
      tag: WS_METHODS.roboticsJobStop,
    }),
    restart: createEnvironmentRpcCommand(runtime, {
      label: "robotics:restart-job",
      tag: WS_METHODS.roboticsJobRestart,
    }),
    logs: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "robotics:job-logs",
      tag: WS_METHODS.roboticsJobWatchLogs,
      idleTtlMs: 0,
      transform: (stream) =>
        stream.pipe(
          Stream.scan(
            () => ({ output: "", nextAfter: 0, discarded: false }),
            (state, page) => {
              const output =
                state.output +
                page.chunks
                  .filter((chunk) => chunk.sequence > state.nextAfter)
                  .map((chunk) => chunk.text)
                  .join("");
              return {
                output: output.slice(-12_000),
                nextAfter: Math.max(state.nextAfter, page.nextAfter),
                discarded: state.discarded || page.discarded || output.length > 12_000,
              };
            },
          ),
          Stream.drop(1),
        ),
    }),
    robots: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "robotics:robots",
      tag: WS_METHODS.roboticsRobotList,
      refreshIntervalMs: 3_000,
    }),
    connect: createEnvironmentRpcCommand(runtime, {
      label: "robotics:connect",
      tag: WS_METHODS.roboticsRobotConnect,
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "robotics:cancel",
      tag: WS_METHODS.roboticsRobotCancel,
    }),
  };
}

export const roboticsStatusLabels = {
  starting: msg("Starting"),
  running: msg("Running"),
  stopping: msg("Stopping"),
  stopped: msg("Stopped"),
  failed: msg("Failed"),
  unknown: msg("Unknown"),
  disconnected: msg("Disconnected"),
  connecting: msg("Connecting"),
  ready: msg("Ready"),
  degraded: msg("Degraded"),
  blocked: msg("Blocked"),
};

export const robotSessionPhaseLabels = {
  loadingInstructions: msg("Loading setup instructions"),
  settingUp: msg("Setting up"),
  checkingReadiness: msg("Checking readiness"),
  monitoring: msg("Monitoring readiness"),
  cancelled: msg("Canceled"),
};

export const robotSessionReasonLabels = {
  instructionsUnavailable: msg("Setup instructions are unavailable."),
  setupFailed: msg("Setup failed."),
  readinessUnavailable: msg("The readiness probe failed."),
  cancelled: msg("Session canceled."),
};
