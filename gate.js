/* Access gate for the deployed demo. Loaded only on the public domain (the
   loader skips localhost / file://), so local development never sees it.
   Checks a SHA-256 of the entered password and remembers access per tab.
   Note: this is a soft gate for a static site, it deters visitors, it is not
   server-side security. */
(function () {
  "use strict";
  if (sessionStorage.getItem("nclAccess") === "granted") return;

  var HASH = "7e5d372861a1707177f26240d98713b826c1ecf8029d28c1bcd07698da76c85f";

  // compact synchronous SHA-256 (ascii input), so the gate also works over plain http
  function sha256(ascii) {
    function rr(v, a) { return (v >>> a) | (v << (32 - a)); }
    var maxWord = Math.pow(2, 32), result = "", i, j;
    var words = [], asciiBitLength = ascii.length * 8;
    var hash = [], k = [], primeCounter = 0, isComposite = {};
    for (var candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (i = 0; i < 313; i += candidate) isComposite[i] = candidate;
        hash[primeCounter] = (Math.pow(candidate, 0.5) * maxWord) | 0;
        k[primeCounter++] = (Math.pow(candidate, 1 / 3) * maxWord) | 0;
      }
    }
    ascii += "\x80";
    while (ascii.length % 64 - 56) ascii += "\x00";
    for (i = 0; i < ascii.length; i++) {
      j = ascii.charCodeAt(i);
      if (j >> 8) return "";                       // ascii only
      words[i >> 2] |= j << ((3 - i) % 4) * 8;
    }
    words[words.length] = (asciiBitLength / maxWord) | 0;
    words[words.length] = asciiBitLength;
    for (j = 0; j < words.length;) {
      var w = words.slice(j, j += 16), oldHash = hash;
      hash = hash.slice(0, 8);
      for (i = 0; i < 64; i++) {
        var w15 = w[i - 15], w2 = w[i - 2];
        var a = hash[0], e = hash[4];
        var t1 = hash[7] + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & hash[5]) ^ (~e & hash[6])) + k[i] +
          (w[i] = (i < 16) ? w[i] : (w[i - 16] + (rr(w15, 7) ^ rr(w15, 18) ^ (w15 >>> 3)) + w[i - 7] + (rr(w2, 17) ^ rr(w2, 19) ^ (w2 >>> 10))) | 0);
        var t2 = (rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(t1 + t2) | 0].concat(hash);
        hash[4] = (hash[4] + t1) | 0;
      }
      for (i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
    }
    for (i = 0; i < 8; i++) for (j = 3; j + 1; j--) {
      var b = (hash[i] >> (j * 8)) & 255;
      result += (b < 16 ? "0" : "") + b.toString(16);
    }
    return result;
  }

  // Keep the demo hidden behind a designed splash until access is granted (the splash
  // overrides the inherited visibility for itself). Brand values are inlined so the gate
  // is self-contained and renders before tokens.css / Inter load.
  document.documentElement.style.visibility = "hidden";
  function reveal() { document.documentElement.style.visibility = ""; }

  function buildGate() {
    var wrap = document.createElement("div");
    wrap.id = "nclGate";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.setAttribute("aria-label", "Private demo access");
    wrap.innerHTML =
      "<style>" +
      "#nclGate{visibility:visible;position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;" +
      "background:radial-gradient(900px 600px at 50% -12%,rgba(37,99,235,0.16),transparent 60%),#0a1120;" +
      "font-family:Inter,ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased;}" +
      "#nclGate *{box-sizing:border-box;}" +
      "#nclGate .gate-card{width:360px;max-width:calc(100vw - 40px);padding:32px;border:1px solid #233351;" +
      "border-radius:16px;background:#131f36;box-shadow:0 24px 60px rgba(0,0,0,0.55);text-align:center;}" +
      "#nclGate .gate-mark{width:56px;height:56px;margin:0 auto 16px;border-radius:14px;display:grid;place-items:center;" +
      "background:#2563eb;color:#fff;font-weight:800;font-size:19px;letter-spacing:.04em;box-shadow:0 10px 30px rgba(37,99,235,0.45);}" +
      "#nclGate h1{margin:0 0 4px;font-size:18px;font-weight:700;color:#eaf0fb;}" +
      "#nclGate .gate-sub{margin:0 0 20px;font-size:13px;color:#93a4c0;line-height:1.5;}" +
      "#nclGate input{width:100%;padding:11px 13px;border-radius:10px;border:1px solid #233351;background:#0f1a30;" +
      "color:#eaf0fb;font-size:14px;outline:none;}" +
      "#nclGate input:focus{border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,0.28);}" +
      "#nclGate button{width:100%;margin-top:10px;padding:11px 14px;border:0;border-radius:10px;background:#2563eb;" +
      "color:#fff;font-size:14px;font-weight:700;cursor:pointer;transition:filter .15s;}" +
      "#nclGate button:hover{filter:brightness(1.08);}" +
      "#nclGate .gate-err{margin-top:10px;font-size:12.5px;color:#fb6f6f;min-height:15px;opacity:0;transition:opacity .15s;}" +
      "#nclGate .gate-err.show{opacity:1;}" +
      "</style>" +
      "<form class='gate-card' autocomplete='off'>" +
      "<div class='gate-mark'>NCL</div>" +
      "<h1>Physical Observability</h1>" +
      "<p class='gate-sub'>Private demo. Enter the access password to continue.</p>" +
      "<input id='nclGateInput' type='password' placeholder='Access password' aria-label='Access password' autocomplete='current-password'>" +
      "<button type='submit'>Enter</button>" +
      "<div class='gate-err' id='nclGateErr' role='alert'>Incorrect password. Try again.</div>" +
      "</form>";
    (document.body || document.documentElement).appendChild(wrap);
    var input = wrap.querySelector("#nclGateInput");
    var err = wrap.querySelector("#nclGateErr");
    wrap.querySelector("form").addEventListener("submit", function (e) {
      e.preventDefault();
      if (sha256(input.value) === HASH) {
        sessionStorage.setItem("nclAccess", "granted");
        wrap.remove();
        reveal();
      } else {
        err.classList.add("show");
        input.value = "";
        input.focus();
      }
    });
    input.focus();
  }

  if (document.body) buildGate();
  else document.addEventListener("DOMContentLoaded", buildGate);
})();
