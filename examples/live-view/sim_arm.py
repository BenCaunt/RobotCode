"""Simulated arm that serves a Robot Code live view.

Run:  python sim_arm.py [--port 9876] [--allow-origin ORIGIN]
Then register the robot with
  "liveView": { "url": "rerun+http://127.0.0.1:9876/proxy" }

A bridge for a real robot has the same shape. Replace `simulate` with the
robot's joint-state subscription and log sensors under their own entity paths.
"""

from __future__ import annotations

import argparse
import math
import time
from pathlib import Path

import rerun as rr
import rerun.blueprint as rrb
from rerun.urdf import UrdfTree

RATE_HZ = 30
# (amplitude rad, period s, phase rad) per actuated joint.
MOTION = {
    "shoulder_yaw": (1.1, 11.0, 0.0),
    "shoulder_pitch": (0.55, 7.0, 0.6),
    "elbow": (0.9, 5.0, 1.4),
    "wrist_pitch": (0.7, 3.0, 0.2),
}


def simulate(t: float) -> dict[str, tuple[float, float, float]]:
    """Target, measured position (rad) and velocity (rad/s) for each joint."""
    state = {}
    for name, (amplitude, period, phase) in MOTION.items():
        omega = 2 * math.pi / period
        target = amplitude * math.sin(omega * t + phase)
        # The measured joint trails its target, as a real tracking loop does.
        lag = 0.12
        measured = amplitude * math.sin(omega * (t - lag) + phase)
        velocity = amplitude * omega * math.cos(omega * (t - lag) + phase)
        state[name] = (target, measured, velocity)
    return state


def blueprint() -> rrb.Blueprint:
    return rrb.Blueprint(
        rrb.Horizontal(
            rrb.Spatial3DView(
                origin="/",
                name="Robot",
                # This URDF uses primitive shapes, which Rerun outlines unless told to fill them.
                defaults=[
                    rr.Boxes3D.from_fields(fill_mode="solid"),
                    rr.Cylinders3D.from_fields(fill_mode="solid"),
                ],
            ),
            rrb.Vertical(
                rrb.TimeSeriesView(origin="/joints/position", name="Joint position (rad)"),
                rrb.TimeSeriesView(origin="/joints/velocity", name="Joint velocity (rad/s)"),
                rrb.TimeSeriesView(origin="/tracking_error", name="Tracking error (rad)"),
            ),
            column_shares=[3, 2],
        ),
        collapse_panels=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=9876)
    parser.add_argument(
        "--allow-origin",
        action="append",
        default=[],
        help="Extra web origin allowed to read the stream. Localhost is always allowed.",
    )
    args = parser.parse_args()

    rr.init("sim_arm")
    url = rr.serve_grpc(
        grpc_port=args.port,
        server_memory_limit="256MB",
        cors_allow_origin=args.allow_origin or None,
    )
    # Activate the layout for every viewer, including one that remembers an older blueprint.
    rr.send_blueprint(blueprint(), make_active=True, make_default=True)
    print(f"Live view: {url}", flush=True)

    # Static data stays available to viewers that connect later.
    rr.log("/", rr.ViewCoordinates.RIGHT_HAND_Z_UP, static=True)
    tree = UrdfTree.from_file_path(Path(__file__).with_name("arm.urdf"))
    tree.log_urdf_to_recording()
    joints = {name: tree.get_joint_by_name(name) for name in MOTION}
    for name in MOTION:
        rr.log(f"joints/position/{name}/target", rr.SeriesLines(names=f"{name} target"), static=True)
        rr.log(f"joints/position/{name}/measured", rr.SeriesLines(names=name), static=True)
        rr.log(f"joints/velocity/{name}", rr.SeriesLines(names=name), static=True)
        rr.log(f"tracking_error/{name}", rr.SeriesLines(names=name), static=True)

    start = time.monotonic()
    step = 0
    while True:
        t = step / RATE_HZ
        rr.set_time("sim_time", duration=t)
        for name, (target, measured, velocity) in simulate(t).items():
            rr.log("transforms", joints[name].compute_transform(measured))
            rr.log(f"joints/position/{name}/target", rr.Scalars(target))
            rr.log(f"joints/position/{name}/measured", rr.Scalars(measured))
            rr.log(f"joints/velocity/{name}", rr.Scalars(velocity))
            rr.log(f"tracking_error/{name}", rr.Scalars(target - measured))
        step += 1
        time.sleep(max(0.0, start + step / RATE_HZ - time.monotonic()))


if __name__ == "__main__":
    main()
