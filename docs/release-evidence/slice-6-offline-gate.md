# Slice 6 offline release gate

The baseline audit covers source commit `b0a0f2c1c20bae6ce0ffb8e92688f7c0b5fa68c9` and tree
`2588c47cf534dae62980f35b3c6bbfbcb5aa7fd2`. It ran at `2026-08-12T13:11:12Z`.
The evidence and sample-data changes follow that baseline commit.

## Tool versions

- Node.js `v26.4.0`
- npm `11.17.0`
- Python `3.9.6`
- Git `2.50.1 (Apple Git-155)`
- Claude Code `2.1.227`
- Codex CLI `0.145.0`

## Baseline gate results

| Gate | Controlled risk | Result |
| --- | --- | --- |
| Exact HEAD, clean status, and tracked scope | Evidence applies to different or local source | Pass: exact commit and 53 tracked files |
| Clean archive | Ignored local state hides a defect | Pass: archive equals the tracked set |
| Type check | Tool contracts are invalid | Pass |
| Full package tests | CSV, match, argument, or payload behavior regresses | Pass: 4 of 4 tests |
| Helper integration | Peer creation, blank environment stub, or overwrite refusal fails | Pass |
| Portability and tracked secret scan | A secret, local path, unsafe source, symlink, or host metadata ships | Pass: 53 tracked files and 0 symlinks |
| Codex plugin validation | The Codex manifest or layout is invalid | Pass |
| Claude strict validation | The Claude catalog or plugin schema is invalid | Pass: 2 of 2 checks |
| JSON parse | A catalog, manifest, lockfile, or configuration is malformed | Pass: 9 files |
| Documentation links and commands | Published instructions refer to missing files or scripts | Pass: 11 Markdown files |
| Archive path safety | The archive contains traversal paths or extra files | Pass |
| Sample-rate review | Example data can appear to be a current offer | Pending at the baseline commit |

The broad environment-key review found two syntax-only matches in
`plugins/heroes-agent/scripts/init-peer.mjs` and `plugins/heroes-agent/scripts/test-helpers.mjs`.
The first creates a blank assignment. The second asserts that no filled assignment exists.
No credential value was present or recorded.

## Candidate validation

The owner approved sample-data replacement after the baseline audit. The candidate uses
unmistakably fictitious carrier identifiers and round example values. This replacement is not
part of baseline commit `b0a0f2c1c20bae6ce0ffb8e92688f7c0b5fa68c9`.

A disposable pre-review validation commit `f0f7e81c366edb3f6506043a2816941dbf5b6d0d` with tree
`5d1967b6b328f4fc5a00c24fce1c70af40a82d49` passed the portability validator, all four package
tests, helper integration, the Codex plugin validator, both Claude strict validators, and
`git diff --check`. This temporary commit is not the final release commit.

The final release commit must pass all repeatable commands below after it is committed. The
release record outside this self-referential commit records that final commit and tree.

## Repeatable commands

Run these commands from the repository root:

```sh
git status -sb
git rev-parse HEAD
git rev-parse HEAD^{tree}
git ls-files | wc -l
git archive --format=tar HEAD --output=/tmp/heroes-release-candidate.tar
git archive --format=tar HEAD | git get-tar-commit-id
tar -tf /tmp/heroes-release-candidate.tar
node plugins/heroes-agent/scripts/validate-portability.mjs
node plugins/heroes-agent/scripts/setup-tools.mjs --check
python3 "$CODEX_HOME/skills/.system/plugin-creator/scripts/validate_plugin.py" plugins/heroes-agent
claude plugin validate . --strict
claude plugin validate plugins/heroes-agent --strict
git diff --check
rm /tmp/heroes-release-candidate.tar
```

The validator prints only paths and finding categories. It never prints matched secret values.
When exact repository Git scope is unavailable, it states that its direct declared-output scan
has reduced coverage.

## Exclusions

This offline gate does not prove live Codex, Claude, or Cursor installation. It does not prove
tenant reads, tenant mutations, watcher behavior, or marketplace submission. Slices 7 through 9
cover those live host and tenant checks.
