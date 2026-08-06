# Post-install API key onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Right after plugin install, every host agent asks for tenant identity, runs `init-peer` into `run/<tenant-key>/`, opens a stub `self/.env` with hosted `API_URL` and blank `API_KEY`, and waits before any authenticated Heroes work.

**Architecture:** Keep a single portable path: extend `init-peer.mjs` to write the ignored env stub mechanically; teach that sequence in shared `SKILL.md`; document it for humans and agents in `README.md`. No hooks, Cursor variables, MCP, or per-platform auth forks.

**Tech Stack:** Node.js ESM scripts, shared skill markdown, offline helper integration tests via `scripts/test-helpers.mjs` / `setup-tools.mjs --check`.

**Spec:** `docs/superpowers/specs/2026-08-06-post-install-api-key-onboarding-design.md`

## Global Constraints

- Destination is always `run/<tenant-key>/` under the current workspace (agents ask only for tenant key + display name).
- Hosted default URL is exactly `https://api.logicheroes.network/api`; local Heroes remains `http://localhost:3401/api`.
- `API_KEY` must be written as an empty value; never write a real secret in init.
- `writesSecrets` in dry-run stays `false` (stub is not a filled secret).
- No Cursor `variables`, hooks, rules, MCP, or dashboard credential store.
- Platform manifests (`.cursor-plugin`, `.claude-plugin`, `.codex-plugin`) stay metadata-only for this change.
- Peer-template `self/.env.example` stays blank placeholders; only generated `self/.env` gets the hosted URL.
- Tenant key regex unchanged: `^[a-z0-9]+(?:-[a-z0-9]+)*$`.

## File map

| File | Responsibility |
| --- | --- |
| `plugins/heroes-agent/scripts/test-helpers.mjs` | Integration assertions for stub `.env`, README, overwrite refusal |
| `plugins/heroes-agent/scripts/init-peer.mjs` | Create peer + write stub `self/.env` + generate peer README |
| `plugins/heroes-agent/skills/heroes-agent/SKILL.md` | Post-install onboarding gate for all hosts |
| `plugins/heroes-agent/README.md` | Human + agent quick starts and auth docs |
| `plugins/heroes-agent/skills/heroes-agent/scripts/heroes-tools/lib.ts` | Align missing-key error with stub-already-exists world |
| `plugins/heroes-agent/skills/heroes-agent/references/portability.md` | One-line note that init writes a blank-key stub |

---

### Task 1: Failing helper tests for env stub

**Files:**
- Modify: `plugins/heroes-agent/scripts/test-helpers.mjs`
- Test: `plugins/heroes-agent/scripts/test-helpers.mjs` (run via `node` / `setup-tools.mjs --check`)

**Interfaces:**
- Consumes: `init-peer.mjs` CLI (`<destination> --tenant-key <key> --display-name <name>`)
- Produces: Assertions that later tasks must satisfy:
  - `self/.env` exists
  - contains `API_URL=https://api.logicheroes.network/api`
  - contains blank `API_KEY=`
  - no destination-root `.env`
  - peer `README.md` mentions setting `API_KEY` in `self/.env`

- [ ] **Step 1: Update helper assertions to expect the stub**

Replace the current “no `.env`” checks and README-unrelated assertions in `plugins/heroes-agent/scripts/test-helpers.mjs` with:

```js
#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const initializer = join(pluginRoot, 'scripts', 'init-peer.mjs');
const sandbox = mkdtempSync(join(tmpdir(), 'heroes-agent-helpers-'));
const destination = join(sandbox, 'run', 'nested', 'acme-corp');
const hostedApiUrl = 'https://api.logicheroes.network/api';

try {
  const first = spawnSync(process.execPath, [
    initializer,
    destination,
    '--tenant-key',
    'acme-corp',
    '--display-name',
    'Acme Corp',
  ], { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.ok(existsSync(join(destination, 'self', 'identity.md')));
  assert.match(readFileSync(join(destination, 'self', 'identity.md'), 'utf8'), /`acme-corp`/);
  assert.ok(existsSync(join(destination, 'self', '.env.example')));

  const envPath = join(destination, 'self', '.env');
  assert.ok(existsSync(envPath), 'init-peer must create ignored self/.env stub');
  const envText = readFileSync(envPath, 'utf8');
  assert.match(envText, /^API_URL=https:\/\/api\.logicheroes\.network\/api$/m);
  assert.match(envText, /^API_KEY=$/m);
  assert.doesNotMatch(envText, /^API_KEY=.+$/m);
  assert.equal(existsSync(join(destination, '.env')), false);

  const peerReadme = readFileSync(join(destination, 'README.md'), 'utf8');
  assert.match(peerReadme, /self\/\.env/);
  assert.match(peerReadme, /API_KEY/);

  const second = spawnSync(process.execPath, [
    initializer,
    destination,
    '--tenant-key',
    'acme-corp',
    '--display-name',
    'Changed Name',
  ], { encoding: 'utf8' });
  assert.equal(second.status, 1, 'existing destination must be refused');
  assert.match(second.stderr, /Refusing to overwrite existing destination/);
  assert.match(readFileSync(join(destination, 'self', 'identity.md'), 'utf8'), /`Acme Corp`/);
  console.log('Helper integration checks passed (nested init, env stub, overwrite refusal).');
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run the helper test and confirm it fails**

Run:

```bash
node plugins/heroes-agent/scripts/test-helpers.mjs
```

Expected: non-zero exit; assertion failure that `self/.env` must exist (or equivalent missing stub).

- [ ] **Step 3: Commit the failing test**

```bash
git add plugins/heroes-agent/scripts/test-helpers.mjs
git commit -m "$(cat <<'EOF'
test: expect init-peer to create blank-key env stub

Lock the post-install credential gate so peer init must write hosted API_URL and empty API_KEY before docs catch up.
EOF
)"
```

---

### Task 2: Make `init-peer` create the env stub

**Files:**
- Modify: `plugins/heroes-agent/scripts/init-peer.mjs`

**Interfaces:**
- Consumes: peer-template `self/.env.example`
- Produces:
  - `self/.env` with `API_URL=https://api.logicheroes.network/api` and `API_KEY=`
  - peer `README.md` instructing to open `self/.env` and set `API_KEY`
  - dry-run still includes `writesSecrets: false`

- [ ] **Step 1: Implement stub + README in `init-peer.mjs`**

Keep argument parsing, validation, overwrite refusal, staging, and identity fill. Inside the `try` block after identity write, add stub creation and replace the README write. Use this full file content:

```js
#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOSTED_API_URL = 'https://api.logicheroes.network/api';

const args = process.argv.slice(2);
const destinationArg = args.find((arg) => !arg.startsWith('--') && args[args.indexOf(arg) - 1]?.startsWith('--') !== true);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const tenantKey = value('--tenant-key');
const displayName = value('--display-name');
const dryRun = args.includes('--dry-run');

if (!destinationArg || !tenantKey || !displayName) {
  console.error('Usage: node scripts/init-peer.mjs <destination> --tenant-key <key> --display-name <name> [--dry-run]');
  process.exit(2);
}
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tenantKey)) {
  console.error('Tenant key must be normalized lower-case hyphen-case.');
  process.exit(2);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(scriptDir, '..');
const source = join(pluginRoot, 'skills', 'heroes-agent', 'assets', 'peer-template');
const references = join(pluginRoot, 'skills', 'heroes-agent', 'references');
const destination = resolve(destinationArg);
const destinationParent = dirname(destination);

if (existsSync(destination)) {
  console.error(`Refusing to overwrite existing destination: ${destination}`);
  process.exit(1);
}
if (dryRun) {
  console.log(JSON.stringify({
    destination,
    tenantKey,
    displayName,
    source,
    writesSecrets: false,
    createsEnvStub: true,
    apiUrl: HOSTED_API_URL,
  }, null, 2));
  process.exit(0);
}

mkdirSync(destinationParent, { recursive: true });
const staging = join(
  destinationParent,
  `.${basename(destination)}.heroes-agent-init-${process.pid}-${Date.now()}`,
);
try {
  mkdirSync(staging, { recursive: false });
  cpSync(source, staging, { recursive: true, errorOnExist: true });
  mkdirSync(join(staging, 'railways'), { recursive: true });
  cpSync(join(references, 'handshake.md'), join(staging, 'railways', 'handshake.md'));
  cpSync(join(references, 'rfq.md'), join(staging, 'railways', 'rfq.md'));
  const identityPath = join(staging, 'self', 'identity.md');
  const identity = readFileSync(identityPath, 'utf8')
    .replace('<tenant-key>', tenantKey)
    .replace('<display-name>', displayName);
  writeFileSync(identityPath, identity);

  const envExample = readFileSync(join(staging, 'self', '.env.example'), 'utf8');
  const envStub = envExample
    .replace(/^API_URL=.*$/m, `API_URL=${HOSTED_API_URL}`)
    .replace(/^API_KEY=.*$/m, 'API_KEY=');
  writeFileSync(join(staging, 'self', '.env'), envStub);

  writeFileSync(
    join(staging, 'README.md'),
    `# Heroes peer: ${displayName}\n\n` +
      `Tenant key: \`${tenantKey}\`.\n\n` +
      `Open ignored \`self/.env\`, set \`API_KEY\` for this tenant, and keep \`API_URL\` as \`${HOSTED_API_URL}\` ` +
      `unless you run local Heroes (\`http://localhost:3401/api\`). ` +
      `Then ask an agent with heroes-agent installed to operate from this directory.\n`,
  );
  renameSync(staging, destination);
} catch (error) {
  rmSync(staging, { recursive: true, force: true });
  throw error;
}
console.log(`Created peer workspace for ${tenantKey} at ${destination}`);
```

- [ ] **Step 2: Run helper tests — expect pass**

Run:

```bash
node plugins/heroes-agent/scripts/test-helpers.mjs
```

Expected stdout ends with: `Helper integration checks passed (nested init, env stub, overwrite refusal).` Exit code `0`.

- [ ] **Step 3: Smoke dry-run**

Run:

```bash
node plugins/heroes-agent/scripts/init-peer.mjs temporary-peer --tenant-key smoke-peer --display-name "Smoke Peer" --dry-run
```

Expected JSON includes `"writesSecrets": false` and `"createsEnvStub": true` and `"apiUrl": "https://api.logicheroes.network/api"`.

- [ ] **Step 4: Commit**

```bash
git add plugins/heroes-agent/scripts/init-peer.mjs
git commit -m "$(cat <<'EOF'
feat: create hosted-url env stub during peer init

Give every new peer an ignored self/.env with blank API_KEY so agents can open it immediately after install.
EOF
)"
```

---

### Task 3: Shared skill post-install gate

**Files:**
- Modify: `plugins/heroes-agent/skills/heroes-agent/SKILL.md`
- Modify: `plugins/heroes-agent/skills/heroes-agent/references/portability.md`
- Modify: `plugins/heroes-agent/skills/heroes-agent/scripts/heroes-tools/lib.ts` (error string only)

**Interfaces:**
- Consumes: Task 2 init-peer behavior (`run/<tenant-key>/`, stub env)
- Produces: Portable agent instructions identical for Cursor, Claude Code, and Codex

- [ ] **Step 1: Replace the Start safely section in `SKILL.md`**

Replace from `## Start safely` through the paragraph ending `never a filled secret file.` with:

```markdown
## Post-install onboarding

Immediately after this plugin is installed (same session), before any HANDSHAKE, RFQ, or authenticated Heroes tool call:

1. Ask the human for the peer **tenant key** and **display name**. Never invent or borrow them. Tenant keys must be lower-case hyphen-case.
2. Locate the plugin root. If runtime dependencies are not installed, run `node <plugin-root>/scripts/setup-tools.mjs`.
3. Create the peer workspace with `node <plugin-root>/scripts/init-peer.mjs run/<tenant-key> --tenant-key <key> --display-name <name>`. This writes templates plus an ignored `self/.env` stub (`API_URL` set to hosted Heroes, `API_KEY` blank). It never writes a filled secret.
4. Open `run/<tenant-key>/self/.env` for the human and **stop**. Wait until they set `API_KEY`. Never print or echo the key.
5. Only then continue with Heroes operations.

If a peer already exists at `run/<tenant-key>/` and `API_KEY` is blank or missing, open `self/.env` and wait; do not re-run init. If `API_KEY` is already set, skip onboarding and use Start safely below. If init refuses because the destination exists, ask the human how to proceed.

## Start safely

1. Locate the plugin root. If runtime dependencies are not installed, run `node <plugin-root>/scripts/setup-tools.mjs`. Run bundled tools from the peer workspace with `node <plugin-root>/scripts/run-tool.mjs <script-name> <arguments>`. Both helpers set their child working directories explicitly, so setup is npm-version independent and tool execution preserves the peer workspace.
2. Read `<peer-workspace>/self/identity.md`. State the tenant key and display name. If either placeholder is unfilled, stop and ask the user to configure it; never infer or borrow an identity.
3. Confirm that local configuration belongs to the same peer. Runtime lookup is `<peer-workspace>/self/.env` first, then `<peer-workspace>/.env`; file values intentionally override inherited shell values to preserve tenant isolation. If `API_KEY` is missing, open `self/.env` and wait; do not call authenticated APIs.
4. Never reveal or print `API_KEY`. Network calls authenticate with `x-api-key`. Obtain human approval if the host requires it before mutations.
```

Leave the rest of `SKILL.md` (Triage, HANDSHAKE, RFQ, Inspect, Boundaries) unchanged.

- [ ] **Step 2: Update portability credential bullet**

In `plugins/heroes-agent/skills/heroes-agent/references/portability.md`, replace the credential bullet with:

```markdown
- Credential configuration UX differs, but all runtime scripts read the same ignored `self/.env` or `.env` names. `init-peer` creates a blank-key `self/.env` stub with the hosted API URL; agents open that file for the human. Cursor manifest variables are not used because they would not populate this local runtime automatically.
```

- [ ] **Step 3: Align `requireApiKey` error text**

In `plugins/heroes-agent/skills/heroes-agent/scripts/heroes-tools/lib.ts`, change the thrown message to:

```ts
  throw new Error(
    'No API_KEY set. Open self/.env and fill in this peer\'s Heroes API key.',
  );
```

- [ ] **Step 4: Quick offline verification**

Run:

```bash
node plugins/heroes-agent/scripts/validate-portability.mjs
rg -n "Post-install onboarding|Open self/\.env" plugins/heroes-agent/skills/heroes-agent/SKILL.md plugins/heroes-agent/skills/heroes-agent/scripts/heroes-tools/lib.ts
```

Expected: portability validator exits `0`; ripgrep finds the new onboarding heading and updated error string.

- [ ] **Step 5: Commit**

```bash
git add \
  plugins/heroes-agent/skills/heroes-agent/SKILL.md \
  plugins/heroes-agent/skills/heroes-agent/references/portability.md \
  plugins/heroes-agent/skills/heroes-agent/scripts/heroes-tools/lib.ts
git commit -m "$(cat <<'EOF'
docs: require post-install peer init and API key gate

Make every host follow the same install → identity → env stub → wait sequence before Heroes work.
EOF
)"
```

---

### Task 4: README for humans and agents

**Files:**
- Modify: `plugins/heroes-agent/README.md`

**Interfaces:**
- Consumes: Task 2/3 flow and commands
- Produces: Top-of-doc quick starts that match the skill exactly

- [ ] **Step 1: Insert dual quick starts and rewrite auth section**

After the opening paragraphs (before `## Repository structure`), insert:

```markdown
## Quick start (agents)

Right after installing this plugin, before any Heroes operation:

1. Ask the human for **tenant key** and **display name** (never invent them).
2. If tool dependencies are missing, run `node <plugin-root>/scripts/setup-tools.mjs`.
3. Run `node <plugin-root>/scripts/init-peer.mjs run/<tenant-key> --tenant-key <key> --display-name <name>`.
4. Open `run/<tenant-key>/self/.env` (hosted `API_URL` is already set; `API_KEY` is blank).
5. Stop and wait until the human sets `API_KEY`. Never print the key.
6. Only then triage intake, drive railways, or call authenticated tools.

If the peer already exists with a blank key, open `self/.env` and wait. If the key is set, skip to normal operation.

## Quick start (humans)

1. Install the plugin on your agent host (commands below).
2. Tell the agent your **tenant key** and **display name**.
3. When it opens `run/<your-tenant>/self/.env`, paste your Logic Heroes API key into `API_KEY`.
4. Leave `API_URL` as `https://api.logicheroes.network/api` unless you run Heroes locally (`http://localhost:3401/api`).
5. Do not commit `self/.env`. Ask the agent to continue once the key is saved.
```

Then replace the entire `## Peer initialization and authentication` section with:

```markdown
## Peer initialization and authentication

Node.js 18 or newer is required and enforced by the setup helper; Node.js 22 is recommended. Install the shared development/runtime dependencies once:

```text
node plugins/heroes-agent/scripts/setup-tools.mjs
```

The helper runs the locked `npm ci` with the shared tools directory as the actual child-process working directory. This avoids npm-version-dependent `--prefix` behavior and works with `npm.cmd` on Windows.

Create an isolated peer workspace (agents should use `run/<tenant-key>/`):

```text
node plugins/heroes-agent/scripts/init-peer.mjs run/acme-corp --tenant-key acme-corp --display-name "Acme Corp"
```

`init-peer` creates an ignored `self/.env` stub automatically:

- `API_URL`: set to `https://api.logicheroes.network/api` (change to `http://localhost:3401/api` only for local Heroes);
- `API_KEY`: left blank for the human to fill.

All Heroes JSON and multipart calls use `x-api-key`. Local rate ingestion and lookup do not require authentication. One workspace must contain only one tenant credential.

- **Codex:** open and edit `self/.env` inside the peer workspace; allow network or mutation commands when prompted. Do not put values in Codex marketplace metadata.
- **Claude Code:** edit the same ignored file. This plugin does not declare `userConfig`, because the runtime intentionally binds identity to the peer workspace. Claude's background-task behavior may help watchers but is not an authentication store.
- **Cursor:** edit the same ignored file (agent should open it after init). This plugin does not declare Cursor `variables`, because dashboard values would not automatically populate the workspace-scoped runtime. Allow local shell/network actions according to workspace policy.

The runtime reads `self/.env` first and root `.env` second; file values override inherited shell values to prevent cross-peer credential leakage. Never commit either filled file.
```

Keep `## Install`, `## Use`, `## Local development`, `## Portability limitations`, `## Validation`, and `## Public-release checklist` sections; only ensure the first Use bullet still matches onboarding (it already asks to set up a peer and show missing local values — leave it).

Also update the repository-structure blurb for `init-peer.mjs` if it still says templates-only — change the scripts comment line to:

```text
    init-peer.mjs                cross-platform workspace initializer (writes blank-key env stub)
```

- [ ] **Step 2: Sanity-check README wording**

Run:

```bash
rg -n "Quick start \(agents\)|Quick start \(humans\)|creates an ignored|Copy the generated peer" plugins/heroes-agent/README.md
```

Expected: both quick-start headings match; “creates an ignored” present; **no** match for “Copy the generated peer” (old manual copy instruction removed).

- [ ] **Step 3: Full offline check**

Run:

```bash
node plugins/heroes-agent/scripts/setup-tools.mjs --check
node plugins/heroes-agent/scripts/validate-portability.mjs
```

Expected: both exit `0`. Helper log line includes `env stub`.

- [ ] **Step 4: Commit**

```bash
git add plugins/heroes-agent/README.md
git commit -m "$(cat <<'EOF'
docs: document post-install API key quick start for humans and agents

Put the shared install → identity → open self/.env sequence at the top of the plugin README.
EOF
)"
```

---

## Self-review

1. **Spec coverage:** Required flow, init-peer stub, skill gate, idempotence, README dual quick starts, helper tests, portability note, no hooks/variables — each has a task/step.
2. **Placeholders:** None; full file/section content included.
3. **Consistency:** Hosted URL, `run/<tenant-key>/`, blank `API_KEY`, `writesSecrets: false` match across tasks.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-06-post-install-api-key-onboarding.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks
2. **Inline Execution** — execute tasks in this session with checkpoints

Which approach?
