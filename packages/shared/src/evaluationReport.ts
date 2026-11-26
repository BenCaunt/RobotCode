import { EvaluationPrimaryMetric } from "@t3tools/contracts";
import { sha256 } from "@noble/hashes/sha2";
import * as DateTime from "effect/DateTime";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const evaluationDirectory = "evaluations";
const slug = "[a-z0-9]+(?:-[a-z0-9]+)*";
const Slug = Schema.String.check(Schema.isPattern(new RegExp(`^${slug}$`)), Schema.isMaxLength(48));
const idPattern = new RegExp(`^(${slug})--(\\d{4}-\\d{2}-\\d{2})--(${slug})--([0-9a-f]{12})$`);
const Label = Schema.NonEmptyString.check(Schema.isTrimmed(), Schema.isMaxLength(256));
const EvidencePath = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(512),
  Schema.makeFilter(
    (path) =>
      !/[:\\\x00-\x1f]/u.test(path) &&
      path.split("/").every((part) => part && part !== "." && part !== ".."),
  ),
);
const ReplayCitation = Schema.Struct({
  id: Slug,
  label: Label,
  path: EvidencePath.check(Schema.isPattern(/\.rrd$/i)),
  recordingId: Schema.optionalKey(Label.check(Schema.isPattern(/^Recording:.+:.+$/))),
  timeline: Label,
  timeType: Schema.Literals(["duration", "timestamp", "sequence"]),
  time: Schema.String.check(
    Schema.makeFilter(
      (value) => {
        if (!/^(?:0|-?[1-9]\d{0,18})$/.test(value)) return false;
        const time = BigInt(value);
        return BigInt.asIntN(64, time) === time;
      },
      { message: "Use a signed 64-bit integer written as a decimal string." },
    ),
  ),
});
export type ReplayCitation = typeof ReplayCitation.Type;
export function replayPosition(citation: ReplayCitation) {
  if (citation.timeType === "sequence") return citation.timeline + " · #" + citation.time;
  if (citation.timeType === "timestamp") return citation.timeline + " · " + citation.time + " ns";
  const value = BigInt(citation.time);
  const abs = value < 0n ? -value : value;
  const fraction = String(abs % 1_000_000_000n)
    .padStart(9, "0")
    .replace(/0+$/, "");
  const seconds =
    (value < 0n ? "-" : "") + String(abs / 1_000_000_000n) + (fraction ? "." + fraction : "");
  return citation.timeline + " · " + seconds + " s";
}
function validReplayReferences(input: {
  readonly replayCitations?: readonly ReplayCitation[];
  readonly evidence: readonly (string | { readonly path: string })[];
}) {
  const paths = new Set(
    input.evidence.map((item) => (typeof item === "string" ? item : item.path)),
  );
  const citations = input.replayCitations ?? [];
  return (
    paths.size === input.evidence.length &&
    new Set(citations.map((item) => item.id)).size === citations.length &&
    citations.every((item) => paths.has(item.path))
  );
}
export function formatEvaluationMetric(metric: EvaluationPrimaryMetric, value = metric.value) {
  const unit = metric.unit ?? "";
  const separator = unit && !/^[%°/]/u.test(unit) ? " " : "";
  return String(value) + separator + unit;
}

const fields = {
  primaryMetric: Schema.optionalKey(EvaluationPrimaryMetric),
  version: Schema.Literal(1),
  replayCitations: Schema.optionalKey(Schema.Array(ReplayCitation).check(Schema.isMaxLength(128))),
  category: Slug,
  name: Slug,
  title: Label,
  mode: Schema.Literals(["physical", "simulation"]),
  recordedAt: Schema.String.check(
    Schema.isPattern(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/),
    Schema.makeFilter((value) => {
      const parsed = DateTime.make(value);
      return (
        Option.isSome(parsed) &&
        DateTime.formatIso(parsed.value).slice(0, 19) === value.slice(0, 19)
      );
    }),
  ),
  revision: Label,
  setup: Schema.NonEmptyString.check(Schema.isTrimmed(), Schema.isMaxLength(4096)),
  baseline: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(idPattern), Schema.isMaxLength(128)),
  ),
  summary: Schema.NonEmptyString.check(Schema.isMaxLength(64 * 1024)),
};

export const EvaluationManifest = Schema.Struct({
  ...fields,
  evidence: Schema.NonEmptyArray(EvidencePath).check(Schema.isMaxLength(32), Schema.isUnique()),
}).check(
  Schema.makeFilter(validReplayReferences, {
    message:
      "Evidence paths and citation IDs must be unique. Each replay citation must refer to a listed recording.",
  }),
);
const EvaluationReport = Schema.Struct({
  ...fields,
  evidence: Schema.NonEmptyArray(
    Schema.Struct({
      path: EvidencePath,
      sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
    }),
  ).check(Schema.isMaxLength(32)),
}).check(
  Schema.makeFilter(validReplayReferences, {
    message:
      "Evidence paths and citation IDs must be unique. Each replay citation must refer to a listed recording.",
  }),
);
export type EvaluationReport = typeof EvaluationReport.Type;
const decodeReport = Schema.decodeUnknownOption(Schema.fromJsonString(EvaluationReport), {
  onExcessProperty: "error",
});

export function evaluationId(report: EvaluationReport, contents: string) {
  const digest = Hex.encode(sha256(new TextEncoder().encode(contents.replace(/\r\n/g, "\n"))));
  return `${report.category}--${report.recordedAt.slice(0, 10)}--${report.name}--${digest.slice(0, 12)}`;
}

export function evaluationEntry(id: string) {
  const match = idPattern.exec(id);
  if (!match || match[1]!.length > 48 || match[3]!.length > 48) return null;
  return { id, category: match[1]!, day: match[2]!, name: match[3]!.replaceAll("-", " ") };
}

export function groupEvaluationEntries(
  entries: ReadonlyArray<{ path: string; kind: string }>,
  query: string,
) {
  const groups = new Map<string, Array<NonNullable<ReturnType<typeof evaluationEntry>>>>();
  const needle = query.trim().toLowerCase();
  for (const { path, kind } of entries) {
    if (kind !== "file" || !path.startsWith(evaluationDirectory + "/") || !path.endsWith(".json"))
      continue;
    const entry = evaluationEntry(path.slice(evaluationDirectory.length + 1, -5));
    if (!entry || !(entry.id + " " + entry.name).includes(needle)) continue;
    const group = groups.get(entry.category) ?? [];
    group.push(entry);
    groups.set(entry.category, group);
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, results]) => ({
      category,
      results: results.sort((a, b) => b.day.localeCompare(a.day) || a.id.localeCompare(b.id)),
    }));
}

export function readEvaluationReport(id: string, contents: string) {
  const report = Option.getOrNull(decodeReport(contents));
  return report && evaluationId(report, contents) === id ? report : null;
}
