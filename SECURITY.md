# Security policy

## Supported versions

The `main` branch and the most recent published release of each package are supported. Fixes ship
forward rather than as backports.

| Package | Registry |
| --- | --- |
| `@circuit-nova/nova-core` | npm |
| `@circuit-nova/nova-cli` | npm |
| `@circuit-nova/state-*` | npm |
| The hosted control plane | deployed from `main` |

The desktop app is maintained in [chrisnkuno/nova-desktop](https://github.com/chrisnkuno/nova-desktop);
report issues that are specific to the window or its installer there.

## Reporting a vulnerability

**Please do not open a public issue.**

Report privately through GitHub's
[private vulnerability reporting](https://github.com/chrisnkuno/circuit-agent/security/advisories/new).
Include what you did, what happened, and what you expected. A reproduction matters far more than a
severity rating.

Expect an acknowledgement within a few days. You will be credited in the advisory unless you ask
not to be.

## What this system trusts, and what it does not

Worth knowing before you report, because it is the difference between a bug and the design:

- **The model is not trusted.** Permission modes are enforced by *not offering* a tool to the
  model, not by asking it nicely. A write reaching disk from a planning session is a vulnerability.
- **Approvals bind to an action digest, not to a job id, and execution is at-most-once.** Anything
  that lets one approval authorize a different action — including one a worker re-parked while a
  human was deciding — is a vulnerability.
- **Money is integer RWF end to end.** The cap, the reservation, the settlement and the audit
  ledger are integers; conversion happens only for display. A path that lets real spend exceed an
  approved cap is a vulnerability, and so is one that settles a different number than it reserved.
- **Sandboxes are the execution boundary.** Command allowlisting, opt-in internet, approved
  templates and bounded runtime are the contract. An escape from a sandbox's file or command policy
  is a vulnerability.
- **Credentials never reach the browser.** OAuth secrets and vault keys are Convex environment
  state; connector payloads are encrypted before insertion. Installation identity is re-resolved
  server-side rather than trusted from a browser redirect. A credential reaching the client, a log,
  or a third party is a vulnerability.
- **The Defensive Brain feed is signed.** Its trust root is pinned. Anything that would let an
  unsigned or substituted feed be accepted is a vulnerability.

Out of scope: a model doing something unhelpful within permissions a user explicitly granted it;
findings that require an attacker to already have code execution as the user; and the two
deployment flags documented in [docs/guides/activation.md](docs/guides/activation.md), which are
off by default and whose risks are stated there.

## Development flags that are not vulnerabilities

`ALLOW_TERMINAL_LIVE_EXECUTION` and `ALLOW_DEV_PAYMENT_BYPASS` default to unset. Enabled on a
deployment reachable by anyone other than trusted developers, they let an organization owner
authorize a task's cap without a real payment. That is documented, intentional, and the reason both
default to off — enabling them on a public deployment is a misconfiguration, not a defect.
