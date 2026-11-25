import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  RoboticsJobError,
  ThreadId,
  type RoboticsJobEnsureInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedJobs from "../../../robotics/managedJobs.ts";
import * as RobotRegistry from "../../../robotics/RobotRegistry.ts";
import * as RoboticsAnnotationService from "../../../robotics/RoboticsAnnotationService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as RoboticsHandlers from "./handlers.ts";
import { RoboticsToolkit } from "./tools.ts";

it.effect.each([
  { runtimeMode: "full-access", code: "invalid_request" },
  { runtimeMode: "approval-required", code: "capability_denied" },
] as const)(
  "binds process management to the active conversation in $runtimeMode mode",
  (scenario) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:robotics");
      const caller = liveThreadShell(threadId, { runtimeMode: scenario.runtimeMode });
      const requests: RoboticsJobEnsureInput[] = [];
      const dependencies = Layer.mergeAll(
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("environment:robotics"),
          requestNamespace: "provider:robotics",
          thread: {
            threadId,
            providerSessionId: "provider:robotics",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(caller),
        }),
        Layer.mock(ManagedJobs.ManagedJobs)({
          ensure: (input) =>
            Effect.sync(() => {
              requests.push(input);
            }).pipe(
              Effect.andThen(Effect.fail(new RoboticsJobError({ reason: "definition-not-found" }))),
            ),
        }),
        Layer.mock(RobotRegistry.RobotRegistry)({}),
        Layer.mock(RoboticsAnnotationService.RoboticsAnnotationService)({}),
      );
      const result = yield* Effect.gen(function* () {
        const toolkit = yield* RoboticsToolkit;
        return yield* toolkit
          .handle("t3_robotics_job_manage", {
            action: { type: "ensure", definitionId: "bridge", idempotencyKey: "request" },
          })
          .pipe(Stream.unwrap, Stream.runCollect);
      }).pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(RoboticsHandlers.layer).pipe(
            Layer.provideMerge(dependencies),
          ),
        ),
      );
      expect(result.at(-1)?.result).toMatchObject({ code: scenario.code });
      expect(requests).toEqual(
        scenario.runtimeMode === "full-access"
          ? [
              {
                projectId: caller.projectId,
                threadId,
                definitionId: "bridge",
                idempotencyKey: "request",
              },
            ]
          : [],
      );
    }),
);
