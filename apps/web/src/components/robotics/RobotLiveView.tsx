import { RERUN_VIEWER_VERSION, type RobotSummary } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { RerunCanvas } from "../files/RerunCanvas";
import { Button } from "../ui/button";

type StreamState = "starting" | "loading" | "open" | "failed";

export function RobotLiveView(props: {
  readonly robot: Pick<RobotSummary, "displayName"> & { readonly liveView: { url: string } };
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const { url } = props.robot.liveView;
  const [attempt, setAttempt] = useState(0);
  return (
    <section
      aria-label={gt("Live view of {robot}", { robot: props.robot.displayName })}
      className="overflow-hidden rounded-xl border bg-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{props.robot.displayName}</h3>
          <p className="truncate text-xs text-muted-foreground">
            <code>{url}</code>
          </p>
        </div>
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" onClick={() => setAttempt(attempt + 1)}>
            <T>Reconnect</T>
          </Button>
          <Button variant="ghost" size="sm" onClick={props.onClose}>
            <T>Close live view</T>
          </Button>
        </div>
      </div>
      <LiveStream key={`${url}#${attempt}`} url={url} />
    </section>
  );
}

function LiveStream({ url }: { readonly url: string }) {
  const gt = useGT();
  const [state, setState] = useState<StreamState>("starting");
  return (
    <div className="relative flex h-[min(72vh,760px)] min-h-80 flex-col">
      <RerunCanvas sourceUrl={url} onState={setState} dashboard />
      {state !== "open" && (
        <div
          role="status"
          className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-card px-6 text-center"
        >
          <p className="text-sm">
            {state === "failed"
              ? gt("Could not open the live stream.")
              : gt("Waiting for the live stream…")}
          </p>
          <p className="max-w-md text-xs text-muted-foreground">
            {gt(
              "The robot's bridge must be running and serve Rerun {version} at an address this device can reach.",
              { version: RERUN_VIEWER_VERSION },
            )}
          </p>
        </div>
      )}
    </div>
  );
}
