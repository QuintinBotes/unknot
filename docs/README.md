# Unknot documentation

Start with the [top-level README](../README.md) for what Unknot is, how to install it and a quickstart. This directory has the detail.

## For users

| Page | Read it to |
|---|---|
| [concepts.md](concepts.md) | Understand the graph, findings, patterns, campaigns and slices, proof obligations, proof bundles and recovery |
| [commands.md](commands.md) | Look up a command: arguments, flags, what it writes, who may run it, exit codes |
| [configuration.md](configuration.md) | Look up a config key and its default; understand config acceptance and organization policy; copy an example |
| [decomposition.md](decomposition.md) | Decide whether and how to split a backend or frontend monolith; read a recommendation |
| [learning.md](learning.md) | See how accept and reject decisions tune ranking and thresholds |
| [adapters.md](adapters.md) | See what Unknot can read, at what confidence, and how to write an adapter |
| [runtime-evidence.md](runtime-evidence.md) | Export traces and metrics from a hosted observability vendor into `evidence.*` files |
| [faq.md](faq.md) | Find a quick answer |

## For security review

| Page | Read it to |
|---|---|
| [../SECURITY.md](../SECURITY.md) | Report a vulnerability; see the threat model, controls and honest limitations |
| [security-model.md](security-model.md) | See the exact policy decisions, the broker, the sandbox, approval binding and the ledger |

## For operators

| Page | Read it to |
|---|---|
| [operations.md](operations.md) | Roll out organization policy, link repositories, set retention, back up and restore |
| [release.md](release.md) | Verify a release (checksums, SBOM, provenance); understand telemetry and what it never contains |
| [benchmarks.md](benchmarks.md) | See measured mapping times and memory, and what has not been measured |
| [../COMPATIBILITY.md](../COMPATIBILITY.md) | Check supported platforms, public API and the semver and support policy |
| [../CHANGELOG.md](../CHANGELOG.md) | See what changed |
| [../runtime/daemon/README.md](../runtime/daemon/README.md) | Run the optional local API daemon |

## For contributors

| Page | Read it to |
|---|---|
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Set up, run tests, add detectors, pattern cards and adapters, use the dogfood harness |
| [../adapters/README.md](../adapters/README.md) | The adapter contract |
| [../adapters/database/README.md](../adapters/database/README.md) | The database adapter, its export formats and forecast model |
| [../runtime/diagnose/README.md](../runtime/diagnose/README.md) | The detector contract |
| [../patterns/README.md](../patterns/README.md) | The pattern-card format and the signal vocabulary |

## Design

| Page | Read it to |
|---|---|
| [spec.md](spec.md) | The product specification: goals and non-goals, architecture, security model, subsystems, acceptance scenarios |
| [research/decomposition.md](research/decomposition.md) | The sources behind decomposition, with sourced claims separated from Unknot heuristics |

The user documentation describes what the code does in version 0.1.0. Where the code does less than the specification says, the user pages say so; the specification is the target, not a description of the current behaviour.
