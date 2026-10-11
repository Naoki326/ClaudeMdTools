# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

**Layout: single-context.** One `CONTEXT.md` + `docs/adr/` at the repo root.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the glossary for this project (`lanbook`). Read it before naming anything in an issue title, refactor proposal, hypothesis, or test name.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in. Currently:
  - `0001-user-homedir-data-directory.md`
  - `0002-vendor-frontend-assets.md`
  - `0003-bind-all-interfaces-by-default.md`
  - `0004-link-host-follows-service-config.md`
  - `0005-cross-platform-autostart.md`

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-user-homedir-data-directory.md
│   ├── 0002-vendor-frontend-assets.md
│   ├── 0003-bind-all-interfaces-by-default.md
│   ├── 0004-link-host-follows-service-config.md
│   └── 0005-cross-platform-autostart.md
├── lib/
├── bin/
└── server.js
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0003 (bind all interfaces by default) — but worth reopening because…_
