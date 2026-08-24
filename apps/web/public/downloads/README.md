# Downloads

Nothing is served from this folder. It exists so the path stays stable.

Desktop installers are built and published from their own repository —
[chrisnkuno/nova-desktop](https://github.com/chrisnkuno/nova-desktop) — by its `release.yml`
workflow when a `v*` tag is pushed there. `app/download/page.tsx` resolves that repository's
latest release at request time, so there is nothing to copy here and nothing to keep in step.
