import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildPlan } from "./experiment.mjs";
import { compareTreatments } from "./compare.mjs";
import { importReviewBenchGold, normalizeReview } from "./normalize.mjs";
import { digest, scoreTrial } from "./score.mjs";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const local = (path) => fileURLToPath(new URL(path, import.meta.url));

async function main([command, input, extra]) {
  if (command === "plan") {
    const study = await readJson(input ?? local("./study.json"));
    const corpus = await readJson(extra ?? local("./corpus.json"));
    const sources = await Promise.all(["./cli.mjs", "./experiment.mjs", "./score.mjs", "./compare.mjs", "./normalize.mjs"].map((path) => readFile(local(path), "utf8")));
    return buildPlan({ ...study, measurementDigest: digest(sources) }, corpus);
  }
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
  throw new Error("Usage: review-bench plan [study.json] [corpus.json] | normalize input.json | gold input.json | score trial.json | compare plan.json trials.json");
}

main(process.argv.slice(2)).then(
  (result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
  (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; },
);
