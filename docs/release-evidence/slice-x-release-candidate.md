# Slice X — v1.0.0 release candidate

Date: 2026-08-13

Baseline commit: `a56a2f7573aeb028a36a15c08f811156d3b3d946`

## Candidate outcome

The release candidate sets every published plugin and tool version to `1.0.0`. The portability gate enforces the common version across the Codex, Claude Code, and Cursor manifests, the Claude catalog, and the tool package lock.

The candidate contains one shared Heroes Agent plugin. Host catalogs and manifests adapt that plugin for Codex, Claude Code, and Cursor. Publisher account setup and marketplace acceptance remain post-v1 work.

## Release notes

Heroes Agent v1.0.0 connects a local coding agent to one Logic Heroes tenant.

The release provides:

- HANDSHAKE creation, discovery, acceptance, rejection, recovery, and watchers;
- solicited one-to-one RFQ requests, quotes, counters, acceptance, documents, and watchers;
- exact tenant identity preservation and one credential per peer workspace;
- a Heroes-shaped local rate catalog with deterministic discovery;
- CSV import and export adapters with approval and source evidence;
- direct repository packages for Codex, Claude Code, and Cursor;
- Apache-2.0 licensing and public operator documentation.

Heroes remains the system of record for shared workflow and legal state. The peer workspace keeps local identity, credentials, intake, provider rates, and downloaded evidence.

## Candidate validation

The complete package gate passed:

- TypeScript type check: pass.
- Package tests: 24 passed, 0 failed.
- Helper integration: pass.
- Dependency audit: 0 vulnerabilities.
- Codex plugin validator: pass.
- Claude root marketplace strict validator: pass.
- Claude plugin strict validator: pass.
- Git diff check: pass.
- Tracked-file portability: 70 files passed.

A fresh archive from the candidate commit passed these checks:

- Codex CLI `0.145.0` added `logic-heroes`, installed `heroes-agent@logic-heroes` version `1.0.0`, and reported enabled state with `ON_USE` authentication.
- Claude Code `2.1.231` accepted both strict validations, installed version `1.0.0`, and reported one skill with no agents, hooks, MCP servers, or LSP servers.
- Cursor Agent CLI `2026.08.11-e8db854` loaded the shared plugin, found the required `tenantKey` and `displayName`, and created no workspace file.
- Independent Cursor assertions confirmed marketplace `logic-heroes`, plugin `heroes-agent`, version `1.0.0`, and shared skill path `./skills/`.

The checks used disposable host configuration and workspace paths. They made no Heroes API call and recorded no credential.

## Post-merge publication gate

After the pull request merges to `main`:

1. Confirm that `main` contains the reviewed candidate without extra changes.
2. Create annotated tag `v1.0.0` on that exact commit.
3. Build source archives from the tag.
4. Publish SHA-256 checksums with the GitHub Release.
5. Install the plugin from the tag on Codex, Claude Code, and Cursor.
6. Record each host result and the final commit in the GitHub Release.

Do not create the tag or GitHub Release before merge approval.

## Understanding test

This tag qualifies as v1 because the repository proves its public package shape, three host adapters, shared runtime, HANDSHAKE workflow, RFQ workflow, rate contract, credential boundary, and release safety gate.

Marketplace acceptance does not change the tagged code. It controls discovery through third-party directories. It remains follow-up work because direct installation from the canonical GitHub release is the v1 distribution boundary.
