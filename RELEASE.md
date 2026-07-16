# Release plan

RP Terminal is distributed to Windows users as one no-install x64 executable attached to a GitHub
Release. Users do not need Git, Node.js, npm, or a source checkout. Updates are manual: close the app,
download the newer executable, and replace the old one.

The first public release remains blocked on choosing and adding the project's own `LICENSE`. Windows
code signing is not configured; until it is, release notes and the README must continue to warn that
SmartScreen may flag the executable.

## Release procedure

1. Update `package.json` and `package-lock.json` to the same semantic version.
2. Run the verification commands below on a clean checkout and smoke-test `npm run build:win`.
3. Merge the release commit to `main`, create an annotated `v<version>` tag on that commit, and push
   the tag.
4. The Release workflow verifies that the tag matches `package.json`, runs the source gates, builds the
   portable executable, audits its contents and size, writes a SHA-256 checksum, and creates a draft
   GitHub Release.
5. Download the draft artifact on a clean Windows account. Verify launch, profile creation, restart,
   and data persistence. For upgrade coverage, place it beside an existing `rp-terminal-data` folder
   and verify that the existing profile opens.
6. Review the generated notes, document any migration or known issues, then publish the draft.

If the smoke test fails, leave the draft unpublished, fix forward with a new version and tag, and delete
the failed draft/tag only after confirming that neither was published. Published versions are never
silently replaced.

## Decisions

- The Windows target is electron-builder `portable`, not NSIS. It produces a single executable and has
  no installer or automatic update channel.
- GitHub Actions builds from the tag so the release artifact is reproducible from repository state.
- Releases start as drafts so a human can test the exact uploaded binary before publication.
- Only runtime-required packages remain in `dependencies`. Renderer libraries compiled into `out/`
  live in `devDependencies` so electron-builder does not copy them into `app.asar` a second time.
- Packaging uses a positive allowlist: compiled `out/`, `package.json`, and the one runtime window icon.
  The package audit rejects unexpected roots/resources and enforces size ratchets.

## Verification

Run before tagging:

```bash
npm ci
npm run check:deps
npm test
npm run build:win
```

`npm run build:win` includes TypeScript checks, the production build, portable packaging, the ASAR
content audit, and verification that the expected portable executable exists within its size budget.
