import { createFileRoute } from "@tanstack/react-router";
import { EvaluationsPage } from "../components/evaluations/EvaluationsPage";

export const Route = createFileRoute("/_chat/evaluations")({
  validateSearch: (
    raw,
  ): { project?: string; result?: string; replay?: string; view?: "results" | undefined } => ({
    ...(raw.view === "results" ? { view: raw.view } : {}),
    ...(typeof raw.replay === "string" ? { replay: raw.replay } : {}),
    ...(typeof raw.project === "string" ? { project: raw.project } : {}),
    ...(typeof raw.result === "string" ? { result: raw.result } : {}),
  }),
  component: EvaluationsPage,
});
