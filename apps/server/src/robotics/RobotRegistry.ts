import {
  isActiveRobotSession,
  RobotRegistryErrorReason,
  type RobotListInput,
  type RobotSessionInput,
  type RobotSessionSnapshot,
  type RobotSummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as ServerConfig from "../config.ts";
import * as RobotSetup from "./RobotSetup.ts";
import { decodeRobotRegistry, type RobotRegistration } from "./robotRegistryConfig.ts";

export class RobotRegistryError extends Schema.TaggedError<
  RobotRegistryError,
  { readonly brand: unique symbol }
>()("RobotRegistryError", {
  reason: RobotRegistryErrorReason,
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "invalidRegistry":
        return "The robot registrations file is invalid.";
      case "registryUnavailable":
        return "The robot registrations file could not be read.";
      case "robotNotFound":
        return "This robot is not registered to the project.";
    }
  }
}

export class RobotRegistry extends Context.Service<
  RobotRegistry,
  {
    readonly list: (
      input: RobotListInput,
    ) => Effect.Effect<ReadonlyArray<RobotSummary>, RobotRegistryError>;
    readonly inspect: (input: RobotSessionInput) => Effect.Effect<RobotSummary, RobotRegistryError>;
    readonly connect: (input: RobotSessionInput) => Effect.Effect<RobotSummary, RobotRegistryError>;
    readonly cancel: (input: RobotSessionInput) => Effect.Effect<RobotSummary, RobotRegistryError>;
  }
>()("t3/robotics/RobotRegistry") {}

interface ActiveSession {
  snapshot: RobotSessionSnapshot;
  fiber: Fiber.Fiber<void, never> | null;
}

const CONFIG_LIMIT = 256 * 1024;
const INSTRUCTIONS_LIMIT = 64 * 1024;
const HTTP_PROBE_TIMEOUT = "3 seconds";
const ADAPTER_PROBE_TIMEOUT = "15 seconds";
const PROBE_INTERVAL = "5 seconds";
const SETUP_TIMEOUT = "60 seconds";
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const setup = yield* RobotSetup.RobotSetup;
  const scope = yield* Scope.Scope;
  const random = yield* SecureRandom.SecureRandom;
  const sessions = new Map<string, ActiveSession>();
  const connectionLocks = new Map<string, Semaphore.Semaphore>();
  const directory = path.join(config.stateDir, "robotics");

  const connectionLock = (robotId: string) => {
    const existing = connectionLocks.get(robotId);
    if (existing) return existing;
    const lock = Semaphore.makeUnsafe(1);
    connectionLocks.set(robotId, lock);
    return lock;
  };

  const readText = Effect.fn("RobotRegistry.readText")(function* (
    filePath: string,
    maxBytes: number,
  ) {
    const stats = yield* fileSystem.stat(filePath);
    if (stats.type !== "File" || stats.size > BigInt(maxBytes)) {
      return yield* new RobotRegistryError({ reason: "invalidRegistry" });
    }
    const chunks = yield* Stream.runCollect(
      fileSystem.stream(filePath, { bytesToRead: maxBytes + 1 }),
    );
    if (chunks.reduce((total, chunk) => total + chunk.byteLength, 0) > maxBytes) {
      return yield* new RobotRegistryError({ reason: "invalidRegistry" });
    }
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return yield* Effect.try({
      try: () =>
        chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") + decoder.decode(),
      catch: (cause) => new RobotRegistryError({ reason: "invalidRegistry", cause }),
    });
  });

  const loadRegistrations = Effect.fn("RobotRegistry.loadRegistrations")(function* () {
    const raw = yield* readText(path.join(directory, "registrations.json"), CONFIG_LIMIT).pipe(
      Effect.asSome,
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : Effect.fail(new RobotRegistryError({ reason: "registryUnavailable", cause })),
      }),
    );
    if (Option.isNone(raw)) return [];

    const document = yield* decodeRobotRegistry(raw.value).pipe(
      Effect.mapError((cause) => new RobotRegistryError({ reason: "invalidRegistry", cause })),
    );
    return document.robots;
  });
  // Read on every call so an edited file applies without a server restart.
  const registrations = Effect.tap(loadRegistrations(), (robots) =>
    Effect.forEach(
      [...sessions].filter(([robotId]) => !robots.some((robot) => robot.robotId === robotId)),
      ([robotId, active]) =>
        Effect.gen(function* () {
          sessions.delete(robotId);
          connectionLocks.delete(robotId);
          if (active.fiber) yield* Fiber.interrupt(active.fiber);
        }),
      { discard: true },
    ),
  );

  const findRobot = Effect.fn("RobotRegistry.findRobot")(function* (input: RobotSessionInput) {
    const robots = yield* registrations;
    const robot = robots.find(
      (entry) => entry.robotId === input.robotId && entry.projectId === input.projectId,
    );
    if (!robot) return yield* new RobotRegistryError({ reason: "robotNotFound" });
    return robot;
  });

  const summarize = (robot: RobotRegistration): RobotSummary => ({
    robotId: robot.robotId,
    projectId: robot.projectId,
    displayName: robot.displayName,
    knownHosts: robot.knownHosts,
    initPath: robot.initPath ?? null,
    ...(robot.liveView ? { liveView: robot.liveView } : {}),
    session: sessions.get(robot.robotId)?.snapshot ?? null,
  });

  const readInstructions = Effect.fn("RobotRegistry.readInstructions")(function* (
    robot: RobotRegistration,
  ) {
    if (!robot.initPath) return null;
    const root = yield* fileSystem.realPath(directory);
    const target = yield* fileSystem.realPath(path.join(root, robot.initPath));
    const relative = path.relative(root, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return yield* new RobotRegistryError({ reason: "invalidRegistry" });
    }
    return yield* readText(target, INSTRUCTIONS_LIMIT);
  });

  const update = Effect.fn("RobotRegistry.update")(function* (
    active: ActiveSession,
    patch: Partial<Pick<RobotSessionSnapshot, "state" | "phase" | "reason">>,
    ready = false,
  ) {
    const updatedAt = yield* nowIso;
    if (active.snapshot.state === "disconnected") return;
    active.snapshot = {
      ...active.snapshot,
      ...patch,
      updatedAt,
      lastReadyAt: ready ? updatedAt : active.snapshot.lastReadyAt,
    };
  });

  const verify = Effect.fn("RobotRegistry.verify")(function* (
    active: ActiveSession,
    robot: RobotRegistration,
  ) {
    const ready = yield* setup
      .probe(robot)
      .pipe(
        Effect.timeoutOption(
          robot.readiness && "adapter" in robot.readiness
            ? ADAPTER_PROBE_TIMEOUT
            : HTTP_PROBE_TIMEOUT,
        ),
        Effect.map(Option.getOrElse(() => false)),
        Effect.catchTags({ RobotSetupError: () => Effect.succeed(false) }),
      );
    if (ready === "unconfigured") {
      yield* update(active, { state: "unverified", phase: "setupComplete", reason: null });
      return false;
    }
    yield* update(
      active,
      {
        state: ready ? "ready" : "degraded",
        phase: "monitoring",
        reason: ready ? null : "readinessUnavailable",
      },
      ready,
    );
    return true;
  });

  const runSession = Effect.fn("RobotRegistry.runSession")(
    function* (active: ActiveSession, robot: RobotRegistration) {
      const instructions = yield* Effect.option(readInstructions(robot));
      if (Option.isNone(instructions)) {
        yield* update(active, { state: "blocked", reason: "instructionsUnavailable" });
        return;
      }
      yield* update(active, { phase: "settingUp" });
      const started = yield* setup
        .setup({
          registration: robot,
          sessionId: active.snapshot.sessionId,
          instructions: instructions.value,
        })
        .pipe(
          Effect.timeoutOption(SETUP_TIMEOUT),
          Effect.catchTags({ RobotSetupError: () => Effect.succeed(Option.none<void>()) }),
        );
      if (Option.isNone(started)) {
        yield* update(active, { state: "blocked", reason: "setupFailed" });
        return;
      }

      yield* update(active, { phase: "checkingReadiness" });
      yield* verify(active, robot).pipe(
        Effect.repeat({ schedule: Schedule.spaced(PROBE_INTERVAL), while: (monitor) => monitor }),
      );
    },
    (effect, active) =>
      effect.pipe(
        Effect.catchDefect(() => update(active, { state: "blocked", reason: "setupFailed" })),
      ),
  );

  const list: RobotRegistry["Service"]["list"] = Effect.fn("RobotRegistry.list")(function* ({
    projectId,
  }) {
    const robots = yield* registrations;
    return robots.filter((robot) => robot.projectId === projectId).map(summarize);
  });

  const inspect: RobotRegistry["Service"]["inspect"] = Effect.fn("RobotRegistry.inspect")(
    function* (input) {
      return summarize(yield* findRobot(input));
    },
  );

  const connect: RobotRegistry["Service"]["connect"] = Effect.fn("RobotRegistry.connect")(
    function* (input) {
      const robot = yield* findRobot(input);
      return yield* Effect.gen(function* () {
        const existing = sessions.get(robot.robotId);
        if (existing && isActiveRobotSession(existing.snapshot)) {
          return summarize(robot);
        }

        const startedAt = yield* nowIso;
        const active: ActiveSession = {
          snapshot: {
            sessionId: yield* random.uuidV4().pipe(Effect.orDie),
            state: "connecting",
            phase: "loadingInstructions",
            reason: null,
            startedAt,
            updatedAt: startedAt,
            lastReadyAt: null,
          },
          fiber: null,
        };
        sessions.set(robot.robotId, active);
        active.fiber = yield* runSession(active, robot).pipe(Effect.forkIn(scope));
        return summarize(robot);
      }).pipe(Effect.uninterruptible, connectionLock(robot.robotId).withPermits(1));
    },
  );

  const cancel: RobotRegistry["Service"]["cancel"] = Effect.fn("RobotRegistry.cancel")(
    function* (input) {
      const robot = yield* findRobot(input);
      return yield* Effect.gen(function* () {
        const active = sessions.get(robot.robotId);
        if (active?.fiber && active.snapshot.state !== "disconnected") {
          yield* update(active, { state: "disconnected", phase: "cancelled", reason: "cancelled" });
          yield* Fiber.interrupt(active.fiber);
          active.fiber = null;
        }
        return summarize(robot);
      }).pipe(Effect.uninterruptible, connectionLock(robot.robotId).withPermits(1));
    },
  );

  return RobotRegistry.of({ list, inspect, connect, cancel });
});

export const layerWithSetup = Layer.effect(RobotRegistry, make);
export const layer = layerWithSetup.pipe(Layer.provide(RobotSetup.layer));
export const layerManaged = layerWithSetup.pipe(Layer.provide(RobotSetup.layerManaged));
