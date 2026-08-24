# Nova Defensive Brain corpus

This directory is the human-reviewable authority for Nova's defensive security knowledge. The Rust
engine projects `*.jsonl` into a disposable SQLite FTS5 index and returns only the few records that
match a Defender query. The whole corpus never enters the model prompt.

Every active record must be defense-only, cite at least one HTTPS primary source, carry review and
expiry dates, and distinguish safe validation from operational exploitation. Web research and Exa
output are untrusted inputs: the refresh job stages candidates outside this directory and cannot
promote them. Promotion is a deliberate code review that checks source currency, scope, provenance,
and whether the guidance would increase offensive capability.

The seven covered domains are red teaming, vulnerability assessment and safe impact validation,
security testing, detection-evasion and bypass investigation, malware reverse engineering,
cryptographic research, and threat-intelligence investigations.
