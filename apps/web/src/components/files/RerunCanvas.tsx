import type { WebViewer } from "@rerun-io/web-viewer";
import { type RefObject, useEffect, useRef } from "react";

const loadViewer = () => import("@rerun-io/web-viewer");

export function RerunCanvas(props: {
  readonly sourceUrl: string;
  readonly onState: (state: "loading" | "open" | "failed") => void;
  readonly viewerRef?: RefObject<WebViewer | null>;
  /** Hides the viewer's own chrome so a live stream's blueprint fills the canvas. */
  readonly dashboard?: boolean;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const { sourceUrl, onState, viewerRef, dashboard } = props;

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
          if (viewerRef) viewerRef.current = null;
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
        if (viewerRef) viewerRef.current = viewer;
        if (dashboard) {
          for (const panel of ["top", "blueprint", "selection"] as const)
            viewer.overridePanelState(panel, "hidden");
          viewer.overridePanelState("time", "collapsed");
        }
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
  }, [sourceUrl, onState, viewerRef, dashboard]);

  return <div ref={parentRef} className="relative min-h-0 flex-1 overflow-hidden" />;
}
