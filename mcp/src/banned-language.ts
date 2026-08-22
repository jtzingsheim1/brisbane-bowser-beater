// Test data for the language-discipline checks (see CLAUDE.md "Legal
// hygiene"): observation-only wording, so none of these may appear in any
// user-visible string this server ships nor in any doc the RAG corpus
// serves. Imported only by tests; not reachable from the handler entry
// point, so it never lands in the deployed bundle.

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
