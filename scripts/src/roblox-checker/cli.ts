/**
 * Roblox rare-username checker CLI.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run roblox-checker -- --length 3 --mode letters
 *
 * Run with --help for the full option list.
 *
 * Exhaustive runs are processed in fixed-size batches, and the checkpoint
 * index only advances to the end of a fully-settled batch. That is what
 * makes resuming safe: whatever index is on disk, every candidate below it
 * has actually been checked, never merely "in flight" when the process was
 * interrupted.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRobloxUsername } from "./check.js";
import { sampleCandidates, spaceSize, walkCandidates, type UsernameLength, type UsernameMode } from "./generate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`
Roblox rare-username checker — 3/4/5-length, letters-only or full charset.

Options:
  --length <3|4|5>              Username length (required)
  --mode <letters|chars>        letters = a-z only, chars = a-z0-9 + one underscore (required)
  --strategy <exhaustive|sample>  exhaustive walks the full space in order (default), sample draws at random
  --sample-count <n>             Candidates to draw when --strategy sample (default 2000)
  --concurrency <n>              Concurrent checks in flight (default 6)
  --rps <n>                      Max HTTP requests/sec to Roblox, shared across all workers (default 4)
  --limit <n>                    Stop after this many candidates this run (still resumable)
  --no-resume                    Ignore any saved checkpoint and start this (mode,length) over
  --yes                          Skip the confirmation prompt for long exhaustive runs
  --help                         Show this help

Output (git-ignored, under scripts/src/roblox-checker/data/):
  available_roblox_<mode>-<length>.txt   confirmed hits, one per line
  review_roblox_<mode>-<length>.txt      "unknown" results worth a manual look
  <mode>-<length>.checkpoint.json        resume point for exhaustive runs

Examples:
  pnpm --filter @workspace/scripts run roblox-checker -- --length 3 --mode letters
  pnpm --filter @workspace/scripts run roblox-checker -- --length 5 --mode chars --strategy sample --sample-count 5000
`);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86_400).toFixed(1)}d`;
}

async function confirmOrExit(): Promise<void> {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("continue? [y/N] ");
  rl.close();
  if (answer.trim().toLowerCase() !== "y") {
    console.log("aborted.");
    process.exit(0);
  }
}

/** Spaces out `.wait()` resolutions at a fixed interval, shared across every caller, capping total requests/sec regardless of concurrency. */
class RateLimiter {
  private queue: Promise<void> = Promise.resolve();
  private readonly intervalMs: number;

  constructor(rps: number) {
    this.intervalMs = 1000 / Math.max(rps, 0.1);
  }

  wait(): Promise<void> {
    const result = this.queue.then(() => new Promise<void>((resolve) => setTimeout(resolve, this.intervalMs)));
    this.queue = result;
    return result;
  }
}

interface Paths {
  checkpointPath: string;
  hitsPath: string;
  reviewPath: string;
}

function pathsFor(key: string): Paths {
  return {
    checkpointPath: join(DATA_DIR, `${key}.checkpoint.json`),
    hitsPath: join(DATA_DIR, `available_roblox_${key}.txt`),
    reviewPath: join(DATA_DIR, `review_roblox_${key}.txt`),
  };
}

async function recordResult(candidate: string, paths: Paths): Promise<"available" | "taken" | "unknown"> {
  const result = await checkRobloxUsername(candidate);
  if (result.verdict === "available") {
    appendFileSync(paths.hitsPath, candidate + "\n");
    process.stdout.write(`\n[HIT] ${candidate}  (${result.detail})\n`);
  } else if (result.verdict === "unknown") {
    appendFileSync(paths.reviewPath, `${candidate}\t${result.detail}\n`);
  }
  return result.verdict;
}

async function runExhaustive(opts: {
  mode: UsernameMode;
  length: UsernameLength;
  startIndex: number;
  totalChecked: number;
  totalHits: number;
  total: number;
  limit: number;
  concurrency: number;
  limiter: RateLimiter;
  paths: Paths;
}): Promise<void> {
  const { mode, length, startIndex, total, limit, concurrency, limiter, paths } = opts;
  let totalChecked = opts.totalChecked;
  let totalHits = opts.totalHits;

  const iter = walkCandidates(mode, length, startIndex);
  let lastIndex = startIndex - 1;
  let checkedThisRun = 0;
  let stopping = false;

  const saveCheckpoint = (): void => {
    writeFileSync(
      paths.checkpointPath,
      JSON.stringify({ nextIndex: lastIndex + 1, totalChecked, totalHits, updatedAt: new Date().toISOString() }, null, 2),
    );
  };

  const onSigint = (): void => {
    stopping = true;
    console.log("\nfinishing the current batch, then stopping (checkpoint will be saved)...");
  };
  process.on("SIGINT", onSigint);

  const startTime = Date.now();

  while (!stopping && checkedThisRun < limit) {
    const batch: Array<[number, string]> = [];
    for (let k = 0; k < concurrency && checkedThisRun + batch.length < limit; k++) {
      const next = iter.next();
      if (next.done) break;
      batch.push(next.value);
    }
    if (batch.length === 0) break;

    await Promise.all(
      batch.map(async ([, candidate]) => {
        await limiter.wait();
        const verdict = await recordResult(candidate, paths);
        totalChecked++;
        checkedThisRun++;
        if (verdict === "available") totalHits++;
      }),
    );

    lastIndex = batch[batch.length - 1][0];
    saveCheckpoint();

    const elapsed = (Date.now() - startTime) / 1000;
    const rate = elapsed > 0 ? checkedThisRun / elapsed : 0;
    process.stdout.write(
      `\rchecked ${totalChecked.toLocaleString()}/${total.toLocaleString()}  hits:${totalHits}  ${rate.toFixed(1)}/s   `,
    );
  }

  process.off("SIGINT", onSigint);
  saveCheckpoint();
  console.log(
    `\nstopped. checked ${checkedThisRun.toLocaleString()} this run (${totalChecked.toLocaleString()} total), ${totalHits} hits total. next index is ${lastIndex + 1}.`,
  );
}

async function runSample(opts: {
  mode: UsernameMode;
  length: UsernameLength;
  sampleCount: number;
  concurrency: number;
  limiter: RateLimiter;
  paths: Paths;
}): Promise<void> {
  const { mode, length, sampleCount, concurrency, limiter, paths } = opts;
  const iter = sampleCandidates(mode, length, sampleCount);
  let checked = 0;
  let hits = 0;
  let stopping = false;

  const onSigint = (): void => {
    stopping = true;
  };
  process.on("SIGINT", onSigint);

  const startTime = Date.now();

  while (!stopping) {
    const batch: string[] = [];
    for (let k = 0; k < concurrency; k++) {
      const next = iter.next();
      if (next.done) break;
      batch.push(next.value);
    }
    if (batch.length === 0) break;

    await Promise.all(
      batch.map(async (candidate) => {
        await limiter.wait();
        const verdict = await recordResult(candidate, paths);
        checked++;
        if (verdict === "available") hits++;
      }),
    );

    const elapsed = (Date.now() - startTime) / 1000;
    const rate = elapsed > 0 ? checked / elapsed : 0;
    process.stdout.write(`\rchecked ${checked}/${sampleCount}  hits:${hits}  ${rate.toFixed(1)}/s   `);
  }

  process.off("SIGINT", onSigint);
  console.log(`\ndone. checked ${checked}, ${hits} hits.`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const length = Number(args.length);
  const mode = args.mode;
  if (![3, 4, 5].includes(length) || (mode !== "letters" && mode !== "chars")) {
    printHelp();
    console.error("\nerror: --length (3|4|5) and --mode (letters|chars) are required.");
    process.exitCode = 1;
    return;
  }
  const typedLength = length as UsernameLength;
  const typedMode = mode as UsernameMode;

  const strategy = typeof args.strategy === "string" ? args.strategy : "exhaustive";
  const concurrency = Number(args.concurrency ?? 6);
  const rps = Number(args.rps ?? 4);
  const limit = args.limit ? Number(args.limit) : Infinity;
  const sampleCount = Number(args["sample-count"] ?? 2000);
  const noResume = Boolean(args["no-resume"]);
  const skipConfirm = Boolean(args.yes);

  mkdirSync(DATA_DIR, { recursive: true });
  const key = `${typedMode}-${typedLength}`;
  const paths = pathsFor(key);
  const limiter = new RateLimiter(rps);
  const total = spaceSize(typedMode, typedLength);

  console.log(`roblox-checker — mode=${typedMode} length=${typedLength} strategy=${strategy} rps=${rps} concurrency=${concurrency}`);

  if (strategy === "sample") {
    console.log(`drawing ${sampleCount.toLocaleString()} random candidates from a space of ${total.toLocaleString()}...`);
    await runSample({ mode: typedMode, length: typedLength, sampleCount, concurrency, limiter, paths });
    return;
  }

  if (strategy !== "exhaustive") {
    console.error(`error: unknown --strategy "${strategy}" (expected exhaustive or sample).`);
    process.exitCode = 1;
    return;
  }

  let startIndex = 0;
  let totalChecked = 0;
  let totalHits = 0;
  if (!noResume && existsSync(paths.checkpointPath)) {
    const cp = JSON.parse(readFileSync(paths.checkpointPath, "utf8")) as {
      nextIndex?: number;
      totalChecked?: number;
      totalHits?: number;
    };
    startIndex = cp.nextIndex ?? 0;
    totalChecked = cp.totalChecked ?? 0;
    totalHits = cp.totalHits ?? 0;
    console.log(
      `resuming from index ${startIndex.toLocaleString()} (${totalChecked.toLocaleString()} checked so far, ${totalHits} hits)`,
    );
  }

  if (startIndex >= total) {
    console.log("this (mode, length) space is already fully checked. pass --no-resume to redo it, or pick a different --length/--mode.");
    return;
  }

  const remaining = Math.min(total - startIndex, limit);
  const etaSeconds = remaining / rps;
  console.log(
    `${total.toLocaleString()} total candidates, ${(total - startIndex).toLocaleString()} remaining. this run checks up to ${
      remaining === Infinity ? "all of them" : remaining.toLocaleString()
    }.`,
  );
  console.log(`at ${rps} req/s that's up to ~${formatDuration(etaSeconds)}. progress is checkpointed — Ctrl+C any time and resume later.`);

  if (etaSeconds > 3600 && !skipConfirm) {
    await confirmOrExit();
  }

  await runExhaustive({
    mode: typedMode,
    length: typedLength,
    startIndex,
    totalChecked,
    totalHits,
    total,
    limit,
    concurrency,
    limiter,
    paths,
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
