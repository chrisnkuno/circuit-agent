# Native npm distribution

Each release compiles `nova-state` for one target and stages an intentionally tiny npm package:

```sh
bun run tooling/release/package-native-state.ts \
  --target x86_64-unknown-linux-gnu \
  --version 0.1.0
```

The supported target set covers GNU and musl Linux on x64/arm64, Intel and Apple Silicon macOS,
and x64/arm64 Windows. Every package declares npm `os`, `cpu`, and—on Linux—`libc` constraints.

Native packages must be published and verified first. Only then may the synchronized versions be
added to `@circuit-nova/nova-cli` as optional dependencies and the CLI published. Keeping those two
release phases separate prevents a CLI version from referring to native packages that are not yet
available in the registry.

The TypeScript bridge also supports `NOVA_STATE_BINARY` for development and unsupported packagers.
If no compatible binary exists, Nova can retain its TypeScript projection instead of failing to
start. Native indexing is the preferred CLI history path, with verified JSON as the portable
fallback. It remains a rebuildable projection, never the authority: deleting its SQLite file cannot
delete a conversation, approval, job, memory entry, or checkpoint.
