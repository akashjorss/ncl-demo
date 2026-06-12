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

  document.documentElement.style.visibility = "hidden";
  function deny() {
    document.documentElement.style.visibility = "";
    document.documentElement.innerHTML =
      "<body style='margin:0;display:grid;place-items:center;height:100vh;background:#0a1120;color:#93a4c0;" +
      "font-family:Inter,system-ui,sans-serif'><div style='text-align:center'>" +
      "<div style='font-size:28px;font-weight:800;color:#eaf0fb;margin-bottom:8px'>NCL</div>" +
      "Private demo. Reload the page to try again.</div></body>";
  }
  function ask(msg) {
    var p = window.prompt(msg);
    if (p === null) { deny(); return; }
    if (sha256(p) === HASH) {
      sessionStorage.setItem("nclAccess", "granted");
      document.documentElement.style.visibility = "";
    } else {
      ask("Incorrect password. Enter the access password:");
    }
  }
  ask("This demo is private.\nEnter the access password:");
})();
