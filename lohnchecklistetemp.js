/* ============ Checkliste Lohn Temp 2.0 (Workflows) ============
   Pro KUNDE + LOHNPERIODE (Monat) eine Checkliste mit einem oder mehreren
   LOHNLÄUFEN.

   ZUORDNUNG (Stand nach Feedback vom 10.09.2026 — wichtig für die Struktur):
   - Checkbox-Status + Bemerkung EINER Checkbox → gehört zum einzelnen LOHNLAUF.
   - Die beiden grossen Freitextfelder «Bemerkungen aktuelle Lohnperiode» und
     «Hinweise für Folgemonat» sowie die periodenbezogenen Dokumente/Bilder
     → gehören zu KUNDE + PERIODE (Monat), NICHT zum einzelnen Lohnlauf.
     Sie sind in JEDEM Lohnlauf derselben Periode identisch sichtbar/editierbar.
   - «Hinweise für Folgemonat» wird automatisch MONAT FÜR MONAT weitergeführt
     (nicht nur einmal in den nächsten Monat), bis der User ihn aktiv löscht.
     Er erscheint gleichzeitig synchron an zwei Stellen: im Freitextfeld selbst
     und als rote Hervorhebung oben bei der Kunde/Monat-Auswahl — beide zeigen
     IMMER denselben aktuellen Inhalt (keine getrennte Kopie).
   - Kundenspezifische Kontrollpunkte, Dokumente/Anleitungen (Kunde, dauerhaft)
     und kundenspezifische Anpassungen der Standard-Checkliste (inkl. deren
     Reihenfolge) → gehören dauerhaft zum KUNDEN, unabhängig von der Periode.
   - Periodenbezogene Dokumente/Bilder → gehören zu KUNDE + PERIODE, sichtbar
     in allen Lohnläufen dieser Periode, werden NICHT in den Folgemonat
     übernommen (anders als die dauerhaften Kunden-Dokumente).
   - Reihenfolge kundenspezifischer Kontrollpunkte ist frei verschiebbar
     (auch zwischen Standard-Kontrollpunkten) und wird gespeichert; wird eine
     Änderung «für alle Kunden» übernommen, wird auch die Reihenfolge Teil
     der Standard-Checkliste.

   SPEICHERUNG: JSON-Dateien im SharePoint-Drive (NICHT die 255-Zeichen-
   begrenzte Title-Spalte der «Budget»-Liste). Ordner CRM-Budgetdaten:
     lct_standard.json          — globale Standard-Vorlage (Kontrollpunkte)
     lct_kunde_<companyId>.json — pro Kunde: Anpassungen, alle Perioden/
                                   Lohnläufe, dauerhafte Dokumente
   Dokument-Dateien: CRM-Budgetdaten/LCT-Dokumente/<companyId>/ (dauerhaft)
                      CRM-Budgetdaten/LCT-Dokumente/<companyId>/<YYYY-MM>/ (periodenbezogen)

   Abhängigkeiten: index.html (graph, siteId, escape, toast, render, val,
   showModal, closeModal, cache.companies, getToken). */

const LCT_VERSION = "1.147.0";
const LCT_DIR = "CRM-Budgetdaten";
const LCT_DOC_DIR = "LCT-Dokumente";

/* Standard-Kontrollpunkte — Gruppen 1–10, insgesamt 11 Checkboxen (Gruppe 9 hat zwei).
   id ist stabil und wird referenziert (nie umbenennen — stattdessen text bearbeiten). */
const LCT_STANDARD_BASIS = [
  { id: "zl1", gruppe: "1. Zahlungslisten", text: "Zahlungslisten alle auf «ausgeführt» stellen, bevor Lohn gerechnet wird" },
  { id: "rap1", gruppe: "2. Rapporterfassung", text: "Alle Rapporte sind erfasst" },
  { id: "ldm1", gruppe: "3. Lohndatenmeldungen", text: "Sämtliche Lohndatenmeldungen im Ticketsystem überprüfen, erfassen und kontrollieren" },
  { id: "gf1", gruppe: "4. Guthaben / Ferien / 13. Gehalt", text: "Guthaben, Ferien und 13. Gehalt gemäss Lohnmeldungen des Kunden auszahlen bzw. verarbeiten" },
  { id: "bp1", gruppe: "5. Betreibungen / Lohnpfändungen", text: "Betreibungen und Lohnpfändungen kontrollieren" },
  { id: "uc1", gruppe: "6. Ultimativ Check", text: "Ultimativ Check durchführen", hinweis: "Ferienguthaben (Minusbeträge kontrollieren), 13. Gehalt, BVG, Sozialversicherungsabzüge, Quellensteuer (QST), Vorschussgebühren etc." },
  { id: "uc2", gruppe: "7. Ultimativ Check berücksichtigt", text: "Sämtliche Meldungen von Ultimativ Check wurden kontrolliert und bereinigt", hinweis: "Ebenso der Entwicklung melden" },
  { id: "la1", gruppe: "8. Lohnabrechnung zur Kontrolle", text: "Lohnabrechnungen an den Kunden zur Kontrolle versenden" },
  { id: "za1", gruppe: "9. Zahlungsauftrag nach Kundenfreigabe", text: "Nach OK / Freigabe des Kunden Zahlungsauftrag auf die Bank stellen" },
  { id: "za2", gruppe: "9. Zahlungsauftrag nach Kundenfreigabe", text: "Dem Kunden die Auszahlungsliste senden" },
  { id: "zg1", gruppe: "10. Zahlung ausgeführt", text: "Sobald die Zahlung auf der Bank ausgeführt wurde, Zahlungsauftrag im System auf «ausgeführt» stellen" }
];

/* ---------- Laufender Zustand ---------- */
const lctState = {
  monat: null,             // "YYYY-MM"
  kundeId: null,
  laufIdx: 0,               // welcher Lohnlauf ist gerade sichtbar (0-basiert)
  standard: null,            // { items:[...], updatedAt } — einmal geladen, bleibt im Speicher
  standardLoading: null,
  kunde: null,              // aktuell geladene Kundendatei (siehe lctLeer())
  kundeLoading: null,
  neuerPunktText: ""
};

function lctMonatHeute() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}
function lctMonatLabel(ym) {
  if (!ym) return "";
  const [y, m] = ym.split("-").map(Number);
  const NAMEN = ["Januar","Februar","März","April","Mai","Juni","Juli","August","September","Oktober","November","Dezember"];
  return NAMEN[(m || 1) - 1] + " " + y;
}
function lctMonatVorher(ym) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

function lctLeer() {
  return { customExtra: [], customOverrides: {}, customRemoved: [], periods: {}, documents: [] };
}
function lctNeueLohnperiode(hinweisVorbelegt) {
  return { laeufe: [lctNeuerLaufObjekt()], bemerkungPeriode: "", hinweisFolgemonat: hinweisVorbelegt || "", documents: [] };
}
function lctNeuerLaufObjekt() {
  return { items: {} };
}
/* Altdaten-Migration: frühe Testversion hatte bemerkungPeriode/hinweisFolgemonat/documents
   fälschlich pro Lohnlauf statt pro Periode gespeichert (siehe Feedback 10.09.2026). Beim Laden
   auf das neue Format heben, damit nichts verloren geht. */
function lctMigrierePeriode(per) {
  if (!per) return per;
  if (typeof per.bemerkungPeriode !== "string") per.bemerkungPeriode = "";
  if (typeof per.hinweisFolgemonat !== "string") per.hinweisFolgemonat = "";
  if (!Array.isArray(per.documents)) per.documents = [];
  if (Array.isArray(per.laeufe)) {
    per.laeufe.forEach(l => {
      if (typeof l.bemerkungPeriode === "string" && l.bemerkungPeriode.trim() && !per.bemerkungPeriode) per.bemerkungPeriode = l.bemerkungPeriode;
      if (typeof l.hinweisFolgemonat === "string" && l.hinweisFolgemonat.trim() && !per.hinweisFolgemonat) per.hinweisFolgemonat = l.hinweisFolgemonat;
      delete l.bemerkungPeriode; delete l.hinweisFolgemonat;
    });
  } else {
    per.laeufe = [lctNeuerLaufObjekt()];
  }
  return per;
}

/* ---------- Laden ---------- */
async function lctLoadStandard(force) {
  if (lctState.standard && !force) return lctState.standard;
  if (lctState.standardLoading) return lctState.standardLoading;
  lctState.standardLoading = (async () => {
    let data = null;
    try {
      const res = await graph(`/sites/${siteId}/drive/root:/${LCT_DIR}/lct_standard.json:/content`);
      data = res;
    } catch (e) { /* noch keine Datei — Basis-Vorlage verwenden */ }
    if (!data || !Array.isArray(data.items) || !data.items.length) {
      data = { items: LCT_STANDARD_BASIS.slice(), updatedAt: null };
    }
    lctState.standard = data;
    lctState.standardLoading = null;
    return data;
  })();
  return lctState.standardLoading;
}
async function lctSaveStandard() {
  lctState.standard.updatedAt = new Date().toISOString();
  const path = `/sites/${siteId}/drive/root:/${LCT_DIR}/lct_standard.json:/content`;
  const body = JSON.stringify(lctState.standard);
  try { await graph(path, { method: "PUT", body }); }
  catch (e) {
    if (!/404|itemNotFound|400/i.test(e.message)) throw e;
    await graph(`/sites/${siteId}/drive/root/children`, {
      method: "POST",
      body: JSON.stringify({ name: LCT_DIR, folder: {}, "@microsoft.graph.conflictBehavior": "replace" })
    });
    await graph(path, { method: "PUT", body });
  }
}

async function lctLoadKunde(companyId, force) {
  if (!force && lctState.kunde && lctState.kunde.__id == companyId) return lctState.kunde;
  if (lctState.kundeLoading) return lctState.kundeLoading;
  lctState.kundeLoading = (async () => {
    let data = null;
    try {
      data = await graph(`/sites/${siteId}/drive/root:/${LCT_DIR}/lct_kunde_${companyId}.json:/content`);
    } catch (e) { data = lctLeer(); }
    if (!data || typeof data !== "object") data = lctLeer();
    data.customExtra = data.customExtra || [];
    data.customOverrides = data.customOverrides || {};
    data.customRemoved = data.customRemoved || [];
    data.periods = data.periods || {};
    data.documents = data.documents || [];
    Object.keys(data.periods).forEach(ym => { data.periods[ym] = lctMigrierePeriode(data.periods[ym]); });
    // order-Feld für Alt-Zusatzpunkte ohne order ergänzen (ans Ende, in Erstellungsreihenfolge)
    data.customExtra.forEach((it, i) => { if (typeof it.order !== "number") it.order = 1000 + i; });
    data.__id = companyId;
    lctState.kunde = data;
    lctState.kundeLoading = null;
    return data;
  })();
  return lctState.kundeLoading;
}
async function lctSaveKunde() {
  const k = lctState.kunde;
  const companyId = k.__id;
  const toSave = { customExtra: k.customExtra, customOverrides: k.customOverrides, customRemoved: k.customRemoved, periods: k.periods, documents: k.documents };
  const path = `/sites/${siteId}/drive/root:/${LCT_DIR}/lct_kunde_${companyId}.json:/content`;
  const body = JSON.stringify(toSave);
  try { await graph(path, { method: "PUT", body }); }
  catch (e) {
    if (!/404|itemNotFound|400/i.test(e.message)) throw e;
    await graph(`/sites/${siteId}/drive/root/children`, {
      method: "POST",
      body: JSON.stringify({ name: LCT_DIR, folder: {}, "@microsoft.graph.conflictBehavior": "replace" })
    });
    await graph(path, { method: "PUT", body });
  }
}

/* ---------- Effektive Kontrollpunkt-Liste ----------
   Standard-Items behalten ihre Array-Position als Ordnungszahl (0,1,2,…).
   Zusatzpunkte tragen ein eigenes order (float) und werden anhand dessen
   zwischen die Standard-Items einsortiert — so lässt sich ein Zusatzpunkt
   frei zwischen zwei beliebige Kontrollpunkte schieben (siehe lctVerschieben). */
function lctEffektiveItems() {
  const std = (lctState.standard && lctState.standard.items) || LCT_STANDARD_BASIS;
  const k = lctState.kunde || lctLeer();
  const basis = std
    .filter(it => k.customRemoved.indexOf(it.id) < 0)
    .map((it, i) => Object.assign({ order: i }, it, k.customOverrides[it.id] ? { text: k.customOverrides[it.id] } : {}));
  const extra = (k.customExtra || []).map(it => Object.assign({ kundenspezifisch: true }, it));
  return basis.concat(extra).sort((a, b) => a.order - b.order);
}

/* ---------- Periode / Lohnläufe sicherstellen (inkl. dauerhafter Monat-für-Monat-
   Weiterführung des Folgemonat-Hinweises, bis der User ihn aktiv löscht) ---------- */
function lctPeriode(anlegenWennFehlt) {
  const k = lctState.kunde;
  if (!k) return null;
  const ym = lctState.monat;
  if (!k.periods[ym]) {
    if (!anlegenWennFehlt) return null;
    const vorher = lctMonatVorher(ym);
    const pv = k.periods[vorher];
    const hinweis = (pv && (pv.hinweisFolgemonat || "").trim()) ? pv.hinweisFolgemonat : "";
    k.periods[ym] = lctNeueLohnperiode(hinweis);
  }
  return k.periods[ym];
}

/* ---------- Rendering ---------- */
function lctKunden() {
  return (cache.companies || []).filter(c => c.IsCustomer).sort((a, b) => (a.Title || "").localeCompare(b.Title || "", "de-CH"));
}

async function renderLct(el) {
  if (!lctState.monat) lctState.monat = lctMonatHeute();
  el.innerHTML = `<div class="empty">Lade Checkliste …</div>`;
  await lctLoadStandard(false);
  const kunden = lctKunden();
  if (!lctState.kundeId && kunden.length) lctState.kundeId = kunden[0].id;
  if (lctState.kundeId) await lctLoadKunde(lctState.kundeId, false);

  document.getElementById("view-actions").innerHTML = `
    <div style="display:inline-flex;gap:8px;align-items:center;font-size:12px;color:var(--text-dim);flex-wrap:wrap">
      <input type="month" value="${escape(lctState.monat)}" onchange="lctSetMonat(this.value)"
        style="background:var(--bg-card);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:3px;font-family:inherit;font-size:12px">
      <select onchange="lctSetKunde(this.value)" style="background:var(--bg-card);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:3px;font-family:inherit;font-size:12px;min-width:220px">
        ${kunden.map(k => `<option value="${k.id}" ${k.id == lctState.kundeId ? "selected" : ""}>${escape(k.Title || "")}</option>`).join("")}
      </select>
    </div>
  `;

  if (!kunden.length) { el.innerHTML = `<div class="empty">Keine Kunden vorhanden (Firma bearbeiten → «Ist Kunde» aktivieren).</div>`; return; }
  lctRenderBody(el);
}

function lctRenderBody(el) {
  const per = lctPeriode(true);
  if (lctState.laufIdx >= per.laeufe.length) lctState.laufIdx = per.laeufe.length - 1;
  const lauf = per.laeufe[lctState.laufIdx];
  const items = lctEffektiveItems();
  // Hinweis aus Vormonat: EIN Feld (per.hinweisFolgemonat), zwei synchrone Anzeigen — Textarea unten
  // und rote Box oben. Immer sichtbar, unabhängig davon welcher Lohnlauf gerade offen ist.
  const hinweisAktuell = (per.hinweisFolgemonat || "").trim();

  // Gruppieren nach .gruppe für die Darstellung
  const gruppen = [];
  items.forEach(it => {
    let g = gruppen.find(x => x.name === (it.gruppe || "Weitere"));
    if (!g) { g = { name: it.gruppe || "Weitere", items: [] }; gruppen.push(g); }
    g.items.push(it);
  });

  const k = lctState.kunde;
  const doks = k.documents || [];
  const perDoks = per.documents || [];
  const kundeName = (lctKunden().find(c => c.id == lctState.kundeId) || {}).Title || "";

  el.innerHTML = `
    <div class="detail-grid" style="grid-template-columns:1fr">
      ${hinweisAktuell ? `
        <div class="panel" style="border-left:4px solid #c62828;background:#FEF2F2">
          <div class="panel-h" style="color:#7f1d1d">⚠ Hinweis aus Vormonat</div>
          <div style="padding:12px 16px;color:#7f1d1d;font-size:13px;white-space:pre-wrap">${escape(hinweisAktuell)}</div>
        </div>` : ""}

      <div class="panel">
        <div class="panel-h" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span>Lohnläufe — ${escape(lctMonatLabel(lctState.monat))}</span>
          <div style="display:flex;gap:6px;margin-left:auto">
            ${per.laeufe.map((l, i) => `<button class="btn btn-sm ${i === lctState.laufIdx ? "btn-primary" : ""}" onclick="lctWaehleLauf(${i})">${i + 1}. Lohnlauf</button>`).join("")}
            <button class="btn btn-sm" onclick="lctNeuerLauf()" title="Neuen Lohnlauf mit denselben Kontrollpunkten anlegen">＋</button>
          </div>
        </div>
        <div style="padding:14px 16px">
          <div style="font-size:11px;color:var(--text-faint);margin-bottom:10px">Erledigte Arbeiten im Kontrollkästchen ankreuzen. Bemerkungsfelder und Dokumente unten gelten für die ganze Periode — bei allen Lohnläufen gleich.</div>
          ${gruppen.map(g => `
            <div style="margin-bottom:14px">
              <div style="font-size:11px;font-weight:700;color:var(--text-faint);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">${escape(g.name)}</div>
              ${g.items.map(it => {
                const st = lauf.items[it.id] || { checked: false, bemerkung: "" };
                return `
                <div style="padding:8px 0;border-bottom:1px solid var(--border)">
                  <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer">
                    <input type="checkbox" ${st.checked ? "checked" : ""} onchange="lctToggle('${it.id}',this.checked)" style="margin-top:3px;width:auto">
                    <span style="flex:1">${escape(it.text)}${it.kundenspezifisch ? ` <span style="font-size:10px;color:var(--accent,#5ad275)">· kundenspezifisch</span>` : ""}</span>
                    <span style="display:flex;gap:4px">
                      ${it.kundenspezifisch ? `
                      <button class="btn btn-sm" onclick="lctVerschieben('${it.id}',-1)" title="Nach oben verschieben">↑</button>
                      <button class="btn btn-sm" onclick="lctVerschieben('${it.id}',1)" title="Nach unten verschieben">↓</button>` : ""}
                      <button class="btn btn-sm" onclick="lctBearbeiten('${it.id}')" title="Text bearbeiten">✎</button>
                      <button class="btn btn-sm" onclick="lctEntfernen('${it.id}')" title="Entfernen">✕</button>
                    </span>
                  </label>
                  ${it.hinweis ? `<div style="font-size:11px;color:var(--text-faint);margin:4px 0 0 26px">${escape(it.hinweis)}</div>` : ""}
                  <input type="text" placeholder="Bemerkung …" value="${escape(st.bemerkung || "")}"
                    onchange="lctBemerkung('${it.id}',this.value)"
                    style="margin:6px 0 0 26px;width:calc(100% - 26px);font-size:12px;padding:4px 8px;border:1px solid var(--border);border-radius:3px;background:var(--bg-card);color:var(--text)">
                </div>`;
              }).join("")}
            </div>
          `).join("")}

          <div style="display:flex;gap:8px;margin:14px 0 4px">
            <input type="text" id="lct-neu-text" placeholder="Neuer Kontrollpunkt für diesen Kunden …" value="${escape(lctState.neuerPunktText)}"
              oninput="lctState.neuerPunktText=this.value"
              style="flex:1;font-size:12px;padding:6px 10px;border:1px solid var(--border);border-radius:3px;background:var(--bg-card);color:var(--text)">
            <button class="btn btn-sm" onclick="lctHinzufuegen()">＋ Kontrollpunkt hinzufügen</button>
          </div>

          <div class="field" style="margin-top:16px">
            <label>Bemerkungen / offene Punkte aktuelle Lohnperiode <span style="font-weight:400;color:var(--text-faint);font-size:11px">— gilt für die ganze Periode, nicht nur diesen Lohnlauf</span></label>
            <textarea rows="3" onchange="lctSetPeriodeFeld('bemerkungPeriode',this.value)">${escape(per.bemerkungPeriode || "")}</textarea>
          </div>
          <div class="field" style="margin-top:10px">
            <label>Hinweise / Bemerkungen für Folgemonat <span style="font-weight:400;color:var(--text-faint);font-size:11px">— wird automatisch Monat für Monat weitergeführt, bis aktiv gelöscht</span></label>
            <textarea rows="3" onchange="lctSetPeriodeFeld('hinweisFolgemonat',this.value)">${escape(per.hinweisFolgemonat || "")}</textarea>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-h">Dokumente für ${escape(kundeName)} / ${escape(lctMonatLabel(lctState.monat))} <span style="font-weight:400;color:var(--text-faint);font-size:11px">— nur diese Periode, in allen Lohnläufen sichtbar, wird NICHT in den Folgemonat übernommen</span></div>
        <div style="padding:12px 16px">
          ${perDoks.length ? perDoks.map((d, i) => `
            <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
              <a href="${escape(d.url)}" target="_blank" style="flex:1">${escape(d.name)}</a>
              <span style="font-size:11px;color:var(--text-faint)">${d.uploadedAt ? new Date(d.uploadedAt).toLocaleDateString("de-CH") : ""}</span>
              <button class="btn btn-sm" onclick="lctPeriodeDokEntfernen(${i})">✕</button>
            </div>`).join("") : `<div style="color:var(--text-faint);font-size:12px">Keine Dokumente für diese Periode hinterlegt.</div>`}
          <input type="file" id="lct-perdok-file" style="display:none" onchange="lctPeriodeDokUpload(this)">
          <button class="btn btn-sm" style="margin-top:10px" onclick="document.getElementById('lct-perdok-file').click()">📎 Dokument für diese Periode hochladen</button>
        </div>
      </div>

      <div class="panel">
        <div class="panel-h">Dokumente / Anleitungen für ${escape(kundeName)} <span style="font-weight:400;color:var(--text-faint);font-size:11px">— dauerhaft, nicht an Monat gebunden</span></div>
        <div style="padding:12px 16px">
          ${doks.length ? doks.map((d, i) => `
            <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
              <a href="${escape(d.url)}" target="_blank" style="flex:1">${escape(d.name)}</a>
              <span style="font-size:11px;color:var(--text-faint)">${d.uploadedAt ? new Date(d.uploadedAt).toLocaleDateString("de-CH") : ""}</span>
              <button class="btn btn-sm" onclick="lctDokEntfernen(${i})">✕</button>
            </div>`).join("") : `<div style="color:var(--text-faint);font-size:12px">Keine Dokumente hinterlegt.</div>`}
          <input type="file" id="lct-dok-file" style="display:none" onchange="lctDokUpload(this)">
          <button class="btn btn-sm" style="margin-top:10px" onclick="document.getElementById('lct-dok-file').click()">📎 Dokument hochladen</button>
        </div>
      </div>
    </div>
  `;
}

/* ---------- Aktionen ---------- */
function lctSetMonat(v) { lctState.monat = v; lctState.laufIdx = 0; render(); }
async function lctSetKunde(id) {
  lctState.kundeId = parseInt(id, 10);
  lctState.laufIdx = 0;
  await lctLoadKunde(lctState.kundeId, false);
  render();
}
function lctWaehleLauf(i) { lctState.laufIdx = i; render(); }
async function lctNeuerLauf() {
  const per = lctPeriode(true);
  per.laeufe.push(lctNeuerLaufObjekt());
  lctState.laufIdx = per.laeufe.length - 1;
  render();
  try { await lctSaveKunde(); } catch (e) { toast("Speichern fehlgeschlagen: " + e.message, true); }
}
async function lctToggle(itemId, checked) {
  const lauf = lctPeriode(true).laeufe[lctState.laufIdx];
  lauf.items[itemId] = lauf.items[itemId] || { checked: false, bemerkung: "" };
  lauf.items[itemId].checked = checked;
  try { await lctSaveKunde(); } catch (e) { toast("Speichern fehlgeschlagen: " + e.message, true); }
}
async function lctBemerkung(itemId, text) {
  const lauf = lctPeriode(true).laeufe[lctState.laufIdx];
  lauf.items[itemId] = lauf.items[itemId] || { checked: false, bemerkung: "" };
  lauf.items[itemId].bemerkung = text;
  try { await lctSaveKunde(); } catch (e) { toast("Speichern fehlgeschlagen: " + e.message, true); }
}
/* Bemerkungsfelder gehören zur PERIODE (Kunde+Monat) — gelten für alle Lohnläufe gleich,
   siehe Feedback 10.09.2026. Nach dem Ändern von hinweisFolgemonat neu zeichnen, damit die
   rote Box oben sofort synchron mitzieht. */
async function lctSetPeriodeFeld(feld, text) {
  const per = lctPeriode(true);
  per[feld] = text;
  try { await lctSaveKunde(); } catch (e) { toast("Speichern fehlgeschlagen: " + e.message, true); }
  if (feld === "hinweisFolgemonat") render();
}

/* Änderung an Kontrollpunkten: immer fragen, ob für alle Kunden (Standard) oder nur diesen. */
function lctFrageGlobal(beschreibung, weiterFn) {
  showModal("Änderung übernehmen", `
    <p style="margin-bottom:14px">${escape(beschreibung)}</p>
    <p><b>Soll diese Änderung auf alle Kunden übertragen werden?</b></p>
    <p style="font-size:12px;color:var(--text-dim);margin-top:6px">
      <b>Ja</b> → wird Teil der Standard-Checkliste (inkl. Reihenfolge) und gilt künftig für alle Kunden.<br>
      <b>Nein</b> → gilt nur für den aktuell ausgewählten Kunden.
    </p>
  `, [
    `<button class="btn" onclick="closeModal()">Abbrechen</button>`,
    `<button class="btn" onclick="closeModal();(${weiterFn.name})(false)">Nein — nur dieser Kunde</button>`,
    `<button class="btn btn-primary" onclick="closeModal();(${weiterFn.name})(true)">Ja — alle Kunden</button>`
  ]);
}

function lctHinzufuegen() {
  const text = (lctState.neuerPunktText || "").trim();
  if (!text) return;
  window.__lctPendingAdd = text;
  lctFrageGlobal(`Neuer Kontrollpunkt: «${text}»`, lctHinzufuegenAusfuehren);
}
async function lctHinzufuegenAusfuehren(global) {
  const text = window.__lctPendingAdd; window.__lctPendingAdd = null;
  if (!text) return;
  const id = "u" + Date.now().toString(36);
  if (global) {
    await lctLoadStandard(false);
    lctState.standard.items.push({ id, gruppe: "Zusätzlich", text });
    try { await lctSaveStandard(); } catch (e) { toast("Speichern fehlgeschlagen: " + e.message, true); }
  } else {
    const maxOrder = Math.max(999, ...lctEffektiveItems().map(x => x.order));
    lctState.kunde.customExtra.push({ id, gruppe: "Zusätzlich (kundenspezifisch)", text, order: maxOrder + 1 });
    try { await lctSaveKunde(); } catch (e) { toast("Speichern fehlgeschlagen: " + e.message, true); }
  }
  lctState.neuerPunktText = "";
  render();
}

function lctBearbeiten(itemId) {
  const items = lctEffektiveItems();
  const it = items.find(x => x.id === itemId);
  if (!it) return;
  showModal("Kontrollpunkt bearbeiten", `
    <div class="field"><label>Text</label><textarea id="lct-edit-text" rows="2">${escape(it.text)}</textarea></div>
  `, [
    `<button class="btn" onclick="closeModal()">Abbrechen</button>`,
    `<button class="btn btn-primary" onclick="lctBearbeitenSpeichern('${itemId}')">Weiter</button>`
  ]);
}
function lctBearbeitenSpeichern(itemId) {
  const text = val("lct-edit-text");
  if (!text) return;
  closeModal();
  window.__lctPendingEdit = { id: itemId, text };
  lctFrageGlobal(`Text ändern zu: «${text}»`, lctBearbeitenAusfuehren);
}
async function lctBearbeitenAusfuehren(global) {
  const p = window.__lctPendingEdit; window.__lctPendingEdit = null;
  if (!p) return;
  const isExtra = (lctState.kunde.customExtra || []).some(x => x.id === p.id);
  if (isExtra) {
    // kundenspezifischer Zusatzpunkt: Text direkt in customExtra ändern (kein globaler Bezug möglich)
    const e = lctState.kunde.customExtra.find(x => x.id === p.id);
    if (e) e.text = p.text;
    try { await lctSaveKunde(); } catch (e2) { toast("Speichern fehlgeschlagen: " + e2.message, true); }
  } else if (global) {
    await lctLoadStandard(false);
    const it = lctState.standard.items.find(x => x.id === p.id);
    if (it) it.text = p.text;
    try { await lctSaveStandard(); } catch (e2) { toast("Speichern fehlgeschlagen: " + e2.message, true); }
  } else {
    lctState.kunde.customOverrides[p.id] = p.text;
    try { await lctSaveKunde(); } catch (e2) { toast("Speichern fehlgeschlagen: " + e2.message, true); }
  }
  render();
}

function lctEntfernen(itemId) {
  const isExtra = (lctState.kunde.customExtra || []).some(x => x.id === itemId);
  if (isExtra) {
    lctState.kunde.customExtra = lctState.kunde.customExtra.filter(x => x.id !== itemId);
    lctSaveKunde().catch(e => toast("Speichern fehlgeschlagen: " + e.message, true));
    render();
    return;
  }
  window.__lctPendingRemove = itemId;
  lctFrageGlobal("Kontrollpunkt entfernen.", lctEntfernenAusfuehren);
}
async function lctEntfernenAusfuehren(global) {
  const id = window.__lctPendingRemove; window.__lctPendingRemove = null;
  if (!id) return;
  if (global) {
    await lctLoadStandard(false);
    lctState.standard.items = lctState.standard.items.filter(x => x.id !== id);
    try { await lctSaveStandard(); } catch (e) { toast("Speichern fehlgeschlagen: " + e.message, true); }
  } else {
    if (lctState.kunde.customRemoved.indexOf(id) < 0) lctState.kunde.customRemoved.push(id);
    try { await lctSaveKunde(); } catch (e) { toast("Speichern fehlgeschlagen: " + e.message, true); }
  }
  render();
}

/* ---------- Reihenfolge kundenspezifischer Kontrollpunkte ----------
   Verschiebt NUR den bewegten Zusatzpunkt (fractional/midpoint-Einordnung) — Standard-Items
   und andere Zusatzpunkte bleiben unverändert. So kann ein Zusatzpunkt frei zwischen zwei
   beliebige Kontrollpunkte geschoben werden, auch zwischen zwei Standard-Punkte. */
async function lctVerschieben(itemId, richtung) {
  const merged = lctEffektiveItems();
  const idx = merged.findIndex(x => x.id === itemId);
  if (idx < 0) return;
  const neuIdx = idx + richtung;
  if (neuIdx < 0 || neuIdx >= merged.length) return;
  const extra = lctState.kunde.customExtra.find(x => x.id === itemId);
  if (!extra) return;   // Standard-Items werden hier nicht verschoben
  let neueOrder;
  if (richtung < 0) {
    const oberGrenze = merged[neuIdx].order;
    const untereGrenze = neuIdx > 0 ? merged[neuIdx - 1].order : oberGrenze - 2;
    neueOrder = (oberGrenze + untereGrenze) / 2;
  } else {
    const untereGrenze = merged[neuIdx].order;
    const obereGrenze = neuIdx < merged.length - 1 ? merged[neuIdx + 1].order : untereGrenze + 2;
    neueOrder = (untereGrenze + obereGrenze) / 2;
  }
  extra.order = neueOrder;
  render();
  try { await lctSaveKunde(); } catch (e) { toast("Speichern fehlgeschlagen: " + e.message, true); }
}

/* ---------- Dokumente: dauerhaft (Kunde) ---------- */
async function lctDokUpload(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const companyId = lctState.kundeId;
  const token = await getToken();
  const folder = `${LCT_DOC_DIR}/${companyId}`;
  const url = `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/root:/${LCT_DIR}/${encodeURIComponent(folder)}/${encodeURIComponent(file.name)}:/content`;
  const put = () => fetch(url, { method: "PUT", headers: { Authorization: "Bearer " + token }, body: file });
  let res = await put();
  if (!res.ok && (res.status === 404 || res.status === 400)) {
    await fetch(`https://graph.microsoft.com/v1.0/sites/${siteId}/drive/root:/${LCT_DIR}:/children`, {
      method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ name: LCT_DOC_DIR, folder: {}, "@microsoft.graph.conflictBehavior": "replace" })
    }).catch(() => {});
    await fetch(`https://graph.microsoft.com/v1.0/sites/${siteId}/drive/root:/${LCT_DIR}/${encodeURIComponent(LCT_DOC_DIR)}:/children`, {
      method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ name: String(companyId), folder: {}, "@microsoft.graph.conflictBehavior": "replace" })
    }).catch(() => {});
    res = await put();
  }
  if (!res.ok) { toast("Hochladen fehlgeschlagen (HTTP " + res.status + ")", true); return; }
  const item = await res.json();
  lctState.kunde.documents.push({ name: file.name, url: item.webUrl, uploadedAt: new Date().toISOString() });
  try { await lctSaveKunde(); } catch (e) { toast("Speichern fehlgeschlagen: " + e.message, true); }
  input.value = "";
  render();
}
async function lctDokEntfernen(idx) {
  lctState.kunde.documents.splice(idx, 1);
  try { await lctSaveKunde(); } catch (e) { toast("Speichern fehlgeschlagen: " + e.message, true); }
  render();
}

/* ---------- Dokumente: periodenbezogen (Kunde + Monat, nicht in Folgemonat übernommen) ---------- */
async function lctPeriodeDokUpload(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const companyId = lctState.kundeId, ym = lctState.monat;
  const token = await getToken();
  const folder = `${LCT_DOC_DIR}/${companyId}/${ym}`;
  const url = `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/root:/${LCT_DIR}/${encodeURIComponent(folder)}/${encodeURIComponent(file.name)}:/content`;
  const put = () => fetch(url, { method: "PUT", headers: { Authorization: "Bearer " + token }, body: file });
  let res = await put();
  if (!res.ok && (res.status === 404 || res.status === 400)) {
    // Ordnerkette sicherstellen: LCT-Dokumente → <companyId> → <YYYY-MM>
    await fetch(`https://graph.microsoft.com/v1.0/sites/${siteId}/drive/root:/${LCT_DIR}:/children`, {
      method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ name: LCT_DOC_DIR, folder: {}, "@microsoft.graph.conflictBehavior": "replace" })
    }).catch(() => {});
    await fetch(`https://graph.microsoft.com/v1.0/sites/${siteId}/drive/root:/${LCT_DIR}/${encodeURIComponent(LCT_DOC_DIR)}:/children`, {
      method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ name: String(companyId), folder: {}, "@microsoft.graph.conflictBehavior": "replace" })
    }).catch(() => {});
    await fetch(`https://graph.microsoft.com/v1.0/sites/${siteId}/drive/root:/${LCT_DIR}/${encodeURIComponent(LCT_DOC_DIR)}/${encodeURIComponent(String(companyId))}:/children`, {
      method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ name: ym, folder: {}, "@microsoft.graph.conflictBehavior": "replace" })
    }).catch(() => {});
    res = await put();
  }
  if (!res.ok) { toast("Hochladen fehlgeschlagen (HTTP " + res.status + ")", true); return; }
  const item = await res.json();
  const per = lctPeriode(true);
  per.documents.push({ name: file.name, url: item.webUrl, uploadedAt: new Date().toISOString() });
  try { await lctSaveKunde(); } catch (e) { toast("Speichern fehlgeschlagen: " + e.message, true); }
  input.value = "";
  render();
}
async function lctPeriodeDokEntfernen(idx) {
  const per = lctPeriode(true);
  per.documents.splice(idx, 1);
  try { await lctSaveKunde(); } catch (e) { toast("Speichern fehlgeschlagen: " + e.message, true); }
  render();
}
