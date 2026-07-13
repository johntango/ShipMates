import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function createFirstmateId(prefix, { uuidFactory = randomUUID } = {}) {
  const compactUuid = uuidFactory().replaceAll("-", "").toLowerCase();
  return `${prefix}-${compactUuid.slice(0, 20)}`;
}

export async function discoverFirstmateContext({
  cwd = process.cwd(),
  runGit = runGitCommand,
} = {}) {
  const repoPath = path.resolve(cwd);
  const [remoteUrl, baseSha] = await Promise.all([
    runGit(["remote", "get-url", "origin"], repoPath),
    runGit(["rev-parse", "HEAD"], repoPath),
  ]);
  return {
    repoPath,
    repo: parseGitHubRepository(remoteUrl),
    baseSha: baseSha.trim(),
  };
}

export function parseGitHubRepository(remoteUrl) {
  const value = String(remoteUrl).trim().replace(/\.git$/u, "");
  const sshMatch = value.match(/^git@github\.com:([^/]+\/[^/]+)$/u);
  if (sshMatch) return sshMatch[1];
  try {
    const url = new URL(value);
    if (url.hostname === "github.com") {
      const repository = url.pathname.replace(/^\//u, "");
      if (/^[^/]+\/[^/]+$/u.test(repository)) return repository;
    }
  } catch {
    // Fall through to the actionable error below.
  }
  throw new Error(
    `Firstmate could not derive owner/repo from the origin remote: ${remoteUrl}`,
  );
}

async function runGitCommand(args, cwd) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
    });
    return stdout;
  } catch (cause) {
    throw new Error(
      `Firstmate requires a Git repository with an origin remote (${args.join(" ")})`,
      { cause },
    );
  }
}
