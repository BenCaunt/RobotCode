import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ResourceAuthority from "../src/robotics/ResourceAuthority.ts";

const resourceId = "simulation/drive";
const claim = [{ resourceId, access: "write" }] as const;
const ttlMs = 5_000;
const layer = ResourceAuthority.layer([
  {
    id: resourceId,
    policy: "single-writer-multiple-observers",
    maxLeaseMs: ttlMs,
    enforcement: { kind: "simulation", commandTimeoutMs: 1_000 },
  },
]);

const simulate = Effect.gen(function* () {
  const authority = yield* ResourceAuthority.ResourceAuthority;
  const [first] = yield* authority.acquire("publisher-a", claim, ttlMs);
  if (!first?.fencingToken) return yield* Effect.die("The first publisher received no fence.");

  const conflict = yield* Effect.flip(authority.acquire("publisher-b", claim, ttlMs));
  const packet = {
    resourceId,
    ownerId: first.ownerId,
    fencingToken: first.fencingToken,
    sequence: 0,
    active: true,
  };
  const firstCommand = yield* authority.receive(packet);

  const successor = yield* authority.handoff(first.ownerId, first.id, "publisher-b", ttlMs);
  if (!successor.fencingToken) return yield* Effect.die("The second publisher received no fence.");
  const afterHandoff = (yield* authority.list())[0]?.receiver;
  const stale = yield* Effect.flip(authority.receive({ ...packet, sequence: 1 }));
  const watchdog = yield* authority.safeTransitions.pipe(
    Stream.runHead,
    Effect.forkScoped({ startImmediately: true }),
  );
  const secondCommand = yield* authority.receive({
    ...packet,
    ownerId: successor.ownerId,
    fencingToken: successor.fencingToken,
  });
  const stopped = yield* Fiber.join(watchdog).pipe(Effect.timeout("3 seconds"));
  if (
    conflict.reason !== "resource-conflict" ||
    stale.reason !== "unauthorized-command" ||
    afterHandoff?.kind !== "safe" ||
    afterHandoff.reason !== "handoff" ||
    Option.isNone(stopped) ||
    stopped.value.reason !== "command-timeout"
  ) {
    return yield* Effect.die("The simulated authority did not enforce the expected transition.");
  }
  return {
    resourceId,
    firstCommand,
    secondPublisherBeforeHandoff: conflict.reason,
    afterHandoff,
    stalePublisherAfterHandoff: stale.reason,
    secondCommand,
    watchdog: stopped.value,
  };
}).pipe(Effect.scoped, Effect.provide(layer));

const result = await Effect.runPromise(simulate);
await Effect.runPromise(Console.log(JSON.stringify(result, null, 2)));
