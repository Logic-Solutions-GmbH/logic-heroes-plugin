# Slice 8 Claude Code smoke evidence

This smoke test started from baseline commit
`ed7ba3f545e580104c0d81f1250042103588fafa`, whose tree was
`e067480925ee9dfdc60059bb59b31b34663f3742`.

The host used Claude Code `2.1.227`. The source was a fresh `git archive` of the baseline.
A disposable Claude configuration was used for marketplace and installation checks, and a
disposable peer parent was used for onboarding.

This file contains no API key, owner-supplied identity value, account email, organization ID,
absolute user path, or disposable absolute path.

## Package and installation evidence

Sanitized commands:

```sh
CLAUDE_CONFIG_DIR=<disposable-claude-config> claude plugin validate <disposable-source> --strict
CLAUDE_CONFIG_DIR=<disposable-claude-config> claude plugin validate <disposable-source>/plugins/heroes-agent --strict
CLAUDE_CONFIG_DIR=<disposable-claude-config> claude plugin marketplace add <disposable-source>/
CLAUDE_CONFIG_DIR=<disposable-claude-config> claude plugin marketplace list
CLAUDE_CONFIG_DIR=<disposable-claude-config> claude plugin install heroes-agent@logic-heroes
CLAUDE_CONFIG_DIR=<disposable-claude-config> claude plugin list --json
CLAUDE_CONFIG_DIR=<disposable-claude-config> claude plugin details heroes-agent@logic-heroes
```

Results:

- Strict root marketplace validation passed.
- Strict `plugins/heroes-agent` validation passed.
- Claude added marketplace `logic-heroes` from the disposable source.
- Claude installed and enabled `heroes-agent@logic-heroes` version `0.1.0` under the disposable
  configuration.
- The reported install path was under the disposable configuration.
- Plugin details reported one skill and zero agents, hooks, MCP servers, and LSP servers.

## Authentication boundary

The installed plugin instructions must be sent to the external Claude provider for live discovery
and understanding tests. The owner explicitly approved that test boundary.

The macOS Keychain-backed Claude subscription login was not available when Claude ran with the
isolated `CLAUDE_CONFIG_DIR`. Marketplace and installation checks therefore stayed isolated, while
live prompts used the normal authenticated Claude session with the disposable plugin root supplied
explicitly through `--plugin-dir`. This did not install the plugin into the normal Claude
configuration.

No Heroes credential was supplied to Claude. No Heroes API call was made.

## Validation test: pass

The discovery prompt instructed Claude to read the loaded plugin and state the two values required
before initialization without creating files or calling a network service. Claude asked for
exactly:

```json
{
  "tenantKey": "<owner-supplied-disposable-tenant-key>",
  "displayName": "<owner-supplied-exact-display-name>"
}
```

Discovery created no files.

The onboarding prompt then supplied those two values and required character-for-character copying.
Claude used the shared initializer to create `run/<tenantKey>` and preserved both values exactly in
`self/identity.md`. The generated `self/.env` had mode `0600`, contained the hosted API URL, and left
`API_KEY` blank. Claude stopped at the credential boundary without making a Heroes call.

A second initialization exited `1` and refused to overwrite the existing peer workspace.

## Understanding test: pass after corrections

Earlier understanding responses failed acceptance because they invented a startup hook, dry-run
gating, or generic host rule-loading behavior that the package does not provide.

The final corrected test passed. Claude accurately separated the thin Claude adapter from the
portable shared implementation: each host manifest exposes the same `./skills/` directory, while
the shared skill, initializer, launcher, references, peer template, and tools define the actual
workflow. It also correctly stated that the plugin has no hooks, agents, MCP servers, or LSP
servers and did not claim host behavior absent from the package.

## Risk map

| Evidence | Release risk controlled |
| --- | --- |
| Fresh archive and disposable install state | Local ignored files or prior plugin state can hide packaging defects. |
| Strict root and plugin validation | Invalid Claude marketplace or plugin metadata can block installation. |
| Marketplace, list, and details checks | A prompt response alone cannot prove catalog, enabled state, or component inventory. |
| File-free discovery | Claude can answer from generic context instead of the loaded skill or mutate state too early. |
| Exact stored identity comparison | A transformed value can bind the peer workspace to the wrong identity. |
| Mode-`0600` blank-key environment | A credential stub can be exposed or Claude can call Heroes before the human supplies a key. |
| Overwrite refusal | A repeated setup can replace an existing peer workspace. |
| Corrected understanding test | Claude can invent host facilities instead of using the shared portable workflow. |

## Current status

Slice 8 Claude Code acceptance passed at the stated baseline. The smoke proves validation,
disposable marketplace installation, live skill discovery, exact-identity onboarding, blank-key
stop, overwrite refusal, and correct adapter/workflow understanding. It does not prove an
authenticated Heroes read or mutation.
