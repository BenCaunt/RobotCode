import type { WebViewer } from "@rerun-io/web-viewer";
import type { ReplayCitation } from "@t3tools/shared/evaluationReport";

export async function verifiedEvidenceBlob(url: string, digest: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const worker = new Worker(new URL("./verifyRecording.worker.ts", import.meta.url), {
    type: "module",
  });
  const { promise, resolve, reject } = Promise.withResolvers<Blob | null>();
  const abort = () => reject(signal.reason);
  try {
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<Blob | null | "error">) => {
      if (event.data === "error") reject(new Error("Recording unavailable"));
      else resolve(event.data);
    };
    worker.onerror = worker.onmessageerror = () => reject(new Error("Verification failed"));
    worker.postMessage({ url, digest }, []);
    return await promise;
  } finally {
    signal.removeEventListener("abort", abort);
    worker.terminate();
  }
}

export async function seekCitation(
  viewer: Pick<WebViewer, "getState" | "setLocation" | "setTime">,
  citation: ReplayCitation,
  signal: AbortSignal,
) {
  const { recordings } = await viewer.getState();
  const recording = citation.recordingId
    ? recordings.find((item) => item.storeId === citation.recordingId)
    : recordings.length === 1
      ? recordings[0]
      : undefined;
  const timeline = recording?.timelines.find(
    (item) => item.name === citation.timeline && item.timeType === citation.timeType,
  );
  const time = BigInt(citation.time);
  if (
    !recording ||
    !timeline?.timeRange ||
    time < timeline.timeRange.start ||
    time > timeline.timeRange.end
  )
    throw new Error("Recording position unavailable");
  signal.throwIfAborted();
  await viewer.setLocation(recording.location);
  signal.throwIfAborted();
  await viewer.setTime({
    recording: recording.storeId,
    timeline: timeline.name,
    playState: "paused",
    ...(citation.timeType === "sequence"
      ? { sequence: time }
      : citation.timeType === "duration"
        ? { durationNanos: time }
        : { timestampNanos: time }),
  });
}
