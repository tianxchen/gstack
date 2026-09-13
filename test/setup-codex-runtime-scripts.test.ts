import { test, expect } from 'bun:test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('Codex runtime can import question tuning dependencies', () => {
  const root = resolve(import.meta.dir, '..');
  const setup = readFileSync(join(root, 'setup'), 'utf8');
  const fn = setup.match(/^create_codex_runtime_root\(\) \{[\s\S]*?^\}/m)![0];
  const dir = mkdtempSync(join(tmpdir(), 'gstack-runtime-test-'));
  try {
    const install = Bun.spawnSync(['bash', '-c',
      '_link_or_copy() { ln -s "$1" "$2"; }\n' + fn + '\ncreate_codex_runtime_root "$1" "$2"',
      'test', root, join(dir, 'runtime')], { timeout: 10_000 });
    expect(install.exitCode).toBe(0);
    const check = Bun.spawnSync(['bun', '-e',
      "await import('./scripts/one-way-doors.ts'); await import('./scripts/archetypes.ts'); await import('./scripts/psychographic-signals.ts');"],
      { cwd: join(dir, 'runtime'), timeout: 10_000 });
    expect(check.stderr.toString()).toBe('');
    expect(check.exitCode).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
