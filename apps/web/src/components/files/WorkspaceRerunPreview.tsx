import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ProjectId,
  type ScopedThreadRef,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { workspaceRelativeFilePath } from "@t3tools/shared/path";
import type { WebViewer } from "@rerun-io/web-viewer";
import { T, useGT } from "gt-react";
import { type RefObject, useEffect, useRef, useState } from "react";

import { useAssetUrlRefresh, useAssetUrlState } from "~/assets/assetUrls";
import { useComposerHandleContext } from "~/composerHandleContext";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { connectionAtomRuntime } from "~/connection/runtime";
import { randomUUID } from "~/lib/utils";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { workspaceAssetResource } from "./filePreviewMode";
import { FileSurfaceFailure, FileSurfaceLoading } from "./fileSurfaceChrome";
import {
  captureRerunAnnotationLocation,
  formatRerunAnnotation,
  type RerunAnnotationLocation,
  type RerunAnnotationReference,
} from "./rerunAnnotation";

const MAX_COMMENT_LENGTH = 4_000;
const loadViewer = () => import("@rerun-io/web-viewer");
const createAnnotation = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:robotics:annotation:create",
  tag: WS_METHODS.roboticsAnnotationCreate,
});

export function WorkspaceRerunPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | undefined;
  readonly threadRef: ScopedThreadRef;
  readonly draft: boolean;
  readonly absolutePath: string;
  readonly workspaceRoot: string;
}) {
  const gt = useGT();
  const resource = workspaceAssetResource({ ...props, kind: "media-file" });
  const asset = useAssetUrlState(props.environmentId, resource);
  const refresh = useAssetUrlRefresh(props.environmentId, resource);
  const [generation, setGeneration] = useState(0);
  const [retrying, setRetrying] = useState(false);

  async function retry() {
    setRetrying(true);
    const url = await refresh().catch(() => null);
    if (url !== null) setGeneration((value) => value + 1);
    setRetrying(false);
  }

  if (retrying || asset._tag === "Loading") return <FileSurfaceLoading />;
  if (asset._tag === "Failure") {
    return <FileSurfaceFailure message={gt("Unable to load Rerun recording.")} onRetry={retry} />;
  }
  return (
    <RerunPreview
      key={generation}
      sourceUrl={asset.url}
      fileRevision={asset.fileRevision}
      path={props.absolutePath}
      environmentId={props.environmentId}
      projectId={
        workspaceRelativeFilePath(props.absolutePath, props.workspaceRoot) === null
          ? undefined
          : props.projectId
      }
      threadId={props.draft ? undefined : props.threadRef.threadId}
      onRetry={retry}
    />
  );
}

type ViewerState = "starting" | "loading" | "open" | "failed" | "closed";

function RerunPreview(props: {
  readonly sourceUrl: string;
  readonly fileRevision: string | undefined;
  readonly path: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | undefined;
  readonly threadId: ThreadId | undefined;
  readonly onRetry: () => void;
}) {
  const gt = useGT();
  const composerRef = useComposerHandleContext();
  const viewerRef = useRef<WebViewer | null>(null);
  const [source] = useState({ url: props.sourceUrl, revision: props.fileRevision });
  const [state, setState] = useState<ViewerState>("starting");
  const [location, setLocation] = useState<RerunAnnotationLocation | null>(null);
  const [comment, setComment] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<RerunAnnotationReference | undefined>();
  const saveAttempt = useRef<{ comment: string; idempotencyKey: string; pending: boolean } | null>(
    null,
  );
  const save = useAtomCommand(createAnnotation, { reportFailure: false });
  const canSave = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const [annotationError, setAnnotationError] = useState<
    "capture" | "size" | "composer" | "save" | null
  >(null);

  async function annotate() {
    const viewer = viewerRef.current;
    if (viewer === null) return;
    setCapturing(true);
    const captured = await captureRerunAnnotationLocation(viewer).catch(() => null);
    if (viewerRef.current !== viewer) return;
    setCapturing(false);
    setAnnotationError(captured === null ? "capture" : null);
    setLocation(captured);
  }

  function resetAnnotation() {
    setLocation(null);
    setComment("");
    setSaved(undefined);
    saveAttempt.current = null;
    setAnnotationError(null);
  }

  async function addToChat() {
    const note = comment.trim();
    if (!location || note.length === 0 || saveAttempt.current?.pending) return;
    const composer = composerRef?.current;
    if (!composer) {
      setAnnotationError("composer");
      return;
    }
    const annotationInput = {
      path: props.path,
      environmentId: props.environmentId,
      fileRevision: source.revision,
      location,
      comment: note,
    };
    let annotation = formatRerunAnnotation({ ...annotationInput, reference: saved });
    if (annotation === null) {
      setAnnotationError("size");
      return;
    }
    const { projectId, threadId } = props;
    if (projectId && !saved) {
      if (!canSave || !source.revision || !location.timeType) {
        setAnnotationError("save");
        return;
      }
      const viewer = viewerRef.current;
      const previousAttempt = saveAttempt.current;
      const idempotencyKey =
        previousAttempt?.comment === note ? previousAttempt.idempotencyKey : randomUUID();
      saveAttempt.current = { comment: note, idempotencyKey, pending: true };
      setSaving(true);
      setAnnotationError(null);
      const result = await save({
        environmentId: props.environmentId,
        input: {
          projectId,
          idempotencyKey,
          recording: {
            path: props.path,
            version: source.revision,
            recordingId: location.recordingId,
          },
          timeline: location.timeline,
          timeType: location.timeType,
          start: location.time,
          entityPaths: [
            ...new Set(
              location.selection.flatMap((item) => ("entityPath" in item ? [item.entityPath] : [])),
            ),
          ],
          views: location.views,
          comment: note,
          ...(threadId === undefined ? {} : { threadId }),
        },
      }).catch(() => null);
      if (viewerRef.current !== viewer) return;
      saveAttempt.current = { comment: note, idempotencyKey, pending: false };
      setSaving(false);
      if (result?._tag !== "Success") {
        setAnnotationError("save");
        return;
      }
      const reference = {
        projectId,
        annotationId: result.value.annotationId,
        artifactId: result.value.recording.artifactId,
      };
      setSaved(reference);
      annotation = formatRerunAnnotation({ ...annotationInput, reference });
      if (annotation === null) {
        setAnnotationError("size");
        return;
      }
    }
    const separator = composer.getSendContext().prompt.trim() ? "\n\n" : "";
    const inserted =
      composerRef?.current === composer && composer.insertTextAtEnd(separator + annotation);
    if (!inserted) {
      setAnnotationError("composer");
      return;
    }
    resetAnnotation();
    toastManager.add({ type: "success", title: gt("Added to chat") });
  }

  if (state === "failed") {
    return (
      <FileSurfaceFailure message={gt("Unable to load Rerun recording.")} onRetry={props.onRetry} />
    );
  }
  if (state === "closed") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <Button variant="outline" size="sm" onClick={props.onRetry}>
          <T>Open recording</T>
        </Button>
      </div>
    );
  }
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 justify-end gap-2 border-b px-2 py-1">
        <Button
          size="xs"
          variant="ghost"
          disabled={state !== "open" || capturing || location !== null}
          onClick={annotate}
        >
          <T>Annotate recording</T>
        </Button>
        <Button size="xs" variant="ghost" disabled={saving} onClick={() => setState("closed")}>
          <T>Close recording</T>
        </Button>
      </div>
      {location ? (
        <form
          className="flex shrink-0 flex-col gap-2 border-b px-2 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            addToChat();
          }}
        >
          <code className="truncate text-xs text-muted-foreground">
            {location.timeline} · {location.time}
          </code>
          <Textarea
            size="sm"
            aria-label={gt("Recording comment")}
            placeholder={gt("Recording comment")}
            value={comment}
            maxLength={MAX_COMMENT_LENGTH}
            readOnly={saving || saved !== undefined}
            onChange={(event) => setComment(event.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={saving}
              onClick={resetAnnotation}
            >
              <T>Cancel</T>
            </Button>
            <Button type="submit" size="xs" disabled={saving || comment.trim().length === 0}>
              {saving ? gt("Saving…") : <T>Add to chat</T>}
            </Button>
          </div>
        </form>
      ) : null}
      {annotationError ? (
        <p role="alert" className="shrink-0 border-b px-2 py-1 text-xs text-destructive">
          {annotationError === "capture"
            ? gt("Unable to capture the recording position.")
            : annotationError === "size"
              ? gt("The recording selection is too large to add to chat.")
              : annotationError === "save"
                ? gt("Could not save the comment")
                : gt("The chat isn't ready to accept input right now.")}
        </p>
      ) : null}
      <RerunCanvas sourceUrl={source.url} onState={setState} viewerRef={viewerRef} />
      {state === "starting" ? (
        <FileSurfaceLoading className="pointer-events-none absolute inset-x-0 top-8 bottom-0" />
      ) : null}
    </div>
  );
}

function RerunCanvas(props: {
  readonly sourceUrl: string;
  readonly onState: (state: "loading" | "open" | "failed") => void;
  readonly viewerRef: RefObject<WebViewer | null>;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const { sourceUrl, onState, viewerRef } = props;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- binds the external viewer to this mounted canvas
  useEffect(() => {
    const parent = parentRef.current;
    if (parent === null) return;
    let active = true;
    let stop: (() => void) | undefined;
    void loadViewer()
      .then(async ({ WebViewer }) => {
        if (!active) return;
        const viewer = new WebViewer();
        const unsubscribe = viewer.once("recording_open", () => {
          if (active) onState("open");
        });
        stop = () => {
          viewerRef.current = null;
          unsubscribe();
          viewer.stop();
        };
        await viewer.start(null, parent, {
          checkForUpdatesOnStartup: false,
          hideWelcomeScreen: true,
          memoryLimit: "512MB",
          width: "100%",
          height: "100%",
        });
        if (!active) return;
        viewerRef.current = viewer;
        onState("loading");
        // The URL loader decodes the HTTP response incrementally. The JS byte channel loads a complete RRD per call.
        const { storeIds, loading } = await viewer.open(sourceUrl);
        if (!active) return;
        if (storeIds.length > 0) onState("open");
        else if (loading.length === 0) onState("failed");
      })
      .catch(() => {
        if (active) onState("failed");
      });
    return () => {
      active = false;
      stop?.();
    };
  }, [sourceUrl, onState, viewerRef]);

  return <div ref={parentRef} className="relative min-h-0 flex-1 overflow-hidden" />;
}
