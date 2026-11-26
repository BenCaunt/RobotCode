import type { EvaluationPrimaryMetric } from "@t3tools/contracts";
import { formatEvaluationMetric } from "@t3tools/shared/evaluationReport";
import { useGT } from "gt-react";

export function EvaluationMetric({ metric }: { metric: EvaluationPrimaryMetric }) {
  const gt = useGT();
  return (
    <dl className="max-w-[45%] text-end leading-tight">
      <dt className="break-words text-xs text-muted-foreground">{metric.label}</dt>
      <dd className="break-words text-lg font-semibold tabular-nums">
        {formatEvaluationMetric(metric)}
      </dd>
      {metric.baselineValue !== undefined && (
        <>
          <dt className="sr-only">{gt("Baseline")}</dt>
          <dd className="break-words text-xs text-muted-foreground">
            {gt("Baseline")} · {formatEvaluationMetric(metric, metric.baselineValue)}
          </dd>
        </>
      )}
    </dl>
  );
}
