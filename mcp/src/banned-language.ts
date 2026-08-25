// The language-discipline term list (see CLAUDE.md "Legal hygiene"):
// observation-only wording, so none of these may appear in any
// user-visible string this server ships nor in any doc the RAG corpus
// serves. Used two ways: tests sweep every source file and corpus doc,
// and rag.ts checks generated ask_docs answers at runtime before they
// are returned to the caller.

export const BANNED_LANGUAGE = [
  "manipulat",
  "collu",
  "rigged",
  "scam",
  "fleece",
  "goug",
  "predatory",
  "greed",
  "playing games",
  "fight back",
  "stand up to",
];

// A second discipline, corpus-only: public docs describe what the project
// does, never who is assumed to be reading it. Reader-anchored framing
// dates quickly and reads oddly when the docs tools quote a passage out
// of context, so the corpus sweep in manifest.test.ts bans these terms
// the same way it bans the legal list above. Test-time only -- this list
// is not part of the runtime answer check in rag.ts, because a caller's
// own question may legitimately echo these words. Substring-matched
// case-insensitively like BANNED_LANGUAGE; "resume" also catches the
// verb, so a doc that needs that meaning should say "restart" or
// "continue" instead. "candidate" is deliberately absent: it is standard
// detection vocabulary here (candidate troughs/peaks) and the terms it
// would co-occur with in reader-anchored prose are already listed.
export const AUDIENCE_ANCHORED_TERMS = [
  "recruit",
  "hiring",
  "employer",
  "interview",
  "portfolio",
  "evaluator",
  "resume",
  "curriculum vitae",
  "job search",
  "job hunt",
  "job application",
];
