import type { WebViewer } from "@rerun-io/web-viewer";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  type EvaluationReport,
  type ReplayCitation,
  replayPosition,
} from "@t3tools/shared/evaluationReport";
import { isRerunRecordingPath } from "@t3tools/shared/filePreview";
import { Link, useSearch } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { CheckIcon, PlayIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAssetUrlState, useAssetUrlRefresh } from "~/assets/assetUrls";
import { Button } from "../ui/button";
import { verifiedEvidenceBlob, seekCitation } from "./recordingPlayback";

export function EvaluationReplay({
  report,
  seekRequest,
  onSeek,
  cwd,
  project,
  id,
  environmentId,
}: {
  report: EvaluationReport;
  seekRequest: number;
  onSeek: () => void;
  cwd: string;
  project: string;
  id: string;
  environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const { replay, view } = useSearch({ from: "/_chat/evaluations" });
  const recordings = report.evidence.filter((e) => isRerunRecordingPath(e.path));
  const citation = report.replayCitations?.find((item) => item.id === replay);
  const selected = recordings.find((e) => e.path === (citation?.path ?? replay));
  if (!recordings.length && !replay) return null;
  return (
    <section id="replay-evidence" className="min-w-0 space-y-3 border-t pt-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-semibold">{gt("Replay evidence")}</h3>
        {selected && (
          <Link
            className="text-xs underline"
            to="/evaluations"
            search={{ project, view, result: id }}
          >
            {gt("Close recording")}
          </Link>
        )}
      </div>
      {recordings.map((file) => (
        <div key={file.path} className="space-y-1">
          <Link
            to="/evaluations"
            hash="replay-evidence"
            search={{ project, view, result: id, replay: file.path }}
            className="inline-flex max-w-full items-center gap-2 text-sm font-medium hover:underline"
          >
            <PlayIcon className="size-4 shrink-0" />
            <span className="break-all">{file.path}</span>
          </Link>
          {report.replayCitations
            ?.filter((item) => item.path === file.path)
            .map((item) => (
              <Link
                key={item.id}
                to="/evaluations"
                hash="replay-evidence"
                search={{ project, view, result: id, replay: item.id }}
                onClick={replay === item.id ? onSeek : undefined}
                aria-current={replay === item.id ? "location" : undefined}
                className="flex w-fit max-w-full flex-wrap items-baseline gap-x-2 rounded px-2 py-1 text-sm hover:bg-muted aria-[current]:bg-muted"
              >
                <span className="font-mono text-xs text-muted-foreground">
                  {replayPosition(item)}
                </span>
                <span className="underline underline-offset-2">{item.label}</span>
              </Link>
            ))}
        </div>
      ))}
      {replay && !selected && <p role="alert">{gt("Recording position unavailable.")}</p>}
      {selected && (
        <ReplayAsset
          key={selected.path + selected.sha256}
          environmentId={environmentId}
          cwd={cwd}
          file={selected}
          seekRequest={seekRequest}
          citation={citation}
        />
      )}
    </section>
  );
}

function ReplayAsset({
  environmentId,
  cwd,
  file,
  citation,
  seekRequest,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  file: EvaluationReport["evidence"][number];
  citation: ReplayCitation | undefined;
  seekRequest: number;
}) {
  const gt = useGT();
  const resource = { _tag: "draft-workspace-file" as const, cwd, path: "./" + file.path };
  const asset = useAssetUrlState(environmentId, resource);
  const refresh = useAssetUrlRefresh(environmentId, resource);
  const [retry, setRetry] = useState<{ url: string; attempt: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const url = retry?.url ?? (asset._tag === "Success" ? asset.url : null);
  async function retryOpen() {
    const next = await refresh().catch(() => null);
    setFailed(!next);
    if (next) setRetry((old) => ({ url: next, attempt: (old?.attempt ?? 0) + 1 }));
  }
  if (failed || asset._tag === "Failure")
    return (
      <div role="alert">
        {gt("Unable to load Rerun recording.")} <Button onClick={retryOpen}>{gt("Retry")}</Button>
      </div>
    );
  return url ? (
    <ReplayViewer
      key={retry?.attempt ?? 0}
      url={url}
      digest={file.sha256}
      citation={citation}
      seekRequest={seekRequest}
      onRetry={retryOpen}
    />
  ) : (
    <p role="status">{gt("Loading…")}</p>
  );
}

function ReplayViewer({
  url,
  digest,
  citation,
  seekRequest,
  onRetry,
}: {
  url: string;
  digest: string;
  citation: ReplayCitation | undefined;
  seekRequest: number;
  onRetry: () => void;
}) {
  const gt = useGT();
  const host = useRef<HTMLDivElement>(null);
  const [source] = useState(url);
  const [viewer, setViewer] = useState<WebViewer | null>(null);
  const [status, setStatus] = useState<"verify" | "loading" | "ready" | "mismatch" | "error">(
    "verify",
  );
  const [seekError, setSeekError] = useState<{ citation: ReplayCitation; request: number }>();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the verified bytes and external Rerun viewer for this mounted recording
  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const controller = new AbortController();
    const { signal } = controller;
    let instance: WebViewer | undefined;
    let objectUrl: string | undefined;
    async function open(parent: HTMLDivElement) {
      const blob = await verifiedEvidenceBlob(source, digest, signal);
      signal.throwIfAborted();
      if (!blob) {
        setStatus("mismatch");
        return;
      }
      setStatus("loading");
      const { WebViewer } = await import("@rerun-io/web-viewer");
      signal.throwIfAborted();
      const player = new WebViewer();
      instance = player;
      await player.start(null, parent, {
        checkForUpdatesOnStartup: false,
        hideWelcomeScreen: true,
        allowFullscreen: true,
        memoryLimit: "512MB",
        width: "100%",
        height: "100%",
      });
      signal.throwIfAborted();
      objectUrl = URL.createObjectURL(blob);
      const opened = await player.open(objectUrl);
      let loading = opened.loading.length;
      while (loading) {
        signal.throwIfAborted();
        await new Promise((resolve) => setTimeout(resolve, 100));
        signal.throwIfAborted();
        loading = (await player.getState()).loading.length;
      }
      const state = await player.getState();
      signal.throwIfAborted();
      if (!state.recordings.length) throw new Error("Empty recording");
      setViewer(player);
      setStatus("ready");
    }
    void open(parent).catch(() => {
      if (signal.aborted) return;
      instance?.stop();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setStatus("error");
    });
    return () => {
      controller.abort();
      instance?.stop();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [source, digest]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a citation link drives the time cursor in the external viewer
  useEffect(() => {
    if (!citation || !viewer) return;
    const controller = new AbortController();
    void seekCitation(viewer, citation, controller.signal)
      .then(() => {
        if (!controller.signal.aborted) setSeekError(undefined);
      })
      .catch(() => {
        if (!controller.signal.aborted) setSeekError({ citation, request: seekRequest });
      });
    return () => controller.abort();
  }, [viewer, citation, seekRequest]);
  return (
    <div className="space-y-2">
      {status === "mismatch" || status === "error" ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm"
        >
          {status === "mismatch"
            ? gt("This recording differs from the published evidence.")
            : gt("Unable to load Rerun recording.")}
          <Button variant="outline" size="sm" onClick={onRetry}>
            {gt("Retry")}
          </Button>
        </div>
      ) : null}
      {status === "verify" || status === "loading" ? (
        <p role="status" className="text-sm text-muted-foreground">
          {status === "verify" ? gt("Verifying recording…") : gt("Loading…")}
        </p>
      ) : null}
      {status === "ready" && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
          <CheckIcon aria-hidden className="size-3.5" /> {gt("Verified recording")}
          <code>{digest.slice(0, 12)}</code>
        </p>
      )}
      {citation && seekError?.citation === citation && seekError.request === seekRequest && (
        <p role="alert">{gt("Recording position unavailable.")}</p>
      )}
      <div
        ref={host}
        className={
          status === "ready" || status === "loading"
            ? "relative h-[min(65vh,36rem)] overflow-hidden rounded-md border"
            : "hidden"
        }
      />
    </div>
  );
}
