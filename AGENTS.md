# AGENTS.md

Guidance for agents working in this repository.

## What this repo is

`lanbook` (repo name `ClaudeMdTools`) — serves scattered Markdown notes and HTML courses over a LAN web
service: files stay in place, refresh live, readable from phone / tablet. Node.js + Express, entry
`server.js`, code in `lib/` and `bin/`, frontend assets in `public/`, tests in `test/`.

Read `CONTEXT.md` at the repo root before naming domain concepts — it is the glossary (数据目录,
根目录, 服务配置, 自启任务, …). Read the relevant ADRs in `docs/adr/` before changing the areas they cover.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `Naoki326/ClaudeMdTools` — note that `origin` in this clone is a GitLab
mirror, so `gh` commands must pass `--repo Naoki326/ClaudeMdTools` explicitly. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map to identically-named labels (`needs-triage`, `needs-info`,
`ready-for-agent`, `ready-for-human`, `wontfix`), plus the `wayfinder:*` family. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
