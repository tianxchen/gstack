# Keep a customized gstack checkout current

Use this workflow when `origin` is the upstream gstack repository and your local
`main` contains custom commits. It retains those commits while bringing in
`origin/main`. The same source checkout can serve Claude Code and Codex.

Keep `auto_upgrade: false`. Automatic fast-forward updates cannot reconcile a
custom branch, and a direct reset would discard local commits.

From the checkout that is installed for both hosts:

```bash
cd /path/to/gstack
./bin/gstack-integrate-upstream prepare
```

`prepare` fetches `origin/main`, creates `../gstack-integration` on its first
run, and merges local `main` and the fetched upstream commit there. It does not
change local `main`. If Git reports a conflict, edit the files in the integration
worktree, stage and commit the resolution, then run `prepare` again.
For a shallow checkout it also fetches complete history, which Git needs to
make a self-contained validation snapshot.

Review the candidate and commit your changes in the integration worktree.
Use the Bun version required by the candidate's `package.json`. Run validation
with the candidate's command so the new gate also works before its first activation:

```bash
../gstack-integration/bin/gstack-integrate-upstream validate --repo "$PWD"
../gstack-integration/bin/gstack-integrate-upstream status --repo "$PWD"
```

Validation tests a separate clone of the committed candidate. It never runs
setup or changes either active installation. It installs dependencies, builds,
and checks product and test types. On macOS the default `docker` backend runs
native launcher and macOS regression checks, then the complete free suite on
Linux in Docker. Linux defaults to the `native` backend and runs the full free
suite directly. `--backend native` on macOS also requires the full suite there;
it is not a way to skip the Linux-only test failures.

Docker must be running. The first validation builds a Linux image with Bun,
Node, Chromium, Xvfb, and the gate tools. Docker receives a committed Git bundle
and an owned output directory. It does not mount the operator's home, source
checkout, credentials, or Docker socket. Its seccomp setting permits user
namespaces so Chromium keeps its own sandbox. It has no extra capabilities or
host directories beyond those two inputs. Four CPUs bound its load while the
complete suite still runs. Node and Bun have separate tool directories, and
the source clone is outside the system temporary root, matching the suite's
path and fixture assumptions.

Only `HOME` is redirected for the test processes. Do not inject a shared
`GSTACK_HOME`, `CODEX_HOME`, or `CLAUDE_CONFIG_DIR`: tests create their own
isolated state and change HOME as needed. Docker configuration is passed only
to the host Docker client, never to test processes.

Records and full stage logs are stored under the repository's common Git
directory, in `upstream-integration-validation/`. Each record binds the candidate
commit and tree, local main, fetched upstream revision, validation policy, host,
and the check results and log hashes. A failed or interrupted run cannot reuse
an earlier pass. A changed commit, base, policy, or evidence requires validation
again. Keep this directory until activation; removing logs invalidates the pass.
These local records prevent accidental activation without checks. They are not
an attestation against a malicious process running as the same user.

After validation, rehearse promotion without activating:

```bash
../gstack-integration/bin/gstack-integrate-upstream apply <full-tested-commit-id> --check-only --repo "$PWD"
```

The check-only mode runs every promotion guard and leaves main and both hosts
untouched. Once the candidate has been reviewed and activation is approved,
run the same command without `--check-only`.

`apply` refuses missing, failed, incomplete, changed, or stale validation
evidence, a different integration commit, uncommitted changes in that worktree,
tracked edits on local `main`, or a local `main` that moved since validation.
Preserve and commit local changes before the final prepare/validation pass;
never discard them to make apply succeed. When the checks pass, it fast-forwards local
`main` and runs `./setup --host claude` and `./setup --host codex`. If a setup
step fails, local `main` remains at the integrated commit; fix the reported
setup issue and rerun that host's setup command. The script never pushes.

Use `./bin/gstack-integrate-upstream status` to see the local, integration, and
fetched upstream commit IDs. `--repo`, `--worktree`, `--branch`, and `--upstream`
override the defaults when the checkout uses different names or locations.
The integration branch defaults to `codex/gstack-integration` so an existing
worktree with that branch is reused.

Before this gate is first installed, the old command on main has no evidence
checks. Use the candidate's command for validation and activation. After activation,
the command on main has the same gate. Nothing schedules or activates an update
automatically; keep `auto_upgrade: false`.

After `apply`, `./setup --status` should report both global installations as
current. If you publish your customization, push to your fork after reviewing
the outgoing commits. Do not push this local branch to Garry's `origin`.
