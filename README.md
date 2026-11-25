# Robot Code

![Robot Code, with a two-eyed inspection robot examining a machined part](./.github/readme/hero.webp)

**Robot Code** is an open-source workspace for building and debugging robot software with coding agents. Run a simulation, pause its Rerun recording at the moment your robot does something unexpected, and share that moment with your agent in chat.

**Robot Code is an unofficial fork of [T3 Code](https://github.com/pingdotgg/t3code). T3 Tools, Inc. has no affiliation with Robot Code and does not maintain or endorse it.** We thank the upstream contributors for the agent workspace this project builds on.

## Run from source

Install [Vite+](https://viteplus.dev/guide/), then run these commands from this checkout.

```sh
vp i
vp run dev
```

Open the pairing URL printed by the development server. To run the Electron client, use `vp run dev:desktop`. For iOS and Android source builds, see the [mobile guide](./apps/mobile/README.md).

## Work with a robot project

- **Run a project process.** Open **Settings → Projects → Robotics** to start an approved job, read its logs, and stop or restart it across conversations. [Managed processes](./docs/user/robotics-processes.md)
- **Review a recording.** Open a Rerun `.rrd` file, pause at an event, select the entities involved, and attach an annotation to your chat. [Recording review](./docs/user/robotics-recordings.md)
- **Trace a simulation.** Walk through the local simulation and inspect the evidence it records. [Evidence demo](./docs/operations/robotics-evidence.md)

## License and credits

The source code is available under the [MIT License](./LICENSE), including the original copyright notice. The Robot Code name and inspection robot identify this fork. The upstream project's [trademark policy](./TRADEMARK.md) covers its own name and artwork.
