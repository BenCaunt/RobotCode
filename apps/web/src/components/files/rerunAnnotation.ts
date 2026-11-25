import type { WebViewer } from "@rerun-io/web-viewer";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { formatReviewCommentFence } from "~/reviewCommentContext";

const MAX_ANNOTATION_BYTES = 32_768;

export type RerunAnnotationLocation = Awaited<ReturnType<typeof captureRerunAnnotationLocation>>;
export interface RerunAnnotationReference {
  readonly annotationId: string;
  readonly artifactId: string;
  readonly projectId: ProjectId;
}

export async function captureRerunAnnotationLocation(
  viewer: Pick<WebViewer, "getState" | "getSelection">,
) {
  const [state, selection] = await Promise.all([viewer.getState(), viewer.getSelection()]);
  const recording = state.recordings.find((item) => item.storeId === state.activeStoreId);
  const cursor = recording?.currentTime;
  if (!recording || !cursor || cursor.time === undefined) throw new Error("No recording cursor");
  return {
    recordingId: recording.storeId,
    timeline: cursor.timeline,
    time: cursor.time.toString(),
    timeType:
      cursor.timeType ??
      recording.timelines.find((timeline) => timeline.name === cursor.timeline)?.timeType,
    selection: selection.storeId === recording.storeId ? selection.items : [],
    views: state.views.map(({ viewId, name, class: viewClass, origin, visible }) => ({
      viewId,
      name,
      class: viewClass,
      origin,
      visible,
    })),
  };
}

export function formatRerunAnnotation(input: {
  readonly path: string;
  readonly environmentId: EnvironmentId;
  readonly fileRevision: string | undefined;
  readonly location: RerunAnnotationLocation;
  readonly comment: string;
  readonly reference?: RerunAnnotationReference | undefined;
}) {
  const { location, comment, reference, ...source } = input;
  const json = JSON.stringify(
    { ...source, ...reference, ...location, comment: comment.trim() },
    (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
  if (new TextEncoder().encode(json).byteLength > MAX_ANNOTATION_BYTES) return null;
  // oxlint-disable-next-line t3code/no-untranslated-copy -- this labels evidence in the agent's draft
  return `Rerun recording annotation\n\n${formatReviewCommentFence("json", json)}`;
}
