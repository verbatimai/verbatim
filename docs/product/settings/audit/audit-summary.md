# Settings verification audit — summary

_13 Aug 2026. Three parallel read-only auditors traced every setting from config → WS start frame → backend → adapter → real vendor request, for all providers. PyAI prioritized. Full detail in `audit-stt.md`, `audit-correction.md`, `audit-config.md`._

## Headline
**PyAI (the priority/default) is correct** — STT (streaming + batch match the documented protocol; English-only settings properly guarded) and correction (`/v1/messages`, `gpt-5.6-sol`, JSON-in-text). The `correct`/`format`/`vocabulary`/`language` settings all reach the request identically across providers because the gating lives in the provider-agnostic `server.ts finalize()`.

**But three settings are "wired in the UI but dead on the real path"** — the same class as the auto-detect/Deepgram bug.

## Confirmed bugs
| Sev | Bug | Root cause | Impact |
|---|---|---|---|
| **HIGH** | **`sttModel` + `correctionModel` overrides are completely dead** | Persisted (`settings.ts:259-260`, `main.rs` config) but never sent on the WS `start` frame (`main.ts:336-348`), never read in `server.ts`, never injected into the sidecar env (`inject_keys`, `main.rs:508-518`). Every adapter resolves its model ONLY from `process.env.*_MODEL` with a hardcoded default. | The **"Models" pane — the headline Settings tab — does nothing.** Only a repo `.env` can change models. Affects all providers, both streaming + batch. |
| **MED** | **`dock_icon` toggle is dead** | Stored (`settings.ts:535`, `main.rs:119`) but nothing reads it; activation policy hard-coded `Accessory` (`main.rs:921`). | Toggle has no effect. |
| **MED** | **Deepgram vocabulary keyword-boost never reaches the final** | `keywords`/`keyterm` applied on streaming (`deepgram.stt.ts:62-68`) but omitted from `transcribeBatch` + not passed at `server.ts:119`. Final = batch. | STT-side term boost is a no-op on the inserted text (format-prompt injection still works). |
| LOW | No backend correction-key pre-check | A missing correction key fails only at finalize, not at start. | Late error instead of an upfront capability error. |

## Clean / verified-correct
- No serde/camelCase mismatch — all 20 `AppConfig` fields match the TS reads exactly.
- Secrets/keychain removal (1.6) correct: all paths route through `secrets.rs`, `key_storage=local` default, `keyring` branch unreachable, `secrets.json` 0600 + gitignored + never logged, Reset preserves it.
- `language` + `auto_detect_language` now reach both streaming and batch for Deepgram/OpenAI (the earlier fix is clean); PyAI English-only guard is consistent between core and the UI.
- `correct`/`format` toggles + `localFormat` fallback gate correctly for all correction providers.
- Telemetry stays metadata/counts only (no transcript/instruction content).

## Connection to the proposed settings consolidation
The **dead `sttModel` override is a prerequisite** for the proposed capability-driven UX ("only show languages the selected STT model offers"): a model-aware language list can't work until the model selection is actually wired. Fixing the HIGH bug and building the consolidated Dictation pane are the same body of work — see the consolidation plan (pending).
