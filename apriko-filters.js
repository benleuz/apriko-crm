/* ============================================================
   AprikoFilters — Filter- und Sortier-Pipe-Strings für den
   Apriko Models-Query-Service.
   ------------------------------------------------------------
   Reine Funktionen: kein fetch, kein DOM, keine Browser-Globals.
   Läuft unverändert in Node (Export-Guard am Dateiende) — damit
   ist der Builder direkt testbar (node tools/filters-test.cjs).

   Pipe-Format (7 Positionen):
     Feldname|Operator|Wert|Datentyp|IstInclude|IgnoreUnset|OR-Label

   OR-Label-Semantik (Conjunctive Normal Form):
     Filter ohne Label sind konjunktiv (AND). Gleiche Labels
     gruppieren Filter disjunktiv (OR):
     F1=[], F2=[A,B], F3=[A], F4=[B]  ⇒  F1 & (F2|F3) & (F2|F4)
   ============================================================ */
(function () {
  "use strict";

  var OPERATORS = ["=", "!=", ">", "<", ">=", "<=", "ANY", "!ANY"];
  var DATA_TYPES = ["Text", "Numeric", "Timestamp", "Date", "Boolean"];

  /* OFFENER PUNKT (Doku widersprüchlich): Das Schema-Beispiel zeigt
     `name|=|Doe|text|false|false|Group1` (Wert ohne Anführungszeichen,
     Datentyp klein), die Schema-Beschreibung verlangt JSON.stringify
     ("Doe") und die Datentypen in Grossschreibung (Text). Implementiert
     ist die Beschreibung (JSON.stringify + Grossschreibung), weil sie
     als normativer Teil des Schemas spezifischer ist als ein Beispiel
     und weil nur JSON.stringify Arrays für ANY/!ANY eindeutig
     serialisiert. Gegen eine echte Anfrage verifizieren; falls die API
     das Beispiel-Format erwartet, unten `serializeValue` anpassen —
     alle Aufrufer bleiben unverändert. */
  function serializeValue(value) {
    if (value === undefined) value = null;
    return JSON.stringify(value);
  }

  function normalizeDataType(dataType) {
    if (!dataType) return "Text";
    var hit = DATA_TYPES.filter(function (t) {
      return t.toLowerCase() === String(dataType).toLowerCase();
    })[0];
    if (!hit) {
      throw new Error("AprikoFilters: unbekannter Datentyp '" + dataType +
        "' — erlaubt: " + DATA_TYPES.join(", "));
    }
    return hit;
  }

  /* GRUPPEN-PFLICHT + JSON-FORM (empirisch 02.09.2026, zwei Runden):
     1. Leeres Label → 400 "Group value has to be set": Gruppe ist Pflicht.
     2. Rohes Label "G1" → 400 "Unexpected character … parsing value: G":
        der Server JSON-parst die Gruppe — verlangt wird ein JSON-Array,
        z.B. ["G1"] (die Doku sagt "Array", ihr Beispiel "Group1" ist
        vereinfacht/falsch).
     Filter ohne OR-Verbund erhalten je eine eigene Gruppe (CNF: einzelne
     Gruppen = AND). buildFilters() vergibt positionsbasiert G1..Gn;
     buildFilter() solo nutzt "G_<feldname>" — bei MEHREREN Filtern aufs
     selbe Feld ohne eigene Labels zwingend buildFilters() verwenden,
     sonst landen sie ungewollt in derselben OR-Gruppe. */
  /* Einen Filter bauen.
     spec = { field, operator, value, dataType, isInclude, ignoreUnset, orLabels } */
  function buildFilter(spec, autoLabel) {
    if (!spec || !spec.field) throw new Error("AprikoFilters: 'field' fehlt");
    var op = spec.operator || "=";
    if (OPERATORS.indexOf(op) < 0) {
      throw new Error("AprikoFilters: unbekannter Operator '" + op +
        "' — erlaubt: " + OPERATORS.join(", "));
    }
    var isArr = Array.isArray(spec.value);
    if ((op === "ANY" || op === "!ANY") && !isArr) {
      throw new Error("AprikoFilters: Operator " + op + " verlangt ein Array als Wert (Feld '" + spec.field + "')");
    }
    var labels = spec.orLabels || [];
    if (!Array.isArray(labels)) labels = [labels];
    if (!labels.length) labels = [autoLabel || ("G_" + spec.field)];
    if (labels.some(function (l) { return /[|,]/.test(String(l)); })) {
      throw new Error("AprikoFilters: OR-Labels dürfen weder '|' noch ',' enthalten");
    }
    if (/\|/.test(String(spec.field))) {
      throw new Error("AprikoFilters: Feldname darf kein '|' enthalten");
    }
    return [
      spec.field,
      op,
      serializeValue(spec.value),
      normalizeDataType(spec.dataType),
      spec.isInclude === true ? "true" : "false",
      spec.ignoreUnset === true ? "true" : "false",
      JSON.stringify(labels)
    ].join("|");
  }

  /* Mehrere Filter bauen. Liefert ein Array von Pipe-Strings —
     für den POST-Body (QueryModel.filters ist EIN string) mit
     joinForBody() zusammenführen. */
  function buildFilters(specs) {
    return (specs || []).map(function (spec, i) { return buildFilter(spec, "G" + (i + 1)); });
  }

  /* OBSOLET (Schema-Irrtum, s. apriko-api.js): Der Server verlangt für
     filters/sortOptions/… Arrays — buildFilters()/buildSorts() direkt
     übergeben, AprikoApi sendet sie korrekt. joinForBody bleibt nur für
     Rückwärtskompatibilität erhalten. */
  function joinForBody(pipes) {
    if (!pipes) return "";
    if (typeof pipes === "string") return pipes;
    return pipes.join(",");
  }

  /* Sortier-Pipe: Feld|ASC/DESC|IstInclude — Schema-Beispiel: age|ASC|true */
  function buildSort(spec) {
    if (!spec || !spec.field) throw new Error("AprikoFilters: sort 'field' fehlt");
    var dir = String(spec.direction || "ASC").toUpperCase();
    if (dir !== "ASC" && dir !== "DESC") {
      throw new Error("AprikoFilters: Sortierrichtung '" + spec.direction + "' — erlaubt: ASC, DESC");
    }
    return [spec.field, dir, spec.isInclude === true ? "true" : "false"].join("|");
  }

  function buildSorts(specs) {
    return (specs || []).map(buildSort);
  }

  var api = {
    OPERATORS: OPERATORS.slice(),
    DATA_TYPES: DATA_TYPES.slice(),
    buildFilter: buildFilter,
    buildFilters: buildFilters,
    buildSort: buildSort,
    buildSorts: buildSorts,
    joinForBody: joinForBody,
    serializeValue: serializeValue
  };

  if (typeof window !== "undefined") window.AprikoFilters = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
