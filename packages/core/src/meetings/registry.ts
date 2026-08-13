/**
 * Meetings — summarizer registry.
 *
 * Same shape as `correction/registry.ts` so the capability layer and Settings can
 * treat summarizers exactly like correction vendors. OpenAI is the only adapter
 * today (decision: 13 Aug 2026 — PyAI for STT, OpenAI for the note); Anthropic and
 * PyAI slot in here without touching any caller.
 */

import type { MeetingSummarizer } from "./types";
import { OpenAiSummarizer } from "./openai.summarize";

export type SummaryVendor = "openai";

const REGISTRY: Record<SummaryVendor, () => MeetingSummarizer> = {
  openai: () => new OpenAiSummarizer(),
};

export function getSummarizer(id: string): MeetingSummarizer {
  const make = REGISTRY[id as SummaryVendor];
  if (!make) {
    throw new Error(
      `unknown summary provider: ${id} (have: ${Object.keys(REGISTRY).join(", ")})`,
    );
  }
  return make();
}

export function summaryVendors(): SummaryVendor[] {
  return Object.keys(REGISTRY) as SummaryVendor[];
}
