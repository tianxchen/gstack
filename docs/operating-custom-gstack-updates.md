# How to update custom gstack through the integration layer

Use this runbook when gstack reports a new upstream version. Prepare and test an
integrated candidate, approve its exact commit, then update both Claude Code and
Codex.

Keep `auto_upgrade=false`. Update notices do not automatically start this process.

## Configured locations on this Mac

| Item | Location or value |
| --- | --- |
| Installed source | `~/Dev/gstack`, branch `main` |
| Integration worktree | `~/Dev/gstack-integration`, branch `codex/gstack-integration` |
| Upstream remote | `origin`: `https://github.com/garrytan/gstack.git` |
| Personal fork remote | `fork`: `https://github.com/tianxchen/gstack.git` |
| Claude runtime root | `~/.claude/skills/gstack` |
| Codex runtime root | `~/.codex/skills/gstack` |
| Install registry | `~/.gstack/installs.tsv` |

Commands below use these existing locations. Verify them before each update.
A command's working directory does not change a Codex chat's attached directory.

## Quick path: ask an agent to run the update

1. When the update notice appears, choose **Not now**.
2. Send this preparation request:

   > Prepare the next gstack update through our integration layer. Check the
   > current coordination rules and obtain a fresh scoped release where required.
   > Preserve local changes, model settings and auto_upgrade=false. Fetch upstream,
   > reconcile the integration worktree, review the committed candidate, run full
   > validation and apply --check-only. Report the full tested commit, evidence,
   > setup side effects and any failures. Stop before activation.

3. Review the candidate, validation result and proposed setup effects.
4. If the result is acceptable, send this separate activation request:

   > Activate commit FULL_TESTED_COMMIT_FROM_REPORT. Obtain the current required
   > activation scope. Preserve local changes and preferences, verify both Claude
   > and Codex, record the result and stop.

   Replace the placeholder with the full hexadecimal commit from the passing
   preparation report before sending the request. Include that report when
   starting a new chat.

5. Start new Claude and Codex sessions after successful verification.

Do not use the standard `/gstack-upgrade` path for this customized installation.
Use the integration commands below. Publishing to the personal fork is a
separate operation.

Do not use the `CLAUDE.md` procedure named **Deploying to the active skill** for
this installation. Its reset to `origin/main` would discard custom commits or
replace the approved source. Use the validated integration candidate instead.

## Before starting

- Start Docker Desktop. Validation on macOS needs its Linux backend.
- Use the Bun version required by the candidate's `package.json`.
- Assign one operator to this update. Keep source fixed while validation runs.
- Obtain fresh per-task coordination scope before each update. Have the agent
  verify current authority, ownership, allowed paths, commands and expiry.
  Previously closed permits cannot authorize another run. A new chat must follow
  the current coordination guide and ownership rules.
- Include validation's Docker image build, public dependency downloads
  (including Bun, Node and Chromium), and Linux container execution in the
  preparation scope. Activation and host refresh need their separate scope.
- Confirm that the source checkout, integration branch and chat attachment are
  the intended ones. Preserve existing changes before proceeding.

| Phase | Installed main advances? | Host setup runs? |
| --- | --- | --- |
| Prepare, reconcile and review | No | No |
| Validate and check-only | No | No |
| Approved apply | Yes | Claude, then Codex |
| Partial-host recovery | Main stays at the approved commit | Only the required host setup |

## Step 1: Check the current installation

Run these read-only commands:

```bash
git -C "$HOME/Dev/gstack" status --short --branch
git -C "$HOME/Dev/gstack-integration" status --short --branch
git -C "$HOME/Dev/gstack" remote -v
"$HOME/Dev/gstack/bin/gstack-config" get auto_upgrade
"$HOME/Dev/gstack/setup" --status
```

Confirm:

- The source checkout is on `main`.
- The integration worktree is on `codex/gstack-integration`.
- `origin` is Garry's repository and `fork` is the personal repository.
- `auto_upgrade` is `false`.
- The Claude and Codex global install rows name the expected source.

Record each checkout's HEAD and existing changes. Preserve local work in reviewed
commits before preparation. Do not reset files or discard untracked files to
clear a guard. Avoid the shared stash stack.

## Step 2: Fetch and merge in the integration worktree

After the required preparation scope is approved, run:

```bash
"$HOME/Dev/gstack/bin/gstack-integrate-upstream" prepare \
  --repo "$HOME/Dev/gstack" \
  --worktree "$HOME/Dev/gstack-integration"
```

This fetches `origin/main`, merges local `main` into the integration branch,
then merges upstream there. The installed main checkout stays at its current
commit.

If a merge stops, resolve it in `~/Dev/gstack-integration`. Preserve the intended
customizations, review the resolution and commit the named files. For generated
`SKILL.md` conflicts, resolve the source templates and regenerate their outputs.
Then run `prepare` again to finish reconciliation.

## Step 3: Review and commit the candidate

Review the integrated changes, especially:

- Local model choices and other customizations.
- The integration command and validation policy.
- `setup`, dependency versions and upgrade migrations.
- Host registration, hook and generated runtime changes.
- Browser prerequisites and both CSO staging/runtime and scanner image catalogs.

Before activation, the scope must cover the candidate's actual setup effects.
These can include public Bun dependencies, browser caches, private temporary
files, gstack-owned host registrations, hook backups and exact-digest public
Docker image acquisition. Preserve user preferences, unrelated skills, existing
Docker services and unrelated cache versions. Container execution beyond the
approved validation run, scans and model evaluations need their own authorization.

An unfamiliar setup effect requires a scope check before that step. The previous
update's path list is not a complete description of future upstream setup.

Arrange an independent read-only review under the current repository policy.
Resolve its required fixes. Commit all candidate repairs and documentation before
validation, then require a clean integration worktree. Record the full commit:

```bash
git -C "$HOME/Dev/gstack-integration" rev-parse HEAD
```

## Step 4: Run full validation

Confirm that the preparation scope covers the image build, downloads and test
container execution before running it. Keep validation's environment isolation
intact; do not export shared `GSTACK_HOME`, `CODEX_HOME` or `CLAUDE_CONFIG_DIR`
overrides into its tests.

Use the command from the candidate:

```bash
"$HOME/Dev/gstack-integration/bin/gstack-integrate-upstream" validate \
  --backend docker \
  --repo "$HOME/Dev/gstack" \
  --worktree "$HOME/Dev/gstack-integration"
```

On macOS, this runs native launcher and macOS regression checks, then the full
free suite in an isolated Linux container. It also checks dependencies, build,
product types and the test-type debt ratchet. Active host setup does not run.

If validation fails, retain the original logs. Diagnose and verify the smallest
repair, commit it, review it, then validate the new committed candidate. Keep
test selection and assertions intact. Use the strict `bun run test` runner for
full free acceptance; bare `bun test` is not its replacement.

Inspect the recorded result:

```bash
"$HOME/Dev/gstack-integration/bin/gstack-integrate-upstream" status \
  --repo "$HOME/Dev/gstack" \
  --worktree "$HOME/Dev/gstack-integration"
```

Require a passing result for the exact full commit. Receipts and complete logs
are under `~/Dev/gstack/.git/upstream-integration-validation/`. Retain them.
Any new commit, including a documentation commit, requires new validation before
apply. If local main, the fetched upstream revision, validation policy, host
identity or recorded logs change, treat the pass as stale and validate again.

## Step 5: Rehearse activation

Replace `FULL_TESTED_COMMIT_FROM_REPORT` below with the full hexadecimal commit
from the passing report. It must equal the integration worktree's HEAD.

```bash
"$HOME/Dev/gstack-integration/bin/gstack-integrate-upstream" apply \
  FULL_TESTED_COMMIT_FROM_REPORT --check-only \
  --repo "$HOME/Dev/gstack" \
  --worktree "$HOME/Dev/gstack-integration"
```

Expected result: the recorded validation evidence check passes and the command
reports readiness while leaving main and both hosts unchanged.

Stop and present the full commit, version, review findings, validation summary,
receipt location and proposed setup effects to the user.

## Step 6: Obtain activation approval

Obtain approval for the exact tested commit and the required current activation
scope. Preserve pre-update settings and registration evidence. The scope should
state command limits, required environment, cleanup rules and any partial-host
recovery allowance.

Use the environment and timeout prescribed by that scope. Before apply or any
host recovery command, confirm the target roots:

| Setting | Expected value on this Mac |
| --- | --- |
| `CODEX_HOME` | Unset, or `$HOME/.codex` |
| `CLAUDE_CONFIG_DIR` | Unset, or `$HOME/.claude` |
| State-root overrides (`GSTACK_STATE_ROOT`, `GSTACK_HOME`, `GSTACK_STATE_DIR`) | Unset, or the approved `$HOME/.gstack` state root |

These settings can redirect host installation or state. Resolve an unexpected
override before running setup; do not change user preferences to clear a guard.
If a scope deliberately uses another root, verify and record that exact target
instead of assuming the defaults above.

If the candidate or source base changes after approval, stop and reassess the
validation and approval bindings.

## Step 7: Apply the approved commit

Replace the placeholder with the same full tested commit:

```bash
"$HOME/Dev/gstack-integration/bin/gstack-integrate-upstream" apply \
  FULL_TESTED_COMMIT_FROM_REPORT \
  --repo "$HOME/Dev/gstack" \
  --worktree "$HOME/Dev/gstack-integration"
```

The command rechecks the evidence, fast-forwards installed `main`, runs
`./setup --host claude`, then runs `./setup --host codex`. It does not push.

Activation has separate stages. Main can advance even if a later host setup
fails. Follow partial-host recovery below in that case.

## Step 8: Verify both hosts

```bash
git -C "$HOME/Dev/gstack" rev-parse HEAD
cat "$HOME/Dev/gstack/VERSION"
"$HOME/Dev/gstack/setup" --status
"$HOME/.claude/skills/gstack/bin/gstack-config" get auto_upgrade
"$HOME/.codex/skills/gstack/bin/gstack-config" get auto_upgrade
```

Require all of these results:

- Installed HEAD equals the approved full commit and VERSION matches the report.
- Both requested global host rows report `current` from the expected source.
- Their runtime files and skill links resolve correctly. Compare stable runtime
  files against the candidate; host-specific generated skill text can differ.
- Both hosts still read `auto_upgrade=false`.
- Model/provider/effort settings, unrelated hooks and skills, and preserved local
  files match the pre-update evidence.
- No owned installer, pull worker or workflow lock remains.

`setup --status` can also list generated source-repository portable exports as
an unregistered project install. Check the requested global rows separately;
do not register or refresh unrelated installations to clear an informational row.

## Step 9: Record the result and reload sessions

Record the full commit and version, both setup outcomes, validation evidence,
preservation checks, actual dependency acquisition and any recovery or scope
exception. Retain owned backups and diagnostic logs. Close the scoped work and
return its stopped confirmation where required.

Start new Claude and Codex sessions. Installed files and discovery checks do not
prove that an already-open conversation reloaded its cached skill instructions.

## Troubleshooting

| Condition | Action |
| --- | --- |
| Dirty integration worktree | Preserve and review the edits; commit them before prepare or validation. |
| Conflict during prepare | Resolve and commit in the integration worktree, then rerun prepare. Installed main remains unchanged. |
| Failed or interrupted validation | Retain the failed receipt and logs, repair the demonstrated cause, then validate the committed result. |
| Candidate, main, upstream or evidence changed | Reconcile the changed inputs and run the required validation again. Do not edit receipt hashes. |
| Apply failed before main advanced | Diagnose the refusal; do not run host setup from the old source. Recheck evidence with `apply --check-only` only if its bindings remain valid. Otherwise reconcile and validate again. |
| Workflow lock exists | Identify its owner and process state. Remove only an owned stale lock after its workers have stopped and cleanup is authorized. |
| New setup effect exceeds scope | Stop before that effect and obtain the required scope adjustment. |
| Main advanced but a host is stale | Use the partial-host procedure below. |
| A current host looks old in an open chat | Start a new session and check discovery again. |

### Recover a partial host refresh

1. Record the apply exit, installed HEAD and each host's actual status. Compare
   installed HEAD with the full approved commit. If main did not advance to that
   commit, follow the pre-advance troubleshooting row above; do not run host setup.
2. Stop owned workers and reconcile only owned locks.
3. Check the error and obtain any missing scope before another setup attempt.
4. Require installed HEAD to equal the full approved commit and require no
   uncommitted tracked source changes. Review and preserve untracked files.
   Verify the host environment roots from Step 6 and keep source fixed.
5. Run only the failed or never-reached host setup, within the approved retry
   limit. These are recovery commands, not steps to run after every update:

   ```bash
   cd "$HOME/Dev/gstack"
   ./setup --host claude
   ```

   ```bash
   cd "$HOME/Dev/gstack"
   ./setup --host codex
   ```

6. If Claude setup failed, refresh Claude first, then the never-reached Codex
   host, within the permitted retry limits. If only Codex failed, refresh Codex
   only. Verify both global installations and report any remaining partial failure.

Do not rerun `apply` to repair a setup failure after main advanced. Its receipt
records the old main identity. Do not reset main or discard user files.

## Publishing to the personal fork

The integration script does not publish commits. Publishing requires a separate
request and a review of the outgoing changes. Confirm the `fork` remote before
publishing. Keep this local customization out of Garry's `origin`.

## Related documentation

- [Integration command behavior and validation design](howto-integrate-custom-gstack.md)
- [Testing commands and policies](../CONTRIBUTING.md#which-command-do-i-run)
- [Validation discipline](../AGENTS.md#validation-discipline)
