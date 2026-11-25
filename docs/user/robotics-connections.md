# Robot connections

Register robots on the machine that runs the environment server. Create
`robotics/registrations.json` in that server's state directory, typically
`~/.t3/userdata`, and set each robot's `projectId` to its existing project ID.
The `t3_project_list` MCP tool returns these IDs.
Restart the environment server after changing registrations.

```json
{
  "version": 1,
  "robots": [
    {
      "robotId": "kiwi-01",
      "projectId": "replace-with-your-project-id",
      "displayName": "Kiwi-01",
      "knownHosts": ["kiwi-bridge.local"],
      "initPath": "kiwi/init.md",
      "readiness": {
        "url": "http://kiwi-bridge.local/ready",
        "expectedText": "kiwi-01-ready"
      }
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

The built-in adapter checks a registered endpoint for a successful HTTP
response with the expected text. Choose an endpoint on an authorized network
that checks your bridge and telemetry and returns a distinct marker for that
robot. The adapter checks readiness throughout the session, and the session
becomes degraded when a scheduled check fails. Use HTTPS when the robot
network needs transport authentication.

One session per robot runs on each environment. Repeated Connect requests
reuse it while it is connecting, ready, or degraded. Cancel ends the session
and its readiness checks. Project-owned bridges stay available for other
work and can be stopped from the Processes panel. Registered robots remain
visible after an environment restart and can be connected again.
