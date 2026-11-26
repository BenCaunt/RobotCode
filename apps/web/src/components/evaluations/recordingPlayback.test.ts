import type { WebViewer } from "@rerun-io/web-viewer";
import type { ReplayCitation } from "@t3tools/shared/evaluationReport";
import { expect, it, vi } from "vite-plus/test";
import { seekCitation } from "./recordingPlayback";

it("resolves multi-recording citations without rounding nanosecond timestamps", async () => {
  const first = "Recording:rover:first";
  const second = "Recording:rover:second";
  const time = 1_800_000_000_000_000_001n;
  const timeline = {
    name: "clock",
    timeType: "timestamp" as const,
    timeRange: { start: time - 1n, end: time + 1n },
  };
  const viewer = {
    getState: async () => ({
      location: "first",
      activeStoreId: first,
      loading: [],
      servers: [],
      views: [],
      recordings: [
        { storeId: first, store_id: first, location: "first", timelines: [timeline] },
        { storeId: second, store_id: second, location: "second", timelines: [timeline] },
      ],
    }),
    setLocation: vi.fn(async () => {}),
    setTime: vi.fn(async () => {}),
  } satisfies Pick<WebViewer, "getState" | "setLocation" | "setTime">;
  const citation: ReplayCitation = {
    id: "slip",
    label: "Wheel slip",
    path: "trial.rrd",
    timeType: "timestamp",
    timeline: "clock",
    time: String(time),
  };
  const signal = new AbortController().signal;
  await expect(seekCitation(viewer, citation, signal)).rejects.toThrow();
  await expect(
    seekCitation(viewer, { ...citation, recordingId: second, time: String(time + 2n) }, signal),
  ).rejects.toThrow();
  expect(viewer.setLocation).not.toHaveBeenCalled();
  await seekCitation(viewer, { ...citation, recordingId: second }, signal);
  expect(viewer.setLocation).toHaveBeenCalledWith("second");
  expect(viewer.setTime).toHaveBeenCalledWith({
    timeline: "clock",
    recording: second,
    playState: "paused",
    timestampNanos: time,
  });
});
