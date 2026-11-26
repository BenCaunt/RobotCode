import * as Schema from "effect/Schema";
import { ProjectId, RobotId, RobotLiveView, TrimmedNonEmptyString } from "@t3tools/contracts";

const ProbeUrl = Schema.URLFromString.check(
  Schema.makeFilter(
    (url) =>
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    { description: "an HTTP(S) readiness URL without credentials, query or fragment" },
  ),
);
const InitPath = Schema.String.check(
  Schema.isMaxLength(250),
  Schema.makeFilter(
    (value) =>
      value.endsWith(".md") &&
      value.split("/").every((segment) => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/u.test(segment)),
    { description: "a relative Markdown path under the robotics state directory" },
  ),
);
const HostLabel = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u));
const BridgeDefinitions = Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(200))).check(
  Schema.isMaxLength(16),
  Schema.makeFilter((ids) => new Set(ids).size === ids.length, {
    description: "unique bridge definition IDs",
  }),
);

const RobotRegistration = Schema.Struct({
  robotId: RobotId,
  projectId: ProjectId,
  displayName: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  knownHosts: Schema.Array(HostLabel).check(Schema.isMaxLength(16)),
  initPath: Schema.optionalKey(InitPath),
  connectionHints: Schema.optionalKey(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(512))).check(
      Schema.isMaxLength(16),
    ),
  ),
  setupModel: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  bridgeDefinitions: Schema.optionalKey(BridgeDefinitions),
  liveView: Schema.optionalKey(RobotLiveView),
  readiness: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({
        url: ProbeUrl,
        expectedText: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
      }),
      Schema.Struct({
        adapter: Schema.String.check(
          Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}(?:\.exe)?$/u),
        ),
      }),
    ]),
  ),
});
export type RobotRegistration = typeof RobotRegistration.Type;

const RobotRegistryDocument = Schema.Struct({
  version: Schema.Literal(1),
  robots: Schema.Array(RobotRegistration).check(
    Schema.isMaxLength(128),
    Schema.makeFilter(
      (robots) => new Set(robots.map((robot) => robot.robotId)).size === robots.length,
      { description: "registrations with unique robot IDs" },
    ),
  ),
});

export const decodeRobotRegistry = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RobotRegistryDocument),
  { onExcessProperty: "error" },
);
