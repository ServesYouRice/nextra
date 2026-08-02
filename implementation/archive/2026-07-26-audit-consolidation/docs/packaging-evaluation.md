# Packaging path evaluation

The supported distribution remains the verified Windows `caxa` executable. Although `caxa` is archived, replacing it without proving native mediasoup loading, asset extraction, child-process behavior, signing, and clean-host startup would increase release risk.

Run `npm run evaluate:packaging` to emit the current dependency version, native-runtime constraints, required inputs, acceptance criteria, and candidate dispositions. CI/release preparation fails if the pinned packager or required packaging inputs disappear.

| Candidate | Current disposition | Promotion gate |
|---|---|---|
| Existing `caxa` Windows executable | Retain | Existing package and exact-artifact smoke gates continue passing |
| Node SEA | Evaluation only | Prove mediasoup worker/native loading, all assets/compliance files, child processes, logging, signing, upgrades, and clean-host smoke behavior |
| Container image | New product target | Define supported service networking, media-plane/TURN exposure, FFmpeg/GPU policy, persistence model, and operational ownership |

Review this decision when the Node major version changes, the current packager stops passing CI, a security issue cannot be mitigated, or a non-Windows distribution becomes a committed product target.
