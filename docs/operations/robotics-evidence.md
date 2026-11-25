# Robotics evidence simulation

Run the evidence demonstration from the repository root after installing dependencies.

```sh
vp run --filter t3 robotics:evidence-demo
```

For machine-readable output, run `node apps/server/scripts/robotics-evidence-demo.ts` directly.

The command creates a temporary directory and reports its location in JSON. It starts a synthetic localization stream, injects a covariance excursion, and records the hook event and an annotation linked to the affected sample. The event requests an intervention. The simulated operator's response leaves the experiment waiting until a separate probe confirms the simulator is back at the origin. The command reopens the SQLite database and prints the saved outcome, annotation, and consumed intervention. It puts configuration, the demo source snapshot, the hook evidence, the reset probe, and the sample window next to the database with SHA-256 versions.

This demo runs a synthetic simulator in the CLI process and exchanges JSON artifacts. The live viewer, agent dispatch, and push delivery require their respective clients and adapters. Demo records live in the reported temporary directory so the command can be run repeatedly alongside an active harness.
