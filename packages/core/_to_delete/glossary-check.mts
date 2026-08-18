import { userMessage, formatMessage } from "./src/correction/prompt.ts";
let fail = 0;
const ok = (label: string, cond: boolean) => { if (!cond) { console.log("FAIL:", label); fail++; } };

// 1. The exact assertions from prompt.test.ts:29-35 ("appends glossary block when entries provided")
const u = userMessage("hello", undefined, "en", [
  { id: "1", term: "SaaSLabs", aliases: ["sass labs"], source: "manual", createdAt: 0 },
]);
ok("contains 'User glossary'", u.includes("User glossary"));
ok("contains the term", u.includes("SaaSLabs"));
ok("contains the alias", u.includes("sass labs"));
ok("no crash + raw transcript still present", u.includes("Raw transcript:\nhello"));

// 2. BYTE-IDENTICAL for the string path that ships today (widget/backend send string[])
ok("string path unchanged", userMessage("hi", undefined, "en", ["Acme", " Verbatim "]) ===
   'Raw transcript:\nhi\n\nKnown terms (preserve and spell exactly): Acme, Verbatim.');
ok("no vocabulary at all unchanged", userMessage("hi") === "Raw transcript:\nhi");
ok("empty array unchanged", userMessage("hi", undefined, "en", []) === "Raw transcript:\nhi");
ok("formatMessage string path unchanged", formatMessage("hi", "en", ["Acme"]) ===
   'Cleaned transcript to format:\nhi\n\nKnown terms (preserve and spell exactly): Acme.');

// 3. Mixed + degenerate input must not throw and must not emit empty bullets
const mixed = userMessage("x", undefined, "en", [
  "PlainTerm",
  { id: "2", term: "Priya Sharma", aliases: [], source: "learned", createdAt: 1 },
  { id: "3", term: "  ", aliases: ["ghost"], source: "suggested", createdAt: 2 },
]);
ok("mixed keeps Known terms", mixed.includes("Known terms (preserve and spell exactly): PlainTerm."));
ok("mixed keeps glossary", mixed.includes("- Priya Sharma"));
ok("no alias clause when aliases empty", !mixed.includes("Priya Sharma (also heard as"));
ok("blank term dropped", !mixed.includes("-   ") && !mixed.includes("ghost"));

// 4. The pre-fix crash is genuinely gone (this threw `t.trim is not a function` before)
try { userMessage("x", undefined, "en", [{ id: "9", term: "T", source: "manual", createdAt: 0 }]); }
catch (e) { ok("entry-only input must not throw: " + (e as Error).message, false); }

console.log(fail === 0 ? "GLOSSARY CHECK OK — 13/13" : `GLOSSARY CHECK FAILED (${fail})`);
process.exit(fail === 0 ? 0 : 1);
