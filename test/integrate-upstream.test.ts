import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(import.meta.dir, '../bin/gstack-integrate-upstream');
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function run(command: string, args: string[], cwd?: string) {
  const result = Bun.spawnSync([command, ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: result.exitCode,
    out: new TextDecoder().decode(result.stdout),
    err: new TextDecoder().decode(result.stderr),
  };
}

function git(cwd: string, ...args: string[]) {
  const result = run('git', args, cwd);
  if (result.code !== 0) throw new Error(`git ${args.join(' ')}: ${result.err}`);
  return result.out.trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gstack-integrate-'));
  fixtures.push(root);
  const remote = join(root, 'upstream.git');
  const main = join(root, 'gstack');
  const integration = join(root, 'gstack-integration');
  const publisher = join(root, 'publisher');
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(root, 'clone', remote, main);
  git(main, 'config', 'user.name', 'Test');
  git(main, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(main, 'VERSION'), '1.0.0\n');
  writeFileSync(join(main, 'setup'), '#!/usr/bin/env bash\nprintf "%s\\n" "$2" >> setup-calls\n');
  chmodSync(join(main, 'setup'), 0o755);
  writeFileSync(join(main, 'local.txt'), 'base\n');
  git(main, 'add', 'VERSION', 'setup', 'local.txt');
  git(main, 'commit', '-m', 'base');
  git(main, 'push', '-u', 'origin', 'main');
  git(root, 'clone', remote, publisher);
  git(publisher, 'config', 'user.name', 'Publisher');
  git(publisher, 'config', 'user.email', 'publisher@example.com');
  return { root, main, integration, publisher };
}

function call(main: string, integration: string, action: string, sha?: string) {
  return run('bash', [script, action, ...(sha ? [sha] : []), '--repo', main, '--worktree', integration]);
}

test('prepare preserves local commits; apply advances main only for the tested SHA and refreshes both hosts', () => {
  const { main, integration, publisher } = fixture();
  writeFileSync(join(main, 'local.txt'), 'customized\n');
  git(main, 'commit', '-am', 'local customization');
  const oldMain = git(main, 'rev-parse', 'HEAD');
  writeFileSync(join(publisher, 'upstream.txt'), 'new upstream feature\n');
  git(publisher, 'add', 'upstream.txt');
  git(publisher, 'commit', '-m', 'upstream update');
  git(publisher, 'push', 'origin', 'main');

  const prepared = call(main, integration, 'prepare');
  expect(prepared.code).toBe(0);
  expect(prepared.out).toContain('bun install --frozen-lockfile && bun run typecheck');
  expect(git(main, 'rev-parse', 'HEAD')).toBe(oldMain);
  expect(readFileSync(join(integration, 'local.txt'), 'utf8')).toBe('customized\n');
  expect(readFileSync(join(integration, 'upstream.txt'), 'utf8')).toBe('new upstream feature\n');
  const preparedSha = git(integration, 'rev-parse', 'HEAD');

  const wrong = call(main, integration, 'apply', oldMain);
  expect(wrong.code).not.toBe(0);
  expect(git(main, 'rev-parse', 'HEAD')).toBe(oldMain);

  const applied = call(main, integration, 'apply', preparedSha);
  expect(applied.code).toBe(0);
  expect(git(main, 'rev-parse', 'HEAD')).toBe(preparedSha);
  expect(readFileSync(join(main, 'setup-calls'), 'utf8')).toBe('claude\ncodex\n');
  expect(git(main, 'status', '--porcelain')).toBe('?? setup-calls');
});

test('apply refuses a changed main or a dirty integration worktree', () => {
  const { main, integration } = fixture();
  expect(call(main, integration, 'prepare').code).toBe(0);
  const preparedSha = git(integration, 'rev-parse', 'HEAD');

  writeFileSync(join(integration, 'unsaved.txt'), 'not tested\n');
  expect(call(main, integration, 'apply', preparedSha).err).toContain('integration worktree has changes');
  rmSync(join(integration, 'unsaved.txt'));

  writeFileSync(join(main, 'local.txt'), 'uncommitted edit\n');
  expect(call(main, integration, 'apply', preparedSha).err).toContain('local main has tracked changes');
  writeFileSync(join(main, 'local.txt'), 'base\n');

  writeFileSync(join(main, 'later.txt'), 'new local work\n');
  git(main, 'add', 'later.txt');
  git(main, 'commit', '-m', 'local main advanced');
  const currentMain = git(main, 'rev-parse', 'HEAD');
  expect(call(main, integration, 'apply', preparedSha).err).toContain('local main advanced');
  expect(git(main, 'rev-parse', 'HEAD')).toBe(currentMain);

  expect(call(main, integration, 'prepare').code).toBe(0);
  const refreshedSha = git(integration, 'rev-parse', 'HEAD');
  expect(refreshedSha).not.toBe(preparedSha);
  expect(call(main, integration, 'apply', refreshedSha).code).toBe(0);
  expect(git(main, 'rev-parse', 'HEAD')).toBe(refreshedSha);
});

test('conflicting upstream changes stop in the integration worktree and leave main intact', () => {
  const { main, integration, publisher } = fixture();
  writeFileSync(join(main, 'local.txt'), 'local version\n');
  git(main, 'commit', '-am', 'local edit');
  const oldMain = git(main, 'rev-parse', 'HEAD');
  writeFileSync(join(publisher, 'local.txt'), 'upstream version\n');
  git(publisher, 'commit', '-am', 'upstream edit');
  git(publisher, 'push', 'origin', 'main');

  const result = call(main, integration, 'prepare');
  expect(result.code).not.toBe(0);
  expect(result.err).toContain('resolve conflicts');
  expect(git(main, 'rev-parse', 'HEAD')).toBe(oldMain);
  expect(git(integration, 'diff', '--name-only', '--diff-filter=U')).toBe('local.txt');
});
