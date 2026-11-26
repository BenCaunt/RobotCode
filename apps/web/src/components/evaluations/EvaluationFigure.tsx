import type { EnvironmentId } from "@t3tools/contracts";
import type { EvaluationReport } from "@t3tools/shared/evaluationReport";
import { workspaceRelativeFilePath } from "@t3tools/shared/path";
import { useGT } from "gt-react";
import { useEffect, useState } from "react";
import { useAssetUrlState } from "~/assets/assetUrls";
import { verifiedEvidenceBlob } from "./recordingPlayback";

export function findFigureEvidence(report: EvaluationReport, cwd: string, path: string) {
  const relative = workspaceRelativeFilePath(path, cwd);
  if (!relative) return;
  const parts: string[] = [];
  for (const segment of relative.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment && segment !== ".") parts.push(segment);
  }
  const normalized = parts.join("/");
  return report.evidence.find((entry) => entry.path === normalized);
}

export function EvaluationFigure({
  environmentId,
  cwd,
  file,
  alt,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  file: EvaluationReport["evidence"][number];
  alt: string;
}) {
  const gt = useGT();
  const asset = useAssetUrlState(environmentId, {
    _tag: "draft-workspace-file",
    cwd,
    path: "./" + file.path,
  });
  const source = asset._tag === "Success" ? asset.url : undefined;
  const [verified, setVerified] = useState<{ source: string; url: string | null }>();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the verification worker and the displayed blob URL
  useEffect(() => {
    if (!source) return;
    const controller = new AbortController();
    let url: string | null = null;
    void verifiedEvidenceBlob(source, file.sha256, controller.signal)
      .catch(() => null)
      .then((blob) => {
        if (controller.signal.aborted) return;
        url = blob ? URL.createObjectURL(blob) : null;
        setVerified({ source, url });
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [source, file.sha256]);
  if (asset._tag === "Failure" || (verified && verified.source === source && !verified.url))
    return (
      <span role="alert">
        {gt("Image unavailable")} · {alt || file.path}
      </span>
    );
  return verified?.url && verified.source === source ? (
    <img src={verified.url} alt={alt} className="h-auto max-w-full rounded-md" />
  ) : (
    <span role="status">{gt("Loading…")}</span>
  );
}
