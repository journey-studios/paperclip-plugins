import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const validator = join(root, "scripts/validate-package-archive.py");

function archiveFixture(memberName, memberType = "file") {
  const directory = mkdtempSync(join(tmpdir(), "paperclip-archive-test-"));
  const archive = join(directory, "plugin.tgz");
  const python = String.raw`
import io, sys, tarfile
with tarfile.open(sys.argv[1], "w:gz") as archive:
    member = tarfile.TarInfo(sys.argv[2])
    if sys.argv[3] == "file":
        contents = b"safe"
        member.size = len(contents)
        archive.addfile(member, io.BytesIO(contents))
    else:
        member.type = {"symlink": tarfile.SYMTYPE, "hardlink": tarfile.LNKTYPE, "fifo": tarfile.FIFOTYPE}[sys.argv[3]]
        member.linkname = "package/worker.js"
        archive.addfile(member)
`;
  execFileSync("python3", ["-c", python, archive, memberName, memberType]);
  return { directory, archive };
}

function validationResult(archive) {
  return spawnSync("python3", [validator, archive], { encoding: "utf8" });
}

test("accepts regular files and directories in a plugin archive", () => {
  const fixture = archiveFixture("package/dist/worker.js");
  try {
    assert.equal(validationResult(fixture.archive).status, 0);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("rejects traversal paths and link or special archive members", () => {
  for (const [name, type] of [
    ["../outside", "file"],
    ["/absolute", "file"],
    ["package/link", "symlink"],
    ["package/hardlink", "hardlink"],
    ["package/fifo", "fifo"],
  ]) {
    const fixture = archiveFixture(name, type);
    try {
      const result = validationResult(fixture.archive);
      assert.equal(result.status, 1, `${name} (${type}) should be rejected: ${result.stderr}`);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  }
});
