# Oracle capture runbook

**WP-0.4 / ADR 0016.** Step-by-step for a manual capture day against the pinned
SillyTavern 1.18.0 checkout. The rig (capture server + ST extension) is
committed; a capture is one-time and produces frozen golden fixtures under
`test/conformance/fixtures/`.

> **Shells:** commands are written for **PowerShell** (the project's primary shell on
> Windows). A POSIX `sh`/Git-Bash variant is given where the two differ. Console
> snippets in step 5 (`rptOracleScenario(...)`) are JavaScript typed into ST's
> **browser DevTools**, not a shell.

> **Licensing:** never edit or commit anything inside `E:\Projects\SillyTavern`
> (AGPL). Copying our extension folder into ST's `third-party` dir locally for the
> capture is fine — that folder is OUR code and stays out of ST's git.

## 0. Prerequisites

- Node 18+ on PATH.
- The pinned ST checkout at `E:\Projects\SillyTavern` (tag 1.18.0, commit `51ad27f`).
- Run every repo-side command from the worktree
  `E:\Projects\RP Terminal\.worktrees\st-preset-compat` (the rig lives on the
  `feat/st-preset-compat` branch; the primary checkout does not have it).

```powershell
Set-Location "E:\Projects\RP Terminal\.worktrees\st-preset-compat"
```

## 1. Start the capture server (this repo)

```powershell
node tools/oracle/capture-server.mjs
# -> Oracle capture server on http://127.0.0.1:8899
#    OpenAI endpoint: http://127.0.0.1:8899/v1
#    writing fixtures to: tools/oracle/captures
# (optional: node tools/oracle/capture-server.mjs --port 8899 --out tools/oracle/captures)
```

Leave it running. Sanity check in another PowerShell window:

```powershell
curl.exe http://127.0.0.1:8899/health       # {"ok":true,...}  — note curl.exe, NOT the curl alias
node tools/oracle/self-test.mjs             # posts a synthetic wire body, prints "SELF-TEST OK: N capture files ..."
```

> PowerShell aliases `curl` to `Invoke-WebRequest`, which prints a different object;
> use `curl.exe`, or just rely on `self-test.mjs` (shell-agnostic).

## 2. Install our capture extension into ST

Copy the folder (do NOT symlink into ST's git index):

```powershell
$src  = "E:\Projects\RP Terminal\.worktrees\st-preset-compat\tools\oracle\st-capture-extension"
$dest = "E:\Projects\SillyTavern\public\scripts\extensions\third-party\rpt-oracle-capture"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Path "$src\manifest.json", "$src\index.js" -Destination $dest
```

> POSIX `sh` equivalent:
> ```sh
> mkdir -p "E:/Projects/SillyTavern/public/scripts/extensions/third-party/rpt-oracle-capture"
> cp tools/oracle/st-capture-extension/manifest.json tools/oracle/st-capture-extension/index.js \
>    "E:/Projects/SillyTavern/public/scripts/extensions/third-party/rpt-oracle-capture/"
> ```
> `Copy-Item` needs its sources as a **comma-separated `-Path` list**; it will not read
> trailing positional sources like POSIX `cp`.

## 3. Start SillyTavern

```powershell
Set-Location "E:\Projects\SillyTavern"
npm i         # first run only; do NOT commit changes in this repo
node server.js
```

Open the printed URL (usually `http://127.0.0.1:8000`). A toast
**"RPT Oracle Capture armed"** confirms the extension loaded. If not, open
DevTools console and check for `[rpt-oracle] armed`.

## 4. Configure ST for capture

1. **API → Chat Completion**, Source = **Custom (OpenAI-compatible)**.
   - Custom Endpoint: `http://127.0.0.1:8899/v1`
   - API key: any non-empty string (redacted by the server, never persisted).
   - Model: `oracle-stub` (the server advertises it via `/v1/models`).
2. **Enable the new macro engine** (experimental macro engine setting; it is the
   1.18.0 fresh-install default — confirm it is ON). This is load-bearing: the legacy
   engine differs (e.g. `{{pick}}`), and parity is frozen to the new engine.
3. Open **Utility Prompts** and paste the override strings from
   `scenarios.json → overrideTemplates` so no ST-default prose can land in a
   fixture (`impersonation_prompt`, `wi_format`, `scenario_format`,
   `personality_format`, `new_chat_prompt`, `new_group_chat_prompt`,
   `new_example_chat_prompt`, `continue_nudge_prompt`, `group_nudge_prompt`).

## 5. Capture each scenario

For each row in `scenarios.md` / `scenarios.json` (32 scenarios), in ST's **browser
DevTools console** tag the scenario **and** its generation type (the type is not
observable from the prompt-ready event, so tag it explicitly; default is `normal`):

```js
rptOracleScenario('wp-2.1-markers-basic')
rptOracleGenType('normal')   // or 'continue' / 'impersonation' / 'group'
```

Then:

2. Set up the scenario's inputs (preset prompts, character card fields, injections,
   regex scripts, generation type) per the `inputs` note. Use only scrambled,
   RPT-authored prose.
3. Trigger the matching generation (send / continue / impersonate / group reply).
   The stub reply returns instantly.
4. A file `…__capture.json` (extension snapshot) and a `…__wire-request.json`
   (exact wire body) land in `tools/oracle/captures/`. The `…__capture.json`
   carries both the assembled output (`promptReady.chat`) **and** the machine-readable
   `input` block the extension could observe (chat messages, active preset name, token
   budget). Fields the extension cannot see — the **pre-activated World Info entries**
   and any inline preset/character override — you record by hand in step 6.

## 6. Freeze fixtures

For each capture, normalize it into the fixture schema
(`test/conformance/fixtureSchema.ts` documents the shape) and save as
`test/conformance/fixtures/<scenario-id>.json` with `source: "captured"`. The
`promptReady.chat` array is the golden prompt.

The `tools/oracle/normalize-capture.mjs` helper does the mechanical part — it copies
the observed `input` (chat messages, preset name, token budget, generation type)
straight through and leaves `worldInfo: []` for you to fill:

```powershell
node tools/oracle/normalize-capture.mjs `
  --in tools/oracle/captures/<file>__capture.json `
  --scenario wp-2.1-markers-basic `
  --out test/conformance/fixtures/wp-2.1-markers-basic.json
```

> POSIX `sh`: same command with `\` line-continuations instead of PowerShell's
> backtick `` ` ``. Or put it on one line.

Then hand-complete the fixture's `input` block (the schema **requires** it; the
runner's `validateFixture` fails without `input.chatMessages` / `generationType` /
`macroEngine`):

- **`input.worldInfo[]`** — the pre-activated World Info entries you fed, in ST
  activation order, each `{ position, depth?, order?, role?, content }`. Under
  assembly-only parity (ADR 0016) WI *selection* is an INPUT the oracle supplies, so
  record exactly what was active — do not expect RPT to recompute it.
- **`input.preset`** / **`input.character`** — add the inline preset and character
  card you set up, when the scenario is self-contained rather than referencing a
  named preset. Use only scrambled, RPT-authored prose.
- **`input.tokenBudget`** — confirm the fixed budget the assembly ran under.

Re-run the suite; the scenario moves from *skipped (fixture absent)* to *asserted*:

```powershell
Set-Location "E:\Projects\RP Terminal\.worktrees\st-preset-compat"
npm run test
```

Where a captured golden disagrees with RPT's output, that is the real signal: either a
genuine RPT parity bug to fix, or a divergence to record in
`test/conformance/KNOWN-DIVERGENCES.md` (and mark the fixture `knownDivergence`). Do
NOT edit `expected` to force green.

## 7. Clean up

Stop both servers. The `tools/oracle/captures/` dir is gitignored (raw captures are
scratch); only the normalized `test/conformance/fixtures/*.json` are committed.
Remove the extension copy from ST if you like — it never entered ST's git:

```powershell
Remove-Item -Recurse -Force "E:\Projects\SillyTavern\public\scripts\extensions\third-party\rpt-oracle-capture"
```

## Notes

- **Incremental is fine.** You need not capture all 32 in one sitting — do a group
  (e.g. all `wp-2.1-*` markers), normalize, `npm run test`, commit, continue. Each
  captured fixture strictly strengthens the suite; 24 synthesized fixtures exist today
  and 8 scenarios currently skip as fixture-absent.
- **Expect divergences on `gen-continue` / `gen-impersonation` / `gen-group-nudge`.**
  These exercise ST utility prompts RPT does not fully emit; the honest outcome is a
  KNOWN-DIVERGENCES row, not a forced match.
- **Environment note (build session):** the capture **server** is verified end-to-end
  via `self-test.mjs`. Driving the ST **browser UI** was not performed in the automated
  build session (it needs an interactive browser); steps 2–6 are the manual capture-day
  path. Until captured, the runner asserts the committed synthesized fixtures and skips
  the rest with a count.
