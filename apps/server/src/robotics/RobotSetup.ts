import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient } from "effect/http";

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
    readonly probe: (registration: RobotRegistration) => Effect.Effect<boolean, RobotSetupError>;
  }
>()("t3/robotics/RobotSetup") {}

const MAX_PROBE_BYTES = 4096;

const makeProbe = (http: HttpClient.HttpClient): RobotSetup["Service"]["probe"] => {
  const scoped = HttpClient.withScope(http);
  return Effect.fn("RobotSetup.probe")(
    function* ({ readiness }) {
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
};

const probeOnlySetup: RobotSetup["Service"]["setup"] = Effect.fn("RobotSetup.probeOnlySetup")(
  function* ({ registration }) {
    if (registration.bridgeDefinitions?.length) {
      return yield* new RobotSetupError({ cause: "This environment has no managed job adapter." });
    }
  },
);

const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  return RobotSetup.of({ setup: probeOnlySetup, probe: makeProbe(http) });
});

export const layer = Layer.effect(RobotSetup, make);

const makeManaged = Effect.gen(function* () {
  const jobs = yield* ManagedJobs.ManagedJobs;
  const http = yield* HttpClient.HttpClient;

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

  return RobotSetup.of({ setup, probe: makeProbe(http) });
});

export const layerManaged = Layer.effect(RobotSetup, makeManaged);
