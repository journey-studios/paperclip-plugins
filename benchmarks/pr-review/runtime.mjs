import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { digest, requireValue } from "./score.mjs";

export const adapterDir = fileURLToPath(new URL("./adapters", import.meta.url));
const IMAGE = /^sha256:[a-f0-9]{64}$/;

/** Hash instruction contents, not machine-specific source paths. No credentials belong in this document. */
export async function freezeProfile(profile, layer) {
  requireValue(profile && IMAGE.test(profile.image), "Use a locally available immutable reviewer image id");
  requireValue(IMAGE.test(profile.gateway?.image), "Pin the gateway image id");
  requireValue(/^[a-zA-Z0-9_.-]+$/.test(profile.gateway.network), "Invalid model network name");
  requireValue(/^https?:\/\/[a-zA-Z0-9_.:-]+(?:\/v1)?\/?$/.test(profile.gateway.upstream), "Use a fixed model gateway endpoint without credentials or query strings");
  for (const key of ["requestModel", "effectiveModel"]) {
    requireValue(typeof profile.gateway[key] === "string" && profile.gateway[key].length > 0 && !/pool|^auto\//i.test(profile.gateway[key]), "Select a fixed model route; automatic pools cannot be frozen");
  }
  for (const key of ["maxRequests", "maxOutputTokens", "maxInputBytes", "timeoutSeconds"]) {
    requireValue(Number.isSafeInteger(profile.gateway[key]) && profile.gateway[key] > 0, `Set a positive gateway ${key}`);
  }
  requireValue(["unknown", "subscription"].includes(profile.gateway.costBasis), "This adapter reports unpriced gateway usage; dollar estimates need a separate rate receipt");
  requireValue(Number.isSafeInteger(profile.timeoutSeconds) && profile.timeoutSeconds > 0 && profile.timeoutSeconds <= 3600, "Set a reviewer timeout at most one hour");
  requireValue(/^\d{4,6}:\d{4,6}$/.test(profile.user), "Run the reviewer as an unprivileged uid:gid");
  requireValue(profile.reviewer?.requestModel === profile.gateway.requestModel, "Reviewer/gateway model mismatch");
  const instructions = [];
  if (layer === "thermo") {
    requireValue(profile.reviewer.instructions?.length > 0, "Snapshot the real Thermo instructions and skills first");
    requireValue(typeof profile.reviewer.deliveryInstructions === "string" && profile.reviewer.deliveryInstructions.trim(), "Missing local verdict delivery contract");
    requireValue(profile.reviewer.cliVersion && profile.reviewer.modelLimit?.context > 0 && profile.reviewer.modelLimit?.output > 0, "Pin the CLI version and model limits");
    for (const path of profile.reviewer.instructions) {
      requireValue(typeof path === "string" && path.endsWith(".md"), "Instructions must name explicit Markdown files");
      instructions.push(await readFile(path, "utf8"));
    }
  } else {
    requireValue(layer === "triage" && profile.reviewer.settings && typeof profile.reviewer.settings === "object", "Missing triage settings snapshot");
  }
  const adapterFiles = ["gateway.py", "triage.py", "thermo.mjs"];
  const adapterDigest = digest(await Promise.all(adapterFiles.map((name) => readFile(`${adapterDir}/${name}`, "utf8"))));
  const reviewer = { ...profile.reviewer };
  if (layer === "thermo") {
    reviewer.instructions = instructions;
  }
  const frozen = { ...profile, reviewer, adapterDigest };
  return { frozen, pins: { reviewerRevision: profile.image, effectiveModel: profile.gateway.effectiveModel, configDigest: digest(frozen) } };
}

export async function configureStudy(study, execution) {
  const configured = structuredClone(study);
  for (const treatment of configured.treatments) {
    treatment.pins = {};
    for (const layer of configured.layers) {
      const { pins } = await freezeProfile(execution.profiles?.[`${layer}/${treatment.id}`], layer);
      treatment.pins[layer] = pins;
    }
  }
  return configured;
}
