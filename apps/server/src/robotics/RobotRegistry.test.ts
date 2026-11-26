// The loopback fixture records paths sent by the production HTTP client.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import { FetchHttpClient } from "effect/http";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ProcessLauncher from "../process/ProcessLauncher.ts";
import * as ManagedJobs from "./managedJobs.ts";
import * as RobotRegistry from "./RobotRegistry.ts";
import * as RobotSetup from "./RobotSetup.ts";

const input = { projectId: ProjectId.make("robotics-project"), robotId: "kiwi-01" };
const registration = {
  ...input,
  displayName: "Kiwi-01",
  knownHosts: ["kiwi-bridge.local"],
  initPath: "kiwi/init.md",
};
const robot = {
  ...registration,
  readiness: { url: "http://kiwi-bridge.local/ready", expectedText: "kiwi-01-ready" },
};
const instructions = "Reconcile the Kiwi telemetry bridge.";

const writeRegistry = Effect.fn("writeRegistry")(function* (registrations: unknown = [robot]) {
  const server = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(server.stateDir, "robotics");
  yield* fs.makeDirectory(path.join(directory, "kiwi"), { recursive: true });
  yield* fs.writeFileString(
    path.join(directory, "registrations.json"),
    JSON.stringify({ version: 1, robots: registrations }),
  );
  yield* fs.writeFileString(path.join(directory, "kiwi", "init.md"), instructions);
  return directory;
});

const configLayer = Layer.provideMerge(
  ServerConfig.layerTest(process.cwd(), { prefix: "robot-registry-" }),
  Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, FetchHttpClient.layer),
);

const loopback = Effect.fn("loopback")(function* (handler: NodeHttp.RequestListener) {
  const server = yield* Effect.acquireRelease(
    Effect.callback<NodeHttp.Server, Error>((resume) => {
      const listening = NodeHttp.createServer(handler);
      listening.once("error", (error) => resume(Effect.fail(error)));
      listening.listen(0, "127.0.0.1", () => resume(Effect.succeed(listening)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    return yield* Effect.die("Expected a loopback readiness endpoint.");
  }
  return `http://127.0.0.1:${address.port}`;
});

it.effect("monitors an adapter probe through connectivity loss without HTTP configuration", () =>
  Effect.gen(function* () {
    const enterSetup = yield* Deferred.make<string | null>();
    const finishSetup = yield* Deferred.make<void>();
    const setupCalls = yield* Ref.make(0);
    const reachable = yield* Ref.make(true);
    const setup = Layer.succeed(
      RobotSetup.RobotSetup,
      RobotSetup.RobotSetup.of({
        setup: (request) =>
          Ref.update(setupCalls, (calls) => calls + 1).pipe(
            Effect.andThen(Deferred.succeed(enterSetup, request.instructions)),
            Effect.andThen(Deferred.await(finishSetup)),
          ),
        probe: () => Ref.get(reachable),
      }),
    );
    const registryLayer = RobotRegistry.layerWithSetup.pipe(Layer.provide(setup));
    yield* Effect.gen(function* () {
      yield* writeRegistry([registration]);
      const registry = yield* RobotRegistry.RobotRegistry;

      const [first, second] = yield* Effect.all(
        [registry.connect(input), registry.connect(input)],
        {
          concurrency: "unbounded",
        },
      );
      expect(first.session?.sessionId).toBe(second.session?.sessionId);
      expect(first.session?.state).toBe("connecting");
      expect(yield* Deferred.await(enterSetup)).toBe(instructions);
      expect(yield* Ref.get(setupCalls)).toBe(1);
      expect(yield* registry.list({ projectId: ProjectId.make("unrelated") })).toEqual([]);
      const forbidden = yield* Effect.flip(
        registry.inspect({ ...input, projectId: ProjectId.make("unrelated") }),
      );
      expect(forbidden.reason).toBe("robotNotFound");

      yield* Deferred.succeed(finishSetup, undefined);
      yield* TestClock.adjust("0 seconds");
      const ready = yield* registry.inspect(input);
      expect(ready.session?.state).toBe("ready");
      expect(ready.session?.lastReadyAt).toBeTruthy();
      expect((yield* registry.connect(input)).session?.sessionId).toBe(first.session?.sessionId);

      yield* Ref.set(reachable, false);
      yield* TestClock.adjust("5 seconds");
      const degraded = yield* registry.inspect(input);
      expect(degraded.session?.state).toBe("degraded");
      expect(degraded.session?.reason).toBe("readinessUnavailable");
      expect(degraded.session?.lastReadyAt).toBe(ready.session?.lastReadyAt);
      expect((yield* registry.connect(input)).session?.sessionId).toBe(first.session?.sessionId);

      yield* Ref.set(reachable, true);
      yield* TestClock.adjust("5 seconds");
      expect((yield* registry.inspect(input)).session?.state).toBe("ready");
      expect(yield* Ref.get(setupCalls)).toBe(1);
    }).pipe(Effect.provide(registryLayer));
  }).pipe(Effect.provide(configLayer)),
);

it.effect("keeps a session without a probe unverified until cancelled", () =>
  Effect.gen(function* () {
    yield* writeRegistry([{ ...input, displayName: "Direct DDS target", knownHosts: [] }]);
    const registry = yield* RobotRegistry.RobotRegistry;
    const first = yield* registry.connect(input);
    yield* TestClock.adjust("0 seconds");
    const { session } = yield* registry.inspect(input);
    expect(session).toMatchObject({
      sessionId: first.session?.sessionId,
      state: "unverified",
      phase: "setupComplete",
      reason: null,
      lastReadyAt: null,
    });
    yield* TestClock.adjust("30 seconds");
    expect((yield* registry.connect(input)).session).toEqual(session);
    expect((yield* registry.cancel(input)).session?.state).toBe("disconnected");
    expect((yield* registry.connect(input)).session?.sessionId).not.toBe(session?.sessionId);
  }).pipe(Effect.provide(RobotRegistry.layer.pipe(Layer.provideMerge(configLayer)))),
);

it.effect("lists a registered live view beside a robot without one", () =>
  Effect.gen(function* () {
    const liveView = { url: "rerun+http://127.0.0.1:9876/proxy" };
    yield* writeRegistry([
      { ...registration, liveView },
      { ...registration, robotId: "kiwi-02" },
    ]);
    const registry = yield* RobotRegistry.RobotRegistry;
    const robots = yield* registry.list(input);
    expect(robots.map((entry) => entry.liveView)).toEqual([liveView, undefined]);
  }).pipe(Effect.provide(RobotRegistry.layer.pipe(Layer.provideMerge(configLayer)))),
);

it.effect("applies registration edits without a restart and ends a removed robot's session", () =>
  Effect.gen(function* () {
    yield* writeRegistry([registration]);
    const registry = yield* RobotRegistry.RobotRegistry;
    expect((yield* registry.connect(input)).session).not.toBeNull();

    const added = { ...registration, robotId: "kiwi-02" };
    yield* writeRegistry([registration, added]);
    expect((yield* registry.list(input)).map((entry) => entry.robotId)).toEqual([
      "kiwi-01",
      "kiwi-02",
    ]);
    expect((yield* registry.inspect(input)).session).not.toBeNull();

    yield* writeRegistry([added]);
    expect((yield* registry.list(input)).map((entry) => entry.robotId)).toEqual(["kiwi-02"]);

    yield* writeRegistry([registration, added]);
    expect((yield* registry.inspect(input)).session).toBeNull();
  }).pipe(Effect.provide(RobotRegistry.layer), Effect.provide(configLayer)),
);

it.effect("rejects a live view that is not a Rerun stream URL", () =>
  Effect.gen(function* () {
    yield* writeRegistry([{ ...registration, liveView: { url: "http://127.0.0.1:9090" } }]);
    const registry = yield* RobotRegistry.RobotRegistry;
    expect((yield* Effect.flip(registry.list(input))).reason).toBe("invalidRegistry");
  }).pipe(Effect.provide(RobotRegistry.layer.pipe(Layer.provideMerge(configLayer)))),
);

it.effect.each(
  Object.entries({
    "an incomplete HTTP check": { url: robot.readiness.url },
    "an adapter outside the installation directory": { adapter: "../go2-ready" },
    "both an HTTP check and an adapter": { ...robot.readiness, adapter: "go2-ready" },
  }),
)("rejects %s on an otherwise valid registration", ([, readiness]) =>
  Effect.gen(function* () {
    yield* writeRegistry([{ ...registration, readiness }]);
    const registry = yield* RobotRegistry.RobotRegistry;
    expect((yield* Effect.flip(registry.list(input))).reason).toBe("invalidRegistry");
  }).pipe(Effect.provide(RobotRegistry.layer.pipe(Layer.provideMerge(configLayer)))),
);

it.effect("interrupts in-flight setup before a new connection may reuse the robot", () =>
  Effect.gen(function* () {
    const setupStarted = yield* Deferred.make<void>();
    const setupCancelled = yield* Deferred.make<void>();
    const setup = Layer.succeed(
      RobotSetup.RobotSetup,
      RobotSetup.RobotSetup.of({
        setup: () =>
          Deferred.succeed(setupStarted, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(setupCancelled, undefined)),
          ),
        probe: () => Effect.die("The readiness probe ran before setup completed."),
      }),
    );
    const registryLayer = RobotRegistry.layerWithSetup.pipe(Layer.provide(setup));
    yield* Effect.gen(function* () {
      yield* writeRegistry();
      const registry = yield* RobotRegistry.RobotRegistry;
      const first = yield* registry.connect(input);
      yield* Deferred.await(setupStarted);
      const cancelled = yield* registry.cancel(input);
      expect(yield* Deferred.isDone(setupCancelled)).toBe(true);
      expect(cancelled.session).toMatchObject({
        sessionId: first.session?.sessionId,
        state: "disconnected",
        reason: "cancelled",
      });
      const second = yield* registry.connect(input);
      expect(second.session?.sessionId).not.toBe(first.session?.sessionId);
    }).pipe(Effect.provide(registryLayer));
  }).pipe(Effect.provide(configLayer)),
);

it.effect("rejects ambiguous robot identities before loading any session", () =>
  Effect.gen(function* () {
    yield* writeRegistry([robot, { ...robot, projectId: "second-project" }]);
    const registry = yield* RobotRegistry.RobotRegistry;
    const invalid = yield* Effect.flip(registry.list({ projectId: input.projectId }));
    expect(invalid.reason).toBe("invalidRegistry");
  }).pipe(Effect.provide(RobotRegistry.layer.pipe(Layer.provideMerge(configLayer)))),
);

it.live("requires the registered readiness marker and rejects redirects and oversized bodies", () =>
  Effect.gen(function* () {
    const reached: Array<string | undefined> = [];
    const origin = yield* loopback((request, response) => {
      reached.push(request.url);
      switch (request.url) {
        case "/wrong-marker":
          response.end("other-robot-ready");
          break;
        case "/oversized":
          response.end("kiwi-01-ready" + " ".repeat(4096));
          break;
        case "/redirect":
          response.writeHead(302, { location: "/ready" }).end();
          break;
        default:
          response.end("kiwi-01-ready\n");
      }
    });
    const setup = yield* RobotSetup.RobotSetup;
    const probe = (route: string) =>
      setup.probe({
        ...robot,
        readiness: {
          url: new URL(route, origin),
          expectedText: robot.readiness.expectedText,
        },
      });
    expect(yield* probe("/ready")).toBe(true);
    expect(yield* probe("/wrong-marker")).toBe(false);
    expect(yield* probe("/oversized")).toBe(false);
    const redirect = yield* Effect.flip(probe("/redirect"));
    expect(redirect._tag).toBe("RobotSetupError");
    expect(reached).toEqual(["/ready", "/wrong-marker", "/oversized", "/redirect"]);
  }).pipe(Effect.scoped, Effect.provide(RobotSetup.layer.pipe(Layer.provide(configLayer)))),
);

it.live("runs a named readiness adapter with the registered target and uses its exit status", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    const directory = yield* writeRegistry();
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const adapters = path.join(directory, "adapters");
    yield* fs.makeDirectory(adapters);
    const executable = path.join(adapters, "dds-fresh");
    yield* fs.writeFileString(
      executable,
      '#!/bin/sh\n[ "$#" = 2 ] && [ "$1" = robotics-project ] && [ "$2" = kiwi-01 ]\n',
    );
    yield* fs.chmod(executable, 0o700);
    const setup = yield* RobotSetup.RobotSetup;
    const target = { ...registration, readiness: { adapter: "dds-fresh" } };
    expect(yield* setup.probe(target)).toBe(true);
    expect(yield* setup.probe({ ...target, robotId: "other" })).toBe(false);
    yield* fs.remove(executable);
    expect((yield* Effect.flip(setup.probe(target)))._tag).toBe("RobotSetupError");
  }).pipe(Effect.provide(RobotSetup.layer.pipe(Layer.provideMerge(configLayer)))),
);

it.live("reuses the same managed bridge on repeated robot connections", () =>
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    if (platform !== "linux" && platform !== "darwin") return;

    const probeSeen = Promise.withResolvers<void>();
    const origin = yield* loopback((_request, response) => {
      response.end(robot.readiness.expectedText);
      probeSeen.resolve();
    });
    const definitionId = "kiwi-bridge";
    const directory = yield* writeRegistry([
      {
        ...robot,
        bridgeDefinitions: [definitionId],
        readiness: { ...robot.readiness, url: `${origin}/ready` },
      },
    ]);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const executable = yield* HostProcess.ExecutablePath;
    const policyPath = path.join(directory, "jobs.json");
    yield* fs.writeFileString(
      policyPath,
      JSON.stringify({
        version: 1,
        jobs: [
          {
            ...input,
            definitionId,
            label: "Kiwi telemetry bridge",
            kind: "non-actuating",
            cwd: directory,
            command: executable,
            args: ["-e", "setInterval(() => {}, 60000)"],
          },
        ],
      }),
    );
    const jobsLayer = ManagedJobs.layer.pipe(Layer.provide(ProcessLauncher.layerServer));
    const registryLayer = RobotRegistry.layerManaged.pipe(Layer.provideMerge(jobsLayer));
    yield* Effect.gen(function* () {
      const registry = yield* RobotRegistry.RobotRegistry;
      const jobs = yield* ManagedJobs.ManagedJobs;
      const bridge = yield* jobs.ensure({
        projectId: input.projectId,
        definitionId,
        idempotencyKey: "already-running-bridge",
      });
      const [first, second] = yield* Effect.all(
        [registry.connect(input), registry.connect(input)],
        {
          concurrency: "unbounded",
        },
      );
      expect(first.session?.sessionId).toBe(second.session?.sessionId);
      yield* Effect.promise(() => probeSeen.promise);

      const running = yield* jobs.list({ projectId: input.projectId });
      expect(running.jobs.map((job) => job.jobId)).toEqual([bridge.jobId]);
      yield* registry.cancel(input);
      expect((yield* jobs.inspect(bridge)).state).toBe("running");
    }).pipe(
      Effect.provide(registryLayer),
      Effect.provideService(HostProcess.Environment, { ROBOTCODE_MANAGED_JOBS_FILE: policyPath }),
    );
  }).pipe(Effect.scoped, Effect.provide(configLayer)),
);
