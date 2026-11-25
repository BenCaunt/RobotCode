# Resource authority simulation

Run the smoke demo from the repository root after installing dependencies.

```sh
vp run --filter t3 robotics:authority-smoke
```

The JSON output shows the first publisher activating the simulated receiver, the second publisher's conflict, the safe transition during handoff, the stale publisher's rejection, and the watchdog stopping the receiver when the second publisher falls silent.

The receiver changes an in-memory state in the demo process and uses a monotonic clock for lease and command deadlines. Restarting it starts the simulated receiver in its safe state with fresh authority. Advisory-only resource definitions support observation leases. A physical deployment needs a protected command path, an independently enforced robot-local watchdog, and an emergency stop that works without the harness. Job reservations coordinate managed jobs within one environment. The receiver enforces command authority at the point where it accepts a command.
