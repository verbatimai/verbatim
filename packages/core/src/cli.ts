#!/usr/bin/env node
// Headless pipeline runner (M1).
//   npm run pipeline -- --stt fixture --correction mock          (offline demo)
//   npm run pipeline -- --stt pyai --correction pyai --wav clip.wav   (live, on your Mac)
import { getSTTProvider, assertKeys } from "./providers/registry";
import { getCorrectionProvider } from "./correction/registry";
import { Pipeline } from "./pipeline";
import type { Op } from "./correction/types";
import { readWav, frameize } from "./audio/wav";

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  strike: (s: string) => `\x1b[9m\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
};

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

function renderDiff(ops: Op[]): string {
  return ops
    .map((o) => {
      if (o.type === "keep") return o.text;
      if (o.type === "remove") return C.strike(o.text);
      return C.strike(o.text) + C.green(o.replacement ?? "");
    })
    .join("");
}

async function main() {
  const sttId = arg("stt", "fixture")!;
  const corrId = arg("correction", "mock")!;
  const wavPath = arg("wav");
  const frameMs = Number(arg("frame-ms", "20"));

  const stt = getSTTProvider(sttId);
  const correction = getCorrectionProvider(corrId);
  const apiKey = stt.requiredKeys[0] ? process.env[stt.requiredKeys[0]] : undefined;
  if (stt.requiredKeys.length) assertKeys(stt);

  let frames: Buffer[] | undefined;
  if (wavPath) {
    const wav = readWav(wavPath);
    frames = frameize(wav, frameMs);
    console.log(C.gray(`audio: ${wavPath}  ${wav.sampleRate}Hz ${wav.channels}ch  ${frames.length} frames`));
  }
  console.log(C.gray(`stt=${sttId}  correction=${corrId}\n`));

  const pipeline = new Pipeline(stt, correction, {
    onLive: (u) => {
      process.stdout.write(`\r\x1b[K${C.cyan("live ")} ${u.transcript} ${C.gray(u.active)}`);
    },
    onCorrection: (u) => {
      process.stdout.write("\r\x1b[K");
      console.log(`${C.cyan("raw  ")} ${u.raw}`);
      console.log(`${C.cyan("diff ")} ${renderDiff(u.result.ops)}`);
      console.log(`${C.cyan("clean")} ${C.green(u.result.cleanText)}`);
      console.log(
        C.gray(`      latency=${u.result.latencyMs}ms  valid=${u.result.valid}  edits=${u.result.edits.length}\n`),
      );
    },
    onFormatted: (u) => {
      console.log(`${C.cyan("FORMATTED (final output):")}`);
      console.log(u.text.split("\n").map((l) => "  " + C.green(l)).join("\n") + "\n");
    },
    onError: (e) => console.error(C.gray("error: ") + e.message),
  });

  await pipeline.run({ frames, frameMs, sttConfig: { apiKey } });
  console.log(C.gray("done."));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
