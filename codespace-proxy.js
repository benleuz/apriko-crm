/* ============================================================
   Apriko-API Reverse-Proxy — GitHub Codespaces · v3
   ------------------------------------------------------------
   Läuft in einem Codespace deines Repos — damit bleibt das POC
   vollständig bei GitHub. Gleiche Logik wie die Worker-Variante:
   Preflight selbst beantworten, exakter Origin (nie *), festes
   Ziel, X-Gateway-Error auf Proxy-eigenen Fehlern, kein Logging
   von Authorization/Bodies/Query-Strings.

   Nutzung (jedes Mal, wenn du das POC brauchst):
   1. github.com/benleuz/apriko-crm → grüner «Code»-Knopf →
      Tab «Codespaces» → «Create codespace on main»
      (bzw. bestehenden Codespace öffnen).
   2. Im Terminal unten:
        APRIKO_BASE=https://<instanz>.apriko.ch node codespace-proxy.js
   3. Reiter «PORTS» (neben Terminal): Port 8787 erscheint →
      Rechtsklick → «Port Visibility» → «Public».
   4. Im PORTS-Reiter die «Forwarded Address» kopieren
      (https://<name>-8787.app.github.dev) → im CRM als
      Gateway-URL eintragen. Token wie gehabt.

   Zu wissen: Der Codespace schläft nach ~30 Min Inaktivität ein
   (Proxy weg, beim nächsten Mal Schritt 2–4 wiederholen; die
   Adresse bleibt beim selben Codespace gleich). Das Gratis-
   Kontingent (Kernstunden/Monat) reicht für POC-Sessions locker.
   Für Dauerbetrieb ist das nichts — dafür braucht es einen der
   anderen Wege (Worker/Deno/Azure) oder die CORS-Freigabe.
   ============================================================ */

const http = require("http");

/* Eine oder mehrere erlaubte Apriko-Instanzen (kommagetrennt).
   Der Client wählt per Header X-Apriko-Target; ohne Header gilt die
   erste. Ziele ausserhalb der Liste werden abgelehnt — kein Relay. */
const APRIKO_BASES = (process.env.APRIKO_BASES || process.env.APRIKO_BASE || process.argv[2] || "")
  .split(",").map(s => s.trim().replace(/\/+$/, "")).filter(Boolean);
const ALLOWED_ORIGINS = ["https://benleuz.github.io"]
  .concat((process.env.EXTRA_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean));
const ALLOWED_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"];
const TOKEN_PATHS = ["/connect/token", "/.well-known/openid-configuration",
  "/api/id/.well-known/openid-configuration", "/identity/.well-known/openid-configuration"];
const DISCOVERY_PATHS = ["/.well-known/openid-configuration", "/api/id/.well-known/openid-configuration",
  "/identity/.well-known/openid-configuration", "/id/.well-known/openid-configuration", "/auth/.well-known/openid-configuration"];
const PORT = 8787;

function corsHeaders(origin, allowed) {
  return {
    "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": ALLOWED_METHODS.join(", "),
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, X-Apriko-Target",
    "Access-Control-Expose-Headers": "X-Token-Endpoint, X-Discovery, X-Gateway-Error",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}
function gatewayError(res, cors, status, msg) {
  res.writeHead(status, Object.assign({ "X-Gateway-Error": "1", "Content-Type": "text/plain; charset=utf-8" }, cors));
  res.end(msg);
}

http.createServer(async (req, res) => {
  try { await handle(req, res); }
  catch (e) { try { res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": ALLOWED_ORIGINS[0], "X-Gateway-Error": "1" }); res.end("Proxy-Fehler: " + e.message); } catch (e2) {} }
}).listen(PORT, () => {
  console.log("Apriko-Proxy läuft auf Port " + PORT +
    (APRIKO_BASES.length ? " → " + APRIKO_BASES.join(", ") : "  (APRIKO_BASES fehlt noch!)"));
  console.log("Jetzt im PORTS-Tab Port " + PORT + " auf «Public» stellen und die Adresse ins CRM übernehmen.");
});

async function handle(req, res) {
  const origin = req.headers.origin || "";
  const allowed = ALLOWED_ORIGINS.includes(origin);
  const cors = corsHeaders(origin, allowed);

  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (!allowed) return gatewayError(res, cors, 403, "Origin nicht erlaubt: " + origin);
  if (!ALLOWED_METHODS.includes(req.method)) return gatewayError(res, cors, 405, "Methode nicht erlaubt");
  if (!APRIKO_BASES.length) return gatewayError(res, cors, 500, "APRIKO_BASES fehlt — Start: APRIKO_BASES=https://<instanz1>,https://<instanz2> node codespace-proxy.js");
  const wanted = (req.headers["x-apriko-target"] || "").replace(/\/+$/, "");
  const APRIKO_BASE = wanted ? (APRIKO_BASES.includes(wanted) ? wanted : null) : APRIKO_BASES[0];
  if (!APRIKO_BASE) return gatewayError(res, cors, 403, "Ziel nicht auf der Allowlist: " + wanted + " — im Proxy unter APRIKO_BASES ergänzen.");

  const url = new URL(req.url, "http://x");

  /* ---- /__diag : zeigt je Instanz, was die OpenID-Discovery liefert (Fehlersuche) ---- */
  if (url.pathname === "/__diag" && req.method === "GET") {
    const out = { bases: APRIKO_BASES, target: APRIKO_BASE, discovery: [] };
    for (const base of APRIKO_BASES) {
      for (const cand of DISCOVERY_PATHS) {
        try {
          const r = await fetch(base + cand, { headers: { Accept: "application/json" } });
          const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch (e) {}
          out.discovery.push({ base, path: cand, status: r.status, token_endpoint: j && j.token_endpoint || null, issuer: j && j.issuer || null });
        } catch (e) { out.discovery.push({ base, path: cand, error: e.message }); }
      }
    }
    res.writeHead(200, Object.assign({ "Content-Type": "application/json; charset=utf-8" }, cors));
    return res.end(JSON.stringify(out, null, 2));
  }

  /* ---- /__token : Password-Grant serverseitig. Der Proxy sucht den token_endpoint per Discovery
          auf der Zielinstanz und ruft ihn direkt auf — auch wenn der Identity-Server auf einem
          anderen Host/Pfad liegt (nur *.apriko.app erlaubt). Antwort: JSON des Identity-Servers
          plus X-Token-Endpoint-Header mit der verwendeten URL. ---- */
  if (url.pathname === "/__token" && req.method === "POST") {
    const chunks0 = []; for await (const c of req) chunks0.push(c);
    const form = new URLSearchParams(Buffer.concat(chunks0).toString("utf8"));
    let tokenUrl = form.get("token_url") || "";
    const tried = [];
    if (!tokenUrl) {
      for (const cand of DISCOVERY_PATHS) {
        try {
          const r = await fetch(APRIKO_BASE + cand, { headers: { Accept: "application/json" } });
          tried.push(cand + " -> " + r.status);
          if (r.ok) { const j = await r.json(); if (j.token_endpoint) { tokenUrl = j.token_endpoint; break; } }
        } catch (e) { tried.push(cand + " -> " + String(e.message).replace(/[^\x20-\x7e]/g, "?")); }
      }
    }
    if (!tokenUrl) tokenUrl = APRIKO_BASE + "/connect/token";
    if (/^\//.test(tokenUrl)) tokenUrl = APRIKO_BASE + tokenUrl;
    let host = ""; try { host = new URL(tokenUrl).hostname; } catch (e) {}
    if (!/\.apriko\.app$/i.test(host)) return gatewayError(res, cors, 403, "Token-Endpunkt ausserhalb apriko.app: " + tokenUrl);
    // grant_type wird vom Client vorgegeben (heute: client_credentials mit client_id/client_secret/scope
    // gemäss Apriko-Vorgabe; Password-Grant bleibt als Fallback für andere Instanzen erhalten).
    const grantType = form.get("grant_type") || "password";
    const body = new URLSearchParams();
    body.set("grant_type", grantType);
    if (grantType === "password") { body.set("username", form.get("username") || ""); body.set("password", form.get("password") || ""); }
    if (form.get("client_id")) body.set("client_id", form.get("client_id"));
    if (form.get("client_secret")) body.set("client_secret", form.get("client_secret"));
    if (form.get("scope")) body.set("scope", form.get("scope"));
    let up;
    try {
      up = await fetch(tokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: body.toString() });
    } catch (e) { return gatewayError(res, cors, 502, "Token-Endpunkt nicht erreichbar: " + tokenUrl + " — " + e.message); }
    const txt = await up.text();
    const hdrs = Object.assign({ "Content-Type": up.headers.get("Content-Type") || "application/json; charset=utf-8", "X-Token-Endpoint": tokenUrl, "X-Discovery": tried.join(" | ").replace(/[^\x20-\x7e]/g, "?").slice(0, 900) }, cors);
    res.writeHead(up.status, hdrs);
    return res.end(txt);
  }

  const isTokenPath = TOKEN_PATHS.includes(url.pathname);
  if (!url.pathname.startsWith("/api/") && !isTokenPath) {
    return gatewayError(res, cors, 404, "Nur /api/* wird weitergeleitet");
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);

  const headers = { Accept: "application/json" };
  if (req.headers.authorization) headers.Authorization = req.headers.authorization;
  if (req.headers["content-type"]) headers["Content-Type"] = req.headers["content-type"];

  let upstream;
  try {
    upstream = await fetch(APRIKO_BASE + url.pathname + url.search, {
      method: req.method, headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : body
    });
  } catch (e) {
    return gatewayError(res, cors, 502, "Apriko-Instanz nicht erreichbar: " + e.message);
  }

  const out = Object.assign({}, cors);
  const ct = upstream.headers.get("Content-Type");
  if (ct) out["Content-Type"] = ct;
  res.writeHead(upstream.status, out);
  res.end(Buffer.from(await upstream.arrayBuffer()));
}
