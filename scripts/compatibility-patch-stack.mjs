import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runGit(checkout, args, env, quiet = false) {
  return execFileSync("git", args, {
    cwd: checkout,
    env,
    stdio: quiet ? "ignore" : "pipe",
  });
}

function patchPaths(patches) {
  return [...new Set(patches.flatMap((patch) => {
    const text = readFileSync(patch, "utf8");
    return [...text.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)].map(([, from, to]) => {
      if (from !== to) throw new Error(`Unsupported compatibility patch path: ${patch}`);
      return from;
    });
  }))];
}

function createSnapshotIndex({ checkout, paths, indexPath }) {
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  runGit(checkout, ["read-tree", "HEAD"], env);
  const trackedPaths = runGit(checkout, ["ls-files", "-z", "--", ...paths], env).toString("utf8").split("\0").filter(Boolean);
  const currentPaths = paths.filter((path) => existsSync(join(checkout, path)));
  const stagePaths = [...new Set([...trackedPaths, ...currentPaths])];
  if (stagePaths.length > 0) runGit(checkout, ["add", "-A", "--", ...stagePaths], env);
  return runGit(checkout, ["write-tree"], env).toString("utf8").trim();
}

function simulatesPrefix({ checkout, patches, prefixLength, indexDirectory, snapshotTree }) {
  const indexPath = join(indexDirectory, `index-${prefixLength}`);
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };

  try {
    runGit(checkout, ["read-tree", snapshotTree], env);

    for (let index = prefixLength - 1; index >= 0; index -= 1) {
      const patch = patches[index];
      runGit(checkout, ["apply", "--cached", "--reverse", "--check", patch], env, true);
      runGit(checkout, ["apply", "--cached", "--reverse", "--whitespace=nowarn", patch], env, true);
    }

    for (let index = 0; index < patches.length; index += 1) {
      const patch = patches[index];
      runGit(checkout, ["apply", "--cached", "--check", patch], env, true);
      runGit(checkout, ["apply", "--cached", "--whitespace=nowarn", patch], env, true);
    }

    return runGit(checkout, ["write-tree"], env).toString("utf8").trim();
  } catch {
    return false;
  }
}

/**
 * Validate the ordered compatibility stack against a temporary Git index,
 * then apply only its missing suffix to the checkout's working tree.
 */
export function applyCompatibilityPatchStack({ checkout, patches }) {
  const indexDirectory = mkdtempSync(join(tmpdir(), "paperclip-patch-stack-"));
  try {
    const paths = patchPaths(patches);
    const snapshotTree = createSnapshotIndex({ checkout, paths, indexPath: join(indexDirectory, "snapshot-index") });
    let appliedPrefix = -1;
    let finalTree = null;
    for (let prefixLength = patches.length; prefixLength >= 0; prefixLength -= 1) {
      const simulatedTree = simulatesPrefix({ checkout, patches, prefixLength, indexDirectory, snapshotTree });
      if (simulatedTree) {
        appliedPrefix = prefixLength;
        finalTree = simulatedTree;
        break;
      }
    }

    if (appliedPrefix < 0) {
      throw new Error("Paperclip checkout has a conflicting or partial compatibility patch stack; no patches were applied");
    }

    const env = { ...process.env, GIT_INDEX_FILE: join(indexDirectory, "snapshot-index") };
    const consolidatedPatch = runGit(checkout, ["diff", "--binary", snapshotTree, finalTree], env);
    if (consolidatedPatch.length > 0) {
      execFileSync("git", ["apply", "--check", "--whitespace=nowarn"], {
        cwd: checkout,
        input: consolidatedPatch,
        stdio: ["pipe", "ignore", "inherit"],
      });
      execFileSync("git", ["apply", "--whitespace=nowarn"], {
        cwd: checkout,
        input: consolidatedPatch,
        stdio: ["pipe", "inherit", "inherit"],
      });
    }

    return { appliedPrefix, appliedCount: patches.length - appliedPrefix };
  } finally {
    rmSync(indexDirectory, { recursive: true, force: true });
  }
}
