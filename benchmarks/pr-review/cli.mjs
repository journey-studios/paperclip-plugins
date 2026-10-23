import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildPlan } from "./experiment.mjs";
import { compareTreatments } from "./compare.mjs";
import { importReviewBenchGold, normalizeReview } from "./normalize.mjs";
import { digest, scoreTrial } from "./score.mjs";
import { mkdir } from "node:fs/promises";
import { prepareCase } from "./prepare.mjs";
import { configureStudy } from "./runtime.mjs";
import { runPlan } from "./run.mjs";
import { importJudgments } from "./judgments.mjs";
import { prepareJudge } from "./judge-overlay.mjs";
import { collect } from "./collect.mjs";
import { exportJudgeInput, importJudgeFiles } from "./judge-input.mjs";
import { measurementFingerprint } from "./fingerprint.mjs";
import { canary } from "./canary.mjs";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const local = (path) => fileURLToPath(new URL(path, import.meta.url));

async function main([command, input, extra, third, fourth]) {
  if (command === "plan") {
    const study = await readJson(input ?? local("./study.json"));
    const corpus = await readJson(extra ?? local("./corpus.json"));
    return buildPlan({ ...study, measurementDigest: await measurementFingerprint() }, corpus);
  }
  if (command === "freeze") return configureStudy(await readJson(input), await readJson(extra));
  if (command === "prepare") {
    const corpus = await readJson(input);
    await mkdir(third, { recursive: true });
    const result = [];
    for (const item of corpus.cases.filter((item) => !fourth || item.split === fourth || item.id === fourth)) {
      result.push(await prepareCase(corpus, item, extra, third));
    }
    if (!result.length) throw new Error("No corpus cases selected");
    return result;
  }
  if (command === "run") return runPlan(await readJson(input), await readJson(extra), third, fourth);
  if (command === "canary") return canary(await readJson(input), extra, third);
  if (command === "prepare-judge") return prepareJudge(input);
  if (command === "judge-import") return importJudgments(await readJson(input));
  if (command === "judge-export") return exportJudgeInput(input, extra, third);
  if (command === "judge-result") return importJudgeFiles(await readJson(input));
  if (command === "collect") return collect(await readJson(input), extra, third, fourth);
  if (command === "normalize") return normalizeReview(await readJson(input));
  if (command === "gold") {
    const bundle = await readJson(input);
    return importReviewBenchGold(bundle.reference, bundle.pr);
  }
  if (command === "score") {
    const { evaluation, ...trial } = await readJson(input);
    return { ...trial, score: scoreTrial(evaluation) };
  }
  if (command === "compare") return compareTreatments(await readJson(input), await readJson(extra));
  throw new Error("Usage: review-bench plan [study] [corpus] | prepare corpus upstream snapshots [split|case] | freeze study execution | run plan execution snapshots runs | prepare-judge upstream | judge-import bundle | collect plan runs snapshots evaluations | normalize input | gold input | score trial | compare plan trials");
}

main(process.argv.slice(2)).then(
  (result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
  (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; },
);
