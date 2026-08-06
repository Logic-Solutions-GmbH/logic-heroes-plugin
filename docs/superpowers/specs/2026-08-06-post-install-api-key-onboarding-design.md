# Post-install Heroes API key onboarding

Date: 2026-08-06  
Status: approved for planning  
Branch: `feat/post-install-api-key-onboarding`

## Problem

After someone installs `heroes-agent` from the public plugin repo into a fresh Cursor, Claude Code, or Codex agent, nothing forces peer setup or credentials. The skill already says to init a peer and configure `self/.env`, but it does not require an immediate post-install sequence that opens an env file for the API key. Users and agents can skip auth and fail later on network tools.

## Goal

Right after the plugin is installed, before any HANDSHAKE, RFQ, or authenticated Heroes tool work, the agent must:

1. Ask the human for **tenant key** and **display name** (never invent them).
2. Ensure runtime deps via `setup-tools.mjs` when missing.
3. Initialize a peer at `run/<tenant-key>/` with `init-peer.mjs`.
4. Ensure an ignored `self/.env` exists with hosted `API_URL` filled and `API_KEY` blank.
5. Open that `self/.env` for the user and **stop** until they provide the key.
6. Never print or echo `API_KEY`.

This behavior must be identical across Cursor, Claude Code, and Codex. Platform manifests remain metadata adapters only.

## Non-goals

- Cursor plugin `variables`, dashboard secrets, hooks, MCP, or hosted OAuth.
- Auto-detecting tenant identity from the repo name or folder.
- Asking for destination path (fixed to `run/<tenant-key>/` under the current workspace).
- Creating a real secret during init.
- Changing HANDSHAKE/RFQ railway behavior.

## Required flow

```text
Plugin installed
  → ask tenant key + display name
  → node <plugin-root>/scripts/setup-tools.mjs   (if deps missing)
  → node <plugin-root>/scripts/init-peer.mjs run/<tenant-key> \
        --tenant-key <key> --display-name <name>
  → open run/<tenant-key>/self/.env
  → wait for human to set API_KEY
  → only then operate Heroes tools / railways
```

### Idempotence

| State | Agent action |
| --- | --- |
| No peer at `run/<tenant-key>/` | Ask identity (if not known), run init, open `self/.env`, wait |
| Peer exists, `API_KEY` blank or missing | Open `self/.env`, wait; do not re-init |
| Peer exists, `API_KEY` set | Skip onboarding; continue with existing “Start safely” checks |
| Destination exists when init would overwrite | Keep current refusal; ask user how to proceed |

Tenant key validation stays as today: lower-case hyphen-case (`^[a-z0-9]+(?:-[a-z0-9]+)*$`).

## `init-peer.mjs` changes

`init-peer` becomes the mechanical owner of the env stub so agents do not hand-edit credentials layout differently per host.

After copying the peer template and filling `identity.md`:

1. Write ignored `self/.env` from `self/.env.example`.
2. Set `API_URL=https://api.logicheroes.network/api`.
3. Leave `API_KEY=` empty.
4. Still never write a filled secret.
5. Still refuse to overwrite an existing destination.
6. Update the generated peer `README.md` to tell humans/agents: open `self/.env`, set `API_KEY`, keep hosted `API_URL` unless using local Heroes (`http://localhost:3401/api`).

Dry-run output should still report that no secret value is written (stub creation is allowed; `writesSecrets` stays false or is clarified as “no filled secret”).

### Template vs generated env

- `self/.env.example` in the peer template remains blank placeholders (documented names only).
- Generated `self/.env` is local/ignored and may contain the hosted default URL with blank key.

## Shared skill (`SKILL.md`)

Replace / extend **Start safely** with an explicit **Post-install onboarding** gate that all hosts share:

1. Immediately after install (same session), before any Heroes operation, run the required flow above.
2. If the skill is rediscovered in a later session, apply the idempotence table: missing key → open env and wait; configured key → normal start checks.
3. Keep existing rules: read `identity.md`, resolve `self/.env` then `.env`, never reveal `API_KEY`, human approval for mutations when the host requires it.

Boundaries text stays: no MCP, hooks, or hosted auth; credentials live only in the peer workspace env file.

## README (humans + agents)

Restructure `plugins/heroes-agent/README.md` so the shared sequence is unmistakable:

1. **Quick start (agents)** — imperative checklist at the top: install → ask identity → setup-tools if needed → init-peer → open `self/.env` → wait for `API_KEY` → only then operate.
2. **Quick start (humans)** — same sequence in plain language: install on your host, tell the agent tenant key and display name, paste the API key into the opened file, do not commit it.
3. Keep per-platform install commands (Cursor / Claude Code / Codex) under that shared flow so no platform invents a different auth path.
4. Keep the existing note that no install command stores a Heroes credential in a manifest or marketplace file.
5. Document that `init-peer` creates the ignored env stub with hosted `API_URL` and blank `API_KEY`.

## Tests and validation

Update helper integration checks (`scripts/test-helpers.mjs`):

- Assert `self/.env` **exists** after init.
- Assert `API_URL` equals the hosted default.
- Assert `API_KEY` is present and empty.
- Assert no root `.env` is created.
- Keep overwrite-refusal coverage.
- Assert generated peer README mentions setting `API_KEY` in `self/.env`.

Portability validator continues to forbid filled secrets inside the **plugin package**. It must not treat the peer-template `.env.example` blanks as secrets. Peer workspaces under ignored `run/` remain out of package scans.

`setup-tools.mjs --check` continues to run the helper checks.

## Portability

- One shared skill + one initializer + one README; three manifests unchanged except if version bumps are desired later.
- No Cursor `variables`, hooks, rules, or MCP for this feature.
- Credential UX still differs by host approvals (shell/network/open-file), but the required steps and file layout are identical.

## Success criteria

- A fresh agent that installs the plugin and follows the skill asks for identity, creates `run/<tenant-key>/`, opens stub `self/.env`, and does not call authenticated Heroes APIs until `API_KEY` is set.
- Humans reading the README can follow the same sequence without host-specific credential inventiveness.
- Offline checks pass: init creates the stub correctly; overwrite still refused; package secret scan still clean.
