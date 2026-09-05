# Apriko Mini-CRM — Projektstand (05.09.2026, v1.62.0)

## Live & Repo
- App: https://benleuz.github.io/apriko-crm/ · Demo: …/demo.html
- Repo: github.com/benleuz/apriko-crm (main). Dateien im Root:
  index.html, demo.html, msal.js, apriko-filters.js, apriko-api.js,
  lohncheck.js, codespace-proxy.js, .devcontainer/devcontainer.json
- Version in der Fusszeile (#app-version) — bei jedem Deploy erhöhen,
  inkl. ?v=-Cache-Busting der Script-Tags; demo.html = Kopie mit
  DEMO_ANON=true, DEMO-Badge, fester redirectUri.

## Apriko-API-Anbindung (POC)
- Client: apriko-api.js (AprikoApi.configure({gateway, target, getToken}),
  16 Service-Registry, Fehlerarten gateway-unreachable/upstream-unreachable/
  auth/business, selfTest = 3 Ampeln) + apriko-filters.js (Pipe-Filter).
- Proxy: GitHub-Codespace, Port 8787 public, Auto-Start via
  .devcontainer (APRIKO_BASES=https://worknet.apriko.app,https://sales.apriko.app —
  worknet = Standard; Ziel wählbar per Header X-Apriko-Target, Allowlist).
  Weck-Routine: Codespace öffnen → 1 Min warten → im CRM «Speichern & testen».
  Alternativen bereit: apriko-api-proxy-deno.js (Deno Deploy) /
  Worker-Variante / CORS-Freigabe durchs Apriko-Dev-Team (Ziellösung).
- Token-Fehler v1.59: /connect/token liefert HTTP 405 (nginx-HTML) → falsche
  Token-URL, Zugangsdaten wurden nie geprüft. Nächster Schritt: token_endpoint
  aus /.well-known/openid-configuration mit der Request-URL im Network-Tab
  vergleichen; Client soll Discovery-Endpoint übernehmen statt
  ${target}/connect/token zu bauen; HTML/404/405-Antworten nicht als «auth»
  klassifizieren; aufgelöste Token-URL im Chip anzeigen.
- Zugang: OAuth Password-Grant — API-Benutzer + Passwort im Rapport-DB-Block,
  Tool holt/erneuert Token selbst (Discovery → /connect/token).
  Offen: verlangt der Identity-Server eine client_id/scope? (Team fragen)

## Empirisch belegte Doku-Abweichungen (für Meldung ans Apriko-Team)
1. QueryModel entityTypes/filters/sortOptions/boosts/includes sind
   Collections (Arrays), nicht Strings (400 IReadOnlyCollection-Fehler).
2. Filter-Gruppe (Pipe-Position 7) ist Pflicht («Group value has to be set»).
3. Gruppe muss JSON-Array sein: ["G1"] («Unexpected character … value: G»).
4. Wert-Serialisierung (Pos. 3) noch offen — Client probiert json/raw/rawlower,
   merkt Erfolg in localStorage 'apriko-filter-format' und zeigt ihn in der
   grauen Fusszeile des Abgleich-Kastens. Gemeldeten Wert im Code fixieren.

## Rapport-Modul (Kern des POC)
- Oben: «Apriko-Datenbank für den Einsatz-Abgleich» (Gateway, Instanz,
  API-Benutzer/-Passwort, Ampel-Selbsttest beim Öffnen und Speichern).
- Nach OCR: rpApiMatch → Mitarbeiter-Dropdown (Volltext, tolerant) →
  Einsatz-Dropdown (alle Einsätze, passendste zuerst, ✓ Kunde /
  ⚠ ausserhalb Zeitraum) → GAV-Vergleich, Konditionen, Zulagen/Spesen.
- Test offen: Hans-Dieter Janoff / Jean Cron AG in worknet — Dropdowns
  und Serialisierungs-Fusszeile noch nie erfolgreich durchgelaufen
  (zuletzt am schlafenden Codespace gescheitert).

## Ultimativer Check (Spielwiese, neu v1.60.0, Stand v1.62.0, lohncheck.js; zeigt eigene
  Versionsnummer LC_VERSION in der Fusszeile des Kastens)
- Upload vieler Lohnabrechnungs-PDFs → Abrechnung beginnt je Seite mit
  «Lohn und Zulagen»; alle Lohnarten 1000–9999 (Bereich einstellbar) per
  Spaltenraster Basis/Ansatz/Anzahl/Betrag erfasst, Einrückung = Bestandteil
  (1000/1160/1161/1200 unter 1005).
- Mitarbeiter-Erkennung aus Kopfzeilen: AHV-Nr 756.…, Personal-Nr, Name
  (Zeile vor Strasse/PLZ), Periode «Monat Jahr». Kopfzeilen im Detail-Modal
  sichtbar zum Nachschärfen — noch nie an echtem Apriko-PDF getestet.
- Tabs: Lohnkontoblatt (Totale je Lohnart), Differenzen (rot/gelb/grau),
  Mitarbeitende; CSV-Export je Tab.
- Prüfungen: Summe Lohnarten=4900, Summe Abzüge=5500, 4900+5500=5900,
  Basis×Ansatz(×Anzahl)=Betrag, Pflichtabzüge AHV/ALV (rot) NBU/KTG/BVG/
  Vollzug (gelb), AHV 5.3 %/ALV 1.1 % Referenzsätze, Abzugsbasis ≠ Brutto
  minus 36xx (nicht pflichtig), Satz weicht vom häufigsten ab (BVG ausgenommen,
  altersabhängig), Ferien/Feiertag/13. ML bei Stundenlohn,
  Sonstige=6500, Netto+Sonstige=6900, Rückbehalte 8000–8499=8500,
  6900+8500=8900 Auszahlung, 8020 Ferienrückbehalt=−1160, Anzahl 6390-
  Gebühren = Anzahl 8105-Vorschüsse, doppelte Abrechnung (gleicher MA + Periode).

## Weitere offene Punkte
- Ultimativer Check mit echtem Lohnlauf-PDF testen; Erkennung Name/Periode
  anhand der Kopfzeilen anpassen; Referenzsätze/Pflichtabzüge feinjustieren.
- LegalPerson-type-Diskriminator vor erstem Firmen-Create per GET ablesen.
- CORS-Anfrage + Doku-Meldung ans Apriko-Dev-Team formulieren (auf Zuruf).
- 2025er-Jahresabschlüsse importieren; Views für Nicht-Super-Admins;
  Vertragsdokumente warten auf .dotx-Vorlagen.
