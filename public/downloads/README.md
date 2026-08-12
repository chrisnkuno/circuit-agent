# Downloads

Drop the packaged Windows installer here so the `/download` page's primary CTA
(`/downloads/nova-setup-0.1.0-x64.msi`) resolves.

Build it from the desktop app:

```bash
cd apps/nova-desktop
npm install
npm run package:windows
```

Copy the resulting `.msi` from `src-tauri/target/release/bundle/msi/` into this
folder as `nova-setup-0.1.0-x64.msi` (or update the href in `app/download/page.tsx`).
