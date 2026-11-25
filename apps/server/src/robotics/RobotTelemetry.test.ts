import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as TestClock from "effect/testing/TestClock";

import RobotTelemetryEventsMigration from "../persistence/Migrations/115_RobotTelemetryEvents.ts";
import * as RobotTelemetry from "./RobotTelemetry.ts";
import * as RobotTelemetryHooks from "./RobotTelemetryHooks.ts";

const stream = {
  projectId: "navigation",
  streamId: "localization",
  sourceId: "sim-worker",
  schemaId: "localization@1",
  clockDomain: "sim-ms",
  coordinateFrame: "map",
  expectedHz: 10,
  staleAfterMs: 1_000,
  retentionMs: 3_000,
  maxSamples: 16,
  metrics: [{ name: "covariance", unit: "m²" }],
};
const hook = {
  projectId: stream.projectId,
  hookId: "lost-localization",
  streamId: stream.streamId,
  version: "1",
  lifetimeMs: 10_000,
  cooldownMs: 1_000,
  maxTriggers: 3,
  preEventMs: 1_000,
  postEventMs: 200,
};

const withTelemetry = <A, E, R>(use: Effect.Effect<A, E, R>, filename = ":memory:") =>
  Effect.provide(
    use,
    RobotTelemetryHooks.layer.pipe(
      Layer.provideMerge(RobotTelemetry.layer),
      Layer.provide(Layer.effectDiscard(RobotTelemetryEventsMigration)),
      Layer.provide(NodeSqliteClient.layer({ filename })),
      Layer.provide(SecureRandom.layerWebCrypto),
    ),
  );

const observation = Effect.fnUntraced(function* (sequence: number, covariance: number) {
  const nowMs = yield* Clock.currentTimeMillis;
  return {
    sequence,
    sourceTimestampMs: nowMs,
    synchronization: { unixMs: nowMs, uncertaintyMs: 0 },
    values: { covariance },
  };
});

it.effect("retains bounded history, distinguishes producer loss, and fences reconnects", () =>
  Effect.gen(function* () {
    const telemetry = yield* RobotTelemetry.RobotTelemetry;
    yield* telemetry.register({ ...stream, maxSamples: 2 });
    yield* telemetry.register({ ...stream, maxSamples: 2 });
    expect((yield* Effect.flip(telemetry.register(stream))).reason).toBe("conflict");
    const firstProducer = yield* telemetry.connect(stream);
    yield* telemetry.ingest(stream, firstProducer, yield* observation(1, 1));
    yield* TestClock.adjust(20);
    yield* telemetry.ingest(stream, firstProducer, yield* observation(3, 2));
    yield* TestClock.adjust(20);
    yield* telemetry.ingest(stream, firstProducer, yield* observation(4, 3));

    const first = yield* telemetry.query(stream, { limit: 1 });
    expect(first.state).toMatchObject({
      freshness: "fresh",
      sourceDroppedSamples: 1,
      evictedSamples: 1,
    });
    expect(first).toMatchObject({
      cursorGap: true,
      hasMore: true,
      samples: [{ cursor: 2, missingBefore: 1, values: { covariance: 2 } }],
      nextCursor: 2,
    });
    const next = yield* telemetry.query(stream, { afterCursor: first.nextCursor });
    expect(next.samples.map(({ cursor }) => cursor)).toEqual([3]);
    const sampled = yield* telemetry.query(stream, { sampleEvery: 2 });
    expect(sampled.samples.map(({ cursor }) => cursor)).toEqual([2]);
    expect(sampled.downsampled).toBe(1);

    const secondProducer = yield* telemetry.connect(stream);
    expect((yield* telemetry.query(stream)).state.freshness).toBe("stale");
    const stale = yield* Effect.flip(
      telemetry.ingest(stream, firstProducer, yield* observation(5, 4)),
    );
    expect(stale.reason).toBe("stale-producer");
    const second = yield* telemetry.ingest(stream, secondProducer, yield* observation(0, 5));
    expect(second.cursor).toBe(4);
    expect(second.generation).not.toBe(secondProducer);
    yield* telemetry.disconnect(stream, secondProducer);
    expect((yield* telemetry.query(stream)).state).toMatchObject({
      connection: "disconnected",
      freshness: "stale",
    });
    yield* TestClock.adjust(3_001);
    expect((yield* telemetry.query(stream)).samples).toEqual([]);
    expect(yield* telemetry.list("unrelated")).toEqual([]);
  }).pipe(Effect.provide(RobotTelemetry.layer.pipe(Layer.provide(SecureRandom.layerWebCrypto)))),
);

it.effect(
  "emits one event for a continuous excursion and preserves bounded evidence across reopen",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "robot-telemetry-test-" });
      const filename = path.join(directory, "evidence.sqlite");

      const eventId = yield* withTelemetry(
        Effect.gen(function* () {
          const telemetry = yield* RobotTelemetry.RobotTelemetry;
          const hooks = yield* RobotTelemetryHooks.RobotTelemetryHooks;
          yield* telemetry.register(stream);
          const producer = yield* telemetry.connect(stream);
          yield* hooks.register({
            ...hook,
            evaluator: {
              kind: "threshold",
              metric: "covariance",
              comparison: "above",
              value: 3,
              durationMs: 200,
              maxGapMs: 150,
            },
          });

          yield* telemetry.ingest(stream, producer, yield* observation(0, 4));
          expect(yield* hooks.evaluate(hook)).toBeNull();
          yield* TestClock.adjust(100);
          yield* telemetry.ingest(stream, producer, yield* observation(2, 4));
          yield* TestClock.adjust(100);
          yield* telemetry.ingest(stream, producer, yield* observation(3, 4));
          expect(yield* hooks.evaluate(hook)).toBeNull();
          yield* TestClock.adjust(100);
          yield* telemetry.ingest(stream, producer, yield* observation(4, 4));
          const event = yield* hooks.evaluate(hook);
          expect(event?.sample.sequence).toBe(4);
          expect(event?.pre.samples.map(({ sequence }) => sequence)).toEqual([0, 2, 3]);
          expect(event?.pre.status).toBe("partial");
          expect(event?.post.status).toBe("pending");
          if (event === null) throw new Error("Expected a localization event");

          yield* TestClock.adjust(100);
          yield* telemetry.ingest(stream, producer, yield* observation(5, 4));
          expect(yield* hooks.evaluate(hook)).toBeNull();
          yield* TestClock.adjust(100);
          yield* telemetry.ingest(stream, producer, yield* observation(6, 1));
          expect(yield* hooks.evaluate(hook)).toBeNull();
          const collected = yield* hooks.collect(event);
          expect(collected.post.status).toBe("captured");
          expect(collected.post.samples.map(({ sequence }) => sequence)).toEqual([5, 6]);
          expect((yield* hooks.collect(event)).post).toEqual(collected.post);
          expect(yield* hooks.events(hook.projectId)).toHaveLength(1);
          expect(yield* hooks.events("other-project")).toEqual([]);
          return event.eventId;
        }),
        filename,
      );
      yield* withTelemetry(
        Effect.gen(function* () {
          const hooks = yield* RobotTelemetryHooks.RobotTelemetryHooks;
          const [stored] = yield* hooks.events(hook.projectId);
          expect(stored?.eventId).toBe(eventId);
          expect(stored?.post.status).toBe("captured");
        }),
        filename,
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("records advisory evaluator failure separately and caps spend", () =>
  withTelemetry(
    Effect.gen(function* () {
      const telemetry = yield* RobotTelemetry.RobotTelemetry;
      const hooks = yield* RobotTelemetryHooks.RobotTelemetryHooks;
      yield* telemetry.register(stream);
      const producer = yield* telemetry.connect(stream);
      yield* hooks.register({
        ...hook,
        evaluator: {
          kind: "advisory",
          timeoutMs: 250,
          minIntervalMs: 100,
          maxEvaluations: 2,
          evaluate: (sample) => Effect.succeed(sample.sequence === 1 ? "failed" : "detected"),
        },
      });
      yield* telemetry.ingest(stream, producer, yield* observation(1, 4));
      expect(yield* hooks.evaluate(hook)).toBeNull();
      expect((yield* hooks.inspect(hook)).evaluation).toBe("failed");

      yield* telemetry.ingest(stream, producer, yield* observation(2, 4));
      expect(yield* hooks.evaluate(hook)).toBeNull();
      expect((yield* hooks.inspect(hook)).evaluationCount).toBe(1);
      yield* TestClock.adjust(100);
      expect((yield* hooks.evaluate(hook))?.sample.sequence).toBe(2);

      yield* TestClock.adjust(100);
      yield* telemetry.ingest(stream, producer, yield* observation(3, 4));
      expect(yield* hooks.evaluate(hook)).toBeNull();
      expect(yield* hooks.inspect(hook)).toMatchObject({
        evaluation: "budget-exhausted",
        evaluationCount: 2,
        triggerCount: 1,
      });
    }),
  ),
);

it.effect("wakes a waiting hook when its source publishes a sample", () =>
  withTelemetry(
    Effect.gen(function* () {
      const telemetry = yield* RobotTelemetry.RobotTelemetry;
      const hooks = yield* RobotTelemetryHooks.RobotTelemetryHooks;
      yield* telemetry.register(stream);
      const producer = yield* telemetry.connect(stream);
      yield* hooks.register({
        ...hook,
        evaluator: {
          kind: "threshold",
          metric: "covariance",
          comparison: "above",
          value: 3,
          durationMs: 0,
          maxGapMs: 200,
        },
      });
      const listening = yield* Deferred.make<void>();
      const firstEvent = yield* telemetry.changes(stream).pipe(
        Stream.mapEffect(() =>
          Effect.gen(function* () {
            const event = yield* hooks.evaluate(hook);
            yield* Deferred.succeed(listening, undefined);
            return event;
          }),
        ),
        Stream.filter((event) => event !== null),
        Stream.runHead,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(listening);
      yield* telemetry.ingest(stream, producer, yield* observation(1, 4));
      expect(yield* Fiber.join(firstEvent)).toMatchObject({ value: { sample: { sequence: 1 } } });
    }),
  ),
);
