# Slice 7 Codex smoke evidence

This smoke test started from baseline commit `08760d19e39408c204f02db08d7c121a5a699d53`.

The host used Codex CLI `0.145.0`. The test used an isolated clean source clone, an isolated Codex home, and a disposable peer parent.

The isolated Codex home started empty. Approved model runs then received a temporary mode-`0600` copy of the existing Codex login. The test never read or recorded its content. The temporary login copy must be removed after the tests.

This file contains no API key, authentication file content, absolute user path, or owner-supplied tenant identity.

## Sanitized commands

```sh
CODEX_HOME=<isolated-codex-home> codex plugin marketplace add <clean-clone> --json
CODEX_HOME=<isolated-codex-home> codex plugin list --available --json
CODEX_HOME=<isolated-codex-home> codex plugin add heroes-agent@logic-heroes --json
CODEX_HOME=<isolated-codex-home> codex plugin list --json
```

The catalog add result reported:

- `marketplaceName`: `logic-heroes`
- `alreadyAdded`: `false`
- `installedRoot`: the isolated clean clone

The available-plugin result reported:

- `pluginId`: `heroes-agent@logic-heroes`
- `version`: `0.1.0`
- `installed`: `false`
- `enabled`: `false`
- source: `plugins/heroes-agent` within the isolated clone

The install result reported:

- `pluginId`: `heroes-agent@logic-heroes`
- `version`: `0.1.0`
- `installedPath`: the isolated Codex plugin cache
- authentication policy: `ON_INSTALL` at the baseline commit

The installed-plugin result reported `installed=true` and `enabled=true`.

## Failed discovery and onboarding attempts

The first discovery prompt prevented the session from reading the installed instructions. The response asked for the human name and email, not the required tenant key and display name. That attempt did not prove skill discovery.

The next onboarding attempt used the owner-supplied disposable tenant key and exact display name. It added one punctuation character to the display name. That change violated exact identity preservation.

Neither result is an accepted discovery proof. No live HANDSHAKE move forms part of this offline smoke test.

These failures require two release fixes:

1. The skill must preserve the supplied display name exactly, including punctuation and spacing.
2. The Codex catalog must declare `ON_USE`, because the human supplies the local Heroes credential after installation.

## Acceptance retest

Start a new Codex session with the fixed plugin. Use this discovery prompt:

```text
Use $heroes-agent. Read its installed instructions. State the two human values required before peer initialization. Do not create files or call a network service.
```

The response must ask for the tenant key and display name. It must not invent either value.

Then use this onboarding prompt:

```text
Use $heroes-agent. Create one peer workspace for the owner-supplied disposable tenant key and exact display name. Preserve both values exactly. Do not use a network service. Stop when a Heroes API key is required.
```

Acceptance requires all these results:

- Catalog JSON reports `logic-heroes`.
- Install JSON reports `heroes-agent@logic-heroes` and an installed path.
- Plugin list JSON reports installed and enabled state.
- A new session applies `$heroes-agent`.
- `self/identity.md` contains the exact owner-supplied disposable tenant key.
- `self/identity.md` contains the exact owner-supplied display name without any change.
- `self/.env` contains the hosted URL and a blank `API_KEY`.
- The agent stops before any authenticated Heroes call.
- A second initialization refuses to overwrite the peer.

The final exact commit and live acceptance results belong in the channel canvas. This evidence commit cannot reference its own final commit.

## Risk map

| Evidence | Release risk controlled |
| --- | --- |
| Isolated clean clone | Ignored local files can hide an incomplete package. |
| Empty Codex home | Existing plugin state can hide installation defects. |
| Catalog and install JSON | Skill output alone cannot prove installed host state. |
| New-session discovery prompt | Installed state alone cannot prove skill discovery. |
| Exact identity assertion | Identity changes can bind work to the wrong peer name. |
| Blank-key stop | The agent can call Heroes before the human supplies a tenant credential. |
| Overwrite refusal | A smoke retry can replace an existing peer workspace. |

## Current status

The baseline install and catalog checks passed. The first new-session attempt failed discovery. The next attempt discovered the skill but failed exact identity preservation.

The planned acceptance retest must run after the skill, catalog policy, and operator instructions contain the fixes above.
