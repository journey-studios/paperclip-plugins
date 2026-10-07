export function assertRepository(remote, expectedRemote) {
  if (remote !== expectedRemote) {
    throw new Error("Paperclip checkout origin does not match the pinned public repository");
  }
}

export function checkoutNeedsPin({ currentCommit, pinnedCommit, status, newlyCloned }) {
  if (currentCommit === pinnedCommit) return false;
  const lines = status.split("\n").filter(Boolean);
  if (lines.length > 0 && !newlyCloned) {
    throw new Error("Refusing to replace a modified Paperclip checkout");
  }
  return true;
}

export function assertPublicCompatibilityPatch(patchText) {
  if (!patchText.includes("artifacts.read") || !patchText.includes('"artifacts.list"')) {
    throw new Error("Compatibility patch is missing the artifact catalog capability or API method");
  }
  if (/journeystudios|tessel|\bJOU-\d+/i.test(patchText)) {
    throw new Error("Compatibility patch contains organization-specific test fixtures");
  }
}

export function assertWorkspaceAlias(workspacePath, hostPath) {
  if (workspacePath !== hostPath) {
    throw new Error("When PAPERCLIP_HOST_DIR is set, .paperclip must point to that exact checkout");
  }
}
