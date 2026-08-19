# Apriko Mini-CRM

Single-Page-CRM für den internen Gebrauch bei Apriko — eine einzige HTML-Datei
(`index.html`), gehostet auf GitHub Pages, mit SharePoint Lists als Backend.

**Live:** https://benleuz.github.io/apriko-crm/

## Architektur

- **Zwei Dateien**: `index.html` (~400 KB, eigener Code: HTML + CSS + JS) und
  `msal.js` (~370 KB, Vendor: @azure/msal-browser 2.38.3, ändert sich nie).
  Kein Build, kein Framework, keine weiteren Abhängigkeiten.
- **Backend**: SharePoint Lists im Apriko-Tenant (`/sites/sales2`) via Microsoft
  Graph API. Auth über MSAL (Azure AD SPA-Flow, Client-ID ist by design öffentlich).
- **Hosting**: GitHub Pages. Deployment = `index.html` im Repo ersetzen (PR-Merge).
  `msal.js` wird nur einmal deployt und danach nie mehr angefasst.

## Module

| Modul | Beschreibung |
|---|---|
| Dashboard | Übersicht: Pipeline, Aufgaben, Kennzahlen |
| Pipeline | Deals mit Phasen, Kunden-Zuordnung |
| Revenue | Monatsumsätze: Monatsabschluss- und Pro-Kunde-Modus |
| Statistiken | Umsatz-Auswertungen über Zeiträume, SVG-Charts, CSV-Export |
| Kunden / Firmen / Kontakte / Aufgaben | CRM-Stammdaten (SharePoint-Listen) |
| BPO Checkliste | Einsatzlisten-CSV → Payroll-Aufgaben (Demo, ohne Persist) |
| **Kundendashboard** | Einsatzlisten- und Margen-Analyse, komplett lokal im Browser (kein Upload). Zwei Tabs: Einsätze (Stichtag-KPIs, Vorjahresvergleich, Charts) und Marge (BM-Export-Auswertung, Kickback, Beteiligungs-Splits, Festvermittlungen) |
| Rapport | Arbeitsrapport-Erfassung mit OCR via Anthropic Claude API (eigener API-Key, lokal im Browser gespeichert) |

## Datenschutz

- **Kundendashboard**: CSVs werden ausschliesslich im Browser verarbeitet
  (`file.text()` → JS im Speicher). Kein Netzwerk-Call, keine Persistenz.
- **Rapport-OCR**: Beleg-Bilder gehen an `api.anthropic.com` (User-eigener Key).
- **CRM-Daten**: liegen in SharePoint im eigenen Microsoft-365-Tenant.

## Entwicklung

- Versions-Anzeige unten links (`#app-version`) — bei jedem Release erhöhen.
- JS-Syntax-Check: Script-Block extrahieren und `node --check` laufen lassen.
- Die Kundendashboard-Logik (Präfix `ed*` / `bm*`) ist in reinen Funktionen
  gehalten und lässt sich in Node mit DOM-Stubs testen (siehe Funktions-Kommentare).

## CSV-Formate (Kundendashboard)

Der Multi-Upload erkennt Dateitypen an den Headern:

| Typ | Erkennungs-Header |
|---|---|
| Einsatzliste | `Eintrittsdatum` + `GAV` |
| Margen-Export | `Placement Nr` + `Margenstufe` |
| Beteiligungen | `Anstellungsnummer` + `Beteiligung` |
| KickBack | `Debitor` + `Kickback` |

Zwei Einsatzlisten (oder eine Liste mit zwei Jahrgängen) aktivieren den
Vorjahresvergleich automatisch.
