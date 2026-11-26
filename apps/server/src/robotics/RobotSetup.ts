import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ManagedJobs from "./managedJobs.ts";
import type { RobotRegistration } from "./robotRegistryConfig.ts";

export class RobotSetupError extends Schema.TaggedError<
  RobotSetupError,
  { readonly brand: unique symbol }
>()("RobotSetupError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "The robot setup adapter failed.";
  }
}

export class RobotSetup extends Context.Service<
  RobotSetup,
  {
    // Setup adapters reconcile existing services before starting new ones. The registry
    // independently verifies readiness and never grants actuator authority.
    readonly setup: (input: {
      readonly registration: RobotRegistration;
      readonly sessionId: string;
      readonly instructions: string | null;
    }) => Effect.Effect<void, RobotSetupError>;
    // Unconfigured ends monitoring. Return false for missing or stale evidence so checks continue.
    readonly probe: (
      registration: RobotRegistration,
    ) => Effect.Effect<boolean | "unconfigured", RobotSetupError>;
  }
>()("t3/robotics/RobotSetup") {}

const MAX_PROBE_BYTES = 4096;

const makeProbe = Effect.gen(function* () {
  const scoped = HttpClient.withScope(yield* HttpClient.HttpClient);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const directory = path.resolve(stateDir, "robotics", "adapters");
  return Effect.fn("RobotSetup.probe")(
    function* ({ readiness, projectId, robotId }: RobotRegistration) {
      if (!readiness) return "unconfigured" as const;
      if ("adapter" in readiness) {
        const command = ChildProcess.make(
          path.join(directory, readiness.adapter),
          [projectId, robotId],
          {
            cwd: directory,
            env: {},
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            forceKillAfter: "1 second",
          },
        );
        return (yield* spawner.exitCode(command)) === 0;
      }
      const response = yield* scoped
        .get(readiness.url.href)
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
          Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        );
      if (response.status < 200 || response.status >= 300) return false;

      const decoder = new TextDecoder();
      let read = 0;
      const text = yield* response.stream.pipe(
        Stream.takeWhile((chunk) => {
          read += chunk.byteLength;
          return read <= MAX_PROBE_BYTES;
        }),
        Stream.runFold(
          () => "",
          (text, chunk) => text + decoder.decode(chunk, { stream: true }),
        ),
      );
      return read <= MAX_PROBE_BYTES && (text + decoder.decode()).trim() === readiness.expectedText;
    },
    Effect.mapError((cause) => new RobotSetupError({ cause })),
    Effect.scoped,
  );
});

const probeOnlySetup: RobotSetup["Service"]["setup"] = Effect.fn("RobotSetup.probeOnlySetup")(
  function* ({ registration }) {
    if (registration.bridgeDefinitions?.length) {
      return yield* new RobotSetupError({ cause: "This environment has no managed job adapter." });
    }
  },
);

const make = Effect.gen(function* () {
  const probe = yield* makeProbe;
  return RobotSetup.of({ setup: probeOnlySetup, probe });
});

export const layer = Layer.effect(RobotSetup, make);

const makeManaged = Effect.gen(function* () {
  const jobs = yield* ManagedJobs.ManagedJobs;
  const probe = yield* makeProbe;

  const setup: RobotSetup["Service"]["setup"] = Effect.fn("RobotSetup.ensureBridges")(function* ({
    registration,
    sessionId,
  }) {
    for (const [index, definitionId] of (registration.bridgeDefinitions ?? []).entries()) {
      const job = yield* jobs
        .ensure(
          {
            projectId: registration.projectId,
            definitionId,
            idempotencyKey: `robot-session:${sessionId}:${index}`,
          },
          registration.robotId,
        )
        .pipe(Effect.mapError((cause) => new RobotSetupError({ cause })));
      if (job.state !== "running" && job.state !== "starting") {
        return yield* new RobotSetupError({ cause: "The managed bridge is not running." });
      }
    }
  });

  return RobotSetup.of({ setup, probe });
});

export const layerManaged = Layer.effect(RobotSetup, makeManaged);
