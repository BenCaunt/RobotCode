import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";

const MAX_STREAMS = 64;
const MAX_SAMPLES = 512;
const MAX_METRICS = 16;
const MAX_RETENTION_MS = 60 * 60_000;
const MAX_QUERY_LIMIT = 200;

export interface RobotStreamRef {
  readonly projectId: string;
  readonly streamId: string;
}

export interface RobotStreamDefinition extends RobotStreamRef {
  readonly sourceId: string;
  readonly schemaId: string;
  readonly clockDomain: string;
  readonly coordinateFrame?: string;
  readonly expectedHz: number;
  readonly staleAfterMs: number;
  readonly retentionMs: number;
  readonly maxSamples: number;
  readonly metrics: ReadonlyArray<{ readonly name: string; readonly unit: string }>;
}

const ObservationFields = {
  sequence: Schema.Int,
  sourceTimestampMs: Schema.Finite,
  synchronization: Schema.optionalKey(
    Schema.Struct({ unixMs: Schema.Finite, uncertaintyMs: Schema.Finite }),
  ),
  values: Schema.Record(Schema.String, Schema.Finite),
  artifact: Schema.optionalKey(Schema.Struct({ id: Schema.String, version: Schema.String })),
};

export const RobotSample = Schema.Struct({
  ...ObservationFields,
  generation: Schema.String,
  cursor: Schema.Int,
  receivedAtMs: Schema.Int,
  missingBefore: Schema.Int,
});
export type RobotSample = typeof RobotSample.Type;

type RobotObservation = Omit<
  RobotSample,
  "generation" | "cursor" | "receivedAtMs" | "missingBefore"
>;

interface RobotStreamState extends RobotStreamDefinition {
  readonly connection: "connected" | "disconnected";
  readonly freshness: "fresh" | "stale" | "unknown";
  readonly activeGeneration: string | null;
  readonly latestCursor: number;
  readonly oldestReceivedAtMs: number | null;
  readonly latestReceivedAtMs: number | null;
  readonly sourceDroppedSamples: number;
  readonly evictedSamples: number;
}

interface RobotStreamQuery {
  readonly afterCursor?: number;
  readonly fromMs?: number;
  readonly toMs?: number;
  readonly clock?: "source" | "received";
  readonly limit?: number;
  readonly sampleEvery?: number;
}

interface RobotStreamWindow {
  readonly state: RobotStreamState;
  readonly samples: ReadonlyArray<RobotSample>;
  readonly nextCursor: number;
  readonly cursorGap: boolean;
  readonly hasMore: boolean;
  readonly downsampled: number;
}

export class RobotTelemetryError extends Schema.TaggedError<
  RobotTelemetryError,
  { readonly brand: unique symbol }
>()("RobotTelemetryError", {
  reason: Schema.Literals(["invalid", "conflict", "missing", "full", "stale-producer"]),
}) {
  override get message(): string {
    return `Robot telemetry operation rejected (${this.reason}).`;
  }
}

export class RobotTelemetry extends Context.Service<
  RobotTelemetry,
  {
    readonly register: (
      definition: RobotStreamDefinition,
    ) => Effect.Effect<RobotStreamState, RobotTelemetryError>;
    readonly list: (projectId: string) => Effect.Effect<ReadonlyArray<RobotStreamState>>;
    readonly connect: (ref: RobotStreamRef) => Effect.Effect<string, RobotTelemetryError>;
    readonly disconnect: (
      ref: RobotStreamRef,
      producerToken: string,
    ) => Effect.Effect<void, RobotTelemetryError>;
    readonly ingest: (
      ref: RobotStreamRef,
      producerToken: string,
      observation: RobotObservation,
    ) => Effect.Effect<RobotSample, RobotTelemetryError>;
    readonly query: (
      ref: RobotStreamRef,
      input?: RobotStreamQuery,
    ) => Effect.Effect<RobotStreamWindow, RobotTelemetryError>;
    readonly changes: (ref: RobotStreamRef) => Stream.Stream<void, RobotTelemetryError>;
  }
>()("t3/robotics/RobotTelemetry") {}

interface Entry {
  readonly definition: RobotStreamDefinition;
  readonly metricNames: ReadonlySet<string>;
  readonly samples: Map<number, RobotSample>;
  readonly changes: PubSub.PubSub<void>;
  generation: string | null;
  producerToken: string | null;
  latest: RobotSample | null;
  latestCursor: number;
  sourceDroppedSamples: number;
  evictedSamples: number;
}

const keyOf = ({ projectId, streamId }: RobotStreamRef) => JSON.stringify([projectId, streamId]);
const validText = (value: string) => value.length > 0 && value.length <= 256;
const boundedInteger = (value: number, minimum: number, maximum: number) =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;

function validDefinition(definition: RobotStreamDefinition): boolean {
  return (
    [
      definition.projectId,
      definition.streamId,
      definition.sourceId,
      definition.schemaId,
      definition.clockDomain,
    ].every(validText) &&
    (definition.coordinateFrame === undefined || validText(definition.coordinateFrame)) &&
    Number.isFinite(definition.expectedHz) &&
    definition.expectedHz > 0 &&
    boundedInteger(definition.retentionMs, 1, MAX_RETENTION_MS) &&
    boundedInteger(definition.staleAfterMs, 1, definition.retentionMs) &&
    boundedInteger(definition.maxSamples, 1, MAX_SAMPLES) &&
    definition.metrics.length <= MAX_METRICS &&
    definition.metrics.every(({ name, unit }) => validText(name) && validText(unit)) &&
    new Set(definition.metrics.map(({ name }) => name)).size === definition.metrics.length
  );
}

function copyDefinition(definition: RobotStreamDefinition): RobotStreamDefinition {
  return {
    projectId: definition.projectId,
    streamId: definition.streamId,
    sourceId: definition.sourceId,
    schemaId: definition.schemaId,
    clockDomain: definition.clockDomain,
    ...(definition.coordinateFrame === undefined
      ? {}
      : { coordinateFrame: definition.coordinateFrame }),
    expectedHz: definition.expectedHz,
    staleAfterMs: definition.staleAfterMs,
    retentionMs: definition.retentionMs,
    maxSamples: definition.maxSamples,
    metrics: definition.metrics.map(({ name, unit }) => ({ name, unit })),
  };
}

export function sampleFreshness(
  sample: RobotSample,
  nowMs: number,
  staleAfterMs: number,
): RobotStreamState["freshness"] {
  const synchronization = sample.synchronization;
  if (nowMs - sample.receivedAtMs > staleAfterMs) return "stale";
  if (
    synchronization === undefined ||
    synchronization.unixMs - synchronization.uncertaintyMs > nowMs
  ) {
    return "unknown";
  }
  return nowMs - synchronization.unixMs + synchronization.uncertaintyMs > staleAfterMs
    ? "stale"
    : "fresh";
}

function summarize(entry: Entry, nowMs: number): RobotStreamState {
  const latest = entry.latest;
  const activeGeneration = entry.producerToken === null ? null : entry.generation;
  const freshness =
    latest === null
      ? "unknown"
      : latest.generation === activeGeneration
        ? sampleFreshness(latest, nowMs, entry.definition.staleAfterMs)
        : "stale";
  return {
    ...copyDefinition(entry.definition),
    connection: entry.producerToken === null ? "disconnected" : "connected",
    freshness,
    activeGeneration,
    latestCursor: entry.latestCursor,
    oldestReceivedAtMs: entry.samples.values().next().value?.receivedAtMs ?? null,
    latestReceivedAtMs: latest?.receivedAtMs ?? null,
    sourceDroppedSamples: entry.sourceDroppedSamples,
    evictedSamples: entry.evictedSamples,
  };
}

function trim(entry: Entry, nowMs: number): void {
  for (const [cursor, sample] of entry.samples) {
    if (
      entry.samples.size <= entry.definition.maxSamples &&
      sample.receivedAtMs >= nowMs - entry.definition.retentionMs
    ) {
      break;
    }
    entry.samples.delete(cursor);
    entry.evictedSamples += 1;
  }
}

function validObservation(entry: Entry, observation: RobotObservation): boolean {
  const synchronization = observation.synchronization;
  return (
    boundedInteger(observation.sequence, 0, Number.MAX_SAFE_INTEGER) &&
    Number.isFinite(observation.sourceTimestampMs) &&
    (synchronization === undefined ||
      (Number.isFinite(synchronization.unixMs) &&
        Number.isFinite(synchronization.uncertaintyMs) &&
        synchronization.uncertaintyMs >= 0)) &&
    (observation.artifact === undefined ||
      (validText(observation.artifact.id) && validText(observation.artifact.version))) &&
    Object.entries(observation.values).every(
      ([key, value]) => entry.metricNames.has(key) && Number.isFinite(value),
    )
  );
}

const make = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const entries = new Map<string, Entry>();

  const register = Effect.fn("RobotTelemetry.register")(function* (
    definition: RobotStreamDefinition,
  ) {
    if (!validDefinition(definition)) {
      return yield* new RobotTelemetryError({ reason: "invalid" });
    }
    const key = keyOf(definition);
    const nowMs = yield* Clock.currentTimeMillis;
    const changes = yield* PubSub.sliding<void>(1);
    const existing = entries.get(key);
    const normalized = copyDefinition(definition);
    if (existing !== undefined) {
      if (!Equal.equals(existing.definition, normalized)) {
        return yield* new RobotTelemetryError({ reason: "conflict" });
      }
      trim(existing, nowMs);
      return summarize(existing, nowMs);
    }
    if (entries.size >= MAX_STREAMS) {
      return yield* new RobotTelemetryError({ reason: "full" });
    }
    const entry: Entry = {
      definition: normalized,
      metricNames: new Set(normalized.metrics.map(({ name }) => name)),
      samples: new Map(),
      changes,
      generation: null,
      producerToken: null,
      latest: null,
      latestCursor: 0,
      sourceDroppedSamples: 0,
      evictedSamples: 0,
    };
    entries.set(key, entry);
    return summarize(entry, nowMs);
  });

  const list = Effect.fn("RobotTelemetry.list")(function* (projectId: string) {
    const nowMs = yield* Clock.currentTimeMillis;
    const states: RobotStreamState[] = [];
    for (const entry of entries.values()) {
      if (entry.definition.projectId === projectId) {
        trim(entry, nowMs);
        states.push(summarize(entry, nowMs));
      }
    }
    return states;
  });

  const connect = Effect.fn("RobotTelemetry.connect")(function* (ref: RobotStreamRef) {
    const generation = yield* random.uuidV4();
    const producerToken = yield* random.uuidV4();
    const entry = entries.get(keyOf(ref));
    if (entry === undefined) return yield* new RobotTelemetryError({ reason: "missing" });
    entry.generation = generation;
    entry.producerToken = producerToken;
    yield* PubSub.publish(entry.changes, undefined);
    return producerToken;
  });

  const disconnect = Effect.fn("RobotTelemetry.disconnect")(function* (
    ref: RobotStreamRef,
    producerToken: string,
  ) {
    const entry = entries.get(keyOf(ref));
    if (entry === undefined) return yield* new RobotTelemetryError({ reason: "missing" });
    if (entry.producerToken !== producerToken || entry.generation === null) {
      return yield* new RobotTelemetryError({ reason: "stale-producer" });
    }
    entry.producerToken = null;
    yield* PubSub.publish(entry.changes, undefined);
  });

  // Per-sample operations stay outside the orchestration event stream and tracing pipeline.
  const ingest = Effect.fnUntraced(function* (
    ref: RobotStreamRef,
    producerToken: string,
    observation: RobotObservation,
  ) {
    const receivedAtMs = yield* Clock.currentTimeMillis;
    const entry = entries.get(keyOf(ref));
    if (entry === undefined) return yield* new RobotTelemetryError({ reason: "missing" });
    if (entry.producerToken !== producerToken || entry.generation === null) {
      return yield* new RobotTelemetryError({ reason: "stale-producer" });
    }
    if (!validObservation(entry, observation)) {
      return yield* new RobotTelemetryError({ reason: "invalid" });
    }
    const previous = entry.latest?.generation === entry.generation ? entry.latest : undefined;
    if (previous !== undefined && observation.sequence <= previous.sequence) {
      return yield* new RobotTelemetryError({ reason: "conflict" });
    }
    const missingBefore = previous === undefined ? 0 : observation.sequence - previous.sequence - 1;
    const sample = Object.freeze({
      generation: entry.generation,
      cursor: entry.latestCursor + 1,
      receivedAtMs,
      missingBefore,
      sequence: observation.sequence,
      sourceTimestampMs: observation.sourceTimestampMs,
      values: Object.freeze({ ...observation.values }),
      ...(observation.synchronization === undefined
        ? {}
        : {
            synchronization: Object.freeze({
              unixMs: observation.synchronization.unixMs,
              uncertaintyMs: observation.synchronization.uncertaintyMs,
            }),
          }),
      ...(observation.artifact === undefined
        ? {}
        : {
            artifact: Object.freeze({
              id: observation.artifact.id,
              version: observation.artifact.version,
            }),
          }),
    });
    entry.latest = sample;
    entry.latestCursor = sample.cursor;
    entry.sourceDroppedSamples = Math.min(
      Number.MAX_SAFE_INTEGER,
      entry.sourceDroppedSamples + missingBefore,
    );
    entry.samples.set(sample.cursor, sample);
    trim(entry, receivedAtMs);
    yield* PubSub.publish(entry.changes, undefined);
    return sample;
  });

  const query = Effect.fn("RobotTelemetry.query")(function* (
    ref: RobotStreamRef,
    input: RobotStreamQuery = {},
  ) {
    const nowMs = yield* Clock.currentTimeMillis;
    const entry = entries.get(keyOf(ref));
    if (entry === undefined) return yield* new RobotTelemetryError({ reason: "missing" });
    const {
      afterCursor = 0,
      fromMs,
      toMs,
      clock = "received",
      limit = 100,
      sampleEvery = 1,
    } = input;
    if (
      !boundedInteger(afterCursor, 0, Number.MAX_SAFE_INTEGER) ||
      !boundedInteger(limit, 1, MAX_QUERY_LIMIT) ||
      !boundedInteger(sampleEvery, 1, MAX_SAMPLES) ||
      (fromMs !== undefined && !Number.isFinite(fromMs)) ||
      (toMs !== undefined && !Number.isFinite(toMs)) ||
      (fromMs !== undefined && toMs !== undefined && fromMs > toMs)
    ) {
      return yield* new RobotTelemetryError({ reason: "invalid" });
    }
    trim(entry, nowMs);
    const firstAvailable = entry.samples.keys().next().value ?? entry.latestCursor + 1;
    const samples: RobotSample[] = [];
    let nextCursor = Math.max(afterCursor, firstAvailable - 1);
    let hasMore = false;
    let downsampled = 0;
    for (const [cursor, sample] of entry.samples) {
      if (cursor <= afterCursor) continue;
      const timestamp = clock === "source" ? sample.sourceTimestampMs : sample.receivedAtMs;
      if (
        (fromMs === undefined || timestamp >= fromMs) &&
        (toMs === undefined || timestamp <= toMs)
      ) {
        if (cursor % sampleEvery === 0) {
          if (samples.length >= limit) {
            hasMore = true;
            break;
          }
          samples.push(sample);
        } else {
          downsampled += 1;
        }
      }
      nextCursor = cursor;
    }
    return {
      state: summarize(entry, nowMs),
      samples,
      nextCursor,
      cursorGap: afterCursor < firstAvailable - 1,
      hasMore,
      downsampled,
    };
  });

  const changes: RobotTelemetry["Service"]["changes"] = (ref) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const entry = entries.get(keyOf(ref));
        if (entry === undefined) return yield* new RobotTelemetryError({ reason: "missing" });
        const subscription = yield* PubSub.subscribe(entry.changes);
        return Stream.succeed(undefined).pipe(Stream.concat(Stream.fromSubscription(subscription)));
      }),
    );

  return RobotTelemetry.of({ register, list, connect, disconnect, ingest, query, changes });
});

export const layer = Layer.effect(RobotTelemetry, make);
