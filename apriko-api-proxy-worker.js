/* ============================================================
   Apriko-API Reverse-Proxy — Cloudflare Worker · v3
   ------------------------------------------------------------
   Zweck: Die Apriko-API gibt den Origin https://benleuz.github.io
   nicht per CORS frei. Dieser Proxy ist der Netzwerk-Umweg: er
   beantwortet den CORS-Preflight selbst und leitet alles andere
   unverändert an die konfigurierte Apriko-Instanz weiter. Er
   hostet nichts vom CRM, hält keinen Zustand, ersetzt kein
   Backend.

   Sicherheits-Einordnung (wichtig): CORS ist Browser-Schutz,
   kein serverseitiger Zugriffsschutz — der Proxy hebelt keine
   Apriko-Autorisierung aus. Die realen Risiken sind
   (1) Token-Sichtbarkeit beim Proxy-Betreiber,
   (2) Mitbenutzung durch Dritte mit gültigem Apriko-Token,
   (3) die Log-Fläche.
   Antworten darauf: exakte Origin-Allow-Liste (nie *), fest
   konfiguriertes Ziel (kein offener Relay), und dieser Worker
   loggt nichts — kein Authorization-Header, keine Bodies, keine
   Query-Strings (dort stehen Filterwerte = Personendaten).

   Token-Fluss: Variante A (transparenter Relay) — das Token
   kommt vom Client und wird durchgereicht. Der Wechsel auf
   Variante B (Apriko-Credential als Worker-Secret, Validierung
   des Azure-AD-Tokens aus MSAL) betrifft NUR diesen Worker und
   die Token-Funktion in index.html — apriko-api.js bleibt gleich.

   Deployment (5 Schritte):
   1. dash.cloudflare.com → Workers & Pages → Create Worker
   2. Diesen Code einfügen → Deploy
   3. Settings → Variables and Secrets:
        APRIKO_BASE = https://<instanz>.apriko.ch   (ohne /api)
        EXTRA_ORIGINS = http://localhost:8080        (optional,
          kommagetrennt für lokale Entwicklung)
   4. Worker-URL kopieren (https://<name>.<konto>.workers.dev)
   5. Im CRM: die Basis-URL im POC-Menü (bzw. CONFIG.aprikoGateway)
      auf die Worker-URL setzen. Token wie gehabt.
   ============================================================ */

const ALLOWED_ORIGINS = ["https://benleuz.github.io"];
const ALLOWED_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"];
/* Identity-Pfade für den optionalen Token-Bezug per Benutzer/Passwort
   (OpenID-Discovery + Token-Endpunkt). */
const TOKEN_PATHS = ["/connect/token", "/.well-known/openid-configuration",
                     "/api/id/.well-known/openid-configuration", "/identity/.well-known/openid-configuration"];

/* Proxy-EIGENE Fehler tragen den Marker X-Gateway-Error, damit der
   Client sie von Upstream-Antworten unterscheiden kann. */
function gatewayError(msg, status, cors) {
  const h = new Headers(cors);
  h.set("X-Gateway-Error", "1");
  h.set("Content-Type", "text/plain; charset=utf-8");
  return new Response(msg, { status, headers: h });
}

export default {
  async fetch(request, env) {
    const origins = ALLOWED_ORIGINS.concat(
      (env.EXTRA_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean));
    const origin = request.headers.get("Origin") || "";
    const allowed = origins.includes(origin);
    const cors = {
      /* Exakter Origin, nie '*': es sind Credentials im Spiel. */
      "Access-Control-Allow-Origin": allowed ? origin : origins[0],
      "Access-Control-Allow-Methods": ALLOWED_METHODS.join(", "),
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    };

    /* Preflight selbst beantworten — nie weiterleiten. */
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (!allowed) {
      return gatewayError("Origin nicht erlaubt: " + origin, 403, cors);
    }
    if (!ALLOWED_METHODS.includes(request.method)) {
      return gatewayError("Methode nicht erlaubt", 405, cors);
    }
    if (!env.APRIKO_BASE) {
      return gatewayError("APRIKO_BASE nicht konfiguriert (Worker -> Settings -> Variables)", 500, cors);
    }

    const url = new URL(request.url);
    const isTokenPath = TOKEN_PATHS.includes(url.pathname);
    /* Ziel-Allow-Liste: Upstream ist fest konfiguriert, Pfade nur /api/*
       (+ Token-Pfade). Kein offener Relay. */
    if (!url.pathname.startsWith("/api/") && !isTokenPath) {
      return gatewayError("Nur /api/* wird weitergeleitet", 404, cors);
    }

    /* Methode, Pfad, Query und Body unveraendert weiterreichen. */
    const target = env.APRIKO_BASE.replace(/\/+$/, "") + url.pathname + url.search;
    const headers = new Headers();
    const auth = request.headers.get("Authorization");
    if (auth) headers.set("Authorization", auth);
    const ct = request.headers.get("Content-Type");
    if (ct) headers.set("Content-Type", ct);
    headers.set("Accept", "application/json");

    let upstream;
    try {
      upstream = await fetch(target, {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer()
      });
    } catch (e) {
      /* Upstream nicht erreichbar -> als Gateway-Fehler markieren,
         damit der Client "Apriko-Instanz nicht erreichbar" meldet
         statt eines fachlichen Fehlers. */
      return gatewayError("Apriko-Instanz nicht erreichbar: " + e.message, 502, cors);
    }

    /* Status und Body unveraendert zurueck — insbesondere 4xx-Bodies
       NICHT verschlucken: CommandResultObject.messages sind die
       einzige verwertbare Fehlerinformation. Kein X-Gateway-Error
       hier: das ist eine echte Upstream-Antwort. */
    const out = new Headers();
    const uct = upstream.headers.get("Content-Type");
    if (uct) out.set("Content-Type", uct);
    Object.entries(cors).forEach(([k, v]) => out.set(k, v));
    return new Response(upstream.body, { status: upstream.status, headers: out });
  }
};
