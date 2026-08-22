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
