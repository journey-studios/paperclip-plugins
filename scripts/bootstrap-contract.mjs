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

export function assertEvolutionCompatibilityPatch(patchText) {
  const required = [
    '"agent_config_revisions"',
    '"company_skill_versions"',
    '"company_skills"',
    '"activity_log"',
    '"activity.logged"',
    "activityAction",
    '"journeystudios.evolution"',
    '"evolution"',
  ];
  if (required.some((token) => !patchText.includes(token))) {
    throw new Error("Evolution compatibility patch is missing required read tables, Audit forwarding, or bundled-plugin registration");
  }
}

export function assertDeliveryQualityCompatibilityPatch(patchText) {
  const paths = [...patchText.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)];
  const added = [...patchText.matchAll(/^\+(?!\+)(.*)$/gm)].map((match) => match[1].trim());
  const removed = [...patchText.matchAll(/^-(?!-)(.*)$/gm)].map((match) => match[1].trim());
  const fileHeaders = [...patchText.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1]);
  const deletedHeaders = [...patchText.matchAll(/^--- a\/(.+)$/gm)].map((match) => match[1]);
  const required = ['"delivery_revisions",', '"delivery_evaluations",', '"run_execution_profiles",'];
  if (paths.length !== 1 || paths[0][1] !== "packages/shared/src/constants.ts" || paths[0][2] !== paths[0][1] ||
      fileHeaders.length !== 1 || fileHeaders[0] !== paths[0][1] || deletedHeaders.length !== 1 || deletedHeaders[0] !== paths[0][1] ||
      added.length !== required.length || required.some((line) => !added.includes(line)) || removed.length !== 0) {
    throw new Error("Delivery-quality compatibility patch must add only its three core read-table declarations");
  }
  if (/server\/src|packages\/db\/|CREATE\s+TABLE|CREATE\s+INDEX|migrations\//i.test(patchText)) {
    throw new Error("Delivery-quality compatibility patch may not add host code or schema");
  }
}

export function assertTelegramChatPublicationPatch(patchText) {
  const allowed = new Set([
    "packages/plugins/sdk/src/index.ts",
    "packages/plugins/sdk/src/host-client-factory.ts",
    "packages/plugins/sdk/src/types.ts",
    "packages/plugins/sdk/src/testing.ts",
    "packages/plugins/sdk/src/worker-rpc-host.ts",
    "packages/shared/src/constants.ts",
    "packages/plugins/sdk/src/protocol.ts",
  ]);
  const diffPaths = [...patchText.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)];
  const changedFiles = [...patchText.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1]);
  const deletedFiles = [...patchText.matchAll(/^--- a\/(.+)$/gm)].map((match) => match[1]).filter((file) => file !== "/dev/null");
  if (
    diffPaths.length !== allowed.size ||
    diffPaths.some(([, from, to]) => from !== to || !allowed.has(from)) ||
    changedFiles.length !== allowed.size || new Set(changedFiles).size !== allowed.size ||
    changedFiles.some((file) => !allowed.has(file)) ||
    deletedFiles.length !== allowed.size || deletedFiles.some((file) => !allowed.has(file))
  ) {
    throw new Error("Telegram chat publication patch may modify only the SDK protocol, types, and worker context files");
  }
  const required = [
    '"chat.publishComment"',
    "chat.publications.publish_existing_comment",
    "PluginChatClient",
    "ctx.chat",
  ];
  if (required.some((token) => !patchText.includes(token))) {
    throw new Error("Telegram chat publication patch is missing its capability, protocol, or SDK context contract");
  }
  if (/server\/src|packages\/db\//.test(patchText)) {
    throw new Error("Telegram chat publication patch must not modify host implementation or database files");
  }
  const sharedConstantsPatch = patchText.match(/diff --git a\/packages\/shared\/src\/constants\.ts[\s\S]*?(?=diff --git|$)/)?.[0] ?? "";
  const sharedAdded = [...sharedConstantsPatch.matchAll(/^\+(?!\+)(.*)$/gm)].map((match) => match[1]);
  const sharedRemoved = [...sharedConstantsPatch.matchAll(/^-(?!-)(.*)$/gm)].map((match) => match[1]);
  if (sharedAdded.length !== 1 || sharedAdded[0].trim() !== '"chat.publications.publish_existing_comment",' || sharedRemoved.length !== 0) {
    throw new Error("Telegram chat publication patch may add only its single capability to shared constants");
  }
}
