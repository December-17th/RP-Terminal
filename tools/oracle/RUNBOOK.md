# Oracle capture runbook

**WP-0.4 / ADR 0016.** Step-by-step for a manual capture day against the pinned
SillyTavern 1.18.0 checkout. The rig (capture server + ST extension) is
committed; a capture is one-time and produces frozen golden fixtures under
`test/conformance/fixtures/`.

> **Licensing:** never edit or commit anything inside `E:\Projects\SillyTavern`
> (AGPL). Copying our extension folder into ST's `third-party` dir locally for the
> capture is fine — that folder is OUR code and stays out of ST's git.

## 0. Prerequisites

- Node 18+ on PATH.
- The pinned ST checkout at `E:\Projects\SillyTavern` (tag 1.18.0, commit `51ad27f`).

## 1. Start the capture server (this repo)

```sh
node tools/oracle/capture-server.mjs
# -> Oracle capture server on http://127.0.0.1:8899
#    OpenAI endpoint: http://127.0.0.1:8899/v1
#    writing fixtures to: tools/oracle/captures
```

Leave it running. Sanity check in another shell:

```sh
curl http://127.0.0.1:8899/health           # {"ok":true,...}
node tools/oracle/self-test.mjs             # posts a synthetic wire body, asserts a capture file lands
```

## 2. Install our capture extension into ST

Copy the folder (do NOT symlink into ST's git index):

```sh
mkdir -p "E:/Projects/SillyTavern/public/scripts/extensions/third-party/rpt-oracle-capture"
cp tools/oracle/st-capture-extension/manifest.json tools/oracle/st-capture-extension/index.js \
   "E:/Projects/SillyTavern/public/scripts/extensions/third-party/rpt-oracle-capture/"
```

## 3. Start SillyTavern

```sh
cd "E:/Projects/SillyTavern"
npm i        # first run only; do NOT commit changes in this repo
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
   1.18.0 fresh-install default — confirm it is ON).
3. Open **Utility Prompts** and paste the override strings from
   `scenarios.json → overrideTemplates` so no ST-default prose can land in a
   fixture (`impersonation_prompt`, `wi_format`, `scenario_format`,
   `personality_format`, `new_chat_prompt`, `new_group_chat_prompt`,
   `new_example_chat_prompt`, `continue_nudge_prompt`, `group_nudge_prompt`).

## 5. Capture each scenario

For each row in `scenarios.md` / `scenarios.json`:

1. In DevTools console tag the scenario:
   ```js
   rptOracleScenario('wp-2.1-markers-basic')
   ```
2. Set up the scenario's inputs (preset prompts, character card fields, injections,
   regex scripts, generation type) per the `inputs` note. Use only scrambled,
   RPT-authored prose.
3. Trigger the matching generation (send / continue / impersonate / group reply).
   The stub reply returns instantly.
4. A file `…__capture.json` (extension snapshot) and a `…__wire-request.json`
   (exact wire body) land in `tools/oracle/captures/`.

## 6. Freeze fixtures

For each capture, normalize it into the fixture schema
(`test/conformance/fixtureSchema.ts` documents the shape) and save as
`test/conformance/fixtures/<scenario-id>.json` with `source: "captured"`. The
`promptReady.chat` array is the golden prompt. Re-run `npm run test`: the scenario
moves from *skipped (fixture absent)* to *asserted*.

The `tools/oracle/normalize-capture.mjs` helper does the mechanical part:

```sh
node tools/oracle/normalize-capture.mjs \
  --in tools/oracle/captures/<file>__capture.json \
  --scenario wp-2.1-markers-basic \
  --out test/conformance/fixtures/wp-2.1-markers-basic.json
```

## 7. Clean up

Stop both servers. The `tools/oracle/captures/` dir is gitignored (raw captures are
scratch); only the normalized `test/conformance/fixtures/*.json` are committed.
Remove the extension copy from ST if you like — it never entered ST's git.

## Environment note (this attempt)

The capture **server** is verified working end-to-end via `self-test.mjs` (a
synthetic wire POST produces a capture file that the conformance runner ingests).
Driving the ST **browser UI** end-to-end was not performed in this automated
session — the ST front-end needs an interactive browser. Follow steps 2–6 above on
a capture day to produce real `source: "captured"` fixtures. Until then the runner
runs against the committed synthesized fixture(s) and skips the rest with a count.
