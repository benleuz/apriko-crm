/* ============ Budgetpositionen (Finanzen) ============
   Erfassung der Budgetpositionen pro Gesellschaft mit Fälligkeit und
   Jahresübersicht (12 Monate) — Grundlage für den Liquiditätsplan.
   Datenbestand = die Einzelpositionen des Jahresbudgets (jb-Items, Feld pos);
   hier zusätzlich je Position:
     f  = Fälligkeit: "m" monatlich (÷12) · "q" quartalsweise (÷4) · "e" einmalig
          · "h" halbjährlich (÷2) · "r" Monat von–bis (gleichmässig)
     sm = erster Monat (1–12) für q/e/h/r · em = letzter Monat für r
   v ist immer der JAHRESBETRAG.
   Abhängigkeiten: jahresbudget.js (jbBuild, jbSaveRow, jbFindRow, jbPos*, jbFmt, jbNum, JB_*),
   index.html (fbSaveItem, reload, escape, toast, render, FB_PLAN, FB_LABELS, FB_SRC). */

const BP_VERSION = "1.110.0";
const BP_MONATE = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
const BP_FAELL = [["m", "monatlich (÷12)"], ["q", "quartalsweise (÷4)"], ["e", "einmalig im Monat"], ["h", "halbjährlich (÷2)"], ["r", "von – bis"]];

const bpState = { year: 2027, ges: "Apriko AG", q: "", showEmpty: true, open: {}, buch: {} };
/* Vorjahres-Buchungen je Monat summieren (Datum «dd.mm.yy» oder «dd.mm.yyyy» in b[0]) */
function bpBuchMonate(buch, fkt) {
  const out = Array(12).fill(0); let rest = 0;
  (buch || []).forEach(b => { const m = /^\s*\d{1,2}\.(\d{1,2})\./.exec(String(b[0] || "")); const v = (parseFloat(b[2]) || 0) * fkt; if (m) { const mi = parseInt(m[1], 10) - 1; if (mi >= 0 && mi < 12) out[mi] += v; else rest += v; } else rest += v; });
  return { m: out, rest };
}
function bpToggleBuch(id) { bpState.buch[id] = !bpState.buch[id]; render(); }

/* Monatsverteilung einer Position (Jahresbetrag v) */
function bpMonths(p) {
  const v = parseFloat(p.v) || 0, f = p.f || "m";
  const sm = Math.min(12, Math.max(1, parseInt(p.sm, 10) || 1)), em = Math.min(12, Math.max(sm, parseInt(p.em, 10) || 12));
  const out = Array(12).fill(0);
  const put = (idx, amt) => { out[idx] += amt; };
  const spread = (idxs, total) => { const each = Math.round(total / idxs.length * 100) / 100; idxs.forEach((i, k) => put(i, k === idxs.length - 1 ? Math.round((total - each * (idxs.length - 1)) * 100) / 100 : each)); };
  if (f === "e") put(sm - 1, v);
  else if (f === "q") spread([0, 3, 6, 9].map(o => ((sm - 1 + o) % 12)), v);
  else if (f === "h") spread([0, 6].map(o => ((sm - 1 + o) % 12)), v);
  else if (f === "r") spread(Array.from({ length: em - sm + 1 }, (_, k) => sm - 1 + k), v);
  else spread(Array.from({ length: 12 }, (_, k) => k), v);
  return out;
}
function bpFaellText(p) {
  const f = p.f || "m", sm = parseInt(p.sm, 10) || 1, em = parseInt(p.em, 10) || 12;
  if (f === "e") return BP_MONATE[sm - 1];
  if (f === "q") return [0, 3, 6, 9].map(o => BP_MONATE[(sm - 1 + o) % 12]).join("/");
  if (f === "h") return [0, 6].map(o => BP_MONATE[(sm - 1 + o) % 12]).join("/");
  if (f === "r") return BP_MONATE[sm - 1] + "–" + BP_MONATE[em - 1];
  return "Jan–Dez";
}

/* Konten der gewählten Gesellschaft (Aufwand & Erlösminderung; Ertrag/Personal ausgenommen) in ER-Reihenfolge */
function bpRows(year, ges) {
  const m = jbBuild(year);
  const out = [];
  FB_PLAN.forEach(row => {
    if (row[0] !== "d" && row[0] !== "d2") return;
    (FB_SRC[row[1]] || [row[1]]).forEach(k => (m.byKey[k] || []).forEach(r => { if (r.editable && jbSameGes(r.g, ges)) out.push({ ...r, posLabel: FB_LABELS[k] || k }); }));
  });
  return { rows: out, model: m };
}

async function bpPosSet(g, kt, i, field, value) {
  const r = jbFindRow(g, kt); if (!r || !r.pos || !r.pos[i]) return;
  const pos = r.pos.map(p => ({ ...p }));
  if (field === "v") pos[i].v = jbNum(value) || 0;
  else if (field === "sm" || field === "em") pos[i][field] = Math.min(12, Math.max(1, parseInt(value, 10) || 1));
  else pos[i][field] = String(value).trim();
  if (field === "f") { if (!pos[i].sm) pos[i].sm = 1; if (value === "r" && !pos[i].em) pos[i].em = 12; }
  await jbSaveRow(r, { pos });
}
async function bpPosAdd(g, kt) {
  const r = jbFindRow(g, kt); if (!r) return;
  bpState.open[g + "|" + kt] = true;
  await jbSaveRow(r, { pos: (r.pos || []).concat([{ t: "", v: 0, n: "", f: "m", sm: 1 }]) });
  setTimeout(() => { const inps = document.querySelectorAll(`input[data-bp="${g}|${kt}"]`); const last = inps[inps.length - 1]; if (last) last.focus(); }, 60);
}
async function bpAddKonto() {
  const kt = prompt("Kontonummer gemäss Abacus (z.B. 6510):"); if (!kt || !/^\d{3,5}$/.test(kt.trim())) { if (kt) toast("Ungültige Kontonummer.", true); return; }
  const b = prompt("Bezeichnung:", "") || "";
  const key = fbZuordnung(kt.trim(), jbSameGes(bpState.ges, "Apriko AG"));
  const istG = fbIst(bpState.year - 1).map(d => d.g).find(x => jbSameGes(x, bpState.ges)) || bpState.ges;
  if (!key || JB_PERSONAL.has(key) || JB_ERTRAG.has(key)) { toast("Konto " + kt + " gehört zu Ertrag/Personal — dort wird nicht manuell budgetiert.", true); return; }
  jbState.year = bpState.year;
  try { await fbSaveItem({ cfg: "jb", y: bpState.year, g: istG, kt: kt.trim(), b, z: key, man: 1, v: 0, n: "", pos: [{ t: "", v: 0, n: "", f: "m", sm: 1 }] }); await reload("Budget"); }
  catch (e) { toast(e.message, true); }
  render();
}
function bpToggle(id) { bpState.open[id] = !bpState.open[id]; render(); }
function bpToggleAll(open) { bpState.open = {}; if (open) bpRows(bpState.year, bpState.ges).rows.forEach(r => { bpState.open[r.g + "|" + r.kt] = true; }); render(); }
function bpSetGes(g) { bpState.ges = g; bpState.open = {}; render(); }
function bpSetYear(y) { bpState.year = parseInt(y, 10); jbState.year = bpState.year; render(); }
function bpExport() {
  const { rows } = bpRows(bpState.year, bpState.ges);
  const q = v => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  const lines = [["Gesellschaft", "Position", "Konto", "Bezeichnung", "Text", "Fälligkeit", "Jahresbetrag", ...BP_MONATE, "Notiz"].map(q).join(";")];
  rows.forEach(r => (r.pos || []).forEach(p => { const mo = bpMonths(p); lines.push([r.g, r.posLabel, r.kt, r.b, p.t || "", bpFaellText(p), Math.round(p.v || 0), ...mo.map(x => Math.round(x)), p.n || ""].map(q).join(";")); }));
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" })); a.download = "budgetpositionen-" + bpState.year + "-" + bpState.ges.replace(/\s+/g, "_") + ".csv"; a.click();
}

/* ---------- Rendering ---------- */
function renderBudgetpositionen(el) {
  jbState.year = bpState.year;
  document.getElementById("view-actions").innerHTML = `
    <button class="btn btn-sm" onclick="bpAddKonto()">＋ Konto</button>
    <button class="btn btn-sm" onclick="bpState.showEmpty=!bpState.showEmpty;render()" style="${bpState.showEmpty ? "" : "background:var(--accent);color:#fff"}" title="Nur Konten ohne Positionen (noch offen) zeigen">⚠ nur offene</button>
    <button class="btn btn-sm" onclick="bpToggleAll(true)" title="Alle Konten aufklappen">▾ alle</button>
    <button class="btn btn-sm" onclick="bpToggleAll(false)" title="Alle Konten zuklappen">▸ alle</button>
    <button class="btn btn-sm" onclick="bpExport()">⇩ CSV</button>`;
  if (jbState.busy) { el.innerHTML = `<div class="full-loading"><div class="loading"></div></div>`; return; }
  const y = bpState.year, ges = bpState.ges;
  const { rows, model } = bpRows(y, ges);
  const basis = y - 1;
  if (!fbBuchYearCache[basis] && typeof siteId !== "undefined" && siteId) fbLoadBuch(basis).then(() => { if (currentView === "budgetpos") render(); });
  const buchMap = fbBuchYearCache[basis] || {};
  const q = bpState.q.trim().toLowerCase();
  const hit = r => !q || (r.kt + " " + r.b + " " + r.posLabel + " " + (r.pos || []).map(p => (p.t || "") + " " + (p.n || "")).join(" ")).toLowerCase().includes(q);
  const shown = rows.filter(r => hit(r) && (bpState.showEmpty || !jbHasPos(r)));
  const years = jbYears();
  const gi = (g, kt) => `'${escape(g).replace(/'/g, "\\'")}','${escape(kt)}'`;
  const fmt = v => Math.round(v) === 0 ? "" : Math.round(v).toLocaleString("de-CH");
  const tdm = (v, extra) => `<td style="text-align:right;font-family:var(--font-mono);font-size:10.5px;padding:2px 4px;white-space:nowrap;${extra || ""}">${fmt(v)}</td>`;

  const totalM = Array(12).fill(0);   // Monatssummen über alle Konten (Positionen, sonst Vorschlag/Überschreibung ÷12)
  let totalJahr = 0, posCount = 0;
  let lastPos = null;
  const body = shown.map(r => {
    const kontoM = Array(12).fill(0);
    if (jbHasPos(r)) r.pos.forEach(p => bpMonths(p).forEach((v, i) => kontoM[i] += v));
    // ohne Positionen: 0 (offen)
    kontoM.forEach((v, i) => totalM[i] += v); const kontoJahr = kontoM.reduce((s, v) => s + v, 0); totalJahr += kontoJahr; posCount += (r.pos || []).length;
    const posHead = r.posLabel !== lastPos ? `<tr><td colspan="19" style="padding:8px 6px 3px;font-size:11px;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:.04em;border-top:1px solid var(--border)">${escape(r.posLabel)}</td></tr>` : "";
    lastPos = r.posLabel;
    const bid = r.g + "|" + r.kt, open = !!bpState.open[bid];
    const buch = buchMap[bid] && buchMap[bid].buch && buchMap[bid].buch.length ? buchMap[bid].buch : null;
    const openB = buch && bpState.buch[bid];
    const kontoRow = `
      <tr style="border-top:1px solid var(--border-soft);background:var(--bg-elev);cursor:pointer" onclick="bpToggle('${escape(bid).replace(/'/g, "\\'")}')" title="Klicken: Positionen ${open ? "zuklappen" : "aufklappen"}">
        <td style="padding:4px 6px;white-space:nowrap;font-weight:600"><span style="display:inline-block;width:12px;color:var(--accent);font-size:9px">${open ? "▼" : "▶"}</span>${escape(r.kt)} <span style="font-weight:400">${escape(r.b)}</span>${r.man ? ` <span style="color:var(--text-faint);font-size:10px">manuell</span>` : ""}</td>
        <td colspan="3" style="padding:4px 6px;font-size:11px;color:var(--text-faint);white-space:nowrap">${jbHasPos(r) ? r.pos.length + " Pos." : `<span style="color:var(--warn)" title="Noch keine Positionen — zählt mit 0">⚠ offen</span>`}
          <span style="margin-left:8px" title="Ist ${basis} (wie importiert) → Hochrechnung">Ist ${basis}: ${r.ist === null ? "—" : jbFmt(r.ist)} → ${jbFmt(r.hoch)}</span>
          ${buch ? ` <span style="cursor:pointer;color:var(--accent);margin-left:6px" onclick="event.stopPropagation();bpToggleBuch('${escape(bid).replace(/'/g, "\\'")}')" title="Buchungen ${basis} ${openB ? "zuklappen" : "anzeigen"}">${openB ? "▼" : "▶"} ${buch.length} Buchungen ${basis}</span>` : ""}</td>
        <td></td>
        ${kontoM.map(v => tdm(v, "font-weight:600")).join("")}
        ${tdm(kontoJahr, "font-weight:700")}
        <td style="padding:2px 6px;white-space:nowrap"><span class="btn btn-sm" style="padding:0 6px;font-size:10px" onclick="event.stopPropagation();bpPosAdd(${gi(r.g, r.kt)})">＋ Position</span></td>
      </tr>`;
    const posRows = (r.pos || []).map((p, i) => {
      const mo = bpMonths(p), f = p.f || "m";
      const sel = (field, from, to, val) => `<select style="font-size:10.5px;padding:1px 2px" onchange="bpPosSet(${gi(r.g, r.kt)},${i},'${field}',this.value)">${Array.from({ length: to - from + 1 }, (_, k) => from + k).map(mm => `<option value="${mm}" ${mm === val ? "selected" : ""}>${BP_MONATE[mm - 1]}</option>`).join("")}</select>`;
      return `
      <tr>
        <td style="padding:2px 6px 2px 22px"><input data-bp="${escape(r.g + "|" + r.kt)}" value="${escape(p.t || "")}" placeholder="Text (z.B. Google Cloud)" style="width:100%;min-width:180px;font-size:11.5px;padding:2px 6px" onchange="bpPosSet(${gi(r.g, r.kt)},${i},'t',this.value)"></td>
        <td style="padding:2px 6px"><input value="${escape(p.n || "")}" placeholder="Notiz …" style="width:100%;min-width:160px;font-size:11px;padding:2px 6px;${p.n ? "" : "color:var(--text-faint)"}" onchange="bpPosSet(${gi(r.g, r.kt)},${i},'n',this.value)"></td>
        <td style="padding:2px 4px;white-space:nowrap"><select style="font-size:10.5px;padding:1px 2px" onchange="bpPosSet(${gi(r.g, r.kt)},${i},'f',this.value)">${BP_FAELL.map(([k, l]) => `<option value="${k}" ${k === f ? "selected" : ""}>${l}</option>`).join("")}</select>
          ${f === "e" || f === "q" || f === "h" ? ` ${sel("sm", 1, 12, parseInt(p.sm, 10) || 1)}` : f === "r" ? ` ${sel("sm", 1, 12, parseInt(p.sm, 10) || 1)}–${sel("em", 1, 12, parseInt(p.em, 10) || 12)}` : ""}</td>
        <td style="text-align:right;white-space:nowrap"><input value="${p.v ? Math.round(p.v) : ""}" placeholder="Jahr" title="Jahresbetrag" style="width:84px;text-align:right;font-family:var(--font-mono);font-size:11.5px;padding:2px 6px" onchange="bpPosSet(${gi(r.g, r.kt)},${i},'v',this.value)"></td>
        <td style="font-size:10px;color:var(--text-faint);white-space:nowrap;padding:2px 4px">${bpFaellText(p)}</td>
        ${mo.map(v => tdm(v, "color:var(--text-dim)")).join("")}
        ${tdm(mo.reduce((s, v) => s + v, 0), "color:var(--text-dim)")}
        <td style="padding:2px 6px;text-align:center"><span style="cursor:pointer;color:var(--danger);font-size:11px" onclick="jbPosDel(${gi(r.g, r.kt)},${i})" title="Position entfernen">✕</span></td>
      </tr>`;
    }).join("");
    const vj = buch ? bpBuchMonate(buch, jbFkt(r.key)) : null;
    const vjRow = vj ? `
      <tr style="background:rgba(127,127,127,.04)">
        <td style="padding:2px 6px 2px 22px;font-size:10.5px;color:var(--text-faint);white-space:nowrap">Vorjahr ${basis} nach Monat <span style="opacity:.7">(${buch.length} Buchungen${vj.rest ? ", ohne Datum " + jbFmt(vj.rest) : ""})</span></td>
        <td></td><td></td><td></td><td></td>
        ${vj.m.map(v => tdm(v, "color:var(--text-faint);font-style:italic")).join("")}
        ${tdm(vj.m.reduce((s, v) => s + v, 0) + vj.rest, "color:var(--text-faint);font-style:italic")}
        <td></td>
      </tr>` : "";
    const buchRows = openB ? buch.map(b => `<tr><td colspan="19" style="padding:2px 8px 2px 40px;font-family:var(--font-mono);font-size:10px;color:var(--text-faint);border-bottom:1px dotted var(--border)">
          <span style="display:inline-block;width:60px">${escape(b[0])}</span><span style="display:inline-block;min-width:280px">${escape(b[1])}</span><span style="display:inline-block;width:90px;text-align:right">${((b[2] || 0) * jbFkt(r.key)).toLocaleString("de-CH", { minimumFractionDigits: 2 })}</span></td></tr>`).join("") : "";
    return posHead + kontoRow + vjRow + buchRows + (open ? posRows : "");
  }).join("");

  el.innerHTML = `
    <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
      <div style="display:flex;gap:4px">${JB_GES.map(g => `<button class="btn btn-sm" style="${jbSameGes(g, ges) ? "background:var(--accent);color:#fff" : ""}" onclick="bpSetGes('${g}')">${escape(g)}</button>`).join("")}</div>
      <label style="font-size:12px;color:var(--text-dim)">Budgetjahr <select onchange="bpSetYear(this.value)" style="padding:4px 6px;font-size:12px;margin-left:4px">${years.map(v => `<option ${v === y ? "selected" : ""}>${v}</option>`).join("")}</select></label>
      <input type="search" placeholder="Suche Konto, Text, Notiz …" value="${escape(bpState.q)}" style="font-size:12px;padding:4px 8px;width:220px" oninput="bpState.q=this.value;render()">
      ${model.hasIst ? "" : `<span style="font-size:12px;color:var(--danger)">Keine Ist-Daten ${y - 1} — Konten stammen nur aus manuellen Ergänzungen</span>`}
    </div>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px">
      <div class="card stat-card"><div class="stat-label">${escape(ges)} · Aufwand ${y}</div><div class="stat-value">${jbFmt(totalJahr)}</div><div style="font-size:11px;color:var(--text-faint)">${shown.length} Konten · ${posCount} Positionen${(() => { const o = rows.filter(r => !jbHasPos(r)).length; return o ? ` · <span style="color:var(--warn)">${o} offen</span>` : " · alle erfasst"; })()}</div></div>
      <div class="card stat-card"><div class="stat-label">Ø pro Monat</div><div class="stat-value">${jbFmt(totalJahr / 12)}</div><div style="font-size:11px;color:var(--text-faint)">Spitze ${BP_MONATE[totalM.indexOf(Math.max(...totalM))]} ${jbFmt(Math.max(...totalM))}</div></div>
    </div>
    <div class="card" style="padding:12px 14px;overflow-x:auto">
      <table style="width:100%;font-size:12px;border-collapse:collapse">
        <tr style="color:var(--text-dim);font-size:10.5px">
          <th style="text-align:left;padding:4px 6px">Konto (Abacus) · Text</th>
          <th style="text-align:left;padding:4px 6px">Notiz</th>
          <th style="text-align:left;padding:4px 4px">Fällt an</th>
          <th style="text-align:right;padding:4px 6px">Betrag/Jahr</th>
          <th style="text-align:left;padding:4px 4px">Monate</th>
          ${BP_MONATE.map(mn => `<th style="text-align:right;padding:4px 4px">${mn}</th>`).join("")}
          <th style="text-align:right;padding:4px 4px">Total</th>
          <th></th></tr>
        ${body || `<tr><td colspan="19" class="empty">Keine Konten für ${escape(ges)} ${y}. Ist-Daten ${y - 1} importieren oder «＋ Konto».</td></tr>`}
        <tr style="border-top:2px solid var(--border);font-weight:700;background:var(--bg-elev)">
          <td style="padding:6px">Total ${escape(ges)}</td><td></td><td></td><td></td><td></td>
          ${totalM.map(v => tdm(v)).join("")}${tdm(totalJahr)}<td></td></tr>
      </table>
      <div style="font-size:10px;color:var(--text-faint);margin-top:8px">Alle Beträge positiv (Aufwand wie Erlösminderung), negativ = Gutschrift. Betrag = Jahresbetrag; die Fälligkeit verteilt ihn auf die Monate (monatlich ÷12, quartalsweise ÷4 ab gewähltem Monat, einmalig, halbjährlich ÷2, von–bis gleichmässig). Konto-Zeile anklicken (▶) zeigt die Positionen; «＋ Position» klappt automatisch auf. Die kursive Zeile «Vorjahr nach Monat» verteilt die Vorjahresbuchungen auf die Monate (Ist, nicht hochgerechnet); «▶ n Buchungen» zeigt sie einzeln. Konten ohne Positionen sind «⚠ offen» und zählen mit 0 — die Zeile «Vorjahr nach Monat» und «Ist → Hochrechnung» helfen beim Erfassen. Positionen und Beträge sind dieselben wie im Jahresbudget — Änderungen wirken in beiden Ansichten. Die Monatssummen unten sind die Aufwand-Seite des künftigen Liquiditätsplans. · Budgetpositionen v${BP_VERSION}</div>
    </div>`;
}
