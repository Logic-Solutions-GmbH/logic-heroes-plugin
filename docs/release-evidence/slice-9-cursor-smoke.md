# Slice 9 Cursor smoke evidence

This smoke test started from baseline commit
`07704633befbe40d6d81a629ff2510e948eae354`, whose tree was
`6ca0c04c75364a365d8190f89b4d84d2fe19265d`.

The host used Cursor Agent CLI `2026.08.11-e8db854` with an authenticated
session and model `composer-2.5`. The source was a fresh `git archive` unpacked
to a disposable source directory. A disposable peer parent served as the CLI
workspace. The plugin loaded directly with `--plugin-dir`.

This file contains no API key, owner-supplied identity value, account email,
absolute user path, or disposable absolute path.

## Sanitized commands and results

Sanitized commands:

```sh
git archive --format=tar HEAD | tar -x -C <disposable-source>
cursor-agent plugin marketplace list
cursor-agent -p --output-format text --model composer-2.5 --trust \
  --workspace <disposable-workspace> \
  --plugin-dir <disposable-source>/plugins/heroes-agent \
  "<discovery prompt>"
cursor-agent -p --output-format text --model composer-2.5 --force --trust \
  --workspace <disposable-workspace> \
  --plugin-dir <disposable-source>/plugins/heroes-agent \
  "<onboarding prompt>"
cursor-agent -p --output-format json --model composer-2.5 --trust \
  --workspace <disposable-workspace> \
  --plugin-dir <disposable-source>/plugins/heroes-agent \
  "<understanding prompt>"
```

Results:

- Independent controller assertions on the archived source passed.
- Root catalog reported marketplace `logic-heroes`, plugin `heroes-agent`, and
  source `plugins/heroes-agent`.
- Nested Cursor manifest reported version `0.1.0` and `skills: ./skills/`.
- `cursor-agent plugin marketplace list` was read-only and did not include
  `logic-heroes`. No account marketplace mutation occurred.
- The owner explicitly approved exporting bounded public plugin content to
  Cursor for this smoke test.

## Isolation limit

Cursor documents no general isolated-configuration switch comparable to
`CODEX_HOME` or `CLAUDE_CONFIG_DIR`. The normal authenticated Cursor account was
used. This smoke does not claim a fresh Cursor account or an isolated Cursor
configuration.

The direct `--plugin-dir` load proves manifest and skill acceptance for the
supplied plugin root. It does not prove Dashboard repository import or account
marketplace indexing.

## Validation test: pass

The discovery prompt instructed Cursor to use the loaded `heroes-agent` skill
and state the two values required before initialization without creating files
or calling the Heroes API. Cursor named `heroes-agent`, requested exactly `tenantKey` and
`displayName`, invented neither value, and created no files.

The onboarding prompt supplied the owner-provided disposable identity; this
evidence represents those values only as placeholders. Cursor used the shared
`init-peer.mjs` workflow. Independent
controller checks reported:

- stored `tenantKey` equals `<tenant-key>`;
- stored `displayName` equals `<display-name>`;
- `self/.env` mode `0600`;
- `API_URL` equals the hosted value;
- `API_KEY` blank.

No dependencies were installed. No `run-tool.mjs` invocation or Heroes API call
occurred.

A second initialization with `<changed-display-name>` exited `1`, matched the
refusal message, and left the original identity hash unchanged.

## Understanding test: pass

Several plain-text `-p` responses were empty because of Cursor text-output
behavior. A structured JSON `-p` response returned a passing answer.

That response correctly assigned the root Cursor catalog, nested Cursor
manifest, and `--plugin-dir` discovery to the Cursor adapter; assigned
`init-peer` identity, environment, and overwrite behavior to the shared
workflow; and stated that Cursor, Codex, and Claude manifests expose the same
`./skills/` tree. It also stated that the package has no hooks, agents, MCP
server, custom UI, or durable watcher resume.

## Risk map

| Evidence | Release risk controlled |
| --- | --- |
| Fresh archive and disposable workspace | Local ignored files or prior plugin state can hide packaging defects. |
| Controller catalog and manifest assertions | Invalid Cursor marketplace or plugin metadata can block discovery. |
| Read-only account marketplace list | A direct `--plugin-dir` load alone cannot prove Dashboard import or account indexing. |
| File-free discovery | Cursor can answer from generic context instead of the loaded skill or mutate state too early. |
| Exact stored identity comparison | A transformed value can bind the peer workspace to the wrong identity. |
| Mode-`0600` blank-key environment | A credential stub can be exposed or Cursor can call Heroes before the human supplies a key. |
| Overwrite refusal | A repeated setup can replace an existing peer workspace. |
| Structured understanding output | Cursor text-output gaps can hide an incorrect architecture answer. |

## Current status

Slice 9 Cursor acceptance passed at the stated baseline. The smoke proves
catalog and manifest acceptance through controller checks, live skill discovery,
exact-identity onboarding through the shared initializer, blank-key stop,
overwrite refusal, and correct adapter/workflow understanding through structured
JSON output. It does not prove Dashboard import, account marketplace indexing,
dependency setup, tool execution, or an authenticated Heroes read or mutation.
