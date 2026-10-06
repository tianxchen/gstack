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

Review and test the integration worktree. The script prints its full commit ID
and the next command. Use the Bun version required by `package.json`; a test
run with an older version does not qualify the merge. For example:

```bash
cd ../gstack-integration
bun install --frozen-lockfile
bun run typecheck
bun run test
cd ../gstack
./bin/gstack-integrate-upstream apply <full-tested-commit-id>
```

`apply` refuses a different integration commit, uncommitted changes in that
worktree, tracked edits on local `main`, or a local `main` that moved since the
integration commit was prepared. When the checks pass, it fast-forwards local
`main` and runs `./setup --host claude` and `./setup --host codex`. If a setup
step fails, local `main` remains at the integrated commit; fix the reported
setup issue and rerun that host's setup command. The script never pushes.

Use `./bin/gstack-integrate-upstream status` to see the local, integration, and
fetched upstream commit IDs. `--repo`, `--worktree`, `--branch`, and `--upstream`
override the defaults when the checkout uses different names or locations.
The integration branch defaults to `codex/gstack-integration` so an existing
worktree with that branch is reused.

After `apply`, `./setup --status` should report both global installations as
current. If you publish your customization, push to your fork after reviewing
the outgoing commits. Do not push this local branch to Garry's `origin`.
