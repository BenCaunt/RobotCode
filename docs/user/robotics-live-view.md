# Robot live view

Open **Robotics**, choose **Connect** on a robot, and its live view opens above the robot list. **Live view** on a robot's row opens and closes it without changing the session. The view is the same for a simulated robot and a real one: a 3D scene with the robot's model beside plots, cameras, and maps of what it is doing now.

Ask an agent in the project to build one:

> Give the arm a live view. Use its URDF for the 3D model and plot commanded against measured joint positions.

## How it works

A live view is a [Rerun](https://rerun.io) stream. A read-only bridge on the environment host logs the robot's model and state to a Rerun gRPC server, and the Robotics page embeds a viewer that follows it. The stream's blueprint sets the layout, so the bridge decides which views appear and how they are arranged.

Add the stream to the robot's entry in `robotics/registrations.json`:

```json
{
  "liveView": { "url": "rerun+http://127.0.0.1:9876/proxy" }
}
```

To start the bridge with **Connect**, approve it as a `non-actuating` definition in `robotics/jobs.json` and list it in the robot's `bridgeDefinitions`. See [robot connections](robotics-connections.md) and [managed processes](robotics-processes.md).

Robots without `liveView` keep working as before. Use a [recording tile](recording-tiles.md) or a [Rerun recording](robotics-recordings.md) for data that was already captured.

## Run the example

[`examples/live-view/sim_arm.py`](../../examples/live-view/sim_arm.py) simulates a four-joint arm. It loads [`arm.urdf`](../../examples/live-view/arm.urdf), moves the joints, and plots target and measured position, velocity, and tracking error.

```sh
pip install rerun-sdk==0.43.2
python examples/live-view/sim_arm.py
```

A bridge for a real robot has the same shape. Replace the simulated state with the robot's joint-state subscription.

## What the bridge needs

- **The same Rerun version as the app.** Install the `rerun-sdk` version shown above. The waiting message in the live view names the version the app expects.
- **A reachable address.** Your browser or desktop app connects to the stream directly. A loopback URL works when the app runs on the environment host. In the desktop app, forward the stream's port from a remote environment and the loopback URL keeps working. For any other device, bind the bridge to an address that device can reach, such as a tailnet hostname, and register that URL. A page served over HTTPS needs a `rerun+https` stream.
- **Permission for the app's origin.** Rerun accepts viewers on localhost by default. The desktop app and other origins must be allowed explicitly: pass `--allow-origin "t3code://app"` to the example, which sets `cors_allow_origin` on `rr.serve_grpc`.
- **Read-only access.** A live view observes. Keep commands to the robot out of the bridge.

The mobile app shows which robots have a live view. Open it on web or desktop.
