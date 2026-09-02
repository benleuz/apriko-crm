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
const PORT = 8787;

function corsHeaders(origin, allowed) {
  return {
    "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": ALLOWED_METHODS.join(", "),
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, X-Apriko-Target",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}
function gatewayError(res, cors, status, msg) {
  res.writeHead(status, Object.assign({ "X-Gateway-Error": "1", "Content-Type": "text/plain; charset=utf-8" }, cors));
  res.end(msg);
}

http.createServer(async (req, res) => {
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
}).listen(PORT, () => {
  console.log("Apriko-Proxy läuft auf Port " + PORT +
    (APRIKO_BASES.length ? " → " + APRIKO_BASES.join(", ") : "  (APRIKO_BASES fehlt noch!)"));
  console.log("Jetzt im PORTS-Tab Port " + PORT + " auf «Public» stellen und die Adresse ins CRM übernehmen.");
});
