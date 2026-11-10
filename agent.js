/* NCL controllability layer: "Ask your plant".

   This is NCL's own harness around the field model. The model estimates the hidden state of the
   asset; this layer reasons over it like a reliability engineer, grounds every claim in a real
   reading, and (autonomously) proposes/runs simulated actions. The human keeps authority by
   STEERING (typing more prompts mid-run) and INTERRUPTING (Esc or the Stop button).

   One file serves every page. It mounts its own button, panel and styles, so a page needs only
   config.js and this script. In the combined shell it talks to the active view through the frame;
   on a standalone view page (2D field, 3D loop, row) it talks to that page's NCL_AGENT_API.

   Architecture:
     - Orchestrator (ask): owns the panel UI, the active-view tool seam, the run log,
       abort + steering, and selects a policy.
     - Pluggable policy: ScriptedPolicy (offline/on-stage default + fallback) and
       LLMPolicy (OpenAI Responses tool loop via a backend). Selected by NCL_CONFIG.AGENT_BACKEND_URL.
     - Plant tools map 1:1 to the real NCL_AGENT_API on the active view; the model only
       requests reads, the harness executes them, the model never authors a number.
     - Computer use: with the LLM backend the model can also operate the console like an operator
       through the provider's computer tool. The harness paints a screenshot of this page, the
       model answers with pointer and keyboard actions, and the harness performs them here with a
       visible cursor. Actions never leave this page.
     - A deterministic verifier reconciles cited figures against actual observations. */
(function () {
  "use strict";
  if (window.NCL_AGENT) return;
  var cfg = window.NCL_CONFIG || {};
  var BACKEND = cfg.AGENT_BACKEND_URL || null;
  var MAX_TURNS = cfg.MAX_TURNS || 8;
  var TIMEOUT_MS = cfg.RUN_TIMEOUT_MS || 45000;
  var COMPUTER = !!BACKEND && cfg.COMPUTER_USE !== false;

  // ---- mount: styles and markup live here, so every page gets the same agent ----------
  var CSS = `
.agent-fab { position: fixed; left: 18px; bottom: 7px; z-index: 40; display: inline-flex; align-items: center; gap: 8px;
  padding: 11px 16px; border-radius: 999px; border: 1px solid var(--blue, #3b82f6);
  background: linear-gradient(180deg, #2563eb, #1e51c8); color: #fff; font: 700 14px Inter, system-ui, sans-serif; cursor: pointer;
  box-shadow: 0 10px 30px rgba(37,99,235,0.45); }
.agent-fab:hover { filter: brightness(1.08); }
.agent-fab.is-open { opacity: 0; pointer-events: none; }
.agent-panel[hidden] { display: none; }
.agent-panel { position: fixed; left: 16px; bottom: 16px; z-index: 41; width: 360px; max-width: calc(100vw - 32px);
  height: min(560px, calc(100vh - 110px)); display: flex; flex-direction: column;
  border: 1px solid var(--line, #2b3a52); border-radius: var(--radius-lg, 16px);
  background: rgba(10, 16, 30, 0.96); backdrop-filter: blur(10px); box-shadow: var(--shadow-2, 0 24px 60px rgba(0,0,0,.55)); overflow: hidden;
  font-family: Inter, system-ui, sans-serif; opacity: 0; transform: translateY(8px) scale(0.98); transform-origin: bottom left;
  transition: opacity var(--dur-base, 180ms) var(--ease-out, ease-out), transform var(--dur-base, 180ms) var(--ease-out, ease-out), height 260ms var(--ease-out, ease-out); }
.agent-panel.is-open { opacity: 1; transform: none; }
.agent-panel.is-driving { height: 230px; }                 /* the agent is operating the console: step aside, keep the last steps in view */
.agent-panel.is-driving .agent-chips { display: none; }
.agent-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid var(--line, #2b3a52); background: rgba(8,14,26,0.9); }
.agent-title { display: inline-flex; align-items: center; gap: 6px; font-weight: 800; font-size: 14px; color: var(--ink, #e8eefb); }
.agent-close { border: 0; background: transparent; color: var(--muted, #93a4c0); font-size: 22px; line-height: 1; cursor: pointer; padding: 0 4px; }
.agent-close:hover { color: var(--ink, #e8eefb); }
.agent-icon { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; }
.agent-icon[hidden] { display: none; }
.agent-icon--stop:hover { color: var(--critical-text, #ff9a9a); }
.agent-log { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.agent-log::-webkit-scrollbar { width: 6px; }
.agent-log::-webkit-scrollbar-thumb { background: #243352; border-radius: 3px; }
.agent-msg { font-weight: 400; font-size: 13.5px; line-height: 1.5; padding: 10px 12px; border-radius: 12px; max-width: 92%; }
.agent-msg.bot { background: rgba(20,32,56,0.9); border: 1px solid var(--line, #2b3a52); color: var(--ink, #e8eefb); align-self: flex-start; border-bottom-left-radius: 4px; }
.agent-msg.user { background: var(--blue-deep, #2563eb); color: #fff; align-self: flex-end; border-bottom-right-radius: 4px; }
.agent-step { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 12px; color: var(--muted, #93a4c0); }
.agent-step b { color: var(--ink, #e8eefb); }
.agent-step .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--blue, #3b82f6); flex: none; box-shadow: 0 0 0 4px rgba(59,130,246,0.18); animation: agentPulse 1s infinite; }
.agent-step .dot.done { background: var(--green, #34d399); box-shadow: none; animation: none; }
.agent-step.hand .dot.done { background: var(--amber, #fbbf24); }
@keyframes agentPulse { 0%,100%{opacity:1;} 50%{opacity:0.35;} }
.agent-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 12px; border-top: 1px solid var(--line, #2b3a52); }
.agent-chip { border: 1px solid var(--line, #2b3a52); background: rgba(20,32,56,0.7); color: var(--muted, #93a4c0); font: 600 11.5px Inter, system-ui, sans-serif; padding: 6px 10px; border-radius: 999px; cursor: pointer; }
.agent-chip:hover { color: var(--ink, #e8eefb); border-color: var(--blue, #3b82f6); }
.agent-input { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--line, #2b3a52); background: rgba(8,14,26,0.9); }
.agent-input input { flex: 1; min-width: 0; padding: 9px 11px; border-radius: 9px; border: 1px solid var(--line, #2b3a52); background: var(--surface-2, #0f1a30); color: var(--ink, #e8eefb); font: 400 13px Inter, system-ui, sans-serif; }
.agent-input input:focus { border-color: var(--blue, #3b82f6); }
.agent-input button { border: 0; border-radius: 9px; padding: 9px 14px; background: var(--blue-deep, #2563eb); color: #fff; font: 700 13px Inter, system-ui, sans-serif; cursor: pointer; }
.agent-input button:hover { filter: brightness(1.08); }
.agent-cursor { position: fixed; left: 0; top: 0; z-index: 60; width: 22px; height: 22px; margin: -2px 0 0 -3px; pointer-events: none; opacity: 0;
  transition: transform 300ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 200ms; filter: drop-shadow(0 2px 6px rgba(0,0,0,.6)); }
.agent-cursor.on { opacity: 1; }
.agent-cursor i { position: absolute; left: -9px; top: -9px; width: 26px; height: 26px; border-radius: 50%; border: 2px solid #fbbf24; opacity: 0; }
.agent-cursor.click i { animation: agentClick 420ms ease-out; }
@keyframes agentClick { 0% { opacity: .9; transform: scale(.3); } 100% { opacity: 0; transform: scale(1.5); } }
.has-agent .footnote { padding-left: 200px; }             /* standalone view pages: the button sits over the footer */
@media (max-width: 760px) {
  .agent-panel { inset: 0; left: 0; bottom: 0; width: 100%; max-width: none; height: 100dvh; border-radius: 0; }
  .agent-panel.is-driving { inset: auto 0 0 0; height: 200px; }
  .agent-fab.is-open { display: none; }
  .agent-fab { left: auto; right: 14px; bottom: 14px; padding: 9px 14px; font-size: 13px; }
  .has-agent .footnote { padding-left: 12px; padding-bottom: 60px; }
}`;
  var SPARK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l1.7 6.1L20 10l-6.3 1.9L12 18l-1.7-6.1L4 10l6.3-1.9z"/></svg>';
  (function mount() {
    if (!document.getElementById("nclAgentCss")) {
      var st = document.createElement("style"); st.id = "nclAgentCss"; st.textContent = CSS; document.head.appendChild(st);
    }
    if (document.getElementById("agentFab")) return;
    var wrap = document.createElement("div");
    wrap.innerHTML =
      '<button id="agentFab" class="agent-fab" type="button" aria-label="Ask your plant">' + SPARK.replace(/13/g, "14") + ' Ask your plant</button>' +
      '<aside id="agentPanel" class="agent-panel" hidden role="dialog" aria-labelledby="agentTitle">' +
        '<header class="agent-head"><span class="agent-title" id="agentTitle">' + SPARK + ' Ask your plant</span>' +
        '<button id="agentClose" class="agent-close" type="button" aria-label="Close">&times;</button></header>' +
        '<div id="agentLog" class="agent-log" role="log" aria-live="polite" aria-label="Investigation log">' +
        '<div class="agent-msg bot">Ask about the asset and I will read the estimated state, including spots with no sensor, and tell you what I find.' +
        (COMPUTER ? ' I can also operate this console for you: ask me to show, open or rotate something.' : '') + '</div></div>' +
        '<div id="agentChips" class="agent-chips"></div>' +
        '<form id="agentForm" class="agent-input"><input id="agentInput" type="text" placeholder="Ask about the asset..." autocomplete="off" aria-label="Ask about the asset">' +
        '<button type="submit">Send</button></form>' +
      '</aside>';
    while (wrap.firstChild) document.body.appendChild(wrap.firstChild);
    if (!document.querySelector(".view-frame")) document.documentElement.classList.add("has-agent");
  })();

  var $ = function (id) { return document.getElementById(id); };
  var fab = $("agentFab"), panel = $("agentPanel"), log = $("agentLog"),
      form = $("agentForm"), input = $("agentInput"), chipsEl = $("agentChips"), closeBtn = $("agentClose");
  if (!fab || !panel) return;
  var headEl = panel.querySelector(".agent-head");

  // ---- run log (append-only, downloadable) --------------------------------
  var runLog = [];
  window.NCL_AGENT_LOG = runLog;   // stable reference, for inspection / "Download log"
  function logPush(e) { e.at = Date.now(); runLog.push(e); }
  function downloadLog() {
    var blob = new Blob([JSON.stringify(runLog, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = "ncl-agent-log-" + Date.now() + ".json";
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }

  // ---- chips (starter prompts) --------------------------------------------
  var CHIPS = [
    { q: "Is anything wrong right now?", intent: "general" },
    { q: "Where is the risk?", intent: "where" },
    { q: "What do you recommend?", intent: "recommend" },
    { q: "Investigate the incident", intent: "general", seek: true },
  ];
  if (COMPUTER) CHIPS.push({ q: "Show me the fault on the console", intent: "general", seek: true });
  CHIPS.forEach(function (c) {
    var b = document.createElement("button");
    b.className = "agent-chip"; b.type = "button"; b.textContent = c.q;
    b.addEventListener("click", function () { openPanel(); ask(c.q, c); });
    chipsEl.appendChild(b);
  });

  // ---- Stop + Download controls in the header -----------------------------
  var stopBtn = document.createElement("button");
  stopBtn.className = "agent-close agent-icon agent-icon--stop"; stopBtn.type = "button"; stopBtn.title = "Stop (Esc)"; stopBtn.setAttribute("aria-label", "Stop");
  stopBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>'; stopBtn.hidden = true;
  stopBtn.addEventListener("click", function () { if (controller) controller.abort(); });
  var dlBtn = document.createElement("button");
  dlBtn.className = "agent-close agent-icon"; dlBtn.type = "button"; dlBtn.title = "Download run log"; dlBtn.setAttribute("aria-label", "Download run log");
  dlBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v10m0 0l-3.5-3.5M12 14l3.5-3.5M5 19h14"/></svg>';
  dlBtn.addEventListener("click", downloadLog);
  if (headEl) { headEl.insertBefore(stopBtn, closeBtn); headEl.insertBefore(dlBtn, closeBtn); }
  // Mode badge so it is obvious whether the real LLM or the built-in scripted policy is active.
  function setBadge(live, title) {
    var badge = $("agentModeBadge");
    if (!badge) {
      badge = document.createElement("span"); badge.id = "agentModeBadge";
      var titleEl = headEl && headEl.querySelector(".agent-title");
      if (titleEl) titleEl.appendChild(badge);
    }
    badge.textContent = live ? "live" : "built-in"; badge.title = title;
    badge.style.cssText = "margin-left:8px;font:700 10px Inter,system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;" +
      "padding:2px 8px;border-radius:999px;vertical-align:middle;" +
      (live ? "background:rgba(52,211,153,0.18);color:#34d399;border:1px solid rgba(52,211,153,0.45);"
            : "background:rgba(148,164,192,0.15);color:#93a4c0;border:1px solid #2b3a52;");
  }
  setBadge(!!BACKEND, BACKEND ? ("LLM agent (" + (cfg.MODEL_HINT || "model set by the backend") + (COMPUTER ? ", computer use" : "") + ") via " + BACKEND)
                              : "built-in scripted policy (no LLM backend configured for this host)");

  function openPanel() {
    panel.hidden = false; fab.classList.add("is-open");
    requestAnimationFrame(function () { panel.classList.add("is-open"); });   // play the fade-and-rise
    setTimeout(function () { try { input.focus(); } catch (e) {} }, 60);       // move focus into the dialog
  }
  function closePanel() {
    panel.classList.remove("is-open"); fab.classList.remove("is-open");
    setTimeout(function () { panel.hidden = true; }, 180);                     // hide after the fade-out
    try { fab.focus(); } catch (e) {}                                         // return focus to the trigger
  }
  fab.addEventListener("click", function () { panel.hidden ? openPanel() : closePanel(); });
  closeBtn.addEventListener("click", closePanel);
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var q = input.value.trim();
    if (q) { input.value = ""; ask(q, null); }
  });
  // Esc: abort a running investigation (human authority); if idle, close the dialog.
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || panel.hidden || !e.isTrusted) return;
    e.preventDefault();
    if (busy && controller) controller.abort();
    else closePanel();
  });
  // Trap Tab within the open dialog so keyboard users are not stranded behind it.
  panel.addEventListener("keydown", function (e) {
    if (e.key !== "Tab") return;
    var f = Array.prototype.filter.call(
      panel.querySelectorAll('button, input, [tabindex]:not([tabindex="-1"])'),
      function (el) { return !el.disabled && !el.hidden && el.offsetParent !== null; });
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // ---- active view's tool API ---------------------------------------------
  // A standalone view page carries the API itself; the combined shell reaches it through the active frame.
  function activeFrame() { return document.querySelector(".view-frame.is-active iframe"); }
  function activeApi() {
    if (window.NCL_AGENT_API) return window.NCL_AGENT_API;
    var f = activeFrame();
    try { return f && f.contentWindow && f.contentWindow.NCL_AGENT_API; } catch (e) { return null; }
  }
  var IN_SHELL = !!document.querySelector(".view-btn");

  // ---- UI primitives (shared by both policies) ----------------------------
  var delay = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  function line(cls, txt) {
    var d = document.createElement("div");
    d.className = cls; if (txt != null) d.textContent = txt;
    log.appendChild(d); log.scrollTop = log.scrollHeight; return d;
  }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  var UI = {
    addUser: function (q) { return line("agent-msg user", q); },
    addSteer: function (q) { return line("agent-msg user", "↳ " + q); },
    addAction: function (t, cls) { var d = line("agent-step" + (cls ? " " + cls : "")); d.innerHTML = '<span class="dot"></span>' + t; return d; },
    markDone: function (step, html) { if (step) step.innerHTML = '<span class="dot done"></span>' + html; },
    addNote: function (t) { var d = line("agent-step"); d.innerHTML = '<span class="dot done"></span>' + t; return d; },
    streamText: async function (t) {
      var d = line("agent-msg bot");
      var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduce) { d.textContent = t; log.scrollTop = log.scrollHeight; return; }   // no typing motion for sensitive viewers
      var steps = Math.min(t.length, 14);   // bounded frames: snappy for users, and won't stall under tab throttling
      for (var k = 1; k <= steps; k++) {
        d.textContent = t.slice(0, Math.ceil(t.length * k / steps));
        log.scrollTop = log.scrollHeight;
        await delay(14);
      }
      d.textContent = t;
    },
  };
  function addUser(q) { return UI.addUser(q); }
  function addSteer(q) { return UI.addSteer(q); }
  function addAction(t) { return UI.addAction(t); }
  function streamText(t) { return UI.streamText(t); }
  function setRunning(b) { stopBtn.hidden = !b; }

  // =========================================================================
  //  Tool registry: the model's only interface to the estimated state (read-only +
  //  simulated act). Validates args, calls the real API, records grounded
  //  numbers for the verifier, returns compact scalars. The schema follows the
  //  active view: its viewpoints, its layers and its simulated actions.
  // =========================================================================
  function clamp01(v) { v = +v; return isFinite(v) ? Math.max(0, Math.min(1, v)) : 0; }
  function allowNumbers(ctx, v, depth) {             // every number a tool returned may be cited
    depth = depth || 0; if (v == null || depth > 6) return;
    if (typeof v === "number") { if (isFinite(v)) ctx.allowed.push(v); }
    else if (Array.isArray(v)) v.forEach(function (x) { allowNumbers(ctx, x, depth + 1); });
    else if (typeof v === "object") Object.keys(v).forEach(function (k) { if (k !== "dataURL") allowNumbers(ctx, v[k], depth + 1); });
  }
  function buildTools(ctx) {
    var api0 = ctx.api || {};
    var viewpoints = api0.viewpoints || ["overview", "fault", "inside", "top", "front", "side", "iso"];
    var layers = api0.layers || ["confidence", "sensors", "volume"];
    var actions = api0.actions || ["inspect", "isolate_segment", "throttle_pump"];
    var noArgs = { type: "object", properties: {}, additionalProperties: false };
    var fn = function (name, description, parameters) { return { type: "function", name: name, description: description, parameters: parameters || noArgs }; };
    var schemas = [
      fn("describe_asset", "Get the coordinate frame (normalized 0..1) and the named landmarks of the asset with their coordinates. Call this first to know where to probe."),
      fn("get_overview", "Asset status, the estimated peak temperature, the hottest physical sensor, the hidden rise, and the fault location if any."),
      fn("list_sensors", "The physical sensors and their current readings."),
      fn("view_field", "Look at the estimated state. Returns a saliency map: temperature and confidence sampled across the coolant network, with the hottest and most-uncertain spots and their normalized coordinates. " + (COMPUTER ? "To see the console itself, take a screenshot with the computer tool. " : "A snapshot image of the view (what the operator sees) follows. ") + "Call this early to decide where to probe."),
      fn("probe_point", "Drop a virtual sensor at a point of the coolant network (normalized coordinates) and read the estimated temperature and the model's confidence there. The point snaps to the nearest part of the network; snapCells>0 means it was off the network. Never state a temperature you did not get from a tool.",
        { type: "object", additionalProperties: false, required: ["nx", "ny"], properties: {
          nx: { type: "number", description: "0..1 along the first axis (see describe_asset)" },
          ny: { type: "number", description: "0..1 along the second axis (see describe_asset)" },
          nz: { type: "number", description: "0..1 along the third axis (3D views only)" } } }),
      fn("clear_sensors", "Remove every virtual sensor the agent has placed (reset the view). Call this when the user asks to clear, remove, or reset sensors. Do not investigate or re-add sensors afterwards."),
      fn("act", "Log a recommended control action for the operator. It is shown on the console as advice; no actuator is connected, so nothing physical happens and the operator decides. Use ONLY for a genuine control decision, never to add or clear sensors. At most once, with a grounded target.",
        { type: "object", additionalProperties: false, required: ["type", "rationale"], properties: {
          type: { type: "string", enum: actions },
          target: { type: "string", description: "the location/section the action applies to" },
          severity: { type: "string", enum: ["low", "medium", "high"] },
          rationale: { type: "string", description: "one sentence, grounded in the readings" } } }),
      fn("set_view", "Move the camera to a viewpoint (no effect on a flat 2D view). 'overview' fits the whole asset, 'fault' frames the worst region. Use this to show the operator the asset from a good angle.",
        { type: "object", additionalProperties: false, required: ["preset"], properties: { preset: { type: "string", enum: viewpoints } } }),
      fn("zoom", "Zoom the view in or out, or fit the whole asset. No effect on a flat 2D view.",
        { type: "object", additionalProperties: false, required: ["direction"], properties: { direction: { type: "string", enum: ["in", "out", "fit"] } } }),
      fn("set_layer", "Turn a visual layer on or off. Turn 'confidence' on to show where the model is unsure.",
        { type: "object", additionalProperties: false, required: ["layer", "on"], properties: { layer: { type: "string", enum: layers }, on: { type: "boolean" } } }),
      fn("control_time", "Move the timeline: 'start', 'incident' (the critical moment), 'end', or 'play' to animate it forward. Use 'incident' to take the operator to the event.",
        { type: "object", additionalProperties: false, required: ["to"], properties: { to: { type: "string", enum: ["start", "incident", "end", "play"] } } }),
    ];
    if (IN_SHELL) schemas.push(fn("switch_view", "Switch the console between the 2D field slice and the full 3D loop. Use 3D to look around, tour, or show the asset; 2D for a flat top-down field map.",
      { type: "object", additionalProperties: false, required: ["view"], properties: { view: { type: "string", enum: ["2d", "3d"] } } }));
    if (COMPUTER) schemas.push({ type: "computer" });
    function invoke(name, args) {
      args = args || {};
      ctx.api = activeApi() || ctx.api;   // re-resolve: a switch_view earlier this run may have changed the active view
      var api = ctx.api, out;
      if (name === "describe_asset") { out = api.describeAsset ? api.describeAsset() : { error: "unavailable" }; }
      else if (name === "get_overview") { out = api.getOverview(); ctx.overview = out; }
      else if (name === "list_sensors") { out = api.listSensors(); }
      else if (name === "probe_point") {
        out = api.probeAt ? api.probeAt(clamp01(args.nx), clamp01(args.ny), args.nz == null ? null : clamp01(args.nz)) : { error: "unavailable" };
        if (out && out.tempC != null) ctx.observations.push(out);
      }
      else if (name === "view_field") {
        out = api.viewField ? api.viewField() : { error: "unavailable" };
        if (api.snapshot && !COMPUTER) { try { var snap = api.snapshot(384); if (snap && snap.dataURL) ctx.pendingImage = snap.dataURL; } catch (e) {} }
      }
      else if (name === "clear_sensors") { if (api.clearProbes) api.clearProbes(); out = { cleared: true }; }
      else if (name === "act") { out = runSimulatedActuator(args, ctx); }
      else if (name === "switch_view") {
        var v = (String(args.view || "")).indexOf("3") >= 0 ? "3d" : "2d";
        var btn = document.querySelector('.view-btn[data-view="' + v + '"]');
        if (btn) btn.click();
        ctx.api = activeApi() || ctx.api; api = ctx.api;   // active view changed; subsequent tools follow it
        out = btn ? { view: v } : { error: "this page has one view" };
      }
      else if (name === "set_view") { out = api.setViewpoint ? api.setViewpoint(args.preset) : { error: "unavailable" }; }
      else if (name === "zoom") { out = api.zoomView ? api.zoomView(args.direction) : { error: "unavailable" }; }
      else if (name === "set_layer") { out = api.setLayer ? api.setLayer(args.layer, !!args.on) : { error: "unavailable" }; }
      else if (name === "control_time") {
        if (String(args.to).toLowerCase() === "play") { out = api.playTimeline ? api.playTimeline() : { error: "unavailable" }; }
        else { out = api.seekTime ? api.seekTime(args.to) : { error: "unavailable" }; }
      }
      else { out = { error: "unknown tool: " + name }; }
      allowNumbers(ctx, out);
      logPush({ t: "tool", name: name, args: args, result: out });
      return out;
    }
    return { schemas: schemas, invoke: invoke };
  }

  function runSimulatedActuator(action, ctx) {
    var label = (action.type || "action") + (action.target ? (" · " + action.target) : "");
    ctx.ui.addNote("⚙ Recommended action: " + esc(label) + " (advice for the operator, no actuator connected)");
    if (action.rationale) ctx.ui.addNote("   ↳ " + esc(action.rationale));
    logPush({ t: "action", action: action, simulated: true });
    // REAL ACTUATOR INTEGRATION PLUGS IN HERE: a production build would POST to the control
    // system through the backend, behind whatever guard the deployment requires.
    return { logged: true, advisory: true, note: "logged as a recommendation for the operator; no actuator is connected" };
  }

  // ---- deterministic grounding verifier -----------------------------------
  // Any number cited with a temperature, percent or flow unit must match an actual reading
  // (within rounding tolerance); otherwise it is replaced with [unverified].
  function verify(text, allowed) {
    if (!text) return { text: "", stripped: [] };
    var stripped = [];
    var out = text.replace(/(\d+(?:\.\d+)?)\s*(°?\s?[cC]\b|%|degrees|L\/min)/g, function (whole, num) {
      var n = parseFloat(num);
      var ok = allowed.some(function (a) { return Math.abs(Math.abs(a) - n) <= 1.0; });
      if (ok) return whole;
      stripped.push(whole.trim());
      return "[unverified]";
    });
    return { text: out, stripped: stripped };
  }

  // =========================================================================
  //  Computer use: the page side of the provider's computer tool.
  //  capture() paints what the operator sees (without this chat panel) from the live
  //  layout, so the model's coordinates are this page's coordinates. perform() turns
  //  the model's actions into pointer and keyboard events here, with a visible cursor.
  //  Nothing leaves this page: no navigation, no typing outside the console's own inputs.
  // =========================================================================
  var CU = (function () {
    var scale = 1, cursor = null, cx = 0, cy = 0;
    function isAgentUi(el) { return !!(el && el.closest && el.closest("#agentPanel, #agentFab, #agentCursor")); }
    function ensureCursor() {
      if (cursor) return cursor;
      cursor = document.createElement("div"); cursor.id = "agentCursor"; cursor.className = "agent-cursor";
      cursor.innerHTML = '<i></i><svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 2l15 9-7 1.6L8.6 20z" fill="#fbbf24" stroke="#1b1300" stroke-width="1.4" stroke-linejoin="round"/></svg>';
      document.body.appendChild(cursor);
      cx = window.innerWidth / 2; cy = window.innerHeight / 2; cursor.style.transform = "translate(" + cx + "px," + cy + "px)";
      return cursor;
    }
    async function moveCursor(x, y, fast) {
      ensureCursor().classList.add("on");
      cx = x; cy = y; cursor.style.transform = "translate(" + x + "px," + y + "px)";
      await delay(fast ? 16 : 320);
    }
    function pulse() { var c = ensureCursor(); c.classList.remove("click"); void c.offsetWidth; c.classList.add("click"); }
    function hideCursor() { if (cursor) cursor.classList.remove("on"); }

    // ---- screenshot: paint the live layout onto a canvas -------------------
    function rgbaAlpha(c) { var m = /rgba?\(([^)]+)\)/.exec(c || ""); if (!m) return 0; var p = m[1].split(/[,\s/]+/).filter(Boolean); return p.length > 3 ? parseFloat(p[3]) : 1; }
    function radiusOf(cs, w, h) {
      var v = cs.borderTopLeftRadius || "0", r = v.indexOf("%") >= 0 ? Math.min(w, h) * parseFloat(v) / 100 : parseFloat(v) || 0;
      return Math.max(0, Math.min(r, w / 2, h / 2));
    }
    function roundRect(g, x, y, w, h, r) {
      g.beginPath();
      if (r <= 0.5) { g.rect(x, y, w, h); return; }
      g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
    }
    function gradientOf(g, img, r) {
      var cols = img.match(/rgba?\([^)]+\)/g); if (!cols || cols.length < 2) return null;
      var horiz = /linear-gradient\(\s*(90deg|to right)/.test(img);
      var gr = horiz ? g.createLinearGradient(r.left, 0, r.right, 0) : g.createLinearGradient(0, r.top, 0, r.bottom);
      cols.forEach(function (c, i) { try { gr.addColorStop(i / (cols.length - 1), c); } catch (e) {} });
      return gr;
    }
    function paintDoc(g, doc, vw, vh, seen) {
      var win = doc.defaultView;
      try { if (win.NCL_AGENT_API && win.NCL_AGENT_API.snapshot) win.NCL_AGENT_API.snapshot(8); } catch (e) {}   // a WebGL scene must be rendered in this task to be readable
      function text(node, cs, alpha) {
        var s = node.nodeValue; if (!s || !/\S/.test(s)) return;
        g.font = cs.fontStyle + " " + cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
        g.fillStyle = cs.color; g.globalAlpha = alpha; g.textBaseline = "middle"; g.textAlign = "left";
        if ("letterSpacing" in g) g.letterSpacing = cs.letterSpacing === "normal" ? "0px" : cs.letterSpacing;
        var upper = cs.textTransform === "uppercase", re = /\S+/g, m, range = doc.createRange();
        while ((m = re.exec(s))) {
          range.setStart(node, m.index); range.setEnd(node, m.index + m[0].length);
          var q = range.getClientRects()[0];
          if (!q || q.width === 0 || q.bottom < 0 || q.top > vh || q.right < 0 || q.left > vw) continue;
          g.fillText(upper ? m[0].toUpperCase() : m[0], q.left, q.top + q.height / 2);
          var num = /-?\d+(?:\.\d+)?/.exec(m[0].replace(/,/g, "")); if (num && seen) seen.push(parseFloat(num[0]));
        }
        g.globalAlpha = 1;
      }
      function walk(el, alpha) {
        if (el.nodeType !== 1 || isAgentUi(el)) return;
        var tag = el.tagName; if (tag === "SCRIPT" || tag === "STYLE" || tag === "svg" || tag === "SVG") return;
        var cs = win.getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || el.hidden) return;
        var op = parseFloat(cs.opacity); if (op === 0) return; alpha *= isFinite(op) ? op : 1;
        var r = el.getBoundingClientRect(), box = r.width > 0.5 && r.height > 0.5;
        if (box && (r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh)) return;
        if (box) {
          var rad = radiusOf(cs, r.width, r.height);
          g.globalAlpha = alpha;
          if (rgbaAlpha(cs.backgroundColor) > 0) { g.fillStyle = cs.backgroundColor; roundRect(g, r.left, r.top, r.width, r.height, rad); g.fill(); }
          if (cs.backgroundImage && cs.backgroundImage.indexOf("linear-gradient") >= 0) { var gr = gradientOf(g, cs.backgroundImage, r); if (gr) { g.fillStyle = gr; roundRect(g, r.left, r.top, r.width, r.height, rad); g.fill(); } }
          var bw = parseFloat(cs.borderTopWidth) || 0;
          if (bw > 0 && cs.borderTopStyle !== "none" && rgbaAlpha(cs.borderTopColor) > 0) { g.strokeStyle = cs.borderTopColor; g.lineWidth = bw; roundRect(g, r.left + bw / 2, r.top + bw / 2, r.width - bw, r.height - bw, rad); g.stroke(); }
          var bl = parseFloat(cs.borderLeftWidth) || 0;
          if (bl >= 2 && bl > bw && rgbaAlpha(cs.borderLeftColor) > 0) { g.fillStyle = cs.borderLeftColor; g.fillRect(r.left, r.top, bl, r.height); }
          if (tag === "CANVAS") { try { g.drawImage(el, r.left, r.top, r.width, r.height); } catch (e) {} }
          else if (tag === "IMG") { try { if (el.complete) g.drawImage(el, r.left, r.top, r.width, r.height); } catch (e) {} }
          else if (tag === "INPUT" && el.type === "range") {
            var lo = +el.min || 0, hi = +el.max || 100, f = hi > lo ? (+el.value - lo) / (hi - lo) : 0, my = r.top + r.height / 2;
            g.fillStyle = "#e5e7eb"; roundRect(g, r.left, my - 2.5, r.width, 5, 2.5); g.fill();
            g.fillStyle = "#3b82f6"; roundRect(g, r.left, my - 2.5, r.width * f, 5, 2.5); g.fill();
            g.beginPath(); g.arc(r.left + 8 + (r.width - 16) * f, my, 8, 0, Math.PI * 2); g.fill();
          }
          else if (tag === "INPUT" || tag === "TEXTAREA") {
            g.font = cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily; g.textBaseline = "middle"; g.textAlign = "left";
            g.fillStyle = el.value ? cs.color : "#7f8fab"; g.fillText(el.value || el.placeholder || "", r.left + (parseFloat(cs.paddingLeft) || 0), r.top + r.height / 2);
          }
          else if (tag === "IFRAME") {
            try {
              var d = el.contentDocument;
              if (d && d.body) { g.save(); g.beginPath(); g.rect(r.left, r.top, r.width, r.height); g.clip(); g.translate(r.left, r.top); paintDoc(g, d, el.clientWidth, el.clientHeight, seen); g.restore(); }
            } catch (e) {}
          }
          g.globalAlpha = 1;
        }
        if (tag === "CANVAS" || tag === "IFRAME" || tag === "INPUT" || tag === "TEXTAREA" || tag === "IMG") return;
        var clip = box && (cs.overflowX !== "visible" || cs.overflowY !== "visible");
        if (clip) { g.save(); g.beginPath(); g.rect(r.left, r.top, r.width, r.height); g.clip(); }
        for (var n = el.firstChild; n; n = n.nextSibling) { if (n.nodeType === 3) text(n, cs, alpha); else if (n.nodeType === 1) walk(n, alpha); }
        if (clip) g.restore();
      }
      var bodyBg = win.getComputedStyle(doc.body).backgroundColor;
      g.fillStyle = rgbaAlpha(bodyBg) > 0 ? bodyBg : "#0a1120"; g.fillRect(0, 0, vw, vh);
      walk(doc.body, 1);
    }
    function capture(seen) {
      var vw = window.innerWidth, vh = window.innerHeight;
      scale = Math.max(0.5, Math.min(2, 1360 / vw));               // about 1360 px wide whatever the window
      var c = document.createElement("canvas"); c.width = Math.round(vw * scale); c.height = Math.round(vh * scale);
      var g = c.getContext("2d"); g.scale(scale, scale);
      paintDoc(g, document, vw, vh, seen);
      return { dataURL: c.toDataURL("image/jpeg", 0.9), w: c.width, h: c.height, scale: scale };
    }

    // ---- actions: pointer and keyboard events on this page ------------------
    function targetAt(x, y) {                                      // top-viewport CSS px -> the element there, through same-origin frames, never the agent's own UI
      var doc = document, win = window, ox = 0, oy = 0;
      for (var depth = 0; depth < 4; depth++) {
        var els = doc.elementsFromPoint(x - ox, y - oy), el = null;
        for (var i = 0; i < els.length; i++) if (!isAgentUi(els[i])) { el = els[i]; break; }
        if (!el) return null;
        if (el.tagName === "IFRAME") {
          var r = el.getBoundingClientRect();
          try { if (!el.contentDocument) return null; doc = el.contentDocument; win = el.contentWindow; } catch (e) { return null; }
          ox += r.left; oy += r.top; continue;
        }
        return { el: el, win: win, doc: doc, x: x - ox, y: y - oy };
      }
      return null;
    }
    function fire(t, type, more) {
      var W = t.win, o = { bubbles: true, cancelable: true, composed: true, view: W, clientX: t.x, clientY: t.y, screenX: t.x, screenY: t.y, button: 0, buttons: 0 };
      if (more) for (var k in more) o[k] = more[k];
      var ev;
      if (type.indexOf("pointer") === 0) { o.pointerId = 1; o.pointerType = "mouse"; o.isPrimary = true; ev = new W.PointerEvent(type, o); }
      else if (type === "wheel") ev = new W.WheelEvent(type, o);
      else ev = new W.MouseEvent(type, o);
      t.el.dispatchEvent(ev);
    }
    function nameOf(el) {
      var b = el.closest("button, [role=button], input, select, .lbl, canvas");
      if (!b) return "the console";
      if (b.tagName === "CANVAS") return "the scene";
      var s = (b.getAttribute("aria-label") || b.textContent || b.type || "").trim().replace(/\s+/g, " ").slice(0, 40);
      return s === "▶" || s === "❚❚" ? "the play button" : "“" + s + "”";
    }
    function setRange(t) {                                          // a synthetic click cannot move a native slider: set the value it points at
      var el = t.el, r = el.getBoundingClientRect(), lo = +el.min || 0, hi = +el.max || 100, st = +el.step || 1;
      var v = lo + Math.max(0, Math.min(1, (t.x - r.left - 8) / Math.max(1, r.width - 16))) * (hi - lo);
      el.value = String(Math.round(v / st) * st);
      el.dispatchEvent(new t.win.Event("input", { bubbles: true })); el.dispatchEvent(new t.win.Event("change", { bubbles: true }));
      return el.value;
    }
    var KEYS = { SPACE: " ", ENTER: "Enter", RETURN: "Enter", TAB: "Tab", BACKSPACE: "Backspace", DELETE: "Delete", HOME: "Home", END: "End",
      LEFT: "ArrowLeft", RIGHT: "ArrowRight", UP: "ArrowUp", DOWN: "ArrowDown", ARROWLEFT: "ArrowLeft", ARROWRIGHT: "ArrowRight", ARROWUP: "ArrowUp", ARROWDOWN: "ArrowDown",
      PAGEUP: "PageUp", PAGEDOWN: "PageDown" };
    function viewDoc() { var f = activeFrame(); try { if (f && f.contentDocument) return { doc: f.contentDocument, win: f.contentWindow }; } catch (e) {} return { doc: document, win: window }; }
    var css = function (v) { return (+v || 0) / scale; };
    // Performs one action; returns { label } for the step log, or { skipped } with the reason.
    async function perform(a, signal) {
      var type = String(a.type || "");
      if (type === "screenshot") return { label: "looked at the console" };
      if (type === "wait") { await delay(Math.min(2000, +a.ms || 700)); return { label: "waited for the console" }; }
      if (type === "keypress") {
        var keys = (a.keys || []).map(function (k) { k = String(k); return KEYS[k.toUpperCase()] || (k.length === 1 ? k : k); });
        var key = keys[keys.length - 1];
        if (!key || /^esc/i.test(key) || keys.length > 1) return { skipped: "key combination not available on this console" };
        var v = viewDoc();
        v.doc.body.dispatchEvent(new v.win.KeyboardEvent("keydown", { key: key, code: key === " " ? "Space" : key, bubbles: true, cancelable: true }));
        v.doc.body.dispatchEvent(new v.win.KeyboardEvent("keyup", { key: key, code: key === " " ? "Space" : key, bubbles: true, cancelable: true }));
        await delay(160);
        return { label: "pressed " + (key === " " ? "Space" : key) };
      }
      if (type === "type") {
        var ae = viewDoc().doc.activeElement;
        if (!ae || isAgentUi(ae) || !/^(INPUT|TEXTAREA)$/.test(ae.tagName) || ae.type === "range") return { skipped: "no text field is focused on the console" };
        ae.value = String(a.text || ""); ae.dispatchEvent(new Event("input", { bubbles: true }));
        return { label: "typed into " + nameOf(ae) };
      }
      if (type === "drag") {
        var path = (a.path || []).map(function (p) { return Array.isArray(p) ? { x: css(p[0]), y: css(p[1]) } : { x: css(p.x), y: css(p.y) }; });
        if (path.length < 2) return { skipped: "drag needs two points" };
        await moveCursor(path[0].x, path[0].y);
        var t0 = targetAt(path[0].x, path[0].y); if (!t0) return { skipped: "nothing to drag there" };
        if (t0.el.tagName === "INPUT" && t0.el.type === "range") {
          var end = path[path.length - 1]; await moveCursor(end.x, end.y);
          var te = targetAt(end.x, t0.y + (path[0].y - t0.y)) || t0; te = { el: t0.el, win: t0.win, doc: t0.doc, x: t0.x + (end.x - path[0].x), y: t0.y };
          return { label: "moved " + nameOf(t0.el) + " to " + setRange(te) };
        }
        var offX = path[0].x - t0.x, offY = path[0].y - t0.y;
        fire(t0, "pointerdown", { buttons: 1 }); fire(t0, "mousedown", { buttons: 1 });
        for (var s = 1; s < path.length; s++) {
          var from = path[s - 1], to = path[s], steps = Math.max(4, Math.min(24, Math.round(Math.hypot(to.x - from.x, to.y - from.y) / 14)));
          for (var k = 1; k <= steps; k++) {
            if (signal && signal.aborted) break;
            var px = from.x + (to.x - from.x) * k / steps, py = from.y + (to.y - from.y) * k / steps;
            await moveCursor(px, py, true);
            var tm = { el: t0.el, win: t0.win, doc: t0.doc, x: px - offX, y: py - offY };
            fire(tm, "pointermove", { buttons: 1 }); fire(tm, "mousemove", { buttons: 1 });
          }
        }
        var last = path[path.length - 1], tu = { el: t0.el, win: t0.win, doc: t0.doc, x: last.x - offX, y: last.y - offY };
        fire(tu, "pointerup"); fire(tu, "mouseup");
        await delay(200);
        return { label: "dragged on " + nameOf(t0.el) };
      }
      // the remaining actions act at one point
      var x = css(a.x), y = css(a.y);
      if (!(x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight)) return { skipped: "point outside the console" };
      await moveCursor(x, y);
      var t = targetAt(x, y); if (!t) return { skipped: "nothing there" };
      if (type === "move") { fire(t, "pointermove"); fire(t, "mousemove"); await delay(380); return { label: "pointed at " + nameOf(t.el) }; }
      if (type === "scroll") {
        var dy = +a.scroll_y || 0, dx = +a.scroll_x || 0;
        var sc = t.el; while (sc && sc !== t.doc.body && !(sc.scrollHeight > sc.clientHeight + 4 && /auto|scroll/.test(t.win.getComputedStyle(sc).overflowY))) sc = sc.parentElement;
        if (sc && sc !== t.doc.body && t.el.tagName !== "CANVAS") { sc.scrollBy({ top: dy / scale, left: dx / scale }); await delay(220); return { label: "scrolled " + (dy >= 0 ? "down" : "up") + " the panel" }; }
        var n = Math.max(1, Math.min(6, Math.round(Math.abs(dy) / 240)));
        for (var w = 0; w < n; w++) { fire(t, "wheel", { deltaY: dy >= 0 ? 120 : -120, deltaX: 0, deltaMode: 0 }); await delay(60); }
        await delay(200);
        return { label: "zoomed " + (dy >= 0 ? "out" : "in") + " on " + nameOf(t.el) };
      }
      if (type === "click" || type === "double_click") {
        if (a.button && a.button !== "left") return { skipped: "only the left button is available" };
        if (t.el.closest && t.el.closest("a[href]")) return { skipped: "links are not followed" };
        pulse();
        var times = type === "double_click" ? 2 : 1;
        for (var c = 0; c < times; c++) {
          fire(t, "pointermove"); fire(t, "pointerdown", { buttons: 1 }); fire(t, "mousedown", { buttons: 1 });
          if (t.el.tagName === "INPUT" && t.el.type === "range") { var val = setRange(t); fire(t, "pointerup"); fire(t, "mouseup"); await delay(220); return { label: "moved " + nameOf(t.el) + " to " + val }; }
          try { if (t.el.focus && /^(INPUT|TEXTAREA|BUTTON)$/.test(t.el.tagName)) t.el.focus({ preventScroll: true }); } catch (e) {}
          fire(t, "pointerup"); fire(t, "mouseup"); fire(t, "click", { detail: c + 1 });
        }
        if (times === 2) fire(t, "dblclick", { detail: 2 });
        await delay(240);
        return { label: "clicked " + nameOf(t.el) };
      }
      return { skipped: "action not available: " + type };
    }
    return { capture: capture, perform: perform, hideCursor: hideCursor };
  })();

  // =========================================================================
  //  ScriptedPolicy: the offline / on-stage default and the LLM fallback.
  //  A view may bring its own narrative (api.narrate) when its asset is not a loop.
  // =========================================================================
  function classify(q) {
    var s = (q || "").toLowerCase();
    if (/recommend|should i|what do|action|do i need|advise|advice/.test(s)) return "recommend";
    if (/where|which|hottest|worst|locate|location/.test(s)) return "where";
    return "general";
  }
  function listLabels(arr) { return arr.map(function (o) { return o.label; }).join(", "); }
  function narrate(intent, ov, obs) {
    var fault = obs.filter(function (o) { return /segment/i.test(o.label); })[0];
    var cools = obs.filter(function (o) { return o !== fault; });
    if (ov.faultPresent && fault) {
      var s = "";
      if (cools.length) {
        var ts = cools.map(function (o) { return o.tempC; });
        var lo = Math.min.apply(null, ts), hi = Math.max.apply(null, ts);
        s += "I walked the loop and dropped a sensor at each stop. The sections I checked first (" +
          listLabels(cools) + ") all read " + (lo === hi ? lo + "°C" : lo + " to " + hi + "°C") + ", normal. ";
      }
      s += "But " + fault.label + " is running at " + fault.tempC + "°C, and my confidence there is only " +
        fault.confidencePct + "%. The hottest physical sensor reads just " + ov.hottestSensorC + "°C, so about " +
        ov.hiddenRiseC + "°C of heat is hidden between the sensors, invisible to them.";
      if (intent === "recommend") {
        s += " Recommendation: inspect " + ov.faultLocation +
          (ov.status === "critical" ? " immediately and isolate it if you safely can" : " now") +
          ", and add a permanent sensor on that section. My confidence is low there precisely because nothing is measuring it.";
      } else if (intent === "where") {
        s = "The risk is at " + ov.faultLocation + ". " + s;
      } else {
        s += " A fault is developing where you have no sensor: I would inspect " + ov.faultLocation + " and add a sensor there.";
      }
      return s;
    }
    var warmest = obs.slice().sort(function (a, b) { return b.tempC - a.tempC; })[0];
    var t = "I walked the loop and read the field beyond the sensors. ";
    if (warmest) t += "The warmest point I found was " + warmest.tempC + "°C at " + warmest.label + ", comfortably within range, ";
    t += "and the reconstruction agrees with your sensors (the hottest reads " + ov.hottestSensorC +
      "°C). Confidence is high near the instrumented sections. Nothing to action right now.";
    return t;
  }
  function ScriptedPolicy() {
    return { run: async function (ctx) {
      var api = ctx.api, ui = ctx.ui;
      if (api.clearProbes) api.clearProbes();   // the canned investigation starts from a clean slate
      ui.addAction("Reading the asset overview…"); await delay(450);
      if (ctx.signal.aborted) throw new Error("aborted");
      var ov = api.getOverview(); ctx.overview = ov;
      var intent = (ctx.chip && ctx.chip.intent) || classify(ctx.q);
      var locs = api.listLocations();
      var fault = locs.filter(function (l) { return l.hot; })[0];
      var cools = locs.filter(function (l) { return !l.hot; });
      var targets = cools.slice(0, 3);
      if (ov.faultPresent && fault) targets.push(fault);
      if (!targets.length && locs[0]) targets.push(locs[0]);
      var canFocus = typeof api.focusOn === "function", obs = [];
      var plan = typeof api.scriptedPlan === "function" ? api.scriptedPlan(intent, ov) : null;   // a view may bring its own tour of its own controls
      if (plan) {
        targets = [];
        try {
          for (var k = 0; k < plan.steps.length; k++) {
            if (ctx.signal.aborted) throw new Error("aborted");
            var st = plan.steps[k], el = ui.addAction(st.say);
            await delay(380);
            var res = st.act() || {};
            await delay(st.wait || 1000);
            if (res.reading) obs.push(res.reading);
            if (res.done) ui.markDone(el, res.done);
            await delay(320);
          }
        } finally { if (plan.cleanup) plan.cleanup(); }
      }
      for (var i = 0; i < targets.length; i++) {
        if (ctx.signal.aborted) throw new Error("aborted");
        var tg = targets[i];
        var step = ui.addAction((tg.hot ? "Inspecting " : "Walking over to check ") + tg.label + "…");
        if (canFocus) api.focusOn(tg.key);
        await delay(canFocus ? 950 : 700);
        var r = api.probe(tg.key);
        if (r) { obs.push(r); ui.markDone(step, cap(tg.label) + ": " + (r.summary ? esc(r.summary) : "<b>" + r.tempC + "°C</b> · " + r.confidencePct + "% confidence")); }
        await delay(360);
      }
      if (ctx.signal.aborted) throw new Error("aborted");
      if (typeof api.resetView === "function") { ui.addAction("Stepping back for the full picture…"); api.resetView(); await delay(600); }
      ui.addAction("Analysing the readings…"); await delay(650);
      if (ctx.signal.aborted) throw new Error("aborted");
      await ui.streamText(typeof api.narrate === "function" ? api.narrate(intent, ov, obs) : narrate(intent, ov, obs));
    } };
  }

  // =========================================================================
  //  LLMPolicy: OpenAI Responses tool loop via the configured backend. The browser
  //  runs the tools and the computer actions; the backend holds the key and the model.
  // =========================================================================
  function systemPrompt(api) {
    return "You are an expert reliability co-engineer at NCL's physical-observability console. " +
      (api.agentBrief || "A model reconstructs the full temperature field of a coolant loop from sparse sensors.") + " " +
      "You investigate hands-on: drive the console, look from several angles, reveal where the model is unsure, probe the estimated state at several points, reason, and narrate each step in one short line like a colleague showing the operator. " +
      "PLANT TOOLS return exact values: describe_asset, get_overview, list_sensors, view_field (a saliency map of the worst temperature and confidence spots) and probe_point (drop a virtual sensor at a normalized point and read its temperature and confidence). " +
      "CONSOLE TOOLS drive the view: " + (IN_SHELL ? "switch_view (2D/3D), " : "") + "set_view, zoom, set_layer, control_time (start/incident/end/play). clear_sensors removes placed sensors; act logs a recommended control action for the operator. " +
      (COMPUTER ? "COMPUTER TOOL: you can also operate this console like a human operator. Take a screenshot to see it, click its buttons and pills, drag on the 3D scene to rotate it, scroll on the scene to zoom, move the pointer over a rack, a hose, a pipe or the CDU to read its tooltip, click or drag the timeline, scroll the telemetry list. The screenshot shows the console without your own chat panel, and its pixel coordinates are the ones you act on. Use the computer tool when the user asks you to show, open, click, rotate or operate something, when a control has no console tool, or to check what the operator sees. Send several actions in one call when the next steps are certain. For numbers prefer the plant tools: they are exact and faster. " : "") +
      "INVESTIGATE (when asked to investigate / assess / look around / what is wrong / where is the risk): run a focused multi-step investigation, never one probe, but be efficient and decisive. Orient: get_overview, list_sensors, and control_time to the incident if something is developing. Survey: set_view to the suspect region (overview or fault), turn set_layer confidence on, and view_field once to see where temperature and confidence are worst. Gather evidence: probe_point at 3 to 4 DISTINCT key spots (the hottest, the most-uncertain, and a calm reference); never stack probes, and stop probing once the picture is clear. Conclude promptly: synthesise findings (what, where, how hot, how confident, what the sensors miss) and a clear recommendation; call act once if a control decision is warranted. Aim to finish within about ten steps; do not keep exploring after you can already explain the situation. " +
      "MEMORY: you remember the earlier turns in this conversation. For a follow-up question (what do you recommend, what is happening, why, what should I do), answer directly from what you already found earlier; do NOT re-run a full investigation unless the user explicitly asks you to investigate again or you genuinely lack the evidence. " +
      "SIMPLE requests stay simple: tour / show me / another angle -> move the camera and describe, no probing. place a sensor at X -> probe_point there. clear / reset -> clear_sensors, confirm briefly, and stop. " +
      "RULES: state a temperature, flow, confidence, or location only if a tool returned it in THIS conversation or it is visible on the console screen. Virtual sensors persist; remove them only when asked. act only logs a recommendation: never claim you physically changed anything, and call it a recommendation you logged. Never present the asset as a live plant; if the operator asks where the data comes from, say it plainly. End with a substantive wrap-up (the finding, the evidence, the recommendation) in clean prose: no markdown, no bullets or headings, and no em dashes or en dashes.";
  }
  async function callBackend(body, signal) {
    var headers = { "Content-Type": "application/json" }, token = null;
    try { token = sessionStorage.getItem("nclToken"); } catch (e) {}   // set by the site's gate; the hosted backend checks it
    if (token) headers.Authorization = "Bearer " + token;
    var res = await fetch(BACKEND, { method: "POST", headers: headers, body: JSON.stringify(body), signal: signal });
    if (!res.ok) { var t = ""; try { t = (await res.text()).slice(0, 200); } catch (e) {} throw new Error("backend HTTP " + res.status + " " + t); }
    return res.json();
  }
  function stepLabel(name, a) {
    if (name === "describe_asset") return "Mapping the asset…";
    if (name === "view_field") return "Looking at the estimated state…";
    if (name === "get_overview") return "Reading the asset overview…";
    if (name === "list_sensors") return "Checking the physical sensors…";
    if (name === "probe_point") return "Probing at (" + (+a.nx).toFixed(2) + ", " + (+a.ny).toFixed(2) + (a.nz != null ? ", " + (+a.nz).toFixed(2) : "") + ")…";
    if (name === "clear_sensors") return "Clearing virtual sensors…";
    if (name === "act") return "⚙ Action: " + esc(a.type || "") + (a.target ? " · " + esc(a.target) : "") + "…";
    if (name === "switch_view") return "Switching to the " + ((String(a.view || "")).indexOf("3") >= 0 ? "3D loop" : "2D field") + "…";
    if (name === "set_view") return "Moving to the " + esc(a.preset || "overview") + " view…";
    if (name === "zoom") return "Zooming " + esc(a.direction || "in") + "…";
    if (name === "set_layer") return (a.on ? "Showing the " : "Hiding the ") + esc(a.layer || "") + " layer…";
    if (name === "control_time") return (String(a.to).toLowerCase() === "play") ? "Playing the timeline…" : "Going to " + esc(a.to || "the incident") + "…";
    return esc(name) + "…";
  }
  function stepDone(name, a, out) {
    if (out && out.error) return "not available on this view";
    if (name === "view_field") return out && out.summary ? ("saw the state · peak " + out.summary.peakTempC + "°C, lowest confidence " + out.summary.minConfidencePct + "%") : "viewed the state";
    if (name === "probe_point") return out && out.onPipe ? (cap(esc(out.label)) + ": " + (out.summary ? esc(out.summary) : "<b>" + out.tempC + "°C</b> · " + out.confidencePct + "% confidence"))
                                                          : "off the network (empty space)";
    if (name === "get_overview") return out ? ("status " + esc(out.status) + ", peak " + out.peakC + "°C") : "overview";
    if (name === "list_sensors") return (out ? out.length : 0) + " sensors read";
    if (name === "describe_asset") return "mapped " + (out && out.anchors ? out.anchors.length : 0) + " landmarks";
    if (name === "clear_sensors") return "cleared the virtual sensors";
    if (name === "act") return esc(a.type || "action") + " logged as a recommendation";
    if (name === "switch_view") return "switched to the " + (out && out.view === "3d" ? "3D loop" : "2D field");
    if (name === "set_view") return "framed the " + esc(out && out.view ? out.view : (a.preset || "overview")) + " view";
    if (name === "zoom") return "zoomed " + esc(out && out.zoom ? out.zoom : (a.direction || "in"));
    if (name === "set_layer") return (a.on ? "showing the " : "hid the ") + esc(a.layer || "") + " layer";
    if (name === "control_time") return (out && out.time) ? ("moved to " + esc(out.time) + (out.status ? " · " + esc(out.status) : "")) : "moved the timeline";
    return "done";
  }
  function summarize(obs, ov) {
    if (obs && obs.length) {
      var w = obs.slice().sort(function (a, b) { return b.tempC - a.tempC; })[0];
      return "I gathered readings across the asset. The hottest point I probed was " + w.tempC + "°C at " + w.label +
        " (" + w.confidencePct + "% confidence)" + (ov ? ", against a hottest sensor of " + ov.hottestSensorC + "°C" : "") + ".";
    }
    return "I could not gather enough readings to conclude.";
  }
  function textOf(items) {                      // the assistant text of a response: its message items' output_text parts
    return (items || []).filter(function (o) { return o.type === "message"; }).map(function (o) {
      return (o.content || []).filter(function (p) { return p.type === "output_text"; }).map(function (p) { return p.text; }).join("");
    }).join("\n").trim();
  }
  function plain(t) { return String(t || "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/[\u2013\u2014]/g, ", "); }   // the panel shows plain text
  // One computer call: perform its actions on this page, then answer with a fresh screenshot.
  async function runComputerCall(call, ctx) {
    var actions = call.actions || (call.action ? [call.action] : []);
    if ((call.pending_safety_checks || []).length) {            // the provider asks for a human decision: this console does not take it for the operator
      ctx.ui.addNote("The provider flagged this console action for review. I did not perform it.");
      logPush({ t: "computer_blocked", checks: call.pending_safety_checks });
      actions = [];
    }
    panel.classList.add("is-driving");
    for (var i = 0; i < actions.length; i++) {
      if (ctx.signal.aborted) throw new Error("aborted");
      var a = actions[i], kind = String(a.type || "");
      var step = ctx.ui.addAction(kind === "screenshot" ? "Looking at the console…" : kind === "drag" ? "Dragging on the console…" : kind === "scroll" ? "Scrolling…" : kind === "move" ? "Pointing…" : kind === "wait" ? "Waiting…" : kind === "keypress" ? "Pressing a key…" : "Clicking…", "hand");
      var r;
      try { r = await CU.perform(a, ctx.signal); } catch (e) { r = { skipped: "the console did not take it" }; }
      ctx.ui.markDone(step, r.skipped ? "skipped: " + esc(r.skipped) : esc(r.label));
      logPush({ t: "computer_action", action: a, result: r });
    }
    await delay(520);                                             // let the camera and the panels settle before the model looks again
    var seen = [], shot = CU.capture(seen);
    seen.forEach(function (n) { if (isFinite(n)) ctx.allowed.push(n); });   // a figure on the screen is a real reading
    logPush({ t: "screenshot", w: shot.w, h: shot.h, kb: Math.round(shot.dataURL.length / 1366) });
    return { type: "computer_call_output", call_id: call.call_id, output: { type: "computer_screenshot", image_url: shot.dataURL, detail: "original" } };
  }
  function LLMPolicy() {
    return { run: async function (ctx) {
      var tools = buildTools(ctx), instructions = systemPrompt(ctx.api);
      var hist = ctx.history || [];   // persistent across questions: lets follow-ups build on prior findings
      var input = hist.concat([{ role: "user", content: ctx.q }]), prevId = null;
      function remember(text) {        // record a compact question/answer so the next question has context
        hist.push({ role: "user", content: ctx.q }, { role: "assistant", content: text });
        while (hist.length > 12) hist.shift();   // cap ~6 exchanges
      }
      async function finish(raw, extra) {
        var v = verify(plain(raw), ctx.allowed);
        logPush(Object.assign({ t: "final_raw", text: raw || "" }, extra || {}));
        logPush({ t: "final_verified", text: v.text, stripped: v.stripped });
        if (v.stripped.length) ctx.ui.addNote("Removed " + v.stripped.length + " unverified figure" + (v.stripped.length > 1 ? "s" : "") + " (not returned by any tool).");
        var finalText = v.text || summarize(ctx.observations, ctx.overview);
        remember(finalText);
        await ctx.ui.streamText(finalText);
      }
      for (var turn = 0; turn < MAX_TURNS; turn++) {
        if (ctx.signal.aborted) throw new Error("aborted");
        while (ctx.pendingSteer.length) { var sx = ctx.pendingSteer.shift(); input.push({ role: "user", content: sx }); logPush({ t: "steer", text: sx }); }
        var data = await callBackend({ input: input, previous_response_id: prevId, tools: tools.schemas, instructions: instructions }, ctx.signal);
        if (!data || !Array.isArray(data.output)) throw new Error("malformed backend response");
        prevId = data.id; input = [];
        var calls = data.output.filter(function (o) { return o.type === "function_call" || o.type === "computer_call"; });
        var said = textOf(data.output);
        logPush({ t: "assistant", content: said || null, calls: calls.map(function (c) { return c.type === "function_call" ? c.name : "computer:" + (c.actions || []).map(function (a) { return a.type; }).join("+"); }), usage: data.usage || null });
        if (!calls.length) { await finish(said); panel.classList.remove("is-driving"); return; }
        if (said) ctx.ui.addNote(esc(plain(said)));                // a line of narration between steps
        for (var j = 0; j < calls.length; j++) {
          if (ctx.signal.aborted) throw new Error("aborted");
          var call = calls[j];
          if (call.type === "computer_call") { input.push(await runComputerCall(call, ctx)); continue; }
          var nm = call.name, args = {};
          try { args = JSON.parse(call.arguments || "{}"); } catch (e) { args = {}; }
          var step = ctx.ui.addAction(stepLabel(nm, args));
          var out = tools.invoke(nm, args);
          ctx.ui.markDone(step, stepDone(nm, args, out));
          input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(out) });
          await delay(120);
        }
        if (ctx.pendingImage) {     // a function result cannot carry an image: hand the view over as a vision message
          input.push({ role: "user", content: [
            { type: "input_text", text: "This is the current view on the console (what the operator sees): brighter is hotter, with the model's confidence where shown. Look at it and the saliency map, then decide your next move: a better angle, a closer look, or a point worth probing." },
            { type: "input_image", image_url: ctx.pendingImage, detail: "low" },
          ] });
          logPush({ t: "image_injected" });
          ctx.pendingImage = null;
        }
      }
      // Out of the step budget: the last tool results go back with a request to wrap up (no more tools),
      // so the operator always gets the model's own conclusion rather than a generic scripted summary.
      panel.classList.remove("is-driving");
      input.push({ role: "user", content: "You have gathered enough evidence. Stop using tools now and give your final wrap-up: the finding, the key evidence, and your recommendation, in a few sentences of plain prose." });
      try {
        var fdata = await callBackend({ input: input, previous_response_id: prevId, tools: tools.schemas, instructions: instructions, tool_choice: "none" }, ctx.signal);
        await finish(textOf(fdata && fdata.output), { stepLimit: true });
      } catch (e) {
        var sum = summarize(ctx.observations, ctx.overview);
        remember(sum);
        await ctx.ui.streamText(sum);
      }
    } };
  }

  // =========================================================================
  //  Orchestrator
  // =========================================================================
  var busy = false, controller = null, pendingSteer = [], history = [], allowedAll = [];   // history + grounded-number set persist across questions (memory)
  async function ask(q, chip) {
    if (busy) {                               // mid-run submit => steer, do not start a new run
      pendingSteer.push(q); addSteer(q); logPush({ t: "steer_queued", text: q }); return;
    }
    busy = true; setRunning(true);
    addUser(q);
    controller = new AbortController();
    var timeoutId = setTimeout(function () { if (controller) controller.abort(); }, TIMEOUT_MS);
    var api = activeApi();
    if (!api) { await streamText("Give the demo a moment to load, then ask again."); busy = false; setRunning(false); clearTimeout(timeoutId); controller = null; return; }
    pendingSteer.length = 0;
    while (allowedAll.length > 1200) allowedAll.shift();   // bound the persistent grounded-number set
    var ctx = { q: q, chip: chip || null, api: api, ui: UI, signal: controller.signal,
                observations: [], allowed: allowedAll, overview: null, pendingImage: null, pendingSteer: pendingSteer, history: history };
    logPush({ t: "run_start", q: q, backend: BACKEND || "scripted", view: api.view, computer: COMPUTER });
    var llmAnswered = false;
    try {
      if (chip && chip.seek) { addAction("Jumping to the incident…"); await delay(500); api.seekCritical(); }
      api.ensureReconstruction();   // ensure we are on the reconstruction (silent; no per-turn step or sensor wipe)
      var policy = BACKEND ? LLMPolicy() : ScriptedPolicy();
      await policy.run(ctx);
      llmAnswered = !!BACKEND;
    } catch (e) {
      if (controller.signal.aborted) { await streamText("Stopped."); logPush({ t: "interrupted" }); }
      else if (BACKEND) {
        logPush({ t: "llm_error", error: String(e && e.message || e) });   // logged for debugging; not surfaced as alarming chrome
        setBadge(false, "LLM backend unreachable; built-in scripted policy answered");   // say honestly that the built-in policy answered
        try { await ScriptedPolicy().run(ctx); } catch (e2) { await streamText("Something went wrong reading the field."); }
      } else { await streamText("Something went wrong reading the field. Try again."); }
    }
    clearTimeout(timeoutId);
    panel.classList.remove("is-driving"); CU.hideCursor();
    if (!controller.signal.aborted && !(llmAnswered && COMPUTER)) {   // return to a clean overview once the answer is in; a console the agent set up for the operator stays as it left it
      try { var rapi = activeApi(); if (rapi && rapi.resetView) rapi.resetView(); } catch (e) {}
    }
    logPush({ t: "run_end" });
    busy = false; setRunning(false); controller = null;
  }

  // hooks for tests and recordings: ask a question, take the screenshot the model would get, perform one action
  window.NCL_AGENT = { ask: function (q) { openPanel(); return ask(q, null); }, capture: function () { return CU.capture([]); }, perform: function (a) { return CU.perform(a, null); }, open: openPanel, busy: function () { return busy; } };
})();
