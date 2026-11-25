import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { captureRerunAnnotationLocation, formatRerunAnnotation } from "./rerunAnnotation";

describe("Rerun annotation handoff", () => {
  it("keeps nanosecond precision and excludes the viewer's signed recording URL", async () => {
    const storeId = "Recording:robot:room-2" as const;
    const signedUrl = "https://environment.test/api/assets/private/room-2.rrd";
    const location = await captureRerunAnnotationLocation({
      getState: async () => ({
        location: signedUrl,
        activeStoreId: storeId,
        recordings: [
          {
            storeId,
            store_id: storeId,
            location: signedUrl,
            timelines: [],
            currentTime: {
              timeline: "camera",
              time: 1_789_123_456_789_012_345n,
              timeType: "timestamp",
            },
          },
        ],
        views: [],
        loading: [],
        servers: [],
      }),
      getSelection: async () => ({ storeId, items: [{ type: "entity", entityPath: "/odom" }] }),
    });
    const prompt = formatRerunAnnotation({
      path: "/robot/room-2.rrd",
      environmentId: EnvironmentId.make("robot-host"),
      fileRevision: "version-2",
      location,
      comment: "Pose flickers here.",
      reference: {
        annotationId: "annotation-1",
        artifactId: "recording-2",
        projectId: ProjectId.make("robot-project"),
      },
    });
    expect(prompt).toContain('"time": "1789123456789012345"');
    expect(prompt).toContain('"entityPath": "/odom"');
    expect(prompt).toContain('"path": "/robot/room-2.rrd"');
    expect(prompt).toContain('"annotationId": "annotation-1"');
    expect(prompt).toContain('"artifactId": "recording-2"');
    expect(prompt).not.toContain(signedUrl);
  });
});
