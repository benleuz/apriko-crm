/* ============ Jahresbudget (Finanzen) ============
   Eigenes Budget für ein Zieljahr (z.B. 2027) pro Gesellschaft und FIBU-Konto.
   Quellen:
     • Ertrag SaaS/BPO           → Ertragsbudget des Zieljahrs (nur Ansicht)
     • Personalaufwand (Lohn, AG-Beiträge, übriger PA) → fb-Positionen des Zieljahrs,
       geschrieben vom Menüpunkt «Budget Personalaufwand» (nur Ansicht; über Kreuz:
       SW_* = Maverix AG, BO_* = Apriko AG)
     • Alle übrigen Positionen    → Ist-Konten des Basisjahrs (Zieljahr − 1), hochgerechnet
       (H1 × 2 bzw. Jahresabschluss × 1) als VORSCHLAG; pro Gesellschaft/Konto
       überschreibbar und mit Notiz versehbar; Buchungen des Basisjahrs aufklappbar.
   Persistenz (Title-JSON in Liste «Budget»):
     {"cfg":"jb","y":2027,"g":"Apriko AG","kt":"6500","v":12345,"n":"Notiz","b":"Bez.","z":"G_VerwIT","man":1}
       v = Budgetwert (Anzeige-Vorzeichen: Aufwand positiv), null/fehlend = Vorschlag gilt
       pos = [{t:"Text", v:Betrag, n:"Notiz"}, …] Einzelpositionen; vorhanden → Konto-Budget = Σ pos
       b/z/man nur bei manuell ergänzten Konten (ohne Ist-Basis)
   Abhängigkeiten aus index.html: cache, fbParse, fbSaveItem, fbIst, fbBudget, fbLoadBuch,
   fbBuchYearCache, FB_PLAN, FB_LABELS, FB_AUFWAND, FB_SRC, fbCompute, fbZuordnung,
   budgetRows, budgetChfOf, budgetIsSaaS, budgetErloes, BUDGET_MONTH_FIELDS,
   deleteItem, reload, escape, toast, render, currentView. */

const JB_VERSION = "1.98.0";
const JB_GES = ["Apriko AG", "Maverix AG"];
const JB_PERSONAL = new Set(["SW_Lohn", "SW_SV", "SW_UebrPA", "BO_Lohn", "BO_SV", "BO_UebrPA"]);
const JB_ERTRAG = new Set(["SW_Ertrag", "BO_Ertrag"]);
const JB_PA_GES = { SW_Lohn: "Maverix AG", SW_SV: "Maverix AG", SW_UebrPA: "Maverix AG", BO_Lohn: "Apriko AG", BO_SV: "Apriko AG", BO_UebrPA: "Apriko AG" };

const jbState = { year: 2027, open: {}, buch: {}, pos: {}, busy: false, onlyChanged: false, q: "" };

/* ---------- Hilfen ---------- */
function jbFkt(key) { return FB_AUFWAND.has(key) ? -1 : 1; }           // bexio → Anzeige
function jbFmt(v) { return Math.round(v) === 0 ? "—" : Math.round(v).toLocaleString("de-CH"); }
function jbNum(v) { const n = parseFloat(String(v == null ? "" : v).replace(/['’\s]/g, "").replace(",", ".")); return isNaN(n) ? null : n; }
function jbItems(year) { return cache.budget.map(it => fbParse(it, "jb")).filter(d => d && d.y == year); }
function jbHochFaktor(p) { return p === "Jahr" ? 1 : p === "H1" || p === "H2" ? 2 : /^Q/.test(String(p)) ? 4 : /^M/.test(String(p)) ? 12 : 2; }
function jbYears() { const s = new Set([2027, new Date().getFullYear() + 1]); jbItems(null); cache.budget.forEach(it => { const d = fbParse(it, "jb"); if (d && d.y) s.add(parseInt(d.y, 10)); }); return [...s].filter(Boolean).sort(); }

/* Ertragsbudget des Zieljahrs: SaaS → SW_Ertrag, BPO → BO_Ertrag, Erlösminderung gesamt (Info) */
function jbErtragsbudget(year) {
  const rows = budgetRows().filter(b => b.BYear == year);
  const tot = b => BUDGET_MONTH_FIELDS.reduce((s, f) => s + budgetChfOf(b, b[f]), 0);
  const saas = rows.filter(budgetIsSaaS).reduce((s, b) => s + tot(b), 0);
  const bpo = rows.filter(b => !budgetIsSaaS(b)).reduce((s, b) => s + tot(b), 0);
  const erloes = budgetErloes(year).reduce((s, v) => s + v, 0);
  return { saas, bpo, erloes, n: rows.length };
}

/* Zeilenmodell: je Position (Key) → Zeilen {g, kt, b, ist, p, hoch, bud, note, id, man, editable} */
function jbBuild(year) {
  const basis = year - 1;
  const ist = fbIst(basis);
  const over = {}; jbItems(year).forEach(d => { over[d.g + "|" + d.kt] = d; });
  const eb = jbErtragsbudget(year);
  const fbY = fbBudget(year);   // fb-Positionen des Zieljahrs (Personalaufwand)
  const byKey = {};
  const push = (key, row) => { (byKey[key] = byKey[key] || []).push(row); };
  // Ist-Konten des Basisjahrs (Konto kann in mehreren Perioden vorkommen → summieren, Faktor je Periode)
  const acc = {};
  ist.forEach(d => {
    if (JB_PERSONAL.has(d.z) || JB_ERTRAG.has(d.z)) return;
    const id = d.g + "|" + d.kt;
    const v = (parseFloat(d.v) || 0) * jbFkt(d.z);
    acc[id] = acc[id] || { key: d.z, g: d.g, kt: d.kt, b: d.b || "", ist: 0, hoch: 0, p: d.p };
    acc[id].ist += v; acc[id].hoch += v * jbHochFaktor(d.p);
    if (d.b) acc[id].b = d.b; if (d.p && d.p !== acc[id].p) acc[id].p = "gemischt";
  });
  Object.values(acc).forEach(r => {
    const o = over[r.g + "|" + r.kt];
    push(r.key, { ...r, id: o ? o.id : null, bud: o && o.v !== null && o.v !== undefined ? parseFloat(o.v) : null, note: o ? (o.n || "") : "", pos: o && Array.isArray(o.pos) ? o.pos : [], man: false, editable: true });
  });
  // Manuell ergänzte Konten (ohne Ist-Basis)
  jbItems(year).forEach(d => {
    if (!d.man) return;
    if (acc[d.g + "|" + d.kt]) return;
    const key = d.z || fbZuordnung(d.kt, d.g === "Apriko AG");
    if (!key || JB_PERSONAL.has(key) || JB_ERTRAG.has(key)) return;
    push(key, { key, g: d.g, kt: d.kt, b: d.b || "", ist: 0, hoch: 0, p: "—", id: d.id, bud: d.v !== null && d.v !== undefined ? parseFloat(d.v) : null, note: d.n || "", pos: Array.isArray(d.pos) ? d.pos : [], man: true, editable: true });
  });
  // Ertrag aus Ertragsbudget (beide Ströme über Apriko AG)
  push("SW_Ertrag", { key: "SW_Ertrag", g: "Apriko AG", kt: "34xx", b: "Ertragsbudget " + year + " · SaaS/Lizenzen", ist: null, hoch: eb.saas, p: "EB", bud: eb.saas, note: "", editable: false, src: "Ertragsbudget" });
  push("BO_Ertrag", { key: "BO_Ertrag", g: "Apriko AG", kt: "3400", b: "Ertragsbudget " + year + " · BPO", ist: null, hoch: eb.bpo, p: "EB", bud: eb.bpo, note: "", editable: false, src: "Ertragsbudget" });
  // Personalaufwand aus fb-Positionen (Menüpunkt Budget Personalaufwand)
  JB_PERSONAL.forEach(k => {
    const v = (fbY[k] || []).reduce((s, x) => s + x, 0);
    push(k, { key: k, g: JB_PA_GES[k], kt: k.endsWith("Lohn") ? "50xx" : k.endsWith("SV") ? "57xx" : "58xx/59xx", b: "Budget Personalaufwand " + year, ist: null, hoch: v, p: "PA", bud: v, note: "", editable: false, src: "Personalaufwand" });
  });
  Object.values(byKey).forEach(a => a.sort((x, y) => (x.g + x.kt).localeCompare(y.g + y.kt)));
  // Ist-Basis je Personal-/Ertragskey zur Info (Hochrechnung Basisjahr)
  const istKey = {};
  ist.forEach(d => { istKey[d.z] = (istKey[d.z] || 0) + (parseFloat(d.v) || 0) * jbFkt(d.z) * jbHochFaktor(d.p); });
  return { basis, byKey, eb, istKey, hasIst: ist.length > 0 };
}
function jbPosSum(r) { return (r.pos || []).reduce((s, p) => s + (parseFloat(p.v) || 0), 0); }
function jbHasPos(r) { return !!(r.pos && r.pos.length); }
function jbRowBudget(r) { if (jbHasPos(r)) return jbPosSum(r); return r.bud !== null && r.bud !== undefined ? r.bud : r.hoch; }

/* ---------- Persistenz ---------- */
async function jbSaveRow(r, patch) {
  const obj = { cfg: "jb", y: jbState.year, g: r.g, kt: r.kt, v: r.bud, n: r.note };
  if (r.pos && r.pos.length) obj.pos = r.pos;
  if (r.man) { obj.man = 1; obj.b = r.b; obj.z = r.key; }
  Object.assign(obj, patch);
  if (obj.v === undefined) obj.v = null;
  jbState.busy = true;
  try { await fbSaveItem(obj, r.id); if (!r.id) await reload("Budget"); } catch (e) { toast("Speichern fehlgeschlagen: " + e.message, true); }
  jbState.busy = false; render();
}
function jbFindRow(g, kt) { const m = jbBuild(jbState.year); for (const rows of Object.values(m.byKey)) { const r = rows.find(x => x.g === g && x.kt === kt && x.editable); if (r) return r; } return null; }
async function jbSetVal(g, kt, value) {
  const r = jbFindRow(g, kt); if (!r) return;
  const v = String(value).trim() === "" ? null : jbNum(value);
  if (v === null && !r.id) return;                      // leer & nie gespeichert → nichts tun
  await jbSaveRow(r, { v });
}
async function jbSetNote(g, kt, value) { const r = jbFindRow(g, kt); if (!r) return; if (!r.id && !String(value).trim()) return; await jbSaveRow(r, { n: String(value).trim() }); }
async function jbResetRow(g, kt) { const r = jbFindRow(g, kt); if (!r || !r.id) return; if (r.man) { if (!confirm("Manuelles Konto " + kt + " entfernen?")) return; jbState.busy = true; try { await deleteItem("Budget", r.id); await reload("Budget"); } catch (e) { toast(e.message, true); } jbState.busy = false; render(); return; } await jbSaveRow(r, { v: null }); }
async function jbAddKonto(key) {
  const g = prompt("Gesellschaft (Apriko AG / Maverix AG):", "Apriko AG"); if (!g) return;
  const ges = JB_GES.find(x => x.toLowerCase().startsWith(g.trim().toLowerCase().slice(0, 3))) || JB_GES[0];
  const kt = prompt("Kontonummer (z.B. 6510):"); if (!kt || !/^\d{3,5}$/.test(kt.trim())) { toast("Ungültige Kontonummer.", true); return; }
  const b = prompt("Bezeichnung:", "") || "";
  const v = jbNum(prompt("Budget " + jbState.year + " (CHF):", "0"));
  jbState.busy = true;
  try { await fbSaveItem({ cfg: "jb", y: jbState.year, g: ges, kt: kt.trim(), b, z: key, man: 1, v: v === null ? 0 : v, n: "" }); await reload("Budget"); }
  catch (e) { toast(e.message, true); }
  jbState.busy = false; render();
}
/* Einzelpositionen je Konto */
async function jbPosAdd(g, kt) {
  const r = jbFindRow(g, kt); if (!r) return;
  const pos = (r.pos || []).concat([{ t: "", v: 0, n: "" }]);
  jbState.pos[g + "|" + kt] = true;
  await jbSaveRow(r, { pos });
  setTimeout(() => { const inps = document.querySelectorAll(`input[data-pos="${g}|${kt}"][data-f="t"]`); const last = inps[inps.length - 1]; if (last) last.focus(); }, 60);
}
async function jbPosSet(g, kt, i, field, value) {
  const r = jbFindRow(g, kt); if (!r || !r.pos || !r.pos[i]) return;
  const pos = r.pos.map(p => ({ ...p }));
  if (field === "v") pos[i].v = jbNum(value) || 0; else pos[i][field] = String(value).trim();
  await jbSaveRow(r, { pos });
}
async function jbPosDel(g, kt, i) {
  const r = jbFindRow(g, kt); if (!r || !r.pos) return;
  const pos = r.pos.filter((p, k) => k !== i);
  if (!pos.length && !confirm("Letzte Position entfernen? Das Konto fällt dann auf Vorschlag/Überschreibung zurück.")) return;
  await jbSaveRow(r, pos.length ? { pos } : { pos: undefined });
}
function jbTogglePos(id) { jbState.pos[id] = !jbState.pos[id]; render(); }
function jbSetYear(y) { jbState.year = parseInt(y, 10); jbState.open = {}; render(); }
function jbToggle(k) { jbState.open[k] = !jbState.open[k]; render(); }
function jbToggleBuch(id) { jbState.buch[id] = !jbState.buch[id]; render(); }

/* Übergabe der Budgetwerte (ohne Personal) in die fb-Positionen des Zieljahrs → Budgetvergleich */
async function jbTransfer() {
  const y = jbState.year, m = jbBuild(y);
  const sums = {};
  Object.entries(m.byKey).forEach(([k, rows]) => { if (JB_PERSONAL.has(k)) return; sums[k] = rows.reduce((s, r) => s + jbRowBudget(r), 0); });
  const keys = Object.keys(sums).filter(k => FB_LABELS[k]);
  if (!confirm("Budgetvergleich " + y + ": " + keys.length + " Positionen (ohne Personalaufwand) überschreiben? Monatsverteilung 1/12.")) return;
  jbState.busy = true; render();
  try {
    const existing = {}; cache.budget.forEach(it => { const d = fbParse(it, "fb"); if (d && d.y == y) existing[d.k] = d.id; });
    const split = v => { const a = Array(12).fill(Math.round(v / 12)); a[11] = Math.round(v) - a.slice(0, 11).reduce((s, x) => s + x, 0); return a; };
    for (const k of keys) await fbSaveItem({ cfg: "fb", y, k, m: split(sums[k]) }, existing[k]);
    await reload("Budget"); toast("Budget " + y + " in den Budgetvergleich übertragen.");
  } catch (e) { toast("Übertragung fehlgeschlagen: " + e.message, true); }
  jbState.busy = false; render();
}
function jbExport() {
  const y = jbState.year, m = jbBuild(y);
  const q = v => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  const lines = [["Position", "Gesellschaft", "Konto", "Bezeichnung", "Ist " + m.basis, "Hochrechnung", "Budget " + y, "Notiz"].map(q).join(";")];
  FB_PLAN.forEach(row => { if (row[0] !== "d" && row[0] !== "d2") return; (FB_SRC[row[1]] || [row[1]]).forEach(k => (m.byKey[k] || []).forEach(r => { lines.push([FB_LABELS[k] || k, r.g, r.kt, r.b, r.ist === null ? "" : Math.round(r.ist), Math.round(r.hoch), Math.round(jbRowBudget(r)), r.note].map(q).join(";")); (r.pos || []).forEach(p => lines.push([FB_LABELS[k] || k, r.g, r.kt, "  └ " + (p.t || ""), "", "", Math.round(p.v || 0), p.n || ""].map(q).join(";"))); })); });
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" })); a.download = "jahresbudget-" + y + ".csv"; a.click();
}

/* ---------- Rendering ---------- */
function renderJahresbudget(el) {
  const y = jbState.year;
  document.getElementById("view-actions").innerHTML = `
    <button class="btn btn-sm" onclick="jbState.onlyChanged=!jbState.onlyChanged;render()" style="${jbState.onlyChanged ? "background:var(--accent);color:#fff" : ""}" title="Nur überschriebene/kommentierte Konten">✎ nur angepasst</button>
    <button class="btn btn-sm" onclick="jbExport()">⇩ CSV</button>
    <button class="btn btn-sm btn-primary" onclick="jbTransfer()" title="Alle Positionen ausser Personalaufwand als fb-Positionen ins Budgetvergleich-Jahr schreiben">→ Budgetvergleich ${y}</button>`;
  if (jbState.busy) { el.innerHTML = `<div class="full-loading"><div class="loading"></div></div>`; return; }
  const m = jbBuild(y), basis = m.basis;
  // Buchungen des Basisjahrs laden (einmalig, dann Re-Render)
  if (!fbBuchYearCache[basis] && typeof siteId !== "undefined" && siteId) fbLoadBuch(basis).then(() => { if (currentView === "jahresbudget") render(); });
  const buchMap = fbBuchYearCache[basis] || {};
  const years = jbYears();
  const q = jbState.q.trim().toLowerCase();
  const hit = r => !q || (r.g + " " + r.kt + " " + r.b + " " + r.note + " " + (FB_LABELS[r.key] || "")).toLowerCase().includes(q);
  const hit2 = r => hit(r) || (r.pos || []).some(p => ((p.t || "") + " " + (p.n || "")).toLowerCase().includes(q));
  const visible = r => hit2(r) && (!jbState.onlyChanged || (r.bud !== null && r.editable) || r.note || jbHasPos(r));

  // Positionswerte (Budget & Hochrechnung) → EBITDA-Kette
  const sumBud = k => (m.byKey[k] || []).reduce((s, r) => s + jbRowBudget(r), 0);
  const sumHoch = k => (m.byKey[k] || []).reduce((s, r) => s + (r.hoch || 0), 0);
  const vb = fbCompute(sumBud), vh = fbCompute(sumHoch);
  const gesBud = g => k => (m.byKey[k] || []).filter(r => r.g === g).reduce((s, r) => s + jbRowBudget(r), 0);
  const vg = {}; JB_GES.forEach(g => vg[g] = fbCompute(gesBud(g)));

  const td = (h, extra) => `<td style="text-align:right;font-family:var(--font-mono);white-space:nowrap;${extra || ""}">${h}</td>`;
  const delta = (b, h) => { const d = b - h; return Math.round(d) === 0 ? "" : `<span style="color:${d > 0 ? "var(--danger)" : "var(--ok, #3a3)"}">${d > 0 ? "+" : ""}${jbFmt(d)}</span>`; };
  const detailRows = key => (m.byKey[key] || []).filter(visible).map(r => {
    const bid = r.g + "|" + r.kt;
    const buch = buchMap[bid] && buchMap[bid].buch && buchMap[bid].buch.length ? buchMap[bid].buch : null;
    const openB = buch && jbState.buch[bid];
    const hasPos = r.editable && jbHasPos(r);
    const openP = hasPos && jbState.pos[bid] !== false || (r.editable && jbState.pos[bid] === true);
    const over = r.editable && r.bud !== null && !hasPos;
    const gi = (g, kt) => `'${escape(g).replace(/'/g, "\\'")}','${escape(kt)}'`;
    return `
      <tr style="border-top:1px solid var(--border-soft);${over ? "background:rgba(127,127,127,.06)" : ""}">
        <td style="padding:4px 6px 4px 34px;font-size:11.5px;white-space:nowrap">${buch ? `<span style="cursor:pointer;color:var(--accent);font-size:9px" onclick="jbToggleBuch('${escape(bid).replace(/'/g, "\\'")}')" title="Buchungen ${basis} ${openB ? "zuklappen" : "anzeigen"}">${openB ? "▼" : "▶"}</span> ` : `<span style="display:inline-block;width:9px"></span> `}<span style="color:var(--text-dim)">${escape(r.g)}</span> · <b>${escape(r.kt)}</b> ${escape(r.b)}${buch ? ` <span style="color:var(--text-faint)">(${buch.length})</span>` : ""}${r.man ? ` <span style="color:var(--text-faint);font-size:10px">manuell</span>` : ""}${r.src ? ` <span style="color:var(--accent);font-size:10px">← ${r.src}</span>` : ""}</td>
        ${td(r.ist === null ? `<span style="color:var(--text-faint)">${r.src ? jbFmt(m.istKey[r.key] || 0) : ""}</span>` : jbFmt(r.ist), "color:var(--text-dim);font-size:11.5px")}
        ${td(`<span style="color:var(--text-dim)">${jbFmt(r.hoch)}</span>`, "font-size:11.5px")}
        <td style="text-align:right;white-space:nowrap">${r.editable
          ? hasPos ? `<span style="font-family:var(--font-mono);font-size:12px;font-weight:600;color:var(--accent)" title="Summe der ${r.pos.length} Einzelpositionen">${jbFmt(jbPosSum(r))}</span> <span style="cursor:pointer;color:var(--accent);font-size:10px" onclick="jbTogglePos('${escape(bid).replace(/'/g, "\\'")}')" title="Einzelpositionen ${openP ? "zuklappen" : "anzeigen"}">${openP ? "▾" : "▸"} ${r.pos.length} Pos.</span>`
            : `<input value="${r.bud === null ? "" : Math.round(r.bud)}" placeholder="${Math.round(r.hoch)}" style="width:100px;text-align:right;font-family:var(--font-mono);font-size:12px;padding:3px 6px;${over ? "font-weight:600;border-color:var(--accent)" : "color:var(--text-dim)"}" title="${over ? "Überschrieben — leeren = zurück zum Vorschlag" : "Vorschlag (Hochrechnung); Wert eintippen zum Überschreiben"}" onchange="jbSetVal(${gi(r.g, r.kt)},this.value)">${over || r.man ? `<span style="cursor:pointer;color:var(--text-faint);margin-left:4px" title="${r.man ? "Konto entfernen" : "Zurück zum Vorschlag"}" onclick="jbResetRow(${gi(r.g, r.kt)})">↺</span>` : ""}`
          : `<span style="font-family:var(--font-mono);font-size:12px">${jbFmt(r.bud)}</span>`}</td>
        ${td(r.editable ? delta(jbRowBudget(r), r.hoch) : "", "font-size:11px")}
        <td style="padding:3px 6px;white-space:nowrap"><div style="display:flex;gap:6px;align-items:center">${r.editable ? `<input value="${escape(r.note)}" placeholder="Notiz …" style="flex:1;min-width:140px;font-size:11.5px;padding:3px 6px;${r.note ? "" : "color:var(--text-faint)"}" onchange="jbSetNote(${gi(r.g, r.kt)},this.value)"><span class="btn btn-sm" style="padding:0 6px;font-size:10px" onclick="jbPosAdd(${gi(r.g, r.kt)})" title="Einzelposition mit Betrag und Notiz ergänzen — das Konto-Budget wird dann aus den Positionen summiert">＋ Position</span>` : ""}</div></td>
      </tr>
      ${r.editable && openP && r.pos && r.pos.length ? r.pos.map((p, i) => `
      <tr style="background:rgba(127,127,127,.04)">
        <td style="padding:2px 6px 2px 58px;font-size:11px"><span style="color:var(--text-faint)">└</span> <input data-pos="${escape(bid)}" data-f="t" value="${escape(p.t || "")}" placeholder="Position (z.B. Google Cloud)" style="width:260px;font-size:11.5px;padding:2px 6px" onchange="jbPosSet(${gi(r.g, r.kt)},${i},'t',this.value)"></td>
        <td></td><td></td>
        <td style="text-align:right;white-space:nowrap"><input data-pos="${escape(bid)}" data-f="v" value="${p.v ? Math.round(p.v) : ""}" placeholder="0" style="width:100px;text-align:right;font-family:var(--font-mono);font-size:11.5px;padding:2px 6px" onchange="jbPosSet(${gi(r.g, r.kt)},${i},'v',this.value)"></td>
        <td></td>
        <td style="padding:2px 6px"><div style="display:flex;gap:6px;align-items:center"><input value="${escape(p.n || "")}" placeholder="Notiz …" style="flex:1;min-width:140px;font-size:11px;padding:2px 6px;${p.n ? "" : "color:var(--text-faint)"}" onchange="jbPosSet(${gi(r.g, r.kt)},${i},'n',this.value)"><span style="cursor:pointer;color:var(--danger);font-size:11px" onclick="jbPosDel(${gi(r.g, r.kt)},${i})" title="Position entfernen">✕</span></div></td>
      </tr>`).join("") : ""}
      ${openB ? buch.map(b => `<tr><td colspan="6" style="padding:2px 8px 2px 58px;font-family:var(--font-mono);font-size:10px;color:var(--text-faint);border-bottom:1px dotted var(--border)">
          <span style="display:inline-block;width:60px">${escape(b[0])}</span><span style="display:inline-block;min-width:280px">${escape(b[1])}</span><span style="display:inline-block;width:90px;text-align:right">${((b[2] || 0) * jbFkt(r.key)).toLocaleString("de-CH", { minimumFractionDigits: 2 })}</span></td></tr>`).join("") : ""}`;
  }).join("");

  const posRow = (key, label, indent, bold, srcKeys) => {
    const keys = srcKeys || [key];
    const n = keys.reduce((s, k) => s + (m.byKey[k] || []).filter(visible).length, 0);
    const changed = keys.reduce((s, k) => s + (m.byKey[k] || []).filter(r => r.editable && (r.bud !== null || r.note || jbHasPos(r))).length, 0);
    const open = jbState.open[key];
    const canAdd = !keys.some(k => JB_PERSONAL.has(k) || JB_ERTRAG.has(k));
    return `
      <tr style="border-top:1px solid var(--border);cursor:pointer;${bold ? "font-weight:600" : ""}" onclick="jbToggle('${key}')">
        <td style="padding:6px 6px 6px ${indent}px;white-space:nowrap"><span style="color:var(--accent);font-size:9px;display:inline-block;width:12px">${n ? (open ? "▼" : "▶") : ""}</span>${escape(label)} <span style="color:var(--text-faint);font-weight:400;font-size:10.5px">${n ? n + " Konten" : ""}${changed ? ` · <span style="color:var(--accent)">${changed} angepasst</span>` : ""}</span>${canAdd && open ? ` <span class="btn btn-sm" style="padding:0 6px;font-size:10px;margin-left:6px" onclick="event.stopPropagation();jbAddKonto('${keys[0]}')" title="Konto ohne Ist-Basis ergänzen">＋ Konto</span>` : ""}</td>
        ${td(`<span style="color:var(--text-faint)">${jbFmt(keys.reduce((s, k) => s + (m.byKey[k] || []).reduce((a, r) => a + (r.ist || 0), 0), 0))}</span>`, "font-size:11.5px")}
        ${td(`<span style="color:var(--text-dim)">${jbFmt(vh[key])}</span>`)}
        ${td(`<b>${jbFmt(vb[key])}</b>`)}
        ${td(delta(vb[key], vh[key]), "font-size:11px")}
        <td style="font-size:10.5px;color:var(--text-faint)">${JB_GES.map(g => `${g.split(" ")[0]} ${jbFmt(vg[g][key])}`).join(" · ")}</td>
      </tr>
      ${open ? keys.map(detailRows).join("") : ""}`;
  };
  const calcRow = (key, label, strong) => `
      <tr style="border-top:2px solid var(--border);${strong ? "font-weight:700" : "font-weight:600"};background:var(--bg-elev)">
        <td style="padding:6px">${escape(label)}</td><td></td>
        ${td(`<span style="color:var(--text-dim)">${jbFmt(vh[key])}</span>`)}${td(jbFmt(vb[key]))}${td(delta(vb[key], vh[key]), "font-size:11px")}
        <td style="font-size:10.5px;color:var(--text-faint)">${JB_GES.map(g => `${g.split(" ")[0]} ${jbFmt(vg[g][key])}`).join(" · ")}</td></tr>`;
  const body = FB_PLAN.map(row => {
    if (row[0] === "d") return posRow(row[1], FB_LABELS[row[1]] || row[1], row[2] ? 22 : 6, false);
    if (row[0] === "d2") return posRow(row[1], row[2], 22, false, row[3]);
    if (row[0] === "g") return `<tr style="border-top:1px solid var(--border);font-weight:600"><td style="padding:6px">${escape(row[2])}</td><td></td>${td(`<span style="color:var(--text-dim)">${jbFmt(vh[row[1]])}</span>`)}${td(jbFmt(vb[row[1]]))}${td(delta(vb[row[1]], vh[row[1]]), "font-size:11px")}<td style="font-size:10.5px;color:var(--text-faint)">${JB_GES.map(g => `${g.split(" ")[0]} ${jbFmt(vg[g][row[1]])}`).join(" · ")}</td></tr>`;
    if (row[0] === "c") return calcRow(row[1], row[1] === "RESULT" ? "Jahresgewinn / (-verlust)" : row[2], ["EBITDA", "RESULT"].includes(row[1]));
    return "";
  }).join("");

  el.innerHTML = `
    <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
      <label style="font-size:12px;color:var(--text-dim)">Budgetjahr <select onchange="jbSetYear(this.value)" style="padding:4px 6px;font-size:12px;margin-left:4px">${years.map(v => `<option ${v === y ? "selected" : ""}>${v}</option>`).join("")}<option value="${Math.max(...years) + 1}">${Math.max(...years) + 1} (neu)</option></select></label>
      <span style="font-size:12px;color:var(--text-dim)">Basis: Ist ${basis}${m.hasIst ? "" : ` <span style="color:var(--danger)">— keine Ist-Daten ${basis} im Budgetvergleich importiert</span>`}</span>
      <input type="search" placeholder="Suche Konto, Bezeichnung, Notiz …" value="${escape(jbState.q)}" style="font-size:12px;padding:4px 8px;width:240px" oninput="jbState.q=this.value;render()">
    </div>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px">
      <div class="card stat-card"><div class="stat-label">Ertrag netto ${y}</div><div class="stat-value">${jbFmt(vb.DLTOT)}</div><div style="font-size:11px;color:var(--text-faint)">Ertragsbudget: SaaS ${jbFmt(m.eb.saas)} · BPO ${jbFmt(m.eb.bpo)}${m.eb.erloes ? ` · Erlösmind. dort ${jbFmt(m.eb.erloes)}` : ""}</div></div>
      <div class="card stat-card"><div class="stat-label">Personalaufwand ${y}</div><div class="stat-value">${jbFmt(vb.PA)}</div><div style="font-size:11px;color:var(--text-faint)">aus Budget Personalaufwand${vb.PA ? "" : " — noch nicht übertragen"}</div></div>
      <div class="card stat-card"><div class="stat-label">Betriebsaufwand ${y}</div><div class="stat-value">${jbFmt(vb.BETRIEB)}</div><div style="font-size:11px;color:var(--text-faint)">Hochrechnung ${basis}: ${jbFmt(vh.BETRIEB)}</div></div>
      <div class="card stat-card"><div class="stat-label">EBITDA ${y}</div><div class="stat-value" style="color:${vb.EBITDA < 0 ? "var(--danger)" : "inherit"}">${jbFmt(vb.EBITDA)}</div><div style="font-size:11px;color:var(--text-faint)">${JB_GES.map(g => `${g.split(" ")[0]} ${jbFmt(vg[g].EBITDA)}`).join(" · ")}</div></div>
    </div>
    <div class="card" style="padding:12px 14px;overflow-x:auto">
      <table style="width:100%;font-size:12.5px;border-collapse:collapse">
        <tr style="color:var(--text-dim);font-size:11px">
          <th style="text-align:left;padding:4px 6px">Position · Gesellschaft · Konto</th>
          <th style="text-align:right;padding:4px 6px">Ist ${basis}<br><span style="font-weight:400">wie importiert</span></th>
          <th style="text-align:right;padding:4px 6px">Hochrechnung<br><span style="font-weight:400">H1 × 2 / Jahr × 1</span></th>
          <th style="text-align:right;padding:4px 6px">Budget ${y}</th>
          <th style="text-align:right;padding:4px 6px">Δ zur Hochr.</th>
          <th style="text-align:left;padding:4px 6px">Notiz / je Gesellschaft</th></tr>
        ${body}
      </table>
      <div style="font-size:10px;color:var(--text-faint);margin-top:8px">Aufwand positiv dargestellt. Positionen aufklappen (▶) zeigt Gesellschaft und Konto; Budgetfeld leer = Vorschlag aus der Hochrechnung gilt, eingetippter Wert überschreibt (↺ setzt zurück), Notiz je Konto. «＋ Position» legt Einzelpositionen (Text, Betrag, Notiz) unter dem Konto an — dann ist das Konto-Budget die Summe der Positionen. ▶ vor einem Konto zeigt die einzelnen Buchungen ${basis}. Ertrag SaaS/BPO kommt aus dem Ertragsbudget ${y}, Personalaufwand aus «Budget Personalaufwand» (beides nur Ansicht). «→ Budgetvergleich ${y}» schreibt alle übrigen Positionen als Budget-Positionen (1/12). · Jahresbudget v${JB_VERSION}</div>
    </div>`;
}
