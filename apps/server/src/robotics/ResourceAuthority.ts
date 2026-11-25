import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";

type ResourceAccess = "observe" | "write";

export interface ResourceDefinition {
  readonly id: string;
  readonly policy: "strict" | "single-writer-multiple-observers";
  readonly maxLeaseMs: number;
  readonly enforcement:
    | { readonly kind: "advisory-only" }
    | { readonly kind: "simulation"; readonly commandTimeoutMs: number };
}

interface ResourceClaim {
  readonly resourceId: string;
  readonly access: ResourceAccess;
}

interface ResourceLease extends ResourceClaim {
  readonly id: string;
  readonly ownerId: string;
  readonly expiresAt: number;
}

type ResourceGrant = ResourceLease & { readonly fencingToken: string | null };

type SafeReason =
  | "startup"
  | "commanded"
  | "lease-expired"
  | "command-timeout"
  | "released"
  | "handoff"
  | "disconnected"
  | "emergency-stop"
  | "reset";

type ReceiverState =
  | { readonly kind: "safe"; readonly reason: SafeReason }
  | { readonly kind: "active" };

interface ResourceSnapshot {
  readonly definition: ResourceDefinition;
  readonly leases: readonly ResourceLease[];
  readonly receiver: ReceiverState | null;
  readonly emergencyStop: boolean;
}

interface SafeTransition {
  readonly resourceId: string;
  readonly reason: SafeReason;
}

interface SimulatedCommand {
  readonly resourceId: string;
  readonly ownerId: string;
  readonly fencingToken: string;
  readonly sequence: number;
  readonly active: boolean;
}

class ResourceAuthorityError extends Schema.TaggedError<
  ResourceAuthorityError,
  { readonly brand: unique symbol }
>()("ResourceAuthorityError", {
  reason: Schema.Literals([
    "invalid-definition",
    "invalid-claim",
    "invalid-ttl",
    "unknown-resource",
    "resource-conflict",
    "advisory-only",
    "unknown-lease",
    "unauthorized-command",
    "emergency-stop",
    "authority-closed",
  ]),
  resourceId: Schema.optional(Schema.String),
  conflictingOwnerId: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return `Resource authority rejected the operation (${this.reason}).`;
  }
}

export class ResourceAuthority extends Context.Service<
  ResourceAuthority,
  {
    readonly list: () => Effect.Effect<readonly ResourceSnapshot[]>;
    readonly acquire: (
      ownerId: string,
      claims: readonly ResourceClaim[],
      ttlMs: number,
    ) => Effect.Effect<readonly ResourceGrant[], ResourceAuthorityError>;
    readonly renew: (
      ownerId: string,
      leaseId: string,
      ttlMs: number,
    ) => Effect.Effect<ResourceGrant, ResourceAuthorityError>;
    readonly release: (
      ownerId: string,
      leaseId: string,
    ) => Effect.Effect<void, ResourceAuthorityError>;
    readonly handoff: (
      ownerId: string,
      leaseId: string,
      targetOwnerId: string,
      ttlMs: number,
    ) => Effect.Effect<ResourceGrant, ResourceAuthorityError>;
    readonly receive: (
      command: SimulatedCommand,
    ) => Effect.Effect<ReceiverState, ResourceAuthorityError>;
    readonly disconnect: (ownerId: string) => Effect.Effect<void>;
    readonly emergencyStop: (resourceId: string) => Effect.Effect<void, ResourceAuthorityError>;
    readonly resetEmergencyStop: (
      resourceId: string,
    ) => Effect.Effect<void, ResourceAuthorityError>;
    readonly safeTransitions: Stream.Stream<SafeTransition>;
  }
>()("t3/robotics/ResourceAuthority") {}

interface ActiveLease {
  grant: ResourceGrant;
  expiresMonotonicMs: number;
  commandDeadlineMs: number;
  lastSequence: number;
}

interface ResourceState {
  readonly definition: ResourceDefinition;
  readonly leases: Map<string, ActiveLease>;
  writer: ActiveLease | null;
  receiver: ReceiverState | null;
  emergencyStop: boolean;
}

const isPositiveDuration = (value: number) =>
  Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;

const make = Effect.fn("ResourceAuthority.make")(function* (
  definitions: readonly ResourceDefinition[],
) {
  const clock = yield* Clock.Clock;
  const wakeup = yield* Queue.sliding<void>(1);
  const safeEvents = yield* PubSub.sliding<SafeTransition>(64);
  const resources = new Map<string, ResourceState>();
  const leases = new Map<string, { state: ResourceState; lease: ActiveLease }>();
  let closed = false;

  for (const definition of definitions) {
    if (
      !definition.id.trim() ||
      resources.has(definition.id) ||
      (definition.policy !== "strict" &&
        definition.policy !== "single-writer-multiple-observers") ||
      (definition.enforcement.kind !== "simulation" &&
        definition.enforcement.kind !== "advisory-only") ||
      !isPositiveDuration(definition.maxLeaseMs) ||
      (definition.enforcement.kind === "simulation" &&
        !isPositiveDuration(definition.enforcement.commandTimeoutMs))
    ) {
      return yield* new ResourceAuthorityError({
        reason: "invalid-definition",
        resourceId: definition.id,
      });
    }
    resources.set(definition.id, {
      definition: Object.freeze({
        ...definition,
        enforcement: Object.freeze({ ...definition.enforcement }),
      }),
      leases: new Map(),
      writer: null,
      receiver:
        definition.enforcement.kind === "simulation" ? { kind: "safe", reason: "startup" } : null,
      emergencyStop: false,
    });
  }

  const monotonicMs = () => Number(clock.monotonicTimeNanosUnsafe() / 1_000_000n);
  const wake = () => Queue.offerUnsafe(wakeup, undefined);
  const setSafe = (state: ResourceState, reason: SafeReason): ReceiverState => {
    const safe = { kind: "safe", reason } as const;
    state.receiver = safe;
    PubSub.publishUnsafe(safeEvents, { resourceId: state.definition.id, reason });
    return safe;
  };

  const uninstall = (state: ResourceState, lease: ActiveLease, reason: SafeReason) => {
    state.leases.delete(lease.grant.id);
    leases.delete(lease.grant.id);
    if (state.writer === lease) {
      state.writer = null;
      setSafe(state, reason);
    }
  };

  const removeIfExpired = (state: ResourceState, lease: ActiveLease, now: number) => {
    if (Math.min(lease.expiresMonotonicMs, lease.commandDeadlineMs) > now) return false;
    uninstall(
      state,
      lease,
      lease.expiresMonotonicMs <= lease.commandDeadlineMs ? "lease-expired" : "command-timeout",
    );
    return true;
  };

  const reap = (now: number) => {
    let nextDeadline = Infinity;
    for (const { state, lease } of leases.values()) {
      if (!removeIfExpired(state, lease, now)) {
        nextDeadline = Math.min(nextDeadline, lease.expiresMonotonicMs, lease.commandDeadlineMs);
      }
    }
    return nextDeadline;
  };

  // One bounded wakeup slot lets the receiver reschedule without queuing every command.
  yield* Effect.gen(function* () {
    const now = monotonicMs();
    const nextDeadline = reap(now);
    yield* nextDeadline === Infinity
      ? Queue.take(wakeup)
      : Queue.take(wakeup).pipe(
          Effect.timeoutOrElse({ duration: nextDeadline - now, orElse: () => Effect.void }),
        );
  }).pipe(Effect.forever, Effect.forkScoped({ startImmediately: true }));

  const currentTime = () => {
    const now = monotonicMs();
    reap(now);
    return now;
  };

  const makeLease = (
    state: ResourceState,
    access: ResourceAccess,
    ownerId: string,
    ttlMs: number,
    now: number,
  ): ActiveLease => ({
    grant: {
      id: SecureRandom.uuidV4Unsafe(),
      resourceId: state.definition.id,
      access,
      ownerId,
      expiresAt: clock.currentTimeMillisUnsafe() + ttlMs,
      fencingToken: access === "write" ? SecureRandom.uuidV4Unsafe() : null,
    },
    expiresMonotonicMs: now + ttlMs,
    commandDeadlineMs:
      access === "write" && state.definition.enforcement.kind === "simulation"
        ? now + state.definition.enforcement.commandTimeoutMs
        : Infinity,
    lastSequence: -1,
  });

  const install = (state: ResourceState, lease: ActiveLease) => {
    state.leases.set(lease.grant.id, lease);
    leases.set(lease.grant.id, { state, lease });
    if (lease.grant.access === "write") state.writer = lease;
  };

  const validateTtl = (state: ResourceState, ttlMs: number) =>
    !isPositiveDuration(ttlMs) || ttlMs > state.definition.maxLeaseMs
      ? new ResourceAuthorityError({ reason: "invalid-ttl", resourceId: state.definition.id })
      : null;

  const ownedLease = (ownerId: string, leaseId: string) => {
    const entry = leases.get(leaseId);
    return entry?.lease.grant.ownerId === ownerId ? entry : undefined;
  };

  const list = Effect.fn("ResourceAuthority.list")(() =>
    Effect.sync(() => {
      currentTime();
      return Array.from(resources.values(), (state): ResourceSnapshot => ({
        definition: state.definition,
        leases: Array.from(state.leases.values(), ({ grant }) => ({
          id: grant.id,
          resourceId: grant.resourceId,
          access: grant.access,
          ownerId: grant.ownerId,
          expiresAt: grant.expiresAt,
        })),
        receiver: state.receiver && { ...state.receiver },
        emergencyStop: state.emergencyStop,
      }));
    }),
  );

  const acquire: ResourceAuthority["Service"]["acquire"] = Effect.fn("ResourceAuthority.acquire")(
    function* (ownerId, claims, ttlMs) {
      if (closed) return yield* new ResourceAuthorityError({ reason: "authority-closed" });
      const now = currentTime();
      if (!ownerId.trim() || claims.length === 0) {
        return yield* new ResourceAuthorityError({ reason: "invalid-claim" });
      }

      // Check every claim before mutating the registry, with no Effect suspension in between.
      const pending = new Map<ResourceState, ResourceAccess>();
      for (const claim of claims) {
        const { resourceId, access } = claim;
        const state = resources.get(resourceId);
        if (!state)
          return yield* new ResourceAuthorityError({ reason: "unknown-resource", resourceId });
        if (pending.has(state) || (access !== "observe" && access !== "write")) {
          return yield* new ResourceAuthorityError({ reason: "invalid-claim", resourceId });
        }
        const invalidTtl = validateTtl(state, ttlMs);
        if (invalidTtl) return yield* invalidTtl;
        if (access === "write") {
          if (state.definition.enforcement.kind !== "simulation") {
            return yield* new ResourceAuthorityError({ reason: "advisory-only", resourceId });
          }
          if (state.emergencyStop) {
            return yield* new ResourceAuthorityError({ reason: "emergency-stop", resourceId });
          }
        }

        const conflict =
          access === "write" && state.definition.policy === "strict"
            ? state.leases.values().next().value
            : access === "write" || state.definition.policy === "strict"
              ? state.writer
              : null;
        if (conflict) {
          return yield* new ResourceAuthorityError({
            reason: "resource-conflict",
            resourceId,
            conflictingOwnerId: conflict.grant.ownerId,
          });
        }
        pending.set(state, access);
      }

      const entries = Array.from(pending, ([state, access]) => ({
        state,
        lease: makeLease(state, access, ownerId, ttlMs, now),
      }));
      for (const { state, lease } of entries) install(state, lease);
      wake();
      return entries.map(({ lease }) => ({ ...lease.grant }));
    },
  );

  const renew: ResourceAuthority["Service"]["renew"] = Effect.fn("ResourceAuthority.renew")(
    function* (ownerId, leaseId, ttlMs) {
      const now = currentTime();
      const entry = ownedLease(ownerId, leaseId);
      if (!entry) return yield* new ResourceAuthorityError({ reason: "unknown-lease" });
      const { state, lease } = entry;
      const invalidTtl = validateTtl(state, ttlMs);
      if (invalidTtl) return yield* invalidTtl;

      lease.expiresMonotonicMs = now + ttlMs;
      lease.grant = { ...lease.grant, expiresAt: clock.currentTimeMillisUnsafe() + ttlMs };
      wake();
      return { ...lease.grant };
    },
  );

  const release: ResourceAuthority["Service"]["release"] = Effect.fn("ResourceAuthority.release")(
    function* (ownerId, leaseId) {
      currentTime();
      const entry = ownedLease(ownerId, leaseId);
      if (!entry) return yield* new ResourceAuthorityError({ reason: "unknown-lease" });
      uninstall(entry.state, entry.lease, "released");
      wake();
    },
  );

  const handoff: ResourceAuthority["Service"]["handoff"] = Effect.fn("ResourceAuthority.handoff")(
    function* (ownerId, leaseId, targetOwnerId, ttlMs) {
      const now = currentTime();
      const entry = ownedLease(ownerId, leaseId);
      if (!entry) return yield* new ResourceAuthorityError({ reason: "unknown-lease" });
      const { state, lease } = entry;
      if (!targetOwnerId.trim() || ownerId === targetOwnerId || state.writer !== lease) {
        return yield* new ResourceAuthorityError({
          reason: "invalid-claim",
          resourceId: state.definition.id,
        });
      }
      const invalidTtl = validateTtl(state, ttlMs);
      if (invalidTtl) return yield* invalidTtl;

      const next = makeLease(state, "write", targetOwnerId, ttlMs, now);
      uninstall(state, lease, "handoff");
      install(state, next);
      wake();
      return { ...next.grant };
    },
  );

  const receive: ResourceAuthority["Service"]["receive"] = Effect.fn("ResourceAuthority.receive")(
    function* (command) {
      const now = monotonicMs();
      const { resourceId, ownerId, fencingToken, sequence, active } = command;
      const state = resources.get(resourceId);
      if (!state)
        return yield* new ResourceAuthorityError({ reason: "unknown-resource", resourceId });
      if (state.definition.enforcement.kind !== "simulation") {
        return yield* new ResourceAuthorityError({ reason: "advisory-only", resourceId });
      }
      const writer = state.writer;
      if (
        state.emergencyStop ||
        !writer ||
        removeIfExpired(state, writer, now) ||
        writer.grant.ownerId !== ownerId ||
        writer.grant.fencingToken !== fencingToken ||
        !Number.isSafeInteger(sequence) ||
        sequence <= writer.lastSequence ||
        typeof active !== "boolean"
      ) {
        return yield* new ResourceAuthorityError({ reason: "unauthorized-command", resourceId });
      }

      writer.lastSequence = sequence;
      writer.commandDeadlineMs = now + state.definition.enforcement.commandTimeoutMs;
      if (!active) return { ...setSafe(state, "commanded") };
      const next = { kind: "active" } as const;
      state.receiver = next;
      return { ...next };
    },
  );

  const disconnect = Effect.fn("ResourceAuthority.disconnect")((ownerId: string) =>
    Effect.sync(() => {
      currentTime();
      for (const { state, lease } of leases.values()) {
        if (lease.grant.ownerId === ownerId) uninstall(state, lease, "disconnected");
      }
      wake();
    }),
  );

  const emergencyStop = Effect.fn("ResourceAuthority.emergencyStop")(function* (
    resourceId: string,
  ) {
    currentTime();
    const state = resources.get(resourceId);
    if (!state)
      return yield* new ResourceAuthorityError({ reason: "unknown-resource", resourceId });
    if (state.receiver === null) {
      return yield* new ResourceAuthorityError({ reason: "advisory-only", resourceId });
    }
    if (state.emergencyStop) return;
    state.emergencyStop = true;
    if (state.writer) {
      uninstall(state, state.writer, "emergency-stop");
    } else {
      setSafe(state, "emergency-stop");
    }
    wake();
  });

  const resetEmergencyStop = Effect.fn("ResourceAuthority.resetEmergencyStop")(function* (
    resourceId: string,
  ) {
    const state = resources.get(resourceId);
    if (!state)
      return yield* new ResourceAuthorityError({ reason: "unknown-resource", resourceId });
    if (state.receiver === null) {
      return yield* new ResourceAuthorityError({ reason: "advisory-only", resourceId });
    }
    if (state.emergencyStop) {
      state.emergencyStop = false;
      setSafe(state, "reset");
    }
  });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
      for (const { state, lease } of leases.values()) {
        uninstall(state, lease, "disconnected");
      }
    }),
  );

  return ResourceAuthority.of({
    list,
    acquire,
    renew,
    release,
    handoff,
    receive,
    disconnect,
    emergencyStop,
    resetEmergencyStop,
    safeTransitions: Stream.fromPubSub(safeEvents),
  });
});

export const layer = (definitions: readonly ResourceDefinition[]) =>
  Layer.effect(ResourceAuthority, make(definitions));
