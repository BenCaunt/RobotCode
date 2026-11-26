# Managed robotics processes

Open your project in the sidebar (the thread list on mobile), then choose **Robotics**. **Processes** lists that project's jobs
across conversations. You can start an approved definition, stream logs, stop
a job, or request a restart. An agent in the same project can discover jobs
and their definitions with the `t3_robotics_job_list` MCP tool.

The process list shows the latest stopped run for each definition alongside active, failed, and unknown runs. Open **Archived runs** to read the available logs from earlier stopped runs. Choose **Current runs** to return.

## Approve a process on the execution host

Create `robotics/jobs.json` under the environment's state directory (usually
`~/.t3/userdata`). Set `ROBOTCODE_MANAGED_JOBS_FILE` on the server to use a
different operator-managed file. Restart the server after changing the policy.

```json
{
  "version": 1,
  "jobs": [
    {
      "projectId": "replace-with-your-project-id",
      "definitionId": "telemetry-bridge",
      "label": "Telemetry bridge",
      "robotId": "kiwi-01",
      "kind": "non-actuating",
      "command": "/opt/robotics/bin/telemetry-bridge",
      "args": ["--read-only"],
      "cwd": "/opt/robotics",
      "resourceClaims": ["kiwi-01/telemetry-bridge"]
    }
  ]
}
```

Use absolute paths for the executable and its working directory, and pair the
example with a bridge that actually supports the listed arguments. The registry
runs approved definitions on the environment host. Keep the policy, executables,
and their inputs under operator control. Grant this host only the robot network
access and credentials required by its non-actuating work.

A resource claim reserves a name against other managed jobs on the same
environment. Physical actuation requires authority enforced at the command receiver.
See the [resource authority simulation](../operations/robotics-authority.md) for
the receiver-side contract.

Managed jobs continue across conversation settlement and client reconnects.
A normal server shutdown stops its supervised jobs and retains their history.
After an unclean shutdown, an unverified process can appear as **Unknown**
and continues to reserve its claims until reconciliation. Restart is explicit.
Connect to another T3 environment to see the jobs running on that host.
