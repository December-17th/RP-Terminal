# Node-Workflow Manual Test Script — 2026-07-02

Point-in-time script covering everything the workflow track shipped through PR #34
(run/trace §13, node panels D4, failure primitives §10, RPM §9, editor polish, save-gate
validation, non-blocking post phase, canvas trace overlay). Run against a session with a
real API connection; the 状态栏 card session is ideal (it also exercises the WCV fixes).

Prereqs: a world open in Play, at least one message exchanged, an API preset that works.

## 1. Run/trace panel (Workflows view)

1. Open the **Workflows** panel view. Confirm the list shows *Default Generation (built-in)*
   plus your workflows, three selector dropdowns, and the **Active workflow** line shows a
   NAME (not a uuid).
2. Send a message in chat. After the reply lands, the **Last run** section should list every
   node of the active workflow with green dots and per-node timings; the two memory/post
   nodes carry a *post-response* chip.
3. Break your API key (Settings → API → Replace with garbage), send a message. The turn
   should fail with an error banner AND the Last-run panel should show the sample node red
   with the provider error text. Restore the key.

## 2. Canvas trace overlay (editor)

1. Workflows view → **Edit** on the workflow the chat actually uses (clone the builtin and
   select it for the session first if you're on the default).
2. After a successful turn, open the editor: each node card should carry a small chip —
   green dot + seconds for ran nodes; skipped nodes dim; a failed node gets a red border and
   the error in the chip tooltip.
3. Confirm the overlay does NOT appear when you open a *different* workflow than the one
   that ran.

## 3. Editor basics (post-polish regression)

1. With the 状态栏 card visible in chat, open the editor → the card UI must disappear
   (native views ducked) and reappear on close. **Esc** closes the editor; the ✕ button too.
2. Rename the open workflow via the top-bar name field → Save → the picker and the
   Workflows list show the new name immediately.
3. **Clone to edit** inside the editor, close the editor → the clone appears in the
   Workflows list AND in all three selector dropdowns without switching chats.
4. Open Settings while the 状态栏 is visible → card UI ducks. Open the Regex editor modal
   INSIDE Settings, close it → the card must STAY hidden until Settings itself closes.

## 4. Save-gate config validation

1. In the editor (on a clone), drag in a **Set Variable** (mvu.set) node, leave its `path`
   empty, hit **Save** → rejected; the status line names the node and the missing field.
   Fill a path (e.g. `debug.flag`) → Save succeeds.
2. Export the clone, hand-edit the `.rptflow` JSON to set an llm.sample config
   `"validator": "nope"`, re-import → import is rejected with the node named.

## 5. Failure primitives (llm.sample config)

1. On a clone selected for the session: select the Sample node, set `retries: 2`,
   `retry_delay_s: 3`. Break the API key. Send a message → the turn should take ~6s longer
   than an instant failure (two 3s retry waits), then fail; the trace shows the sample node
   red. (App log shows the attempts.)
2. Set `fallback_preset_id` to the id of a WORKING second API preset (export the workflow
   to find preset ids, or check settings JSON). Break the primary key, send → the turn
   should SUCCEED via the fallback.
3. Wire the Sample node's `error` port → a **Log** (util.log) node. Break both connections,
   send → the turn no longer errors loudly; the log records the failure. (Note: with the
   error wired, downstream parse/apply/write are skipped — no floor is written. Unwire
   after testing.)
4. Validator: set `validator: regex`, `validator_pattern: 〔.*〕` (something your model
   won't produce), `validator_retries: 1` → send; expect one corrective retry then a
   class-B failure in the trace. Reset the config after.

## 6. Node output panels (D4) + side-branch LLM

1. On a clone: add a second **Sample** node with config `stream: false`; wire
   ctx.gen → its gen, Assemble's sendMessages/params → its inputs. Tick **Show output
   panel in chat** on it, label it `旁路测试`. Save, select, send a message.
2. The chat reply must NOT contain the side model's text; a collapsed `旁路测试` section
   should appear under the reply containing it. It should persist until the next turn
   starts, then reset.
3. Because the side node is post-phase (not wired into Write Floor's ancestry), the reply
   should land WITHOUT waiting for the side call (non-blocking post phase). With a slow
   model on the side node this is very visible.

## 7. RPM limiting

1. Settings → API → set **Requests per Minute (RPM)** = 2 on the active preset.
2. Send 3 messages back-to-back (regenerate quickly). The third should visibly WAIT (not
   error) until the 60s window frees. Press Stop while it's queued → it must cancel
   immediately. Reset RPM to 0.

## 8. Memory decomposition (after the D5 PR)

1. Enable Long-Term Memory in Settings (checkpoint every 2 turns, keep recent 2 for a
   quick test). Play 5+ turns.
2. The trace should show gate firing (`due`), extract + write running post-response, and
   the Memory view filling with entries. The latest floors must never appear summarized.
3. Break the utility connection → extract fails; the turn itself must still complete
   normally (fail-open); the wired Log node records the extraction error in the app log.

## 9. Loops (subgraph.loop)

Prereq: a trivial counting sub-graph. Workflows view → **New sub-graph** → in the editor,
wire **Sub-graph Input** (slot `in2`) → **Sub-graph Output** (slot `out1`). Name it
`Count`, Save. (Its `in2` slot carries the pass index, so it just echoes 0,1,2… per pass.)

1. Edit the workflow selected for the session (clone the builtin first if needed). In the
   palette's **Sub-graphs** section, the `Count` card now shows TWO draggable chips —
   *Sub-graph* and *Sub-graph Loop*. Drag the **Sub-graph Loop** chip onto the canvas → the
   node drops preconfigured with `Count` as its `workflow_id`.
2. Select the loop node: set `mode: foreach`, `max_iterations: 5`. Wire `ctx.gen` → its gen,
   and a REAL array into `in1`: drop a **History** node (wire `ctx.gen` → its gen too) and
   wire its `messages` output (a role-tagged message array) into the loop's `in1`. (A Template node does NOT work here —
   it outputs a string, and foreach rejects non-arrays with a `bad-loop-input` error.) Wire
   the loop's `out1` into a **Log** (util.log) node so you can read the result. Save,
   select, send a message.
3. After the turn, the trace/canvas overlay should show the loop node ran green with a
   single timing (inner passes are NOT broken out — same as Sub-graph). The Log entry in the
   app log should show the collected per-pass indices (`[0,1,…]`, one per history message,
   capped at 5).
4. Switch the loop to `mode: until`, `max_iterations: 3`, feed a starting value into `in1`,
   send again → the loop should stop at `max_iterations` (the `Count` body never reports a
   truthy `out2`), and the trace still shows just the one wrapper node. Unwire the test nodes
   when done.

Reset all test settings when done (memory cadence, RPM, retries, key).
