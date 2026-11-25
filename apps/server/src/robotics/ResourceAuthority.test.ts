import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ResourceAuthority from "./ResourceAuthority.ts";

const drive = "simulation/drive";
const exclusiveSensor = "simulation/calibration";
const legacy = "legacy/locomotion";
const simulation = { kind: "simulation", commandTimeoutMs: 50 } as const;

const layerTest = ResourceAuthority.layer([
  {
    id: drive,
    policy: "single-writer-multiple-observers",
    maxLeaseMs: 1_000,
    enforcement: simulation,
  },
  {
    id: exclusiveSensor,
    policy: "strict",
    maxLeaseMs: 1_000,
    enforcement: simulation,
  },
  {
    id: legacy,
    policy: "single-writer-multiple-observers",
    maxLeaseMs: 1_000,
    enforcement: { kind: "advisory-only" },
  },
]);

const write = (resourceId: string) => ({ resourceId, access: "write" as const });
const observe = (resourceId: string) => ({ resourceId, access: "observe" as const });

describe("ResourceAuthority", () => {
  it.effect("reserves a group atomically and enforces both observation policies", () =>
    Effect.gen(function* () {
      const authority = yield* ResourceAuthority.ResourceAuthority;
      yield* authority.acquire("observer", [observe(exclusiveSensor)], 100);

      const conflict = yield* Effect.flip(
        authority.acquire("candidate", [write(drive), write(exclusiveSensor)], 100),
      );
      expect(conflict).toMatchObject({
        reason: "resource-conflict",
        resourceId: exclusiveSensor,
        conflictingOwnerId: "observer",
      });
      expect(
        (yield* authority.list()).find(({ definition }) => definition.id === drive)?.leases,
      ).toEqual([]);

      const attempts = yield* Effect.forEach(
        ["publisher-a", "publisher-b"],
        (owner) => authority.acquire(owner, [write(drive)], 100).pipe(Effect.result),
        { concurrency: "unbounded" },
      );
      expect(attempts.filter((result) => result._tag === "Success")).toHaveLength(1);
      expect(attempts.filter((result) => result._tag === "Failure")).toHaveLength(1);
      yield* authority.acquire("observer", [observe(drive)], 100);
      expect(
        (yield* Effect.flip(authority.acquire("controller", [write(legacy)], 100))).reason,
      ).toBe("advisory-only");
      const driveSnapshot = (yield* authority.list()).find(
        ({ definition }) => definition.id === drive,
      );
      expect(driveSnapshot?.leases).toHaveLength(2);
      expect(driveSnapshot?.leases[0]).not.toHaveProperty("fencingToken");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("stops on lease expiry and rejects an expired publisher after reacquisition", () =>
    Effect.gen(function* () {
      const authority = yield* ResourceAuthority.ResourceAuthority;
      const [old] = yield* authority.acquire("controller", [write(drive)], 25);
      if (!old?.fencingToken) return yield* Effect.die("Expected a writer grant");
      const packet = {
        resourceId: drive,
        ownerId: old.ownerId,
        fencingToken: old.fencingToken,
        sequence: 0,
        active: true,
      };

      expect(yield* authority.receive(packet)).toEqual({ kind: "active" });
      expect((yield* Effect.flip(authority.receive(packet))).reason).toBe("unauthorized-command");

      const stopped = yield* authority.safeTransitions.pipe(
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* TestClock.adjust(25);
      expect(yield* Fiber.join(stopped)).toEqual(
        Option.some({ resourceId: drive, reason: "lease-expired" }),
      );

      const [fresh] = yield* authority.acquire("controller", [write(drive)], 100);
      expect(fresh?.fencingToken).not.toEqual(old.fencingToken);
      expect((yield* Effect.flip(authority.receive({ ...packet, sequence: 1 }))).reason).toBe(
        "unauthorized-command",
      );
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("stops on command loss even when lease renewal succeeds", () =>
    Effect.gen(function* () {
      const authority = yield* ResourceAuthority.ResourceAuthority;
      const [grant] = yield* authority.acquire("controller", [write(drive)], 60);
      if (!grant?.fencingToken) return yield* Effect.die("Expected a writer grant");
      const packet = {
        resourceId: drive,
        ownerId: grant.ownerId,
        fencingToken: grant.fencingToken,
        sequence: 0,
        active: true,
      };

      yield* authority.receive(packet);
      const stopped = yield* authority.safeTransitions.pipe(
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* TestClock.adjust(40);
      yield* authority.renew(grant.ownerId, grant.id, 100);
      yield* authority.receive({ ...packet, sequence: 1 });
      yield* TestClock.adjust(50);
      expect(yield* Fiber.join(stopped)).toEqual(
        Option.some({ resourceId: drive, reason: "command-timeout" }),
      );
      expect((yield* Effect.flip(authority.renew(grant.ownerId, grant.id, 100))).reason).toBe(
        "unknown-lease",
      );
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("passes through a safe state on handoff and invalidates the disconnected owner", () =>
    Effect.gen(function* () {
      const authority = yield* ResourceAuthority.ResourceAuthority;
      const [grant] = yield* authority.acquire("old", [write(drive)], 100);
      if (!grant?.fencingToken) return yield* Effect.die("Expected a writer grant");
      const old = {
        resourceId: drive,
        ownerId: grant.ownerId,
        fencingToken: grant.fencingToken,
        sequence: 0,
        active: true,
      };
      expect((yield* Effect.flip(authority.release("another-owner", grant.id))).reason).toBe(
        "unknown-lease",
      );
      yield* authority.receive(old);
      const next = yield* authority.handoff(grant.ownerId, grant.id, "new", 100);
      expect(
        (yield* authority.list()).find(({ definition }) => definition.id === drive)?.receiver,
      ).toEqual({ kind: "safe", reason: "handoff" });
      expect((yield* Effect.flip(authority.receive({ ...old, sequence: 1 }))).reason).toBe(
        "unauthorized-command",
      );
      if (!next.fencingToken) return yield* Effect.die("Expected a writer grant");
      const successor = { ...old, ownerId: next.ownerId, fencingToken: next.fencingToken };
      expect(yield* authority.receive(successor)).toEqual({ kind: "active" });
      yield* authority.disconnect(next.ownerId);
      expect(
        (yield* authority.list()).find(({ definition }) => definition.id === drive)?.receiver,
      ).toEqual({ kind: "safe", reason: "disconnected" });
      expect((yield* Effect.flip(authority.receive({ ...successor, sequence: 1 }))).reason).toBe(
        "unauthorized-command",
      );
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("latches the simulated emergency stop until an explicit reset", () =>
    Effect.gen(function* () {
      const authority = yield* ResourceAuthority.ResourceAuthority;
      const [grant] = yield* authority.acquire("controller", [write(drive)], 100);
      if (!grant?.fencingToken) return yield* Effect.die("Expected a writer grant");
      yield* authority.emergencyStop(drive);
      expect(
        (yield* Effect.flip(authority.acquire("controller", [write(drive)], 100))).reason,
      ).toBe("emergency-stop");
      yield* authority.resetEmergencyStop(drive);
      const packet = {
        resourceId: drive,
        ownerId: grant.ownerId,
        fencingToken: grant.fencingToken,
        sequence: 0,
        active: true,
      };
      expect((yield* Effect.flip(authority.receive(packet))).reason).toBe("unauthorized-command");
      yield* authority.acquire("controller", [write(drive)], 100);
    }).pipe(Effect.provide(layerTest)),
  );
});
