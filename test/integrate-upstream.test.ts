import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "../bin/gstack-integrate-upstream");
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0))
    rmSync(fixture, { recursive: true, force: true });
});

function run(
  command: string,
  args: string[],
  cwd?: string,
  extraEnv: Record<string, string> = {},
) {
  const result = Bun.spawnSync([command, ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  return {
    code: result.exitCode,
    out: new TextDecoder().decode(result.stdout),
    err: new TextDecoder().decode(result.stderr),
  };
}

function git(cwd: string, ...args: string[]) {
  const result = run("git", args, cwd);
  if (result.code !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.err}`);
  return result.out.trim();
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gstack-integrate-")));
  fixtures.push(root);
  const remote = join(root, "upstream.git");
  const main = join(root, "gstack");
  const integration = join(root, "gstack-integration");
  const publisher = join(root, "publisher");
  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(root, "clone", remote, main);
  git(main, "config", "user.name", "Test");
  git(main, "config", "user.email", "test@example.com");
  writeFileSync(join(main, "VERSION"), "1.0.0\n");
  writeFileSync(
    join(main, "setup"),
    '#!/usr/bin/env bash\nprintf "%s\\n" "$2" >> setup-calls\n',
  );
  chmodSync(join(main, "setup"), 0o755);
  writeFileSync(join(main, "local.txt"), "base\n");
  mkdirSync(join(main, "bin"));
  mkdirSync(join(main, "lib"));
  mkdirSync(join(main, ".github/docker"), { recursive: true });
  for (const file of [
    "bin/gstack-integrate-upstream",
    "lib/upstream-integration-validation.ts",
    ".github/docker/Dockerfile.integration",
  ]) {
    copyFileSync(resolve(import.meta.dir, "..", file), join(main, file));
  }
  writeFileSync(
    join(main, "package.json"),
    JSON.stringify({
      name: "integration-fixture",
      engines: { bun: ">=1.4.2" },
      scripts: {
        "integration:browser":
          "node -e \"console.log('browser prerequisites')\"",
        build: "node -e \"console.log('build')\"",
        typecheck: "node -e \"console.log('types')\"",
        "typecheck:test": "node -e \"console.log('test types')\"",
        test: "node -e \"console.log('full fixture acceptance')\"",
      },
    }),
  );
  writeFileSync(join(main, ".gitignore"), "node_modules/\nbun.lock\n");
  git(main, "add", ".");
  git(main, "commit", "-m", "base");
  git(main, "push", "-u", "origin", "main");
  git(root, "clone", remote, publisher);
  git(publisher, "config", "user.name", "Publisher");
  git(publisher, "config", "user.email", "publisher@example.com");
  return { root, main, integration, publisher };
}

function call(
  main: string,
  integration: string,
  action: string,
  sha?: string,
  extra: string[] = [],
) {
  return run(
    "bash",
    [
      script,
      action,
      ...(sha ? [sha] : []),
      ...extra,
      "--repo",
      main,
      "--worktree",
      integration,
    ],
    undefined,
    { GSTACK_HOME: join(main, "..", "gstack-state") },
  );
}

function validate(main: string, integration: string) {
  const result = call(main, integration, "validate", undefined, [
    "--backend",
    "native",
  ]);
  expect({ code: result.code, err: result.err, out: result.out }).toMatchObject(
    { code: 0 },
  );
}

function record(main: string) {
  return join(main, ".git/upstream-integration-validation/latest.json");
}

test("prepare preserves local commits; apply advances main only for the tested SHA and refreshes both hosts", () => {
  const { main, integration, publisher } = fixture();
  writeFileSync(join(main, "local.txt"), "customized\n");
  git(main, "commit", "-am", "local customization");
  const oldMain = git(main, "rev-parse", "HEAD");
  writeFileSync(join(publisher, "upstream.txt"), "new upstream feature\n");
  git(publisher, "add", "upstream.txt");
  git(publisher, "commit", "-m", "upstream update");
  git(publisher, "push", "origin", "main");

  const prepared = call(main, integration, "prepare");
  expect(prepared.code).toBe(0);
  expect(prepared.out).toContain("validate --repo");
  expect(
    readFileSync(
      join(main, "..", "gstack-state", "security", "egress.jsonl"),
      "utf8",
    ),
  ).toContain('"sink":"upstream-integration"');
  expect(git(main, "rev-parse", "HEAD")).toBe(oldMain);
  expect(readFileSync(join(integration, "local.txt"), "utf8")).toBe(
    "customized\n",
  );
  expect(readFileSync(join(integration, "upstream.txt"), "utf8")).toBe(
    "new upstream feature\n",
  );
  const preparedSha = git(integration, "rev-parse", "HEAD");

  const wrong = call(main, integration, "apply", oldMain);
  expect(wrong.code).not.toBe(0);
  expect(git(main, "rev-parse", "HEAD")).toBe(oldMain);

  const unvalidated = call(main, integration, "apply", preparedSha);
  expect(unvalidated.code).not.toBe(0);
  expect(unvalidated.err).toContain("run validate before apply");
  expect(git(main, "rev-parse", "HEAD")).toBe(oldMain);
  validate(main, integration);
  const rehearsal = call(main, integration, "apply", preparedSha, [
    "--check-only",
  ]);
  expect(rehearsal.code).toBe(0);
  expect(rehearsal.out).toContain("Check only");
  expect(git(main, "rev-parse", "HEAD")).toBe(oldMain);
  expect(existsSync(join(main, "setup-calls"))).toBe(false);

  const applied = call(main, integration, "apply", preparedSha);
  expect(applied.code).toBe(0);
  expect(git(main, "rev-parse", "HEAD")).toBe(preparedSha);
  expect(readFileSync(join(main, "setup-calls"), "utf8")).toBe(
    "claude\ncodex\n",
  );
  expect(git(main, "status", "--porcelain")).toBe("?? setup-calls");
});

test("apply refuses a changed main or a dirty integration worktree", () => {
  const { main, integration } = fixture();
  expect(call(main, integration, "prepare").code).toBe(0);
  const preparedSha = git(integration, "rev-parse", "HEAD");

  writeFileSync(join(integration, "unsaved.txt"), "not tested\n");
  expect(call(main, integration, "apply", preparedSha).err).toContain(
    "integration worktree has changes",
  );
  rmSync(join(integration, "unsaved.txt"));

  writeFileSync(join(main, "local.txt"), "uncommitted edit\n");
  expect(call(main, integration, "apply", preparedSha).err).toContain(
    "local main has tracked changes",
  );
  writeFileSync(join(main, "local.txt"), "base\n");

  writeFileSync(join(main, "later.txt"), "new local work\n");
  git(main, "add", "later.txt");
  git(main, "commit", "-m", "local main advanced");
  const currentMain = git(main, "rev-parse", "HEAD");
  expect(call(main, integration, "apply", preparedSha).err).toContain(
    "local main advanced",
  );
  expect(git(main, "rev-parse", "HEAD")).toBe(currentMain);

  expect(call(main, integration, "prepare").code).toBe(0);
  const refreshedSha = git(integration, "rev-parse", "HEAD");
  expect(refreshedSha).not.toBe(preparedSha);
  validate(main, integration);
  expect(call(main, integration, "apply", refreshedSha).code).toBe(0);
  expect(git(main, "rev-parse", "HEAD")).toBe(refreshedSha);
});

test("failed validation replaces earlier passing evidence and prevents any host refresh", () => {
  const { main, integration } = fixture();
  expect(call(main, integration, "prepare").code).toBe(0);
  validate(main, integration);
  const pkg = JSON.parse(
    readFileSync(join(integration, "package.json"), "utf8"),
  );
  pkg.scripts.build = 'node -e "process.exit(7)"';
  writeFileSync(join(integration, "package.json"), JSON.stringify(pkg));
  git(integration, "commit", "-am", "broken build");
  const failed = call(main, integration, "validate", undefined, [
    "--backend",
    "native",
  ]);
  expect(failed.code).not.toBe(0);
  expect(failed.err).toContain("build failed (exit 7)");
  expect(JSON.parse(readFileSync(record(main), "utf8")).status).toBe("failed");
  const before = git(main, "rev-parse", "HEAD");
  expect(
    call(main, integration, "apply", git(integration, "rev-parse", "HEAD"))
      .code,
  ).not.toBe(0);
  expect(git(main, "rev-parse", "HEAD")).toBe(before);
  expect(existsSync(join(main, "setup-calls"))).toBe(false);
});

test("apply rejects stale, incomplete, interrupted, foreign and edited validation evidence", () => {
  const { main, integration } = fixture();
  expect(call(main, integration, "prepare").code).toBe(0);
  const mainBefore = git(main, "rev-parse", "HEAD");
  writeFileSync(join(integration, "local.txt"), "candidate with changes\n");
  git(integration, "commit", "-am", "candidate");
  validate(main, integration);
  const sha = git(integration, "rev-parse", "HEAD");
  const original = JSON.parse(readFileSync(record(main), "utf8"));
  const cases = [
    { ...original, status: "running" },
    { ...original, results: original.results.slice(0, -1) },
    {
      ...original,
      identity: { ...original.identity, repo: "/another/repository" },
    },
    {
      ...original,
      identity: { ...original.identity, upstream: "0".repeat(40) },
    },
  ];
  const messages = [
    "Validation is running",
    "incomplete",
    "Validation is stale",
    "Validation is stale",
  ];
  for (const [index, value] of cases.entries()) {
    writeFileSync(record(main), JSON.stringify(value));
    const refused = call(main, integration, "apply", sha);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain(messages[index]);
    expect(existsSync(join(main, "setup-calls"))).toBe(false);
  }
  writeFileSync(record(main), JSON.stringify(original));
  writeFileSync(original.results[0].log, "changed evidence");
  expect(call(main, integration, "apply", sha).err).toContain(
    "evidence is missing or changed",
  );
  expect(git(main, "rev-parse", "HEAD")).toBe(mainBefore);
  expect(existsSync(join(main, "setup-calls"))).toBe(false);
});

test("validation detects a build that rewrites committed source", () => {
  const { main, integration } = fixture();
  expect(call(main, integration, "prepare").code).toBe(0);
  const pkg = JSON.parse(
    readFileSync(join(integration, "package.json"), "utf8"),
  );
  pkg.scripts.build =
    "node -e \"require('fs').writeFileSync('local.txt', 'rewritten')\"";
  writeFileSync(join(integration, "package.json"), JSON.stringify(pkg));
  git(integration, "commit", "-am", "build mutates source");
  const result = call(main, integration, "validate", undefined, [
    "--backend",
    "native",
  ]);
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("validation changed tracked source");
  expect(JSON.parse(readFileSync(record(main), "utf8")).status).toBe("failed");
  expect(readFileSync(join(integration, "local.txt"), "utf8")).toBe("base\n");
});

test("a base that moves during validation cannot receive passing evidence", () => {
  const { main, integration } = fixture();
  expect(call(main, integration, "prepare").code).toBe(0);
  const oldMain = git(main, "rev-parse", "HEAD");
  const nextMain = git(
    main,
    "commit-tree",
    git(main, "rev-parse", "HEAD^{tree}"),
    "-p",
    oldMain,
    "-m",
    "concurrent work",
  );
  writeFileSync(
    join(integration, "move-main.cjs"),
    `require('child_process').execFileSync('git', ['-C', ${JSON.stringify(main)}, 'update-ref', 'refs/heads/main', '${nextMain}'], { timeout: 30_000 });`,
  );
  const pkg = JSON.parse(
    readFileSync(join(integration, "package.json"), "utf8"),
  );
  pkg.scripts.build = "node move-main.cjs";
  writeFileSync(join(integration, "package.json"), JSON.stringify(pkg));
  git(integration, "add", ".");
  git(integration, "commit", "-m", "exercise concurrent base move");
  const result = call(main, integration, "validate", undefined, [
    "--backend",
    "native",
  ]);
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("Source or base moved during validation");
  expect(JSON.parse(readFileSync(record(main), "utf8")).status).toBe("failed");
  expect(git(main, "rev-parse", "HEAD")).toBe(nextMain);
  expect(existsSync(join(main, "setup-calls"))).toBe(false);
});

test("validation and apply refuse a held workflow lock", () => {
  const { main, integration } = fixture();
  expect(call(main, integration, "prepare").code).toBe(0);
  const lock = join(main, ".git/upstream-integration-validation.lock");
  mkdirSync(lock);
  expect(
    call(main, integration, "validate", undefined, ["--backend", "native"]).err,
  ).toContain("Another validation/apply may be running");
  expect(
    call(main, integration, "apply", git(integration, "rev-parse", "HEAD")).err,
  ).toContain("another validation/apply may be running");
  expect(existsSync(join(main, "setup-calls"))).toBe(false);
});

test("a new candidate commit needs new validation, even if an earlier candidate passed", () => {
  const { main, integration } = fixture();
  expect(call(main, integration, "prepare").code).toBe(0);
  validate(main, integration);
  writeFileSync(join(integration, "local.txt"), "changed after passing\n");
  git(integration, "commit", "-am", "new candidate");
  const result = call(
    main,
    integration,
    "apply",
    git(integration, "rev-parse", "HEAD"),
  );
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("Validation is stale");
  expect(readFileSync(join(main, "local.txt"), "utf8")).toBe("base\n");
});

test("conflicting upstream changes stop in the integration worktree and leave main intact", () => {
  const { main, integration, publisher } = fixture();
  writeFileSync(join(main, "local.txt"), "local version\n");
  git(main, "commit", "-am", "local edit");
  const oldMain = git(main, "rev-parse", "HEAD");
  writeFileSync(join(publisher, "local.txt"), "upstream version\n");
  git(publisher, "commit", "-am", "upstream edit");
  git(publisher, "push", "origin", "main");

  const result = call(main, integration, "prepare");
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("resolve conflicts");
  expect(git(main, "rev-parse", "HEAD")).toBe(oldMain);
  expect(git(integration, "diff", "--name-only", "--diff-filter=U")).toBe(
    "local.txt",
  );
});
