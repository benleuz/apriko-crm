/* ============ Ultimativer Check (Spielwiese) ============
   Lohnabrechnungen (PDF, viele Seiten, mehrere Dateien) einlesen,
   alle Lohnarten im Bereich [von, bis] pro Abrechnung erfassen,
   über alles totalisieren (Lohnkontoblatt) und Plausibilitäts-
   Differenzen ausweisen (fehlende Abzüge, Rechenfehler, Satz-
   abweichungen, Doppelte, …).

   Abhängigkeiten aus index.html: kaLoadPdfJs(), render(), toast(),
   escape(), showModal(), closeModal(), kaNum().
   Erkennung ist bewusst tolerant/heuristisch — Kopfzeilen jeder
   Abrechnung sind im Detail-Modal sichtbar, damit die Erkennung
   iterativ nachgeschärft werden kann. */

const LC_VERSION = "1.64.0";
const lcState = {
  von: 1000, bis: 9999,
  slips: [],          // [{id, file, pages:[], name, key, ahv, persNr, periode, rows:[], header:[], issues:[]}]
  issues: [],
  files: [],
  tab: "konto",       // konto | diff | ma
  sev: "all",         // all | rot | gelb | grau
  open: {},           // aufgeklappte Mitarbeitende in der Differenzen-Ansicht (key → true)
  busy: false
};

/* ---------- Referenzwerte (Stand 2026, anpassbar) ---------- */
const LC_REF = {
  AHV: { codes: [5010], key: /\bAHV\b/i, satz: 5.3, pflicht: "rot" },
  ALV: { codes: [5020], key: /\bALV\b/i, satz: 1.1, pflicht: "rot" },
  NBU: { codes: [5050], key: /\bNBU\b/i, satz: null, pflicht: "gelb" },
  KTG: { codes: [5080], key: /\bKTG\b/i, satz: null, pflicht: "gelb" },
  BVG: { codes: [5090], key: /\bBVG\b/i, satz: null, pflicht: "gelb" },
  VOLLZUG: { codes: [5120], key: /Vollzug/i, satz: null, pflicht: "gelb" }
};
/* Nicht sozialversicherungspflichtige Lohnarten (z.B. Spesen 36xx) — fliessen nicht in die AHV/ALV/NBU/KTG-Basis */
const LC_NICHT_PFLICHTIG = code => code >= 3600 && code <= 3699;
const LC_TOTAL_CODES = new Set([4900, 5500, 5900, 6500, 6900, 7900, 8900, 9900]);
const LC_MONATE = "Januar Februar März April Mai Juni Juli August September Oktober November Dezember".split(" ");

/* ---------- Zahlen / Formatierung ---------- */
function lcNum(s) {
  let t = String(s == null ? "" : s).trim();
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (/^[-–−]/.test(t)) { neg = true; t = t.replace(/^[-–−]\s*/, ""); }
  t = t.replace(/['’\u00a0\s]/g, "");
  const pct = /%$/.test(t);
  t = t.replace("%", "");
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, "");
  else t = t.replace(/,/g, ".");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const v = parseFloat(t);
  if (isNaN(v)) return null;
  return { v: neg ? -v : v, pct };
}
function lcIsNumTok(s) { return lcNum(s) !== null && /\d/.test(String(s)); }
function lcFmt(v, dec) {
  if (v === null || v === undefined || isNaN(v)) return "—";
  return v.toLocaleString("de-CH", { minimumFractionDigits: dec == null ? 2 : dec, maximumFractionDigits: dec == null ? 2 : dec });
}
function lcFmtPct(v) { return v === null || v === undefined ? "—" : (Math.round(v * 10000) / 10000).toString().replace(".", ".") + "%"; }
function lcNear(a, b, tol) { return Math.abs(a - b) <= (tol == null ? 0.051 : tol); }

/* ---------- PDF → Zeilen mit Positionen ---------- */
async function lcReadPdf(ab) {
  await kaLoadPdfJs();
  const doc = await window.pdfjsLib.getDocument({ data: ab }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    let items = [];
    for (const i of tc.items) {
      const s = String(i.str || "");
      if (!s.trim()) continue;
      const x = i.transform[4], y = i.transform[5], w = i.width || 0;
      // Zeile als EIN Text-Item? → in Tokens aufteilen, x proportional schätzen
      const toks = s.split(/\s+/).filter(Boolean);
      const numToks = toks.filter(lcIsNumTok).length;
      if (toks.length >= 2 && numToks >= 1 && /\s{2,}/.test(s)) {
        let pos = 0;
        for (const t of toks) {
          const idx = s.indexOf(t, pos);
          items.push({ s: t, x: x + w * idx / s.length, y, w: w * t.length / s.length });
          pos = idx + t.length;
        }
      } else items.push({ s, x, y, w });
    }
    pages.push({ n: p, width: vp.width, lines: lcItemsToLines(items) });
  }
  return pages;
}
function lcItemsToLines(items) {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  let cur = null, curY = null;
  for (const i of sorted) {
    if (curY === null || Math.abs(i.y - curY) > 2.5) { cur = { y: i.y, items: [] }; lines.push(cur); curY = i.y; }
    cur.items.push(i);
  }
  lines.forEach(l => {
    l.items.sort((a, b) => a.x - b.x);
    l.text = l.items.map(i => i.s.trim()).join(" ").replace(/\s+/g, " ").trim();
    l.x = l.items[0].x;
  });
  return lines;
}

/* ---------- Seiten → Abrechnungen ---------- */
function lcSplitSlips(pages, fileName) {
  const slips = [];
  let cur = null;
  const isStart = pg => pg.lines.some(l => /^Lohn und Zulagen\b/i.test(l.text));
  for (const pg of pages) {
    if (isStart(pg) || !cur) {
      cur = { id: slips.length + 1, file: fileName, pages: [], rows: [], header: [], issues: [] };
      slips.push(cur);
    }
    cur.pages.push(pg);
  }
  slips.forEach(s => { lcParseSlip(s); });
  // Seiten ohne Lohnarten (Deckblatt o.ä.) verwerfen
  return slips.filter(s => s.rows.length);
}

function lcColumns(page) {
  // Kopfzeile "Basis Ansatz Anzahl Betrag" → rechte Kanten
  for (const l of page.lines) {
    const it = l.items;
    const f = re => it.find(i => re.test(i.s.trim()));
    const basis = f(/^Basis$/i), ansatz = f(/^Ansatz$/i), anzahl = f(/^Anzahl$/i), betrag = f(/^Betrag$/i);
    if (betrag && (basis || ansatz || anzahl)) {
      const edge = i => i ? i.x + i.w : null;
      return { basis: edge(basis), ansatz: edge(ansatz), anzahl: edge(anzahl), betrag: edge(betrag),
        labelMax: (basis || ansatz || anzahl || betrag).x - 12 };
    }
  }
  return null;
}

function lcParseSlip(slip) {
  const first = slip.pages[0];
  // Kopfzeilen = alles vor "Lohn und Zulagen" auf der ersten Seite
  const startIdx = first.lines.findIndex(l => /^Lohn und Zulagen\b/i.test(l.text));
  slip.header = first.lines.slice(0, startIdx < 0 ? Math.min(25, first.lines.length) : startIdx).map(l => l.text);
  lcIdentify(slip);

  let cols = null, codeXs = [];
  for (const pg of slip.pages) {
    cols = lcColumns(pg) || cols;
    const tol = pg.width * 0.045;
    for (const l of pg.lines) {
      const m = /^(\d{4})\b\s*(.*)$/.exec(l.text);
      if (!m) continue;
      const code = parseInt(m[1], 10);
      if (code < lcState.von || code > lcState.bis) continue;
      const codeItem = l.items[0];
      if (!/^\d{4}\b/.test(codeItem.s.trim())) continue;
      // Tokens klassifizieren
      let basis = null, ansatz = null, anzahl = null, betrag = null;
      const labelParts = [];
      const nums = [];
      l.items.forEach((it, k) => {
        if (k === 0) { const rest = it.s.trim().replace(/^\d{4}\s*/, ""); if (rest) labelParts.push(rest); return; }
        const n = lcNum(it.s);
        const edge = it.x + it.w;
        let col = null;
        if (n !== null && cols) {
          let bd = Infinity;
          for (const c of ["basis", "ansatz", "anzahl", "betrag"]) {
            if (cols[c] == null) continue;
            const d = Math.abs(edge - cols[c]);
            if (d < bd && d <= tol) { bd = d; col = c; }
          }
        }
        if (col) {
          if (col === "basis") basis = n.v; else if (col === "ansatz") ansatz = n.v; else if (col === "anzahl") anzahl = n.v; else betrag = n.v;
          if (n.pct && col === "ansatz") ansatz = n.v;
          nums.push(n);
        } else if (n !== null && (!cols || it.x > cols.labelMax)) {
          nums.push(n); // ohne Spaltenraster → Position später per Regel
        } else labelParts.push(it.s.trim());
      });
      if (betrag === null && nums.length) {
        // Fallback ohne Spaltenraster: letzte Zahl = Betrag, %-Zahl = Ansatz, erste = Basis, Rest = Anzahl
        const rest = nums.slice();
        betrag = rest.pop().v;
        const pIdx = rest.findIndex(n => n.pct);
        if (pIdx >= 0) { ansatz = rest[pIdx].v; rest.splice(pIdx, 1); }
        if (rest.length >= 1) basis = rest[0].v;
        if (rest.length >= 2) anzahl = rest[1].v;
      }
      if (betrag === null) continue;
      const label = labelParts.join(" ").replace(/\s+/g, " ").trim();
      codeXs.push(codeItem.x);
      slip.rows.push({ code, label, basis, ansatz, anzahl, betrag, x: codeItem.x, page: pg.n,
        isTotal: LC_TOTAL_CODES.has(code) || /^Total\b|^Bruttolohn$|^Nettolohn$|^Abgerechnet$/i.test(label) });
    }
  }
  // Einrückung → Unterpositionen (Bestandteile, z.B. 1000/1160/1161/1200 unter 1005)
  if (codeXs.length) {
    const minX = Math.min(...codeXs);
    slip.rows.forEach(r => { r.level = r.x - minX > 6 ? 1 : 0; });
  }
  // Kennzahlen
  const g = c => { const r = slip.rows.find(x => x.code === c); return r ? r.betrag : null; };
  slip.brutto = g(4900); slip.abzuege = g(5500); slip.netto = g(5900); slip.sonstige = g(6500); slip.abgerechnet = g(6900);
  slip.rueckbehalt = g(8500);
  const ausz = slip.rows.find(x => x.code === 8900) || slip.rows.find(x => x.code > 6900 && /^Auszahlung$/i.test(x.label));
  slip.auszahlung = ausz ? ausz.betrag : null;
  if (slip.brutto === null) { const r = slip.rows.find(x => /^Bruttolohn/i.test(x.label)); if (r) slip.brutto = r.betrag; }
  if (slip.netto === null) { const r = slip.rows.find(x => /^Nettolohn/i.test(x.label)); if (r) slip.netto = r.betrag; }
}

function lcIdentify(slip) {
  const H = slip.header;
  const all = H.join(" \n ");
  const ahv = (all.match(/756[.\s]?\d{4}[.\s]?\d{4}[.\s]?\d{2}/) || [])[0];
  slip.ahv = ahv ? ahv.replace(/\s/g, "") : null;
  const pm = /(?:Personal|Pers\.?|Mitarbeiter|MA)[- ]?(?:Nr|Nummer)\.?\s*:?\s*(\d{2,8})/i.exec(all);
  slip.persNr = pm ? pm[1] : null;
  // Periode: "August 2026" bevorzugt, sonst Datumsspanne
  let per = null;
  for (const l of H) {
    const m = new RegExp("(" + LC_MONATE.join("|") + ")\\s+(20\\d{2})", "i").exec(l);
    if (m) { per = m[1] + " " + m[2]; break; }
  }
  if (!per) { const m = /(\d{2}\.\d{2}\.\d{4})\s*[-–]\s*(\d{2}\.\d{2}\.\d{4})/.exec(all); if (m) per = m[1] + " – " + m[2]; }
  if (!per) { const m = /(\d{2})\.(\d{4})\b/.exec(all); if (m) per = LC_MONATE[parseInt(m[1], 10) - 1] + " " + m[2]; }
  slip.periode = per || "?";
  // Name: Zeile vor Strasse+PLZ-Block, sonst erste "namensartige" Zeile
  const bad = /\b(AG|GmbH|SA|Sàrl|Apriko|Lohnabrechnung|Lohnausweis|Seite|Tel|Fax|www\.|@|Strasse|Str\.|Weg|Platz|Gasse|IBAN|Bank|Konto|Eintritt|Austritt|Personal|Abrechnung|Zahlung|Datum)\b/i;
  const clean = s => s.replace(/^(Herr|Frau|Herrn|Monsieur|Madame|Mr\.?|Mrs\.?)\s+/i, "").trim();
  const nameLike = s => { const t = clean(s); return t.length >= 4 && t.length <= 60 && !/\d/.test(t) && !bad.test(t) && /^[A-ZÄÖÜÉÈ][\wÄÖÜäöüéèàç'.-]+(\s+[A-ZÄÖÜÉÈ(][\wÄÖÜäöüéèàç'.()-]*){1,4}$/.test(t); };
  let name = null;
  const plzIdx = H.findIndex(l => /^(CH-)?\d{4}\s+[A-ZÄÖÜ]/.test(l.trim()));
  if (plzIdx >= 1) {
    for (let k = plzIdx - 1; k >= Math.max(0, plzIdx - 4); k--) { if (nameLike(H[k])) { name = clean(H[k]); break; } }
  }
  if (!name) { const c = H.find(nameLike); if (c) name = clean(c); }
  slip.name = name;
  slip.key = slip.ahv || (slip.persNr ? "P" + slip.persNr : null) || (name ? name.toLowerCase() : null) || ("Abrechnung #" + slip.id);
  slip.anzeige = name || (slip.persNr ? "Pers.-Nr. " + slip.persNr : null) || slip.ahv || ("Abrechnung #" + slip.id);
}

/* ---------- Plausibilitätsprüfung ---------- */
function lcCheckAll(slips) {
  const issues = [];
  const add = (slip, sev, pruef, text) => { const i = { sev, pruef, text, slipId: slip.id, ma: slip.anzeige, key: slip.key, periode: slip.periode }; issues.push(i); slip.issues.push(i); };
  // Häufigster Ansatz je Abzugscode (über alle Abrechnungen) als Referenz
  const satzMode = {};
  const cnt = {};
  slips.forEach(s => s.rows.forEach(r => { if (r.code >= 5000 && r.code < 5500 && r.ansatz !== null) { const k = r.code + "|" + r.ansatz; cnt[k] = (cnt[k] || 0) + 1; } }));
  Object.keys(cnt).forEach(k => { const [c, a] = k.split("|"); if (!satzMode[c] || cnt[k] > satzMode[c].n) satzMode[c] = { satz: parseFloat(a), n: cnt[k] }; });

  const seen = {};
  for (const s of slips) {
    s.issues = [];
    const lohn = s.rows.filter(r => r.code < 4900 && !r.isTotal && r.level === 0);
    const abz = s.rows.filter(r => r.code >= 5000 && r.code < 5500 && !r.isTotal);
    if (!s.name) add(s, "grau", "Erkennung", "Kein Mitarbeitername erkannt — Kopfzeilen im Detail prüfen.");
    if (s.periode === "?") add(s, "grau", "Erkennung", "Keine Abrechnungsperiode erkannt.");
    // Doppelte
    const dk = s.key + "|" + s.periode;
    if (seen[dk]) add(s, "rot", "Doppelt", "Zweite Abrechnung für dieselbe Periode (Abrechnung #" + seen[dk] + ").");
    else seen[dk] = s.id;
    // Rechenkontrollen
    if (s.brutto !== null) {
      const sum = lohn.reduce((a, r) => a + r.betrag, 0);
      if (lohn.length && !lcNear(sum, s.brutto)) add(s, "rot", "Rechnung", "Summe Lohnarten " + lcFmt(sum) + " ≠ Bruttolohn " + lcFmt(s.brutto) + " (Δ " + lcFmt(sum - s.brutto) + ").");
      if (s.brutto < 0) add(s, "rot", "Bruttolohn", "Negativer Bruttolohn " + lcFmt(s.brutto) + ".");
      if (s.brutto === 0) add(s, "gelb", "Bruttolohn", "Bruttolohn ist 0.");
    } else add(s, "gelb", "Erkennung", "Kein Bruttolohn (4900) gefunden.");
    if (s.abzuege !== null && abz.length) {
      const sum = abz.reduce((a, r) => a + r.betrag, 0);
      if (!lcNear(sum, s.abzuege)) add(s, "rot", "Rechnung", "Summe Abzüge " + lcFmt(sum) + " ≠ Total Abzüge " + lcFmt(s.abzuege) + ".");
    }
    if (s.brutto !== null && s.abzuege !== null && s.netto !== null && !lcNear(s.brutto + s.abzuege, s.netto))
      add(s, "rot", "Rechnung", "Brutto + Abzüge = " + lcFmt(s.brutto + s.abzuege) + " ≠ Nettolohn " + lcFmt(s.netto) + ".");
    if (s.netto !== null && s.netto < 0) add(s, "rot", "Nettolohn", "Negativer Nettolohn " + lcFmt(s.netto) + ".");
    // Sonstige Zulagen/Abzüge (6000–6499) → 6500 → 6900 Abgerechnet → Auszahlung
    const sonst = s.rows.filter(r => r.code >= 6000 && r.code < 6500 && !r.isTotal);
    if (s.sonstige !== null && sonst.length) {
      const sum = sonst.reduce((a, r) => a + r.betrag, 0);
      if (!lcNear(sum, s.sonstige)) add(s, "rot", "Rechnung", "Summe sonstige Zulagen/Abzüge " + lcFmt(sum) + " ≠ Total 6500 " + lcFmt(s.sonstige) + ".");
    }
    const sonstTot = s.sonstige !== null ? s.sonstige : sonst.reduce((a, r) => a + r.betrag, 0);
    if (s.netto !== null && s.abgerechnet !== null && !lcNear(s.netto + sonstTot, s.abgerechnet))
      add(s, "rot", "Rechnung", "Netto + Sonstige = " + lcFmt(s.netto + sonstTot) + " ≠ Abgerechnet " + lcFmt(s.abgerechnet) + ".");
    if (s.abgerechnet !== null && s.abgerechnet < 0) add(s, "rot", "Abgerechnet", "Negativer Abrechnungsbetrag " + lcFmt(s.abgerechnet) + ".");
    // Rückbehalte und Zahlungen (8000–8499) → 8500 → 6900 + 8500 = 8900 Auszahlung
    const rueck = s.rows.filter(r => r.code >= 8000 && r.code < 8500 && !r.isTotal);
    const rueckTot = s.rueckbehalt !== null ? s.rueckbehalt : rueck.reduce((a, r) => a + r.betrag, 0);
    if (s.rueckbehalt !== null && rueck.length) {
      const sum = rueck.reduce((a, r) => a + r.betrag, 0);
      if (!lcNear(sum, s.rueckbehalt)) add(s, "rot", "Rechnung", "Summe Rückbehalte/Zahlungen " + lcFmt(sum) + " ≠ Total 8500 " + lcFmt(s.rueckbehalt) + ".");
    }
    if (s.abgerechnet !== null && s.auszahlung !== null && !lcNear(s.abgerechnet + rueckTot, s.auszahlung))
      add(s, "rot", "Auszahlung", "Abgerechnet " + lcFmt(s.abgerechnet) + " + Rückbehalte/Zahlungen " + lcFmt(rueckTot) + " = " + lcFmt(s.abgerechnet + rueckTot) + " ≠ Auszahlung " + lcFmt(s.auszahlung) + ".");
    if (s.auszahlung !== null && s.auszahlung < 0) add(s, "rot", "Auszahlung", "Negative Auszahlung " + lcFmt(s.auszahlung) + ".");
    if (s.abgerechnet !== null && s.auszahlung === null) add(s, "grau", "Auszahlung", "Keine Auszahlungszeile (8900) erkannt.");
    // Ferienrückbehalt (8020) sollte der Ferienvergütung (1160) entsprechen
    const ferien = s.rows.find(r => r.code === 1160 || (/Ferienvergütung/i.test(r.label) && r.code < 4900));
    const ferienRb = s.rows.find(r => r.code === 8020 || /Ferienrückbehalt/i.test(r.label));
    if (ferien && ferienRb && !lcNear(ferien.betrag + ferienRb.betrag, 0))
      add(s, "gelb", "Ferienrückbehalt", "Ferienrückbehalt " + lcFmt(ferienRb.betrag) + " ≠ Ferienvergütung " + lcFmt(ferien.betrag) + ".");
    // Anzahl Vorschussgebühren (6390) vs. Anzahl Vorschüsse (8105)
    const vorschuesse = s.rows.filter(r => r.code === 8105 || (/^Vorschuss\b/i.test(r.label) && r.code >= 8000 && r.code < 8500));
    const gebuehr = s.rows.find(r => r.code === 6390 || /Vorschussgebühr/i.test(r.label));
    if (vorschuesse.length && gebuehr && gebuehr.anzahl !== null && !lcNear(gebuehr.anzahl, vorschuesse.length))
      add(s, "gelb", "Vorschuss", vorschuesse.length + " Vorschüsse, aber " + lcFmt(gebuehr.anzahl) + " Vorschussgebühren verrechnet.");
    if (vorschuesse.length && !gebuehr) add(s, "gelb", "Vorschuss", vorschuesse.length + " Vorschüsse ohne Vorschussgebühr (6390).");
    // Basis × Ansatz = Betrag
    for (const r of s.rows) {
      if (r.isTotal || r.basis === null || r.ansatz === null) continue;
      const exp = r.basis * r.ansatz / 100 * (r.anzahl !== null && r.anzahl !== 0 ? r.anzahl : 1);
      if (!lcNear(Math.abs(exp), Math.abs(r.betrag), Math.max(0.06, Math.abs(exp) * 0.002)))
        add(s, "gelb", "Rechnung", r.code + " " + r.label + ": Basis × Ansatz" + (r.anzahl ? " × Anzahl" : "") + " = " + lcFmt(exp) + ", Betrag " + lcFmt(r.betrag) + ".");
    }
    // Pflichtabzüge — Basis = Bruttolohn abzüglich nicht pflichtiger Lohnarten (36xx)
    if (s.brutto !== null && s.brutto > 0) {
      const nichtPflichtig = s.rows.filter(r => LC_NICHT_PFLICHTIG(r.code) && !r.isTotal && r.level === 0).reduce((a, r) => a + r.betrag, 0);
      const svBasis = s.brutto - nichtPflichtig;
      // AHV-Freibetrag Rentner (CHF 1'400/Monat): AHV-Basis = ALV-Basis − 1'400
      const ahvRow = abz.find(r => r.code === 5010) || abz.find(r => LC_REF.AHV.key.test(r.label));
      const alvRow = abz.find(r => r.code === 5020) || abz.find(r => LC_REF.ALV.key.test(r.label));
      const rentner = ahvRow && alvRow && ahvRow.basis !== null && alvRow.basis !== null && lcNear(alvRow.basis - ahvRow.basis, 1400);
      if (rentner) add(s, "grau", "Rentner?", "AHV-Basis " + lcFmt(ahvRow.basis) + " = ALV-Basis " + lcFmt(alvRow.basis) + " − 1'400.00 → AHV-Freibetrag, Rentner/in?");
      for (const [nm, ref] of Object.entries(LC_REF)) {
        const row = abz.find(r => ref.codes.includes(r.code)) || abz.find(r => ref.key.test(r.label));
        if (!row) { add(s, ref.pflicht, "Abzug fehlt", "Kein " + nm + "-Abzug (" + ref.codes.join("/") + ") bei Bruttolohn " + lcFmt(s.brutto) + "."); continue; }
        if (row.betrag === 0) add(s, ref.pflicht, "Abzug 0", nm + "-Abzug vorhanden, aber Betrag 0.");
        if (row.betrag > 0) add(s, "gelb", "Vorzeichen", nm + "-Abzug ist positiv (" + lcFmt(row.betrag) + ").");
        if (ref.satz !== null && row.ansatz !== null && !lcNear(row.ansatz, ref.satz, 0.0001))
          add(s, "rot", "Satz", nm + "-Satz " + lcFmtPct(row.ansatz) + " statt " + lcFmtPct(ref.satz) + ".");
        if (nm === "AHV" && rentner) continue;
        if (nm !== "BVG" && row.basis !== null && !lcNear(row.basis, svBasis))
          add(s, "gelb", "Basis", nm + "-Basis " + lcFmt(row.basis) + " ≠ pflichtiger Lohn " + lcFmt(svBasis) + (nichtPflichtig ? " (Brutto " + lcFmt(s.brutto) + " − 36xx " + lcFmt(nichtPflichtig) + ")" : "") + ".");
      }
    }
    // Satz weicht vom häufigsten Satz ab (Abzüge 5000–5499; BVG ausgenommen — Satz ist altersabhängig)
    for (const r of abz) {
      const m = satzMode[r.code];
      if (LC_REF.BVG.codes.includes(r.code) || LC_REF.BVG.key.test(r.label)) continue;
      if (m && r.ansatz !== null && m.n >= 3 && !lcNear(r.ansatz, m.satz, 0.0001) && !Object.values(LC_REF).some(ref => ref.codes.includes(r.code) && ref.satz !== null))
        add(s, "gelb", "Satz", r.code + " " + r.label + ": " + lcFmtPct(r.ansatz) + ", üblich " + lcFmtPct(m.satz) + " (" + m.n + "×).");
    }
    // Temporär-Bestandteile bei Stundenlohn
    const hasStd = s.rows.some(r => r.code === 1005 || /Stundenlohn/i.test(r.label));
    if (hasStd) {
      const need = [[/Ferien/i, "Ferienvergütung"], [/Feiertag/i, "Feiertagsentschädigung"], [/13\.\s*Monat/i, "13. Monatslohn"]];
      need.forEach(([re, nm]) => { if (!s.rows.some(r => re.test(r.label) && r.code < 4900)) add(s, "gelb", "Bestandteil fehlt", nm + " fehlt bei Stundenlohn."); });
    }
  }
  const order = { rot: 0, gelb: 1, grau: 2 };
  issues.sort((a, b) => order[a.sev] - order[b.sev] || a.ma.localeCompare(b.ma, "de") || a.periode.localeCompare(b.periode));
  return issues;
}

/* ---------- Totalisierung ---------- */
function lcKonto(slips) {
  const map = {};
  for (const s of slips) for (const r of s.rows) {
    const k = r.code + "|" + r.label.toLowerCase().replace(/\s*\(.*?\)\s*/g, " ").trim();
    let e = map[k];
    if (!e) e = map[k] = { code: r.code, label: r.label.replace(/\s*\(\d+(\.\d+)?\s*%\)\s*$/, ""), n: 0, anzahl: 0, hasAnzahl: false, betrag: 0, isTotal: r.isTotal, level: r.level || 0, ma: new Set(), saetze: {} };
    e.n++; e.betrag += r.betrag; e.ma.add(s.key);
    if (r.anzahl !== null) { e.anzahl += r.anzahl; e.hasAnzahl = true; }
    if (r.ansatz !== null) e.saetze[r.ansatz] = (e.saetze[r.ansatz] || 0) + 1;
    if (r.level === 1) e.level = 1;
  }
  return Object.values(map).sort((a, b) => a.code - b.code || a.label.localeCompare(b.label, "de"));
}

/* ---------- Upload ---------- */
async function lcUpload(input) {
  const files = [...(input.files || [])].sort((a, b) => a.name.localeCompare(b.name, "de", { numeric: true }));
  input.value = "";
  if (!files.length) return;
  lcState.busy = true; render();
  try {
    let idx = 0;
    for (const file of files) {
      idx++;
      if (!/\.pdf$/i.test(file.name)) { toast(file.name + ": nur PDF wird unterstützt", true); continue; }
      toast("PDF wird gelesen (" + idx + "/" + files.length + "): " + file.name + " …");
      const pages = await lcReadPdf(await file.arrayBuffer());
      const slips = lcSplitSlips(pages, file.name);
      slips.forEach(s => { s.id = lcState.slips.length + 1; lcState.slips.push(s); });
      lcState.files.push(file.name + " (" + pages.length + " S., " + slips.length + " Abr.)");
    }
    lcState.issues = lcCheckAll(lcState.slips);
    lcState.busy = false;
    render();
    toast(lcState.slips.length + " Abrechnungen erkannt · " + lcState.issues.filter(i => i.sev === "rot").length + " rote / " + lcState.issues.filter(i => i.sev === "gelb").length + " gelbe Hinweise");
  } catch (e) {
    lcState.busy = false; render();
    toast("Import fehlgeschlagen: " + e.message, true);
  }
}
function lcReset() { lcState.slips = []; lcState.issues = []; lcState.files = []; lcState.open = {}; render(); }
function lcRange(von, bis) {
  lcState.von = parseInt(von, 10) || 1000; lcState.bis = parseInt(bis, 10) || 6000;
  // Zeilen neu filtern: Abrechnungen neu parsen wäre nötig — Rows sind bereits mit altem Bereich erfasst,
  // deshalb Hinweis anzeigen. Bereich wirkt beim nächsten Upload.
  toast("Bereich " + lcState.von + "–" + lcState.bis + " gilt für den nächsten Upload.");
}

/* ---------- Export ---------- */
function lcCsv(rows) {
  const q = v => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  const csv = rows.map(r => r.map(q).join(";")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }));
  a.download = "lohnkontoblatt.csv"; a.click();
}
function lcExport() {
  if (lcState.tab === "diff") {
    lcCsv([["Schwere", "Mitarbeiter", "Periode", "Prüfung", "Meldung"], ...lcState.issues.map(i => [i.sev, i.ma, i.periode, i.pruef, i.text])]);
  } else if (lcState.tab === "ma") {
    lcCsv([["Mitarbeiter", "AHV-Nr", "Pers.-Nr", "Abrechnungen", "Bruttolohn", "Nettolohn", "Hinweise"], ...lcEmployees().map(m => [m.name, m.ahv, m.persNr, m.n, m.brutto.toFixed(2), m.netto.toFixed(2), m.rot + m.gelb])]);
  } else {
    lcCsv([["Code", "Lohnart", "Belege", "Mitarbeiter", "Anzahl", "Betrag"], ...lcKonto(lcState.slips).map(e => [e.code, e.label, e.n, e.ma.size, e.hasAnzahl ? e.anzahl.toFixed(2) : "", e.betrag.toFixed(2)])]);
  }
}

/* ---------- Aggregation Mitarbeiter ---------- */
function lcEmployees() {
  const m = {};
  for (const s of lcState.slips) {
    let e = m[s.key];
    if (!e) e = m[s.key] = { key: s.key, name: s.anzeige, ahv: s.ahv || "", persNr: s.persNr || "", n: 0, brutto: 0, netto: 0, rot: 0, gelb: 0, slips: [] };
    e.n++; e.brutto += s.brutto || 0; e.netto += s.netto || 0; e.slips.push(s);
    s.issues.forEach(i => { if (i.sev === "rot") e.rot++; else if (i.sev === "gelb") e.gelb++; });
  }
  return Object.values(m).sort((a, b) => a.name.localeCompare(b.name, "de"));
}

/* ---------- Rendering ---------- */
function lcSevBadge(sev) {
  const c = sev === "rot" ? "var(--danger)" : sev === "gelb" ? "var(--warn)" : "var(--text-faint)";
  return `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${c};margin-right:6px;vertical-align:middle"></span>`;
}
function renderLohncheck(el) {
  document.getElementById("view-actions").innerHTML = `
    <label class="btn btn-sm" style="cursor:pointer">⇪ Lohnabrechnungen (PDF)
      <input type="file" accept=".pdf" multiple style="display:none" onchange="lcUpload(this)"></label>
    ${lcState.slips.length ? `<button class="btn btn-sm" onclick="lcExport()">⇩ CSV</button>
    <button class="btn btn-sm" onclick="lcReset()" title="Alles zurücksetzen">↺</button>` : ""}`;
  if (lcState.busy) { el.innerHTML = `<div class="full-loading"><div class="loading"></div></div>`; return; }
  if (!lcState.slips.length) {
    el.innerHTML = `<div class="empty">Lohnabrechnungen als PDF hochladen — beliebig viele Seiten und Dateien aufs Mal.<br>
      <span style="font-size:11px;color:var(--text-faint)">Jede Abrechnung wird ab «Lohn und Zulagen» erkannt, die Lohnarten
      <input type="number" value="${lcState.von}" style="width:64px" onchange="lcRange(this.value,${lcState.bis})"> bis
      <input type="number" value="${lcState.bis}" style="width:64px" onchange="lcRange(${lcState.von},this.value)">
      werden erfasst und über alle Abrechnungen totalisiert (Lohnkontoblatt). Check v${LC_VERSION}<br>
      Geprüft werden Rechnung (Brutto/Abzüge/Netto/Sonstige/Abgerechnet/Rückbehalte/Auszahlung, Basis × Ansatz), Pflichtabzüge AHV/ALV/NBU/KTG/BVG/Vollzug,
      Sätze, Abzugsbasis, Temporär-Bestandteile, Ferienrückbehalt, Vorschussgebühren und doppelte Abrechnungen.</span></div>`;
    return;
  }
  const S = lcState.slips, I = lcState.issues;
  const rot = I.filter(i => i.sev === "rot").length, gelb = I.filter(i => i.sev === "gelb").length;
  const sum = k => S.reduce((a, s) => a + (s[k] || 0), 0);
  const emps = lcEmployees();
  const tab = (id, label) => `<button class="btn btn-sm" style="${lcState.tab === id ? "background:var(--accent);color:#fff" : ""}" onclick="lcState.tab='${id}';render()">${label}</button>`;
  let body = "";
  if (lcState.tab === "konto") {
    const K = lcKonto(S);
    body = `<table style="width:100%;font-size:12px;border-collapse:collapse">
      <tr style="color:var(--text-dim)"><th style="text-align:left;padding:4px 8px 4px 0">Code</th><th style="text-align:left">Lohnart</th>
        <th style="text-align:right;padding:4px 8px">Belege</th><th style="text-align:right;padding:4px 8px">MA</th>
        <th style="text-align:right;padding:4px 8px">Ansatz</th><th style="text-align:right;padding:4px 8px">Anzahl Σ</th><th style="text-align:right;padding:4px 8px">Betrag Σ</th></tr>
      ${K.map(e => {
        const saetze = Object.keys(e.saetze); const satz = saetze.length === 1 ? lcFmtPct(parseFloat(saetze[0])) : saetze.length > 1 ? saetze.length + " versch." : "";
        return `<tr style="border-top:1px solid var(--border);${e.isTotal ? "font-weight:700" : ""};${e.level ? "color:var(--text-dim)" : ""}">
          <td style="padding:5px 8px 5px 0;font-family:var(--font-mono)">${e.code}</td>
          <td style="padding:5px 8px 5px ${e.level ? 18 : 0}px">${e.level ? "↳ " : ""}${escape(e.label)}</td>
          <td style="text-align:right;padding:5px 8px;font-family:var(--font-mono)">${e.n}</td>
          <td style="text-align:right;padding:5px 8px;font-family:var(--font-mono)">${e.ma.size}</td>
          <td style="text-align:right;padding:5px 8px;font-family:var(--font-mono);color:${saetze.length > 1 ? "var(--warn)" : "inherit"}">${satz}</td>
          <td style="text-align:right;padding:5px 8px;font-family:var(--font-mono)">${e.hasAnzahl ? lcFmt(e.anzahl) : ""}</td>
          <td style="text-align:right;padding:5px 8px;font-family:var(--font-mono);color:${e.betrag < 0 ? "var(--danger)" : "inherit"}">${lcFmt(e.betrag)}</td></tr>`;
      }).join("")}</table>
      <div style="font-size:10px;color:var(--text-faint);margin-top:8px">↳ = Bestandteil einer übergeordneten Lohnart (z.B. Grundlohn/Ferien/Feiertag/13. ML in Stundenlohn enthalten) — nicht zusätzlich zum Bruttolohn zählen. Fett = Totalzeilen.</div>`;
  } else if (lcState.tab === "diff") {
    const list = I.filter(i => lcState.sev === "all" || i.sev === lcState.sev);
    const f = (id, label) => `<button class="btn btn-sm" style="${lcState.sev === id ? "background:var(--accent);color:#fff" : ""}" onclick="lcState.sev='${id}';render()">${label}</button>`;
    // Gruppierung: eine Zeile pro Mitarbeiter, Klick klappt die einzelnen Hinweise auf
    const groups = [];
    const byKey = {};
    list.forEach(i => { let g = byKey[i.key]; if (!g) { g = byKey[i.key] = { key: i.key, ma: i.ma, items: [], rot: 0, gelb: 0, grau: 0 }; groups.push(g); } g.items.push(i); g[i.sev]++; });
    groups.sort((a, b) => b.rot - a.rot || b.gelb - a.gelb || a.ma.localeCompare(b.ma, "de"));
    const allOpen = groups.length && groups.every(g => lcState.open[g.key]);
    body = `<div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap;align-items:center">${f("all", "Alle " + I.length)}${f("rot", "Rot " + rot)}${f("gelb", "Gelb " + gelb)}${f("grau", "Grau " + (I.length - rot - gelb))}
      <span style="flex:1"></span><button class="btn btn-sm" onclick="lcToggleAll(${allOpen ? "false" : "true"})">${allOpen ? "Alle zuklappen" : "Alle aufklappen"}</button></div>
      ${groups.length ? `<table style="width:100%;font-size:12px;border-collapse:collapse">
      <tr style="color:var(--text-dim)"><th style="text-align:left">Mitarbeiter</th><th style="text-align:left">Hinweise</th><th style="text-align:left">Perioden</th></tr>
      ${groups.map(g => {
        const openG = !!lcState.open[g.key];
        const per = [...new Set(g.items.map(i => i.periode))];
        const head = `<tr style="border-top:1px solid var(--border);cursor:pointer;${openG ? "background:var(--bg-hover, rgba(127,127,127,.08))" : ""}" onclick="lcToggle('${escape(g.key).replace(/'/g, "\\'")}')">
          <td style="padding:6px 8px 6px 0;font-weight:600;white-space:nowrap"><span style="display:inline-block;width:14px;color:var(--text-faint)">${openG ? "▾" : "▸"}</span>${escape(g.ma)}</td>
          <td style="padding:6px 8px;white-space:nowrap">${g.rot ? `<span style="color:var(--danger)">${g.rot} rot</span> ` : ""}${g.gelb ? `<span style="color:var(--warn)">${g.gelb} gelb</span> ` : ""}${g.grau ? `<span style="color:var(--text-faint)">${g.grau} grau</span>` : ""}</td>
          <td style="padding:6px 8px;color:var(--text-dim)">${escape(per.length > 4 ? per.length + " Perioden" : per.join(", "))}</td></tr>`;
        if (!openG) return head;
        return head + g.items.map(i => `<tr style="cursor:pointer" onclick="lcDetail(${i.slipId})" title="Abrechnung öffnen">
          <td style="padding:3px 8px 3px 20px;white-space:nowrap;color:var(--text-dim)">${lcSevBadge(i.sev)}${escape(i.periode)}</td>
          <td style="padding:3px 8px;white-space:nowrap">${escape(i.pruef)}</td>
          <td style="padding:3px 8px">${escape(i.text)}</td></tr>`).join("");
      }).join("")}</table>` : `<div class="empty">Keine Hinweise in dieser Kategorie ✓</div>`}`;
  } else {
    body = `<table style="width:100%;font-size:12px;border-collapse:collapse">
      <tr style="color:var(--text-dim)"><th style="text-align:left">Mitarbeiter</th><th style="text-align:left">AHV-Nr</th>
        <th style="text-align:right;padding:4px 8px">Abr.</th><th style="text-align:right;padding:4px 8px">Bruttolohn Σ</th><th style="text-align:right;padding:4px 8px">Nettolohn Σ</th><th style="text-align:right;padding:4px 8px">Hinweise</th></tr>
      ${emps.map(m => `<tr style="border-top:1px solid var(--border);cursor:pointer" onclick="lcDetail(${m.slips[0].id})">
        <td style="padding:5px 8px 5px 0;font-weight:600">${escape(m.name)}</td>
        <td style="padding:5px 8px;font-family:var(--font-mono);color:var(--text-dim)">${escape(m.ahv || m.persNr)}</td>
        <td style="text-align:right;padding:5px 8px;font-family:var(--font-mono)">${m.n}</td>
        <td style="text-align:right;padding:5px 8px;font-family:var(--font-mono)">${lcFmt(m.brutto)}</td>
        <td style="text-align:right;padding:5px 8px;font-family:var(--font-mono)">${lcFmt(m.netto)}</td>
        <td style="text-align:right;padding:5px 8px;font-family:var(--font-mono)">${m.rot ? `<span style="color:var(--danger)">${m.rot} rot</span> ` : ""}${m.gelb ? `<span style="color:var(--warn)">${m.gelb} gelb</span>` : ""}${!m.rot && !m.gelb ? "✓" : ""}</td></tr>`).join("")}</table>`;
  }
  el.innerHTML = `
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px">
      <div class="card stat-card"><div class="stat-label">Abrechnungen</div><div class="stat-value">${S.length}</div></div>
      <div class="card stat-card"><div class="stat-label">Mitarbeitende</div><div class="stat-value">${emps.length}</div></div>
      <div class="card stat-card"><div class="stat-label">Bruttolohn Σ</div><div class="stat-value">${lcFmt(sum("brutto"), 0)}</div></div>
      <div class="card stat-card"><div class="stat-label">Nettolohn Σ</div><div class="stat-value">${lcFmt(sum("netto"), 0)}</div></div>
      <div class="card stat-card"><div class="stat-label">Hinweise</div><div class="stat-value"><span style="color:${rot ? "var(--danger)" : "inherit"}">${rot}</span> <span style="font-size:12px;color:var(--text-faint)">rot</span>
        <span style="color:${gelb ? "var(--warn)" : "inherit"}">${gelb}</span> <span style="font-size:12px;color:var(--text-faint)">gelb</span></div></div>
    </div>
    <div class="card" style="padding:14px 16px;overflow-x:auto">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:10px">
        <div style="display:flex;gap:6px">${tab("konto", "Lohnkontoblatt")}${tab("diff", "Differenzen " + I.length)}${tab("ma", "Mitarbeitende")}</div>
        <div style="font-size:10px;color:var(--text-faint)">${escape(lcState.files.join(" + "))} · Lohnarten ${lcState.von}–${lcState.bis} · Check v${LC_VERSION}</div>
      </div>
      ${body}
    </div>`;
}

function lcToggle(key) { if (lcState.open[key]) delete lcState.open[key]; else lcState.open[key] = true; render(); }
function lcToggleAll(open) { lcState.open = {}; if (open) lcState.issues.forEach(i => { lcState.open[i.key] = true; }); render(); }

function lcDetail(slipId) {
  const s = lcState.slips.find(x => x.id === slipId);
  if (!s) return;
  const same = lcState.slips.filter(x => x.key === s.key);
  const navi = same.length > 1 ? `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px">${same.map(x => `<button class="btn btn-sm" style="${x.id === s.id ? "background:var(--accent);color:#fff" : ""}" onclick="lcDetail(${x.id})">${escape(x.periode)}</button>`).join("")}</div>` : "";
  showModal(escape(s.anzeige) + " — " + escape(s.periode), `
    ${navi}
    <div style="font-size:11px;color:var(--text-dim);margin-bottom:8px">Abrechnung #${s.id} · ${escape(s.file)} · Seite ${s.pages[0].n}${s.pages.length > 1 ? "–" + s.pages[s.pages.length - 1].n : ""}${s.ahv ? " · AHV " + escape(s.ahv) : ""}${s.persNr ? " · Pers.-Nr. " + escape(s.persNr) : ""}</div>
    ${s.issues.length ? `<div style="margin-bottom:10px">${s.issues.map(i => `<div style="font-size:12px;padding:3px 0">${lcSevBadge(i.sev)}<b>${escape(i.pruef)}</b> ${escape(i.text)}</div>`).join("")}</div>` : `<div style="font-size:12px;margin-bottom:10px">✓ Keine Hinweise</div>`}
    <table style="width:100%;font-size:12px;border-collapse:collapse">
      <tr style="color:var(--text-dim)"><th style="text-align:left">Code</th><th style="text-align:left">Lohnart</th><th style="text-align:right">Basis</th><th style="text-align:right">Ansatz</th><th style="text-align:right">Anzahl</th><th style="text-align:right">Betrag</th></tr>
      ${s.rows.map(r => `<tr style="border-top:1px solid var(--border);${r.isTotal ? "font-weight:700" : ""};${r.level ? "color:var(--text-dim)" : ""}">
        <td style="padding:3px 8px 3px 0;font-family:var(--font-mono)">${r.code}</td>
        <td style="padding:3px 8px 3px ${r.level ? 16 : 0}px">${escape(r.label)}</td>
        <td style="text-align:right;font-family:var(--font-mono)">${r.basis === null ? "" : lcFmt(r.basis)}</td>
        <td style="text-align:right;font-family:var(--font-mono)">${r.ansatz === null ? "" : lcFmtPct(r.ansatz)}</td>
        <td style="text-align:right;font-family:var(--font-mono)">${r.anzahl === null ? "" : lcFmt(r.anzahl)}</td>
        <td style="text-align:right;font-family:var(--font-mono);color:${r.betrag < 0 ? "var(--danger)" : "inherit"}">${lcFmt(r.betrag)}</td></tr>`).join("")}
    </table>
    <details style="margin-top:10px"><summary style="cursor:pointer;font-size:11px;color:var(--text-faint)">Kopfzeilen der Abrechnung (Erkennungshilfe)</summary>
      <pre style="font-size:10px;white-space:pre-wrap;color:var(--text-dim);margin:6px 0 0">${escape(s.header.join("\n"))}</pre></details>`,
    [{ label: "Schliessen", action: "closeModal()" }]);
}
