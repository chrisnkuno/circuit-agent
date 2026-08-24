# Security policy

## Supported versions

The latest release is the supported one. Nova Desktop auto-updates, so fixes reach installed apps
through a normal release rather than a backport.

## Reporting a vulnerability

**Please do not open a public issue.**

Report privately through GitHub's
[private vulnerability reporting](https://github.com/chrisnkuno/nova-desktop/security/advisories/new)
on this repository. Include what you did, what happened, and what you expected — a reproduction
matters far more than a severity rating.

Expect an acknowledgement within a few days. You will be credited in the advisory unless you ask
not to be.

If the issue is in the agent runtime rather than the desktop app — tool execution, approval
enforcement, provider handling, secret scanning — report it against
[chrisnkuno/circuit-agent](https://github.com/chrisnkuno/circuit-agent) instead. If you are unsure
which it is, report it here and it will be routed.

## What this app trusts

Worth knowing before you report, so you can tell a bug from the design:

- **The model is not trusted.** Tool calls are gated by mode: Plan is not "Build with a warning",
  it is a session in which the write tools are never offered to the model at all. An escape from
  that — a write reaching disk from a planning session — is a vulnerability, and a serious one.
- **Approvals are deliberate.** The approval dialog has no default button and Enter cannot approve.
  Anything that lets a command run without the user having chosen it is a vulnerability.
- **Nothing is fetched at runtime.** The window ships a CSP and loads no remote fonts, scripts or
  styles. A code path that reaches the network from the webview is a bug.
- **Credentials stay local.** API keys live in the Tauri settings store on the user's machine and
  go only to the configured provider endpoint. A key reaching anywhere else is a vulnerability.
- **Updates are signed.** Installers and `latest.json` are signed with a minisign key held in
  repository secrets; the public half is in `tauri.conf.json`. Anything that would let an unsigned
  or substituted artifact install is a vulnerability.

Out of scope: results from a model doing something unhelpful within permissions the user granted
it, and findings that require an attacker to already have code execution as the user.
