/* ============================================================
   AprikoApi — RESTful-Client für die Apriko-API.
   ------------------------------------------------------------
   Drei Schichten:
     1. Transport  request(service, path, opts) — URL-Bau, Header,
        Statusauswertung. Nur natives fetch.
     2. Ressourcen people.*, models.* — kennen ihre Endpunkte,
        keine fetch-Details.
     3. Aufrufer/UI — liegt in index.html, kennt nur die
        Ressourcen-Methoden.

   Diese Datei ist UI-frei: kein DOM, kein toast()/showError().
   Fehler werden als AprikoApiError GEWORFEN; anzeigen ist Sache
   des Aufrufers. Kein CONFIG-Zugriff — Initialisierung über
   AprikoApi.configure({ gateway, getToken }).

   Der Zugriff läuft über einen eigenen Reverse-Proxy (Gateway),
   weil die Apriko-API den Origin dieses Tools nicht per CORS
   freigibt. Der Proxy ist ein reiner Netzwerk-Umweg; er hebelt
   keine Apriko-Autorisierung aus (CORS ist Browser-Schutz, kein
   serverseitiger Zugriffsschutz). Wechsel auf Direktzugriff oder
   auf einen anders abgesicherten Proxy = configure() mit anderer
   Gateway-URL; diese Datei bleibt unverändert.
   ============================================================ */
(function () {
  "use strict";

  /* ---------- Service-Registry (aus servers[0].url der 16 OpenAPI-Specs) */
  var SERVICES = {
    activities:           "/api/activities",
    businessintelligence: "/api/businessintelligence",
    creditratings:        "/api/creditratings",
    emailmessaging:       "/api/emailmessaging",
    files:                "/api/files",
    identities:           "/api/id",
    models:               "/api/models",
    notes:                "/api/notes",
    payrollaccounting:    "/api/payrollaccounting",
    people:               "/api/people",
    qualifications:       "/api/qualifications",
    receivableaccounting: "/api/receivableaccounting",
    staffing:             "/api/staffing",
    tags:                 "/api/tags",
    textmessaging:        "/api/textmessaging",
    timetracking:         "/api/timetracking"
  };

  var cfg = { gateway: "", getToken: null };

  function configure(options) {
    if (options && typeof options.gateway === "string") {
      cfg.gateway = options.gateway.replace(/\/+$/, "");
    }
    if (options && typeof options.getToken === "function") {
      cfg.getToken = options.getToken;
    }
  }
  function isConfigured() { return !!(cfg.gateway && cfg.getToken); }

  /* ---------- Fehlermodell: vier unterscheidbare Fälle ----------
     kind = "gateway-unreachable" | fetch rejected: Proxy down oder
                                     Origin nicht auf der Allow-Liste
            "upstream-unreachable"| Proxy antwortet selbst (Header
                                     X-Gateway-Error): Apriko-Instanz weg
            "auth"                | 401/403 ohne Body: Token fehlt,
                                     abgelaufen oder unzureichend
            "business"            | 4xx mit CommandResultObject:
                                     messages[] enthalten die Fachfehler
            "config" / "http"     | nicht konfiguriert / Rest       */
  function AprikoApiError(kind, message, status, messages, raw) {
    var e = new Error(message);
    e.name = "AprikoApiError";
    e.kind = kind;
    e.status = status || 0;
    e.messages = messages || [];
    e.raw = raw;
    return e;
  }

  /* CommandResult.messages[] → lesbare Strings.
     CommandResultMessage = { id, key, status, value }, value ist
     ITranslatable = { key, fallback, data } — fallback ist der Text. */
  function extractMessages(body) {
    if (!body || !Array.isArray(body.messages)) return [];
    return body.messages.map(function (m) {
      var txt = (m && m.value && (m.value.fallback || m.value.key)) || (m && m.key) || "";
      return (m && m.status ? "[" + m.status + "] " : "") + txt;
    }).filter(Boolean);
  }

  /* ---------- Transport ---------- */
  function buildUrl(service, path, query) {
    var base = SERVICES[service];
    if (!base) throw AprikoApiError("config", "Unbekannter Service '" + service + "'");
    var qs = "";
    if (query) {
      var parts = [];
      Object.keys(query).forEach(function (k) {
        if (query[k] === undefined || query[k] === null) return;
        parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(query[k]));
      });
      if (parts.length) qs = "?" + parts.join("&");
    }
    return cfg.gateway + base + path + qs;
  }

  async function request(service, path, opts) {
    opts = opts || {};
    if (!isConfigured()) {
      throw AprikoApiError("config", "AprikoApi ist nicht konfiguriert — Gateway-URL und Token hinterlegen.");
    }
    var token = await cfg.getToken();
    if (!token) {
      throw AprikoApiError("auth", "Kein Apriko-Token hinterlegt.", 0);
    }
    var url = buildUrl(service, path, opts.query);
    var init = {
      method: opts.method || "GET",
      headers: { Authorization: "Bearer " + token, Accept: "application/json" }
    };
    if (opts.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }

    var res;
    try {
      res = await fetch(url, init);
    } catch (networkErr) {
      throw AprikoApiError("gateway-unreachable",
        "Gateway nicht erreichbar (" + cfg.gateway + "): Der Proxy ist nicht erreichbar, " +
        "antwortet nicht auf den CORS-Preflight oder dieser Origin steht nicht auf seiner Allow-Liste. " +
        "(" + networkErr.message + ")", 0, [], networkErr);
    }

    /* Proxy-eigene Fehler tragen den Marker X-Gateway-Error — sie bedeuten
       "Apriko-Instanz nicht erreichbar", nicht "fachlicher Fehler". */
    if (res.headers && res.headers.get && res.headers.get("X-Gateway-Error")) {
      var gwText = await res.text().catch(function () { return ""; });
      throw AprikoApiError("upstream-unreachable",
        "Apriko-Instanz nicht erreichbar (Gateway meldet HTTP " + res.status + "). " +
        "Der Proxy läuft, kommt aber nicht zur API durch." + (gwText ? " — " + gwText.slice(0, 200) : ""),
        res.status, [], gwText);
    }

    if (res.status === 401 || res.status === 403) {
      /* Laut Spec ohne Body. */
      throw AprikoApiError("auth",
        res.status === 401
          ? "Token ungültig oder abgelaufen (401)."
          : "Token hat keine Berechtigung für diese Operation (403).",
        res.status);
    }

    if (res.status === 204) return null;

    var text = await res.text().catch(function () { return ""; });
    var body = null;
    if (text) { try { body = JSON.parse(text); } catch (e) { body = null; } }

    if (!res.ok) {
      var msgs = extractMessages(body);
      var isConflict = res.status === 409 || res.status === 412;
      throw AprikoApiError("business",
        (isConflict
          ? "Versionskonflikt (HTTP " + res.status + "): Der Datensatz wurde zwischenzeitlich geändert. Neu laden und erneut versuchen."
          : "Apriko meldet HTTP " + res.status + ".") +
        (msgs.length ? " — " + msgs.join(" · ") : (body ? "" : (text ? " " + text.slice(0, 200) : ""))),
        res.status, msgs, body || text);
    }

    return body;
  }

  /* ---------- Paging: über totalCount weiterblättern (P0-2) ----------
     Eine Seite ist nie "hoffentlich alles": fetchAll blättert, bis
     totalCount erreicht ist. maxPages als Notbremse. */
  async function queryPaged(model) {
    if (typeof model.pageIndex !== "number" || typeof model.pageSize !== "number") {
      throw AprikoApiError("config", "QueryModel: pageIndex und pageSize sind Pflicht (Zahlen).");
    }
    return request("models", "/Query", { method: "POST", body: model });
  }

  async function queryAll(model, options) {
    var maxPages = (options && options.maxPages) || 50;
    var pageSize = typeof model.pageSize === "number" ? model.pageSize : 100;
    var all = [];
    var total = null;
    for (var page = 0; page < maxPages; page++) {
      var res = await queryPaged(Object.assign({}, model, { pageIndex: page, pageSize: pageSize }));
      var hits = (res && res.results) || [];
      all = all.concat(hits);
      total = res && typeof res.totalCount === "number" ? res.totalCount : null;
      if (total === null) {
        if (hits.length < pageSize) break;   // kein totalCount: Ende an kurzer Seite erkennen
      } else if (all.length >= total || hits.length === 0) {
        break;
      }
    }
    if (total !== null && all.length < total) {
      throw AprikoApiError("http",
        "Paging abgebrochen: " + all.length + " von " + total + " Datensätzen geladen (maxPages=" + maxPages + ").",
        0, [], null);
    }
    return { totalCount: total !== null ? total : all.length, results: all };
  }

  /* QueryHit → Nutzdaten (results[].document.data). Fehlende Struktur ist
     ein Fehler, kein stilles {} (P0-4). */
  function hitData(hit) {
    if (!hit || !hit.document || hit.document.data === undefined) {
      throw AprikoApiError("http", "Query-Ergebnis ohne document.data — unerwartete Antwortstruktur.", 0, [], hit);
    }
    return hit.document.data;
  }

  /* ---------- Ressourcen ---------- */
  function crForCreate(res) {
    /* 201 liefert CommandResult{ messages, result, transmittedMessages } */
    return {
      result: res ? res.result : null,
      messages: extractMessages(res),
      raw: res
    };
  }

  var people = {
    /* opts: { dryRun, returnResult, messagePriority } */
    createIndividual: async function (payload, opts) {
      opts = opts || {};
      ["type", "firstName", "lastName"].forEach(function (f) {
        if (!payload || payload[f] === undefined || payload[f] === null || payload[f] === "") {
          throw AprikoApiError("config", "createIndividual: Pflichtfeld '" + f + "' fehlt (Required: Type, FirstName, LastName).");
        }
      });
      var res = await request("people", "/IndividualPeople", {
        method: "POST",
        body: payload,
        query: {
          DryRun: opts.dryRun === true ? "true" : undefined,
          ReturnResult: opts.returnResult === false ? "false" : "true",
          MessagePriority: opts.messagePriority
        }
      });
      return crForCreate(res);
    },
    getIndividual: function (id) {
      return request("people", "/IndividualPeople/" + encodeURIComponent(id));
    },
    listIndividual: function (pageIndex, pageSize) {
      return request("people", "/IndividualPeople", {
        query: { pageIndex: pageIndex || 0, pageSize: pageSize || 50 }
      });
    },
    /* Update mit Optimistic Locking (P0-3): version ist Pflicht;
       409/412 wirft der Transport als Konflikt. */
    updateIndividual: async function (id, payload, opts) {
      if (!payload || typeof payload.version !== "number") {
        throw AprikoApiError("config",
          "updateIndividual: 'version' fehlt im Payload — ohne Version kein Konfliktschutz (Optimistic Locking).");
      }
      var res = await request("people", "/IndividualPeople/" + encodeURIComponent(id), {
        method: "PUT", body: payload,
        query: { DryRun: opts && opts.dryRun === true ? "true" : undefined }
      });
      return crForCreate(res);
    },
    listLegal: function (pageIndex, pageSize) {
      return request("people", "/LegalPeople", {
        query: { pageIndex: pageIndex || 0, pageSize: pageSize || 50 }
      });
    },
    getLegal: function (id) {
      return request("people", "/LegalPeople/" + encodeURIComponent(id));
    }
  };

  var models = {
    query: queryPaged,
    queryAll: queryAll,
    hitData: hitData,
    getEntity: function (entityId) {
      return request("models", "/Query/Entity/" + encodeURIComponent(entityId));
    }
  };

  function serviceInfo(service) {
    return request(service, "/ServiceInfos");
  }

  /* ---------- Konnektivitäts-Selbsttest ----------
     Prüft die Kette schrittweise und liefert drei getrennte Zustände:
       gateway  — Proxy erreichbar?
       upstream — Apriko-Instanz hinter dem Proxy erreichbar?
       token    — Token gültig?
     je: "ok" | "fail" | "unknown", mit Detailtext. */
  async function selfTest(service) {
    var state = {
      gateway:  { status: "unknown", detail: "" },
      upstream: { status: "unknown", detail: "" },
      token:    { status: "unknown", detail: "" },
      info: null
    };
    try {
      state.info = await serviceInfo(service || "people");
      state.gateway =  { status: "ok", detail: "Proxy erreichbar" };
      state.upstream = { status: "ok", detail: "Apriko-Instanz antwortet" };
      state.token =    { status: "ok", detail: "Token akzeptiert" };
    } catch (e) {
      if (e.kind === "gateway-unreachable") {
        state.gateway = { status: "fail", detail: e.message };
      } else if (e.kind === "upstream-unreachable") {
        state.gateway =  { status: "ok", detail: "Proxy erreichbar" };
        state.upstream = { status: "fail", detail: e.message };
      } else if (e.kind === "auth") {
        state.gateway =  { status: "ok", detail: "Proxy erreichbar" };
        state.upstream = { status: "ok", detail: "Apriko-Instanz antwortet" };
        state.token =    { status: "fail", detail: e.message };
      } else {
        state.gateway =  { status: "ok", detail: "Proxy erreichbar" };
        state.upstream = { status: "ok", detail: "Antwort erhalten (HTTP " + e.status + ")" };
        state.token =    { status: "unknown", detail: e.message };
      }
    }
    return state;
  }

  var api = {
    configure: configure,
    isConfigured: isConfigured,
    request: request,
    services: Object.keys(SERVICES),
    serviceInfo: serviceInfo,
    selfTest: selfTest,
    people: people,
    models: models,
    extractMessages: extractMessages
  };

  if (typeof window !== "undefined") window.AprikoApi = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
