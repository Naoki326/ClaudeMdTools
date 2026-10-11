# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker (GitHub, `Naoki326/ClaudeMdTools`).

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

Every triaged issue carries exactly one **category** label (`bug` / `enhancement`) and one **state** label from the table above.

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

## Wayfinder labels

`/wayfinder` uses a separate label family, also already created in this repo:

| Label               | Meaning                                            |
| ------------------- | -------------------------------------------------- |
| `wayfinder:map`     | The map issue — owns Destination / Notes / Decisions-so-far / Fog |
| `wayfinder:research`| AFK research ticket                                |
| `wayfinder:prototype`| HITL prototype ticket                             |
| `wayfinder:grilling`| HITL conversation ticket (the default case)        |
| `wayfinder:task`    | Manual work that unblocks a decision               |

Edit the right-hand column of the triage table to match whatever vocabulary you actually use.
