/* NCL controllability-layer config, shared by the combined shell and every standalone view page.
   AGENT_BACKEND_URL: null  -> scripted/canned policy (offline, on-stage, public default; zero network calls).
   Set it to a backend (e.g. "http://localhost:8787/agent" for local dev, or a deployed Worker)
   to switch the "Ask your plant" agent to the real LLM tool loop. The committed value here
   stays null for every public host, so the public site never calls out; flip it only where you
   intend the LLM to run. */
window.NCL_CONFIG = {
  // localhost auto-uses the local dev proxy (real LLM when ncl-backend is running); any other host stays null (canned).
  AGENT_BACKEND_URL: (location.hostname === "localhost" || location.hostname === "127.0.0.1") ? "http://localhost:8787/agent" : null,
  MODEL_HINT: "gpt-6-sol",     // shown in the badge tooltip only; the backend forces the real model
  COMPUTER_USE: true,          // with a backend: the model may operate this page through the provider's computer tool (screenshots in, clicks and drags out)
  MAX_TURNS: 24,               // model round trips per question; a console step takes about four seconds (the wrap-up call still guarantees a conclusion)
  RUN_TIMEOUT_MS: 240000,      // abort a run that exceeds this
};
