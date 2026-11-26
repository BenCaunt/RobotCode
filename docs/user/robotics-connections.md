# Robot connections

Open your project in the sidebar (the thread list on mobile), then choose **Robotics** to see its registered robots and their readiness.

Register robots on the machine that runs the environment server. Create
`robotics/registrations.json` in that server's state directory, typically
`~/.t3/userdata`, and set each robot's `projectId` to its existing project ID.
The `t3_project_list` MCP tool returns these IDs.
Changes to this file apply the next time the robot list loads; no restart is needed.
Removing a robot ends its session.

```json
{
  "version": 1,
  "robots": [
    {
      "robotId": "kiwi-01",
      "projectId": "replace-with-your-project-id",
      "displayName": "Kiwi-01",
      "knownHosts": ["kiwi-bridge.local"],
      "initPath": "kiwi/init.md"
    }
  ]
}
```

`initPath` is optional and relative to the `robotics` directory. A custom
setup adapter integrated into the environment server receives this file as
input. Store credentials in the environment's secure store. Keep registration
IDs stable as host endpoints change.

To start or reuse local telemetry bridges with Connect, add their managed
job definition IDs to a `bridgeDefinitions` array on the robot registration. Each
definition in `robotics/jobs.json` needs the same project ID and robot ID
as the registration and a `kind` of `non-actuating`. The order in
`bridgeDefinitions` determines the startup order.

To watch the robot while it is connected, add a [live view](robotics-live-view.md)
to its registration.

A readiness check is optional. For a direct DDS target, you can use the
registration above. Connect runs setup, including any configured bridges.
With the built-in adapter, the session then shows **Readiness unverified**.

### Use a project readiness adapter

To verify telemetry directly, install a read-only executable in
`robotics/adapters/` under the environment server's state directory. A
symlink to an operator-installed executable also works. Set the robot's
`readiness` field to the adapter's filename, for example
`{"adapter": "go2-ready"}`.

The server runs the executable directly on the environment host with two
positional arguments, the project ID followed by the robot ID. The working
directory is `robotics/adapters/`. Use an absolute interpreter path for a
script and load any required settings explicitly. The server supplies an
empty environment and discards the program's output.

Exit zero when the target meets the project's readiness criterion. For DDS
this might require recent samples from a particular topic on that robot's
domain. A nonzero exit, launch failure, or 15-second timeout marks the
session **Degraded**. The server checks again five seconds after the prior
check finishes. A passing check returns the same session to **Ready**.
Repairing a failed bridge is a separate action in **Processes**. Run the
executable manually with the same IDs to see its diagnostics.

### Use an HTTP check

If your target already exposes an HTTP health check, add this optional field
to its registration, using the URL and marker supplied by your project.

```json
{
  "readiness": {
    "url": "http://kiwi-bridge.local/ready",
    "expectedText": "kiwi-01-ready"
  }
}
```

The environment server sends a GET and compares the trimmed response body
with the marker. A successful 2xx response with matching text marks the
session **Ready**. To verify telemetry freshness, the endpoint itself must
check the age of that robot's samples. A failed check marks the session
**Degraded**, and monitoring continues so it can recover.

One session per robot runs on each environment. Repeated Connect requests
reuse sessions that are connecting, ready, degraded, or unverified. Cancel ends the session
and its readiness checks. Project-owned bridges stay available for other
work and can be stopped from the Processes panel. Registered robots remain
visible after an environment restart and can be connected again.
