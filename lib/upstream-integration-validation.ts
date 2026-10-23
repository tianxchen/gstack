/** Local acceptance evidence for the customized gstack update workflow. */
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

type Backend = "native" | "docker";
type Stage = { name: string; command: string[]; timeoutMs?: number };
type Result = {
  name: string;
  command: string[];
  exit: number;
  log: string;
  sha256: string;
};
type Identity = {
  repo: string;
  worktree: string;
  commit: string;
  tree: string;
  main: string;
  upstream: string;
  policy: string;
};
type Receipt = {
  schema: 1;
  identity: Identity;
  backend: Backend;
  platform: string;
  status: "running" | "failed" | "passed";
  startedAt: string;
  finishedAt?: string;
  bun: string;
  results: Result[];
  error?: string;
  linuxResults?: Result[];
};

const nativeMacTests = [
  "test/gstack-design-detect.test.ts",
  "browse/test/chromium-profile-isolation.test.ts",
  "test/cso-git-hardening.test.ts",
  "test/plan-count-file-permission.test.ts",
  "test/spec-quality-gate-secret-sink.test.ts",
  "test/gstack-memory-ingest.test.ts",
  "test/regression-issue3024-zsh-sourced-helpers.test.ts",
  "test/codex-probe-subcommands.test.ts",
  "test/integrate-upstream.test.ts",
];
const setupStages: Stage[] = [
  { name: "dependencies", command: ["bun", "install", "--frozen-lockfile"] },
  {
    name: "browser-prerequisites",
    command: ["bun", "run", "integration:browser"],
  },
  { name: "build", command: ["bun", "run", "build"] },
  { name: "typecheck", command: ["bun", "run", "typecheck"] },
  { name: "test-types", command: ["bun", "run", "typecheck:test"] },
];
const fullSuite: Stage = {
  name: "full-free-suite",
  command: ["bun", "run", "test"],
  timeoutMs: 60 * 60_000,
};
const macStages: Stage[] = [
  { name: "macos-launcher", command: ["bun", "run", "test:cso:macos"] },
  { name: "macos-regressions", command: ["bun", "test", ...nativeMacTests] },
];

function hash(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
function git(root: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.status !== 0)
    throw new Error(`git ${args[0]} failed: ${r.stderr?.trim()}`);
  return r.stdout.trim();
}
function commonDir(repo: string): string {
  return fs.realpathSync(
    path.resolve(repo, git(repo, "rev-parse", "--git-common-dir")),
  );
}
function stateRoot(repo: string): string {
  return path.join(commonDir(repo), "upstream-integration-validation");
}
function identity(repo: string, worktree: string, upstream: string): Identity {
  if (git(worktree, "status", "--porcelain"))
    throw new Error(
      "integration worktree has changes; commit them before validation",
    );
  const inputs = [
    "bin/gstack-integrate-upstream",
    "lib/upstream-integration-validation.ts",
    ".github/docker/Dockerfile.integration",
    "package.json",
  ];
  return {
    repo: fs.realpathSync(repo),
    worktree: fs.realpathSync(worktree),
    commit: git(worktree, "rev-parse", "HEAD"),
    tree: git(worktree, "rev-parse", "HEAD^{tree}"),
    main: git(repo, "rev-parse", "HEAD"),
    upstream: git(repo, "rev-parse", `${upstream}/main`),
    policy: hash(
      inputs
        .map((f) => fs.readFileSync(path.join(worktree, f), "utf8"))
        .join("\0"),
    ),
  };
}
function receiptPath(repo: string): string {
  return path.join(stateRoot(repo), "latest.json");
}
function atomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  fs.renameSync(temporary, file);
}
function environment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "SHELL",
    "LANG",
    "LC_ALL",
    "DISPLAY",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  fs.writeFileSync(
    path.join(home, ".gitconfig"),
    "[user]\n\tname = gstack validation\n\temail = validation@gstack.test\n[init]\n\tdefaultBranch = main\n",
    { mode: 0o600 },
  );
  return {
    ...env,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${env.PATH ?? ""}`,
    HOME: home,
    GIT_TERMINAL_PROMPT: "0",
  };
}
async function execute(
  stage: Stage,
  cwd: string,
  env: NodeJS.ProcessEnv,
  directory: string,
): Promise<Result> {
  const log = path.join(directory, `${stage.name}.log`);
  const fd = fs.openSync(log, "wx", 0o600);
  console.log(`Checking ${stage.name}; log: ${log}`);
  let exit: number;
  try {
    exit = await new Promise<number>((resolve, reject) => {
      const child = spawn(
        stage.command[0] === "bun" ? process.execPath : stage.command[0],
        stage.command.slice(1),
        {
          cwd,
          env: {
            ...env,
            ...(stage.name === "build" ? { GSTACK_STRICT_BUILD: "1" } : {}),
            ...(stage.name === "full-free-suite"
              ? { GSTACK_EXPECT_BINARIES: "1" }
              : {}),
            ...(process.platform === "darwin" &&
            ["macos-launcher", "full-free-suite"].includes(stage.name)
              ? { GSTACK_CSO_MACOS_TESTS: "1" }
              : {}),
          },
          stdio: ["ignore", fd, fd],
          detached: process.platform !== "win32",
        },
      );
      let expired = false;
      const stop = () => {
        try {
          process.platform === "win32"
            ? child.kill("SIGKILL")
            : process.kill(-child.pid!, "SIGKILL");
        } catch {}
      };
      const timer = setTimeout(
        () => {
          expired = true;
          stop();
        },
        stage.timeoutMs ?? 15 * 60_000,
      );
      const cleanup = () => {
        clearTimeout(timer);
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      child.once("error", (error) => {
        cleanup();
        reject(error);
      });
      child.once("exit", (code) => {
        stop();
        cleanup();
        resolve(expired ? 124 : (code ?? 1));
      });
    });
  } finally {
    fs.closeSync(fd);
  }
  return {
    name: stage.name,
    command: stage.command,
    exit,
    log,
    sha256: hash(fs.readFileSync(log)),
  };
}
async function runStages(
  stages: Stage[],
  root: string,
  env: NodeJS.ProcessEnv,
  directory: string,
  results: Result[],
): Promise<void> {
  for (const stage of stages) {
    const result = await execute(stage, root, env, directory);
    results.push(result);
    if (result.exit !== 0)
      throw new Error(
        `${stage.name} failed (exit ${result.exit}); see ${result.log}`,
      );
  }
}
function snapshot(
  bundle: string,
  target: string,
  commit: string,
  upstream: string,
): void {
  if (!path.isAbsolute(bundle) || !fs.lstatSync(bundle).isFile())
    throw new Error("snapshot requires an existing local bundle file");
  const cloned = spawnSync(
    "git",
    ["clone", "--quiet", "--no-checkout", bundle, target],
    { encoding: "utf8", timeout: 60_000 },
  );
  if (cloned.status !== 0)
    throw new Error(`snapshot clone failed: ${cloned.stderr}`);
  git(target, "checkout", "--quiet", "--detach", commit);
  git(target, "update-ref", "refs/remotes/origin/main", upstream);
}
function checkBun(root: string): string {
  const required = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  ).engines?.bun;
  const r = spawnSync(process.execPath, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  const version = r.stdout?.trim();
  if (
    r.status !== 0 ||
    !/^\d+\.\d+\.\d+$/.test(version) ||
    !/^>=\d+\.\d+\.\d+$/.test(required)
  ) {
    throw new Error(
      "Cannot compare Bun with package.json engines.bun; install the required stable Bun version",
    );
  }
  const wanted = required.slice(2).split(".").map(Number),
    actual = version.split(".").map(Number);
  const first = actual.findIndex((n: number, i: number) => n !== wanted[i]);
  if (first >= 0 && actual[first] < wanted[first])
    throw new Error(`Bun ${version} is below required ${required}`);
  return version;
}
function ensureSnapshotClean(root: string): void {
  if (git(root, "status", "--porcelain"))
    throw new Error(
      "validation changed tracked source; regenerate and commit it, then validate again",
    );
}
function expectedNames(backend: Backend, platform: string): string[] {
  return backend === "native"
    ? [...setupStages.map((s) => s.name), fullSuite.name]
    : [
        ...setupStages.map((s) => s.name),
        ...(platform === "darwin" ? macStages.map((s) => s.name) : []),
        "docker-image",
        "linux-validation",
      ];
}

/** Verify execution records, rather than accepting a supplied SHA as proof. */
export function verify(
  repo: string,
  worktree: string,
  upstream: string,
  commit: string,
): Receipt {
  const current = identity(repo, worktree, upstream);
  if (current.commit !== commit)
    throw new Error("integration HEAD changed; validate the new commit");
  let receipt: Receipt;
  try {
    receipt = JSON.parse(fs.readFileSync(receiptPath(repo), "utf8"));
  } catch {
    throw new Error("No readable validation record; run validate before apply");
  }
  if (
    receipt.schema !== 1 ||
    receipt.status !== "passed" ||
    !["native", "docker"].includes(receipt.backend)
  ) {
    throw new Error(
      `Validation is ${receipt.status ?? "invalid"}; run validate before apply`,
    );
  }
  if (
    JSON.stringify(receipt.identity) !== JSON.stringify(current) ||
    receipt.platform !== process.platform
  ) {
    throw new Error(
      "Validation is stale (commit, source, main, upstream, policy, or host changed); run validate again",
    );
  }
  const names = expectedNames(receipt.backend, receipt.platform);
  if (
    !Array.isArray(receipt.results) ||
    JSON.stringify(receipt.results.map((r) => r.name)) !== JSON.stringify(names)
  ) {
    throw new Error("Validation record is incomplete; run validate again");
  }
  for (const result of receipt.results) {
    const relative = path.relative(stateRoot(repo), result.log);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      result.exit !== 0 ||
      !fs.existsSync(result.log) ||
      !fs.lstatSync(result.log).isFile() ||
      hash(fs.readFileSync(result.log)) !== result.sha256
    ) {
      throw new Error(
        `Validation evidence is missing or changed for ${result.name}; run validate again`,
      );
    }
  }
  if (receipt.backend === "docker") {
    const linux = receipt.linuxResults;
    if (
      !Array.isArray(linux) ||
      JSON.stringify(linux.map((r) => r.name)) !==
        JSON.stringify(expectedNames("native", "linux"))
    ) {
      throw new Error(
        "Linux validation record is incomplete; run validate again",
      );
    }
    for (const r of linux) {
      const relative = path.relative(stateRoot(repo), r.log);
      if (
        relative.startsWith("..") ||
        path.isAbsolute(relative) ||
        r.exit !== 0 ||
        !fs.existsSync(r.log) ||
        !fs.lstatSync(r.log).isFile() ||
        hash(fs.readFileSync(r.log)) !== r.sha256
      )
        throw new Error(`Linux evidence changed for ${r.name}`);
    }
  }
  return receipt;
}

async function dockerValidation(
  root: string,
  run: string,
  env: NodeJS.ProcessEnv,
  receipt: Receipt,
): Promise<void> {
  const dockerEnv = {
    ...env,
    ...(process.env.DOCKER_HOST
      ? { DOCKER_HOST: process.env.DOCKER_HOST }
      : {}),
    ...(process.env.DOCKER_CONTEXT
      ? { DOCKER_CONTEXT: process.env.DOCKER_CONTEXT }
      : {}),
    DOCKER_CONFIG:
      process.env.DOCKER_CONFIG ?? path.join(process.env.HOME!, ".docker"),
  };
  const dockerfile = path.join(root, ".github/docker/Dockerfile.integration");
  const playwright = JSON.parse(
    fs.readFileSync(
      path.join(root, "node_modules/playwright/package.json"),
      "utf8",
    ),
  ).version;
  const bun = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  ).engines.bun.slice(2);
  const tag = `gstack-integration-validation:${hash(fs.readFileSync(dockerfile) + playwright + bun).slice(0, 20)}`;
  await runStages(
    [
      {
        name: "docker-image",
        command: [
          "docker",
          "build",
          "--build-arg",
          `PLAYWRIGHT_VERSION=${playwright}`,
          "--build-arg",
          `BUN_VERSION=${bun}`,
          "-t",
          tag,
          "-f",
          dockerfile,
          path.dirname(dockerfile),
        ],
        timeoutMs: 30 * 60_000,
      },
    ],
    root,
    dockerEnv,
    run,
    receipt.results,
  );
  const output = path.join(run, "linux");
  fs.mkdirSync(output, { mode: 0o700 });
  const container = `gstack-validation-${randomUUID()}`;
  try {
    await runStages(
      [
        {
          name: "linux-validation",
          command: [
            "docker",
            "run",
            "--rm",
            "--init",
            "--name",
            container,
            "--shm-size=2g",
            "--cpus=4",
            "--security-opt",
            "seccomp=unconfined",
            "--user",
            `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
            "--mount",
            `type=bind,source=${path.join(run, "source.bundle")},target=/input/source.bundle,readonly`,
            "--mount",
            `type=bind,source=${output},target=/output`,
            tag,
            "bash",
            "-c",
            'git clone -q /input/source.bundle /workspace/gstack && cd /workspace/gstack && git checkout -q --detach "$1" && bun --no-env-file --config=/dev/null lib/upstream-integration-validation.ts linux-worker "$1" "$2"',
            "gstack-validation",
            receipt.identity.commit,
            receipt.identity.upstream,
          ],
          timeoutMs: 150 * 60_000,
        },
      ],
      root,
      dockerEnv,
      run,
      receipt.results,
    );
  } finally {
    spawnSync("docker", ["rm", "--force", container], {
      env: dockerEnv,
      encoding: "utf8",
      timeout: 30_000,
    });
  }
  const result = JSON.parse(
    fs.readFileSync(path.join(output, "result.json"), "utf8"),
  );
  if (
    result.commit !== receipt.identity.commit ||
    result.tree !== receipt.identity.tree ||
    result.status !== "passed"
  ) {
    throw new Error(
      "Linux validation did not produce passing evidence for this exact source",
    );
  }
  if (
    !Array.isArray(result.results) ||
    JSON.stringify(result.results.map((r: Result) => r.name)) !==
      JSON.stringify(expectedNames("native", "linux"))
  ) {
    throw new Error("Linux validation did not execute every required check");
  }
  receipt.linuxResults = result.results.map((r: Result) => ({
    ...r,
    log: path.join(output, path.basename(r.log)),
  }));
}

async function linuxWorker(commit: string, upstream: string): Promise<void> {
  if (process.platform !== "linux")
    throw new Error("The Linux worker requires Linux");
  const root = process.cwd();
  if (git(root, "rev-parse", "HEAD") !== commit)
    throw new Error("Linux worker source changed");
  const bun = checkBun(root);
  git(root, "update-ref", "refs/remotes/origin/main", upstream);
  const home = "/tmp/gstack-validation-home";
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const env = {
    ...environment(home),
    PLAYWRIGHT_BROWSERS_PATH: "/opt/gstack-playwright",
  };
  const results: Result[] = [];
  try {
    await runStages(
      [
        ...setupStages,
        { ...fullSuite, command: ["xvfb-run", "-a", ...fullSuite.command] },
      ],
      root,
      env,
      "/output",
      results,
    );
    ensureSnapshotClean(root);
    atomicJson("/output/result.json", {
      status: "passed",
      commit,
      tree: git(root, "rev-parse", "HEAD^{tree}"),
      results,
      bun,
    });
  } finally {
    preserveSuiteLogs(root, "/output");
  }
}

function preserveSuiteLogs(root: string, output: string): void {
  const logs = path.join(root, ".context/free-test-logs");
  if (fs.existsSync(logs))
    fs.cpSync(logs, path.join(output, "free-test-logs"), { recursive: true });
}

function isolatedDirectory(): string {
  const temporaryRoot = fs.realpathSync(tmpdir());
  for (let parent = temporaryRoot; ; parent = path.dirname(parent)) {
    if (
      fs.existsSync(path.join(parent, "node_modules")) ||
      fs.existsSync(path.join(parent, ".git"))
    ) {
      throw new Error(
        "Temporary directory is inside a checkout or dependency tree; choose an isolated TMPDIR",
      );
    }
    if (path.dirname(parent) === parent) break;
  }
  return fs.mkdtempSync(path.join(temporaryRoot, "gstack-validation-"));
}

async function validate(
  repo: string,
  worktree: string,
  upstream: string,
  backend: Backend,
): Promise<void> {
  const before = identity(repo, worktree, upstream);
  const base = stateRoot(repo);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const run = path.join(
    base,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
  );
  fs.mkdirSync(run, { mode: 0o700 });
  const receipt: Receipt = {
    schema: 1,
    identity: before,
    backend,
    platform: process.platform,
    status: "running",
    startedAt: new Date().toISOString(),
    bun: "",
    results: [],
  };
  atomicJson(receiptPath(repo), receipt);
  let isolated: string | undefined;
  try {
    receipt.bun = checkBun(worktree);
    if (git(worktree, "rev-parse", "--is-shallow-repository") === "true") {
      throw new Error(
        "Git history is shallow; run prepare to fetch complete history before validation",
      );
    }
    const bundle = path.join(run, "source.bundle");
    git(
      worktree,
      "bundle",
      "create",
      bundle,
      "HEAD",
      "refs/heads/main",
      `refs/remotes/${upstream}/main`,
    );
    isolated = isolatedDirectory();
    const source = path.join(isolated, "native");
    snapshot(bundle, source, before.commit, before.upstream);
    const home = path.join(isolated, "home");
    fs.mkdirSync(home, { mode: 0o700 });
    const env = {
      ...environment(home),
      PLAYWRIGHT_BROWSERS_PATH: path.join(isolated, "browsers"),
    };
    await runStages(
      [
        ...setupStages,
        ...(backend === "native"
          ? [fullSuite]
          : process.platform === "darwin"
            ? macStages
            : []),
      ],
      source,
      env,
      run,
      receipt.results,
    );
    ensureSnapshotClean(source);
    if (backend === "docker") await dockerValidation(source, run, env, receipt);
    if (
      JSON.stringify(before) !==
      JSON.stringify(identity(repo, worktree, upstream))
    )
      throw new Error("Source or base moved during validation; validate again");
    receipt.status = "passed";
    atomicJson(receiptPath(repo), receipt);
    verify(repo, worktree, upstream, before.commit);
  } catch (error) {
    receipt.status = "failed";
    receipt.error = (error as Error).message;
    throw error;
  } finally {
    let cleanupError: Error | undefined;
    if (isolated) {
      try {
        preserveSuiteLogs(path.join(isolated, "native"), run);
      } catch (error) {
        cleanupError = error as Error;
      }
      try {
        fs.rmSync(isolated, { recursive: true, force: true });
      } catch (error) {
        cleanupError ??= error as Error;
      }
    }
    if (cleanupError) {
      receipt.status = "failed";
      receipt.error = `Validation cleanup failed: ${cleanupError.message}`;
    }
    receipt.finishedAt = new Date().toISOString();
    atomicJson(path.join(run, "receipt.json"), receipt);
    atomicJson(receiptPath(repo), receipt);
    console.log(`Validation ${receipt.status}: ${receiptPath(repo)}`);
    if (cleanupError) throw cleanupError;
  }
}

async function main(): Promise<void> {
  const [action, repo, worktree, upstream, value] = process.argv.slice(2);
  if (action === "linux-worker") return linuxWorker(repo, worktree);
  if (!repo || !worktree || !upstream)
    throw new Error("Missing validation paths");
  if (action === "verify") {
    verify(repo, worktree, upstream, value);
    console.log(`Validation passed for ${value}`);
    return;
  }
  if (action === "status") {
    try {
      const r = JSON.parse(fs.readFileSync(receiptPath(repo), "utf8"));
      if (r.status === "passed") {
        try {
          verify(repo, worktree, upstream, r.identity.commit);
        } catch (error) {
          r.status = `stale: ${(error as Error).message}`;
        }
      }
      console.log(
        `Validation: ${r.status} (${r.identity.commit}); ${receiptPath(repo)}`,
      );
    } catch {
      console.log("Validation: not run");
    }
    return;
  }
  if (action !== "validate" || !["native", "docker"].includes(value))
    throw new Error("Unknown validation action or backend");
  const lock = path.join(
    commonDir(repo),
    "upstream-integration-validation.lock",
  );
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch {
    throw new Error(
      `Another validation/apply may be running; inspect ${lock} before removing a stale lock`,
    );
  }
  try {
    await validate(repo, worktree, upstream, value as Backend);
  } finally {
    fs.rmdirSync(lock);
  }
}
if (import.meta.main)
  main().catch((error) => {
    console.error(`gstack integration: ${error.message}`);
    process.exitCode = 1;
  });
