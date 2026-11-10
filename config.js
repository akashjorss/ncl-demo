/* NCL controllability-layer config, shared by the combined shell and every standalone view page.
   AGENT_BACKEND_URL decides how "Ask your plant" answers:
     null                          the built-in scripted investigator (no network call)
     http://localhost:8787/agent   the local dev proxy (ncl-backend/dev-proxy.mjs), used on localhost
     HOSTED_BACKEND                the hosted service (ncl-backend/worker.mjs), used on the public demo host only.
                                   It checks the site's access password, so it needs the gate (gate.js).
   HOSTED_BACKEND stays null until the service is deployed; with null the public site uses the built-in mode. */
var NCL_HOSTED_BACKEND = null;                                  // for example "https://ncl-agent.<account>.workers.dev/agent"
var NCL_PUBLIC_HOSTS = ["demo.neuralcontinuitylab.com"];
window.NCL_CONFIG = {
  AGENT_BACKEND_URL: (location.hostname === "localhost" || location.hostname === "127.0.0.1") ? "http://localhost:8787/agent"
    : (NCL_PUBLIC_HOSTS.indexOf(location.hostname) >= 0 ? NCL_HOSTED_BACKEND : null),
  MODEL_HINT: "gpt-6-sol",     // shown in the badge tooltip only; the backend forces the real model
  COMPUTER_USE: true,          // with a backend: the model may operate this page through the provider's computer tool (screenshots in, clicks and drags out)
  MAX_TURNS: 24,               // model round trips per question; a console step takes about four seconds (the wrap-up call still guarantees a conclusion)
  RUN_TIMEOUT_MS: 240000,      // abort a run that exceeds this
};
