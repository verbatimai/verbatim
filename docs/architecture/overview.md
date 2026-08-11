# Architecture Overview

Full rationale lives in `../product/product-plan.md` (§2, §4, §13). This is the quick map for someone reading the code.

## Pipeline (two layers, different speeds)
```
mic ─► STT provider (WS) ─► partial events ─► [Layer 1: live raw text]
                              │  stableText = locked (solid)
                              │  activeText = volatile tail (dim)
                              └─ utterance end ─► Correction provider ─► compact edits
                                                       │
                                          reconstruct(raw, edits) ─► {cleanText, ops}
                                                       │
                                     [Layer 2: animate removals] ─► inject cleanText into focused field
```
- **Layer 1** is instant and never waits on the LLM — that's what makes it feel real-time.
- **Layer 2** runs when a segment finalizes; it produces the visible "what was removed" diff and the clean text that gets inserted.

## Two provider roles (`packages/core`)
The app depends only on these interfaces; each vendor is one adapter file.

- **`STTProvider`** (`src/providers/types.ts`) → yields normalized `TranscriptEvent { text, stableText, activeText, endpoint }`. PyAI gives stable/active natively; interim/final-only vendors (Deepgram, OpenAI) derive it by accumulating finals.
- **`CorrectionProvider`** (`src/correction/types.ts`) → returns compact `edits` (changed spans only). The shared `prompt.ts` holds the one system prompt + `reconstruct(raw, edits)` that rebuilds `cleanText` and the keep/remove/replace `ops` the UI animates. Adapters only map to their vendor's chat wire format.

Registries (`registry.ts` in each) resolve `STT_PROVIDER` / `CORRECTION_PROVIDER` and fail fast if required keys are missing.

## Why compact edits (not full ops)
Echoing every kept word made the LLM emit 200–620 output tokens and take 4–13s (finding F9). Compact edits emit only what changed; the client re-locates each substring to rebuild the full op timeline locally. Same UI, far fewer tokens, much lower latency. Unit-tested in `src/correction/reconstruct.test.ts`.

## Key model (open-core)
- **OSS core = BYOK, local-only.** Keys live in the OS keychain, sent only to the chosen vendor over TLS, never in the client bundle or on disk in plaintext. No backend needed.
- **Optional hosted proxy** (`apps/backend`, commercial layer) holds keys server-side and issues short-lived session tokens. The client works fully without it.

## Repo layout
```
open-dictation/
├─ packages/core/     vendor-neutral brain (interfaces, registries, prompt, reconstruct, diff)
├─ apps/widget/       Tauri desktop client (M3)
├─ apps/backend/      optional hosted key-proxy (post-M4)
├─ docs/             product plan, roadmap, architecture, research (research = internal)
└─ experiments/      throwaway validation scripts + fixtures + UX prototype (internal)
```
