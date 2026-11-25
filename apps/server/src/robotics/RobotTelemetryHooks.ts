import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import * as RobotTelemetry from "./RobotTelemetry.ts";
import type { RobotSample } from "./RobotTelemetry.ts";

const MAX_HOOKS = 32;
const MAX_CONCURRENT_EVALUATORS = 4;
const MAX_EVENT_COUNT = 256;
const MAX_EVIDENCE_SAMPLES = 24;
const MAX_LIFETIME_MS = 24 * 60 * 60_000;
const MAX_EVIDENCE_MS = 60_000;

interface HookRef {
  readonly projectId: string;
  readonly hookId: string;
}

type Evaluator =
  | {
      readonly kind: "threshold";
      readonly metric: string;
      readonly comparison: "above" | "below";
      readonly value: number;
      readonly durationMs: number;
      readonly maxGapMs: number;
    }
  | {
      readonly kind: "advisory";
      readonly timeoutMs: number;
      readonly minIntervalMs: number;
      readonly maxEvaluations: number;
      readonly evaluate: (sample: RobotSample) => Effect.Effect<"detected" | "clear" | "failed">;
    };

interface RobotHookDefinition extends HookRef {
  readonly streamId: string;
  readonly version: string;
  readonly lifetimeMs: number;
  readonly cooldownMs: number;
  readonly maxTriggers: number;
  readonly preEventMs: number;
  readonly postEventMs: number;
  readonly evaluator: Evaluator;
}

const Evidence = Schema.Struct({
  samples: Schema.Array(RobotTelemetry.RobotSample),
  status: Schema.Literals(["pending", "empty", "partial", "captured"]),
});
type Evidence = typeof Evidence.Type;

const HookEvent = Schema.Struct({
  projectId: Schema.String,
  hookId: Schema.String,
  eventId: Schema.String,
  streamId: Schema.String,
  hookVersion: Schema.String,
  evaluator: Schema.Literals(["threshold", "advisory"]),
  triggeredAtMs: Schema.Int,
  sample: RobotTelemetry.RobotSample,
  pre: Evidence,
  post: Evidence,
  postUntilMs: Schema.Int,
});
type HookEvent = typeof HookEvent.Type;

const EventJson = Schema.fromJsonString(HookEvent);
const decodeEvent = Schema.decodeEffect(EventJson);
const encodeEvent = Schema.encodeEffect(EventJson);

type Evaluation =
  | "waiting"
  | "clear"
  | "unavailable"
  | "failed"
  | "budget-exhausted"
  | "cooldown"
  | "triggered";

interface HookState extends HookRef {
  readonly version: string;
  readonly streamId: string;
  readonly lifecycle: "enabled" | "disabled" | "expired";
  readonly expiresAtMs: number;
  readonly evaluation: Evaluation;
  readonly evaluating: boolean;
  readonly evaluationCount: number;
  readonly triggerCount: number;
  readonly lastSampleCursor: number;
  readonly lastEvaluatedAtMs: number | null;
}

export class RobotTelemetryHookError extends Schema.TaggedError<
  RobotTelemetryHookError,
  { readonly brand: unique symbol }
>()("RobotTelemetryHookError", {
  reason: Schema.Literals(["invalid", "conflict", "missing", "full", "busy"]),
}) {
  override get message(): string {
    return `Robot telemetry hook operation rejected (${this.reason}).`;
  }
}

export class RobotTelemetryJournalError extends Schema.TaggedError<
  RobotTelemetryJournalError,
  { readonly brand: unique symbol }
>()("RobotTelemetryJournalError", { cause: Schema.Defect() }) {
  override get message(): string {
    return "Robot telemetry evidence journal operation failed.";
  }
}

type HookError = RobotTelemetryHookError | RobotTelemetry.RobotTelemetryError;
type EventQueryError = RobotTelemetryHookError | RobotTelemetryJournalError;
type EvaluationError = HookError | RobotTelemetryJournalError;

export class RobotTelemetryHooks extends Context.Service<
  RobotTelemetryHooks,
  {
    readonly register: (definition: RobotHookDefinition) => Effect.Effect<HookState, HookError>;
    readonly inspect: (ref: HookRef) => Effect.Effect<HookState, RobotTelemetryHookError>;
    readonly disable: (ref: HookRef) => Effect.Effect<HookState, RobotTelemetryHookError>;
    readonly remove: (ref: HookRef) => Effect.Effect<void, RobotTelemetryHookError>;
    readonly evaluate: (ref: HookRef) => Effect.Effect<HookEvent | null, EvaluationError>;
    readonly events: (
      projectId: string,
      limit?: number,
    ) => Effect.Effect<ReadonlyArray<HookEvent>, EventQueryError>;
    readonly collect: (ref: {
      readonly projectId: string;
      readonly eventId: string;
    }) => Effect.Effect<HookEvent, EvaluationError>;
  }
>()("t3/robotics/RobotTelemetryHooks") {}

interface HookEntry {
  readonly definition: RobotHookDefinition;
  readonly instanceId: string;
  readonly expiresAtMs: number;
  enabled: boolean;
  evaluating: boolean;
  evaluation: Evaluation;
  evaluationCount: number;
  triggerCount: number;
  cursor: number;
  lastEvaluatedAtMs: number | null;
  lastTriggeredAtMs: number | null;
  previous: RobotSample | null;
  conditionSinceMs: number | null;
  latched: boolean;
}

const keyOf = ({ projectId, hookId }: HookRef) => JSON.stringify([projectId, hookId]);
const validText = (value: string) => value.length > 0 && value.length <= 256;
const bounded = (value: number, minimum: number, maximum: number) =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const journalFailure = (cause: SqlError.SqlError | Schema.SchemaError) =>
  new RobotTelemetryJournalError({ cause });

function validDefinition(definition: RobotHookDefinition): boolean {
  const evaluator = definition.evaluator;
  return (
    [definition.projectId, definition.hookId, definition.streamId, definition.version].every(
      validText,
    ) &&
    bounded(definition.lifetimeMs, 1, MAX_LIFETIME_MS) &&
    bounded(definition.cooldownMs, 0, MAX_LIFETIME_MS) &&
    bounded(definition.maxTriggers, 1, 32) &&
    bounded(definition.preEventMs, 0, MAX_EVIDENCE_MS) &&
    bounded(definition.postEventMs, 0, MAX_EVIDENCE_MS) &&
    (evaluator.kind === "threshold"
      ? validText(evaluator.metric) &&
        Number.isFinite(evaluator.value) &&
        bounded(evaluator.durationMs, 0, definition.lifetimeMs) &&
        bounded(evaluator.maxGapMs, 1, MAX_EVIDENCE_MS)
      : bounded(evaluator.timeoutMs, 1, 5_000) &&
        bounded(evaluator.minIntervalMs, 100, MAX_LIFETIME_MS) &&
        bounded(evaluator.maxEvaluations, 1, 1_000))
  );
}

function summarize(entry: HookEntry, nowMs: number): HookState {
  const { projectId, hookId, streamId, version } = entry.definition;
  return {
    projectId,
    hookId,
    streamId,
    version,
    lifecycle: !entry.enabled ? "disabled" : nowMs >= entry.expiresAtMs ? "expired" : "enabled",
    expiresAtMs: entry.expiresAtMs,
    evaluation: entry.evaluation,
    evaluating: entry.evaluating,
    evaluationCount: entry.evaluationCount,
    triggerCount: entry.triggerCount,
    lastSampleCursor: entry.cursor,
    lastEvaluatedAtMs: entry.lastEvaluatedAtMs,
  };
}

function resetEpisode(entry: HookEntry): void {
  entry.previous = null;
  entry.conditionSinceMs = null;
  entry.latched = false;
}

function capture(
  samples: ReadonlyArray<RobotSample>,
  overflow: boolean,
  generation: string,
): Evidence {
  const relevant = samples.filter((sample) => sample.generation === generation);
  const partial =
    overflow ||
    relevant.length !== samples.length ||
    relevant.some((sample) => sample.missingBefore > 0);
  return {
    samples: relevant,
    status: partial ? "partial" : relevant.length === 0 ? "empty" : "captured",
  };
}

const make = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const telemetry = yield* RobotTelemetry.RobotTelemetry;
  const sql = yield* SqlClient.SqlClient;
  const hooks = new Map<string, HookEntry>();
  let activeEvaluators = 0;

  const register = Effect.fn("RobotTelemetryHooks.register")(function* (
    definition: RobotHookDefinition,
  ) {
    if (!validDefinition(definition))
      return yield* new RobotTelemetryHookError({ reason: "invalid" });
    const stream = yield* telemetry.query(definition, { limit: 1 });
    if (definition.evaluator.kind === "threshold") {
      const metric = definition.evaluator.metric;
      if (!stream.state.metrics.some(({ name }) => name === metric)) {
        return yield* new RobotTelemetryHookError({ reason: "invalid" });
      }
    }
    const nowMs = yield* Clock.currentTimeMillis;
    const instanceId = yield* random.uuidV4();
    const key = keyOf(definition);
    if (hooks.has(key)) return yield* new RobotTelemetryHookError({ reason: "conflict" });
    if (hooks.size >= MAX_HOOKS) return yield* new RobotTelemetryHookError({ reason: "full" });

    const entry: HookEntry = {
      definition: { ...definition, evaluator: { ...definition.evaluator } },
      instanceId,
      expiresAtMs: nowMs + definition.lifetimeMs,
      enabled: true,
      evaluating: false,
      evaluation: "waiting",
      evaluationCount: 0,
      triggerCount: 0,
      cursor: stream.state.latestCursor,
      lastEvaluatedAtMs: null,
      lastTriggeredAtMs: null,
      previous: null,
      conditionSinceMs: null,
      latched: false,
    };
    hooks.set(key, entry);
    return summarize(entry, nowMs);
  });

  const inspect = Effect.fn("RobotTelemetryHooks.inspect")(function* (ref: HookRef) {
    const entry = hooks.get(keyOf(ref));
    if (entry === undefined) return yield* new RobotTelemetryHookError({ reason: "missing" });
    return summarize(entry, yield* Clock.currentTimeMillis);
  });

  const disable = Effect.fn("RobotTelemetryHooks.disable")(function* (ref: HookRef) {
    const entry = hooks.get(keyOf(ref));
    if (entry === undefined) return yield* new RobotTelemetryHookError({ reason: "missing" });
    entry.enabled = false;
    return summarize(entry, yield* Clock.currentTimeMillis);
  });

  const remove = Effect.fn("RobotTelemetryHooks.remove")(function* (ref: HookRef) {
    const key = keyOf(ref);
    const entry = hooks.get(key);
    if (entry === undefined) return yield* new RobotTelemetryHookError({ reason: "missing" });
    if (entry.evaluating) return yield* new RobotTelemetryHookError({ reason: "busy" });
    hooks.delete(key);
  });

  const read = Effect.fn("RobotTelemetryHooks.readEvent")(function* (
    projectId: string,
    eventId: string,
  ) {
    const rows = yield* sql<{ readonly event_json: string }>`
      SELECT event_json FROM robotics_telemetry_events
      WHERE project_id = ${projectId} AND event_id = ${eventId}
    `.pipe(Effect.mapError(journalFailure));
    const stored = rows[0];
    if (stored === undefined) return yield* new RobotTelemetryHookError({ reason: "missing" });
    return yield* decodeEvent(stored.event_json).pipe(Effect.mapError(journalFailure));
  });

  const persist = Effect.fn("RobotTelemetryHooks.persistEvent")(function* (event: HookEvent) {
    const eventJson = yield* encodeEvent(event).pipe(Effect.mapError(journalFailure));
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
          INSERT INTO robotics_telemetry_events (event_id, project_id, triggered_at_ms, event_json)
          VALUES (${event.eventId}, ${event.projectId}, ${event.triggeredAtMs}, ${eventJson})
          ON CONFLICT (event_id) DO NOTHING
        `;
          yield* sql`
          DELETE FROM robotics_telemetry_events WHERE event_id IN (
            SELECT event_id FROM robotics_telemetry_events
            ORDER BY triggered_at_ms DESC, event_id DESC
            LIMIT -1 OFFSET ${MAX_EVENT_COUNT}
          )
        `;
        }),
      )
      .pipe(Effect.mapError(journalFailure));
    return yield* read(event.projectId, event.eventId);
  });

  const evaluate = Effect.fn("RobotTelemetryHooks.evaluate")(function* (ref: HookRef) {
    const entry = hooks.get(keyOf(ref));
    if (entry === undefined) return yield* new RobotTelemetryHookError({ reason: "missing" });

    return yield* Effect.acquireUseRelease(
      Effect.gen(function* () {
        if (hooks.get(keyOf(ref)) !== entry) {
          return yield* new RobotTelemetryHookError({ reason: "missing" });
        }
        if (entry.evaluating || activeEvaluators >= MAX_CONCURRENT_EVALUATORS) {
          return yield* new RobotTelemetryHookError({ reason: "busy" });
        }
        entry.evaluating = true;
        activeEvaluators += 1;
      }),
      () => evaluateEntry(entry),
      () =>
        Effect.sync(() => {
          entry.evaluating = false;
          activeEvaluators -= 1;
        }),
    );
  });

  const evaluateEntry = Effect.fn("RobotTelemetryHooks.evaluateEntry")(function* (
    entry: HookEntry,
  ) {
    const definition = entry.definition;
    const evaluator = definition.evaluator;
    if (!entry.enabled || (yield* Clock.currentTimeMillis) >= entry.expiresAtMs) return null;
    if (entry.triggerCount >= definition.maxTriggers) {
      entry.evaluation = "budget-exhausted";
      return null;
    }

    let window = yield* telemetry.query(definition, {
      afterCursor: entry.cursor,
      limit: 32,
    });
    if (window.state.connection !== "connected" || window.state.freshness !== "fresh") {
      resetEpisode(entry);
      entry.cursor = window.state.latestCursor;
      entry.evaluation = "unavailable";
      return null;
    }
    if (window.cursorGap) resetEpisode(entry);
    if (
      evaluator.kind === "advisory" &&
      window.state.latestCursor > entry.cursor &&
      window.hasMore
    ) {
      window = yield* telemetry.query(definition, {
        afterCursor: window.state.latestCursor - 1,
        limit: 1,
      });
    }

    const nowMs = yield* Clock.currentTimeMillis;
    if (!entry.enabled || nowMs >= entry.expiresAtMs) return null;
    for (const sample of window.samples) {
      if (
        sample.generation !== window.state.activeGeneration ||
        RobotTelemetry.sampleFreshness(sample, nowMs, window.state.staleAfterMs) !== "fresh"
      ) {
        resetEpisode(entry);
        entry.evaluation = "unavailable";
        entry.cursor = sample.cursor;
        continue;
      }

      let detected = false;
      if (evaluator.kind === "threshold") {
        const value = sample.values[evaluator.metric];
        if (value === undefined || !Object.hasOwn(sample.values, evaluator.metric)) {
          resetEpisode(entry);
          entry.cursor = sample.cursor;
          entry.evaluation = "unavailable";
          continue;
        }
        const previous = entry.previous;
        const sampleTime = sample.sourceTimestampMs;
        if (
          previous === null ||
          previous.generation !== sample.generation ||
          sample.missingBefore > 0 ||
          sampleTime <= previous.sourceTimestampMs ||
          sampleTime - previous.sourceTimestampMs > evaluator.maxGapMs
        ) {
          resetEpisode(entry);
        }
        const exceeded =
          evaluator.comparison === "above" ? value > evaluator.value : value < evaluator.value;
        if (exceeded) {
          entry.conditionSinceMs ??= sampleTime;
          detected = sampleTime - entry.conditionSinceMs >= evaluator.durationMs;
        } else {
          resetEpisode(entry);
        }
        entry.evaluationCount += 1;
        entry.lastEvaluatedAtMs = nowMs;
      } else {
        if (entry.evaluationCount >= evaluator.maxEvaluations) {
          entry.evaluation = "budget-exhausted";
          entry.cursor = window.state.latestCursor;
          return null;
        }
        if (
          entry.lastEvaluatedAtMs !== null &&
          nowMs - entry.lastEvaluatedAtMs < evaluator.minIntervalMs
        )
          return null;
        // Skip the backlog for advisory adapters. Spend their budget on the latest sample.
        if (sample.cursor !== window.state.latestCursor) {
          entry.cursor = sample.cursor;
          continue;
        }
        entry.evaluationCount += 1;
        entry.lastEvaluatedAtMs = nowMs;
        const evaluation = yield* Effect.suspend(() => evaluator.evaluate(sample)).pipe(
          Effect.timeoutOption(evaluator.timeoutMs),
          Effect.catchCause(() => Effect.succeedNone),
        );
        if (Option.isNone(evaluation) || evaluation.value === "failed") {
          entry.evaluation = "failed";
          entry.cursor = sample.cursor;
          return null;
        }
        const check = yield* telemetry.query(definition, { afterCursor: sample.cursor, limit: 1 });
        const checkedAtMs = yield* Clock.currentTimeMillis;
        if (!entry.enabled || checkedAtMs >= entry.expiresAtMs) return null;
        if (
          check.state.activeGeneration !== sample.generation ||
          check.state.freshness !== "fresh" ||
          RobotTelemetry.sampleFreshness(sample, checkedAtMs, check.state.staleAfterMs) !== "fresh"
        ) {
          resetEpisode(entry);
          entry.evaluation = "unavailable";
          entry.cursor = sample.cursor;
          return null;
        }
        detected = evaluation.value === "detected";
        if (!detected) resetEpisode(entry);
      }

      if (detected && !entry.latched) {
        if (
          entry.lastTriggeredAtMs === null ||
          nowMs - entry.lastTriggeredAtMs >= definition.cooldownMs
        ) {
          const event = yield* emit(entry, sample);
          entry.cursor = sample.cursor;
          if (event === null) {
            entry.evaluation = "unavailable";
            return null;
          }
          entry.lastTriggeredAtMs = event.triggeredAtMs;
          entry.triggerCount += 1;
          entry.latched = true;
          entry.evaluation = "triggered";
          entry.previous = sample;
          return event;
        }
        entry.evaluation = "cooldown";
      } else {
        entry.evaluation = detected ? "triggered" : "clear";
      }
      entry.previous = sample;
      entry.cursor = sample.cursor;
    }
    return null;
  });

  const emit = Effect.fn("RobotTelemetryHooks.emit")(function* (
    entry: HookEntry,
    sample: RobotSample,
  ) {
    const definition = entry.definition;
    const fromMs = sample.receivedAtMs - definition.preEventMs;
    const before = yield* telemetry.query(definition, {
      afterCursor: Math.max(0, sample.cursor - MAX_EVIDENCE_SAMPLES - 2),
      fromMs,
      toMs: sample.receivedAtMs,
      limit: MAX_EVIDENCE_SAMPLES + 2,
    });
    const nowMs = yield* Clock.currentTimeMillis;
    if (!entry.enabled || nowMs >= entry.expiresAtMs) return null;
    if (before.state.activeGeneration !== sample.generation || before.state.freshness !== "fresh") {
      resetEpisode(entry);
      return null;
    }
    const preSamples = before.samples.filter((candidate) => candidate.cursor < sample.cursor);
    const evicted =
      before.state.evictedSamples > 0 && (before.state.oldestReceivedAtMs ?? Infinity) > fromMs;
    return yield* persist({
      projectId: definition.projectId,
      hookId: definition.hookId,
      hookVersion: definition.version,
      streamId: definition.streamId,
      eventId: `${entry.instanceId}:${sample.cursor}`,
      evaluator: definition.evaluator.kind,
      triggeredAtMs: nowMs,
      sample,
      pre:
        definition.preEventMs === 0
          ? { status: "empty", samples: [] }
          : capture(
              preSamples.slice(-MAX_EVIDENCE_SAMPLES),
              evicted || preSamples.length > MAX_EVIDENCE_SAMPLES,
              sample.generation,
            ),
      post: { status: definition.postEventMs === 0 ? "empty" : "pending", samples: [] },
      postUntilMs: sample.receivedAtMs + definition.postEventMs,
    });
  });

  const events = Effect.fn("RobotTelemetryHooks.events")(function* (projectId: string, limit = 20) {
    if (!validText(projectId) || !bounded(limit, 1, 50)) {
      return yield* new RobotTelemetryHookError({ reason: "invalid" });
    }
    const rows = yield* sql<{ readonly event_json: string }>`
      SELECT event_json FROM robotics_telemetry_events WHERE project_id = ${projectId}
      ORDER BY triggered_at_ms DESC, event_id DESC LIMIT ${limit}
    `.pipe(Effect.mapError(journalFailure));
    return yield* Effect.forEach(rows, ({ event_json }) =>
      decodeEvent(event_json).pipe(Effect.mapError(journalFailure)),
    );
  });

  const collect = Effect.fn("RobotTelemetryHooks.collect")(function* ({
    projectId,
    eventId,
  }: {
    readonly projectId: string;
    readonly eventId: string;
  }) {
    const event = yield* read(projectId, eventId);
    const nowMs = yield* Clock.currentTimeMillis;
    if (event.post.status !== "pending" || nowMs < event.postUntilMs) return event;

    const window = yield* telemetry
      .query(event, {
        afterCursor: event.sample.cursor,
        fromMs: event.sample.receivedAtMs,
        toMs: event.postUntilMs,
        limit: MAX_EVIDENCE_SAMPLES,
      })
      .pipe(
        Effect.catchTags({
          RobotTelemetryError: (error) =>
            error.reason === "missing" ? Effect.succeed(null) : Effect.fail(error),
        }),
      );
    const post =
      window === null
        ? { status: "partial" as const, samples: [] }
        : capture(
            window.samples,
            window.hasMore || window.cursorGap || window.state.latestCursor < event.sample.cursor,
            event.sample.generation,
          );
    const updated = { ...event, post };
    const eventJson = yield* encodeEvent(updated).pipe(Effect.mapError(journalFailure));
    yield* sql`
      UPDATE robotics_telemetry_events SET event_json = ${eventJson}
      WHERE event_id = ${eventId} AND project_id = ${projectId}
        AND json_extract(event_json, '$.post.status') = 'pending'
    `.pipe(Effect.mapError(journalFailure));
    return yield* read(projectId, eventId);
  });

  return RobotTelemetryHooks.of({ register, inspect, disable, remove, evaluate, events, collect });
});

export const layer = Layer.effect(RobotTelemetryHooks, make);
