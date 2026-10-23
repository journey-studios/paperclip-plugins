import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git } from "./io.mjs";
import { digest, requireValue } from "./score.mjs";

export const REVIEWBENCH_REVISION = "53e4b5ebe9a81e1dd83183215331e17068a5adc5";
const original = "        classifier_tp_fp: cls.tp_fp,";
const replacement = "        tp_fp_justification: cls.tp_fp_justification,\n" + original;
const originalType = '  classifier_tp_fp?: "tp" | "fp";';
const replacementType = "  tp_fp_justification?: string;\n" + originalType;

/** Preserve the classifier rationale in details; no prompts, decisions or scoring are changed. */
export async function prepareJudge(upstream) {
  requireValue((await git(upstream, ["rev-parse", "HEAD"])).trim() === REVIEWBENCH_REVISION, "Use the pinned ReviewBench judge checkout");
  const path = join(upstream, "scripts/eval/eval.ts");
  const source = await git(upstream, ["show", `${REVIEWBENCH_REVISION}:scripts/eval/eval.ts`]);
  requireValue(source.split(original).length === 2 && source.split(originalType).length === 2, "Judge export schema changed");
  const overlay = source.replace(original, replacement).replace(originalType, replacementType);
  const current = await readFile(path, "utf8");
  requireValue(current === source || current === overlay, "Judge checkout has unrelated edits");
  const changed = (await git(upstream, ["diff", "--name-only"])).trim().split("\n").filter(Boolean);
  requireValue(changed.every((name) => name === "scripts/eval/eval.ts"), "Judge source has unrelated edits");
  await writeFile(path, overlay);
  return { sourceRevision: REVIEWBENCH_REVISION, overlayDigest: digest(overlay), purpose: "Export existing classifier evidence without changing judgments" };
}

export function judgeFingerprint(judgeRevision, evalConfig) {
  return digest({ judgeRevision, matcherModel: evalConfig.matcher_model, matcherPrompt: evalConfig.matcher_prompt_hash, classifierModel: evalConfig.classifier_model, classifierPrompt: evalConfig.classifier_prompt_hash });
}
