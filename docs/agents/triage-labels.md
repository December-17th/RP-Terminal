# Triage Labels

The skills speak in terms of five canonical triage roles. This repo uses a **local-markdown
issue tracker**, so these are not GitHub labels — each role is written as the value of the
`Status:` line near the top of an issue file (see `issue-tracker.md`).

| Canonical role    | `Status:` value in our tracker | Meaning                                  |
| ----------------- | ------------------------------ | ---------------------------------------- |
| `needs-triage`    | `needs-triage`                 | Maintainer needs to evaluate this issue  |
| `needs-info`      | `needs-info`                   | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent`              | Fully specified, ready for an AFK agent  |
| `ready-for-human` | `ready-for-human`              | Requires human implementation            |
| `wontfix`         | `wontfix`                      | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), write the corresponding
value into the issue file's `Status:` line.

Edit the right-hand column if you adopt a different vocabulary.
