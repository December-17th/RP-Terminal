# Release plan

RP Terminal is distributed to Windows users as a no-install x64 ZIP attached to a GitHub Release.
Users extract the archive and run `RP Terminal.exe`; they do not need Git, Node.js, npm, or a source
checkout. The extracted folder is self-contained, including its `rp-terminal-data` directory.

The project license is intentionally deferred for the initial release; third-party components retain
their licenses and notices. Windows code signing is not configured, so release notes and the README
must continue to warn that SmartScreen may flag the executable.

## Release procedure

1. Update `package.json` and `package-lock.json` to the same semantic version.
2. Run the verification commands below on a clean checkout and smoke-test `npm run build:win`.
3. Merge the release commit to `main`, create an annotated `v<version>` tag on that commit, and push
   the tag.
4. The Release workflow verifies that the tag matches `package.json`, runs the source gates, builds the
   portable ZIP, audits its contents and size, writes a SHA-256 checksum, and creates a draft
   GitHub Release.
5. Download and extract the draft artifact on a clean Windows account. Verify launch, profile creation,
   restart, and that `rp-terminal-data` is created beside `RP Terminal.exe`. For upgrade coverage,
   verify that data from the previous AppData default is copied into the extracted folder and that the
   existing profile opens; the AppData copy must remain intact as a backup.
6. Review the generated notes, document any migration or known issues, then publish the draft.

If the smoke test fails, leave the draft unpublished, fix forward with a new version and tag, and delete
the failed draft/tag only after confirming that neither was published. Published versions are never
silently replaced.

## Decisions

- The Windows target is electron-builder `zip`, not NSIS. It has no installer or automatic update
  channel, and the extracted directory is the portability boundary for both the app and its data.
- Packaged builds redirect Electron `userData` and `sessionData` beside the executable as well, so
  preferences, browser storage, and caches do not remain in AppData.
- GitHub Actions builds from the tag so the release artifact is reproducible from repository state.
- Releases start as drafts so a human can test the exact uploaded binary before publication.
- Only runtime-required packages remain in `dependencies`. Renderer libraries compiled into `out/`
  live in `devDependencies` so electron-builder does not copy them into `app.asar` a second time.
- Only the `en-US` and `zh-CN` Electron locale packs ship, matching the app's supported UI languages.
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

`npm run build:win` includes TypeScript checks, the production build, ZIP packaging, the ASAR content
audit, and verification that the ZIP exactly contains the audited runtime files within its size budget.
