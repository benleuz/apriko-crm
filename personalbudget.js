/* ============ Budget Personalaufwand (Finanzen) ============
   Passwortgeschützte Erfassung des Personalaufwands pro Mitarbeiter
   und Gesellschaft für ein Budgetjahr. Speicherung in der bestehenden
   SharePoint-Liste «Budget» als JSON im Title-Feld (cfg "pa"):
     {"cfg":"pa","t":"row","y":2027,"n":"Leuzinger","g":"Maverix AG","l":8000,"p":1,"s":6000,"w":1000}
     {"cfg":"pa","t":"cfg","y":2027,"ag":12}          globaler Arbeitgeberbeitrag in %
     {"cfg":"pa","t":"pw","h":"<sha256>"}             Passwort-Hash (einmalig)
   Rechnung je Zeile (wie Vorlage Mappe1):
     Jahreslohn = Lohn × 12 × Pensum · Total Lohn = Jahreslohn × (1 + AG%)
     Total Lohnkosten = Total Lohn + Spesen + Weiterbildung
   Übergabe in den Budgetvergleich (fb-Positionen des Jahres):
     über Kreuz wie fbZuordnung: Apriko AG → BO_Lohn / BO_SV / BO_UebrPA · Maverix AG → SW_*
   Abhängigkeiten aus index.html: cache, fbParse, fbSaveItem, deleteItem,
   reload, escape, toast, render, showModal, closeModal, currentUser. */

const PA_VERSION = "1.110.0";
const PA_GES = ["Apriko AG", "Maverix AG"];
/* Budgetvergleich rechnet Personal ÜBER KREUZ (fbZuordnung): Maverix-Löhne = SW_*, Apriko-Löhne = BO_* */
const PA_FB_KEYS = { "Apriko AG": { lohn: "BO_Lohn", sv: "BO_SV", uebr: "BO_UebrPA" }, "Maverix AG": { lohn: "SW_Lohn", sv: "SW_SV", uebr: "SW_UebrPA" } };
const PA_SALT = "apriko-pa-2026";

const paState = { year: 2027, unlocked: sessionStorage.getItem("pa-unlocked") === "1", busy: false, pwError: "", sort: "g", order: null };
/* Reihenfolge bleibt beim Editieren stabil (kein Springen der Zeilen); neu sortiert wird nur beim
   Hinzufügen eines Mitarbeiters, Jahreswechsel oder Klick auf eine Spaltenüberschrift. */
function paSortRows(rows) { return rows.slice().sort((a, b) => paState.sort === "n" ? String(a.n).localeCompare(String(b.n), "de") : String(a.g).localeCompare(String(b.g)) || String(a.n).localeCompare(String(b.n), "de")); }
function paResort() { paState.order = null; render(); }

/* ---------- Daten ---------- */
function paItems(t) { return cache.budget.map(it => fbParse(it, "pa")).filter(d => d && d.t === t); }
function paRows(year) { return paItems("row").filter(r => r.y == year); }
function paCfg(year) { return paItems("cfg").find(c => c.y == year) || null; }
function paAg(year) { const c = paCfg(year); return c && c.ag !== undefined ? parseFloat(c.ag) : 12; }
function paPw() { return paItems("pw")[0] || null; }
function paYears() { const s = new Set([2027, new Date().getFullYear() + 1]); paItems("row").forEach(r => s.add(parseInt(r.y, 10))); paItems("cfg").forEach(c => s.add(parseInt(c.y, 10))); return [...s].filter(Boolean).sort(); }
function paNum(v) { const n = parseFloat(String(v == null ? "" : v).replace(/['’\s]/g, "").replace(",", ".")); return isNaN(n) ? 0 : n; }
function paFmt(v, dec) { return (Math.round(v * 100) / 100).toLocaleString("de-CH", { minimumFractionDigits: dec == null ? 0 : dec, maximumFractionDigits: dec == null ? 0 : dec }); }
function paCalc(r, ag) {
  const lohn = paNum(r.l), pensum = paNum(r.p), spesen = paNum(r.s), wb = paNum(r.w);
  const jahr = lohn * 12 * pensum, agB = jahr * ag / 100, totalLohn = jahr + agB, total = totalLohn + spesen + wb;
  return { lohn, pensum, spesen, wb, jahr, agB, totalLohn, total };
}
function paSums(rows, ag) {
  const z = () => ({ n: 0, jahr: 0, agB: 0, totalLohn: 0, spesen: 0, wb: 0, total: 0, fte: 0 });
  const out = { gesamt: z() }; PA_GES.forEach(g => out[g] = z());
  rows.forEach(r => { const c = paCalc(r, ag); [out.gesamt, out[r.g] || (out[r.g] = z())].forEach(o => { o.n++; o.jahr += c.jahr; o.agB += c.agB; o.totalLohn += c.totalLohn; o.spesen += c.spesen; o.wb += c.wb; o.total += c.total; o.fte += c.pensum; }); });
  return out;
}

async function paSave(obj, id) { paState.busy = true; try { await fbSaveItem(obj, id); if (!id) await reload("Budget"); } catch (e) { toast("Speichern fehlgeschlagen: " + e.message, true); } paState.busy = false; render(); }
async function paSetField(id, field, value) {
  const r = paItems("row").find(x => x.id == id); if (!r) return;
  const obj = { cfg: "pa", t: "row", y: r.y, n: r.n, g: r.g, l: r.l, p: r.p, s: r.s, w: r.w };
  if (field === "n" || field === "g") obj[field] = String(value || "").trim(); else obj[field] = paNum(value);
  if (field === "p" && obj.p > 1) obj.p = obj.p / 100;   // 80 → 0.8
  await paSave(obj, id);
}
async function paAddRow() {
  paState.order = null;   // beim nächsten Render neu sortieren, neue Zeile ans Ende
  await paSave({ cfg: "pa", t: "row", y: paState.year, n: "", g: PA_GES[0], l: 0, p: 1, s: 0, w: 0 });
  setTimeout(() => { const inp = document.querySelector("#pa-table tr:last-child input[data-f='n']"); if (inp) inp.focus(); }, 50);
}
async function paDeleteRow(id) {
  const r = paItems("row").find(x => x.id == id); if (!r) return;
  if (!confirm("Zeile «" + (r.n || "ohne Name") + "» löschen?")) return;
  paState.busy = true; render();
  try { await deleteItem("Budget", id); await reload("Budget"); } catch (e) { toast("Löschen fehlgeschlagen: " + e.message, true); }
  paState.busy = false; render();
}
async function paSetAg(v) { const c = paCfg(paState.year); await paSave({ cfg: "pa", t: "cfg", y: paState.year, ag: paNum(v) }, c ? c.id : null); }
function paSetYear(y) { paState.year = parseInt(y, 10); paState.order = null; render(); }
async function paCopyYear(from) {
  if (paRows(paState.year).length && !confirm("Jahr " + paState.year + " hat bereits Zeilen. Zeilen aus " + from + " zusätzlich kopieren?")) return;
  paState.busy = true; render();
  try { for (const r of paRows(from)) await fbSaveItem({ cfg: "pa", t: "row", y: paState.year, n: r.n, g: r.g, l: r.l, p: r.p, s: r.s, w: r.w }); if (!paCfg(paState.year)) await fbSaveItem({ cfg: "pa", t: "cfg", y: paState.year, ag: paAg(from) }); await reload("Budget"); toast(paRows(paState.year).length + " Zeilen in " + paState.year); }
  catch (e) { toast("Kopieren fehlgeschlagen: " + e.message, true); }
  paState.busy = false; render();
}

/* ---------- Passwort ---------- */
async function paHash(pw) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(PA_SALT + "|" + String(pw)));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function paUnlock(pw) {
  const p = paPw(); if (!p) return;
  if (await paHash(pw) === p.h) { paState.unlocked = true; paState.pwError = ""; sessionStorage.setItem("pa-unlocked", "1"); }
  else paState.pwError = "Falsches Passwort.";
  render();
}
function paLock() { paState.unlocked = false; sessionStorage.removeItem("pa-unlocked"); render(); }
async function paSetPassword(pw1, pw2, old) {
  const p = paPw();
  if (p && !(currentUser && currentUser.isSuperAdmin) && (await paHash(old || "")) !== p.h) { toast("Bisheriges Passwort falsch.", true); return; }
  if (!pw1 || pw1.length < 6) { toast("Mindestens 6 Zeichen.", true); return; }
  if (pw1 !== pw2) { toast("Passwörter stimmen nicht überein.", true); return; }
  await paSave({ cfg: "pa", t: "pw", h: await paHash(pw1) }, p ? p.id : null);
  paState.unlocked = true; sessionStorage.setItem("pa-unlocked", "1"); closeModal(); toast("Passwort gesetzt."); render();
}
function paPasswordModal() {
  const p = paPw();
  showModal(p ? "Passwort ändern" : "Passwort festlegen", `
    <div style="display:grid;gap:10px;max-width:360px">
      ${p && !(currentUser && currentUser.isSuperAdmin) ? `<label style="font-size:12px;color:var(--text-dim)">Bisheriges Passwort<input id="pa-pw-old" type="password" style="display:block;width:100%;margin-top:4px;padding:6px 8px"></label>` : ""}
      <label style="font-size:12px;color:var(--text-dim)">Neues Passwort (min. 6 Zeichen)<input id="pa-pw-1" type="password" style="display:block;width:100%;margin-top:4px;padding:6px 8px"></label>
      <label style="font-size:12px;color:var(--text-dim)">Wiederholen<input id="pa-pw-2" type="password" style="display:block;width:100%;margin-top:4px;padding:6px 8px"></label>
      <div style="font-size:11px;color:var(--text-faint)">Das Passwort gilt für alle berechtigten Personen gemeinsam und wird nur als Hash gespeichert. Es kann nicht angezeigt, nur neu gesetzt werden.</div>
    </div>`, [
    `<button class="btn" onclick="closeModal()">Abbrechen</button>`,
    `<button class="btn btn-primary" onclick="paSetPassword(document.getElementById('pa-pw-1').value, document.getElementById('pa-pw-2').value, (document.getElementById('pa-pw-old')||{}).value)">Speichern</button>`
  ]);
}

/* ---------- Übergabe in den Budgetvergleich ---------- */
async function paTransfer() {
  const y = paState.year, ag = paAg(y), rows = paRows(y), sums = paSums(rows, ag);
  const lines = PA_GES.map(g => `${g}: Lohnaufwand ${paFmt(sums[g].jahr)} · Arbeitgeberbeiträge ${paFmt(sums[g].agB)} · Übriger PA ${paFmt(sums[g].spesen + sums[g].wb)}`).join("\n");
  if (!confirm("Budget " + y + " im Budgetvergleich überschreiben?\n\n" + lines + "\n\nMonatsverteilung 1/12.")) return;
  paState.busy = true; render();
  try {
    const existing = {}; cache.budget.forEach(it => { const d = fbParse(it, "fb"); if (d && d.y == y) existing[d.k] = d.id; });
    const split = v => { const m = Array(12).fill(Math.round(v / 12)); m[11] = Math.round(v) - m.slice(0, 11).reduce((a, b) => a + b, 0); return m; };
    for (const g of PA_GES) {
      const k = PA_FB_KEYS[g];
      await fbSaveItem({ cfg: "fb", y, k: k.lohn, m: split(sums[g].jahr) }, existing[k.lohn]);
      await fbSaveItem({ cfg: "fb", y, k: k.sv, m: split(sums[g].agB) }, existing[k.sv]);
      await fbSaveItem({ cfg: "fb", y, k: k.uebr, m: split(sums[g].spesen + sums[g].wb) }, existing[k.uebr]);
    }
    await reload("Budget");
    toast("Personalaufwand " + y + " in den Budgetvergleich übertragen.");
  } catch (e) { toast("Übertragung fehlgeschlagen: " + e.message, true); }
  paState.busy = false; render();
}

/* ---------- CSV Export / Import (Aufbau wie Vorlage) ---------- */
function paExport() {
  const y = paState.year, ag = paAg(y);
  const q = v => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  const head = ["Name", "Firma", "Lohn bei 100%", "Pensum", "Jahreslohn", "Spesen", "Weiterbildung", "Arbeitgeberbeiträge", "Total Lohn", "Total Lohnkosten"];
  const lines = [head.map(q).join(";")];
  paRows(y).forEach(r => { const c = paCalc(r, ag); lines.push([r.n, r.g, c.lohn, c.pensum, c.jahr.toFixed(2), c.spesen, c.wb, (ag / 100).toFixed(4), c.totalLohn.toFixed(2), c.total.toFixed(2)].map(q).join(";")); });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" }));
  a.download = "budget-personalaufwand-" + y + ".csv"; a.click();
}
async function paImport(input) {
  const f = input.files && input.files[0]; input.value = ""; if (!f) return;
  const text = await f.text();
  const sep = (text.match(/;/g) || []).length >= (text.match(/,/g) || []).length ? ";" : ",";
  const parse = line => { const out = []; let cur = "", q = false; for (const ch of line) { if (ch === '"') q = !q; else if (ch === sep && !q) { out.push(cur); cur = ""; } else cur += ch; } out.push(cur); return out.map(s => s.trim()); };
  const lines = text.replace(/^\ufeff/, "").split(/\r?\n/).filter(l => l.trim());
  const head = parse(lines[0]).map(h => h.toLowerCase());
  const idx = re => head.findIndex(h => re.test(h));
  const iN = idx(/^name/), iG = idx(/firma|gesellschaft/), iL = idx(/lohn bei|monatslohn/), iP = idx(/pensum/), iS = idx(/spesen/), iW = idx(/weiterbildung/);
  if (iN < 0 || iL < 0) { toast("Spalten «Name» und «Lohn bei 100%» nicht gefunden.", true); return; }
  const rows = lines.slice(1).map(parse).filter(c => c[iN]);
  if (!rows.length) { toast("Keine Zeilen gefunden.", true); return; }
  if (!confirm(rows.length + " Zeilen in Jahr " + paState.year + " importieren (bestehende bleiben)?")) return;
  paState.busy = true; render();
  try {
    for (const c of rows) {
      const g = PA_GES.find(x => x.toLowerCase().startsWith(String(c[iG] || "").toLowerCase().slice(0, 4))) || PA_GES[0];
      let p = iP >= 0 ? paNum(c[iP]) : 1; if (p > 1) p /= 100; if (!p) p = 1;
      await fbSaveItem({ cfg: "pa", t: "row", y: paState.year, n: c[iN], g, l: paNum(c[iL]), p, s: iS >= 0 ? paNum(c[iS]) : 0, w: iW >= 0 ? paNum(c[iW]) : 0 });
    }
    await reload("Budget"); toast(rows.length + " Zeilen importiert.");
  } catch (e) { toast("Import fehlgeschlagen: " + e.message, true); }
  paState.busy = false; render();
}

/* ---------- Rendering ---------- */
function renderPersonalBudget(el) {
  const p = paPw(), admin = !!(currentUser && currentUser.isSuperAdmin);
  document.getElementById("view-actions").innerHTML = paState.unlocked ? `
    <button class="btn btn-sm" onclick="paAddRow()">＋ Mitarbeiter</button>
    <label class="btn btn-sm" style="cursor:pointer">⇪ CSV<input type="file" accept=".csv,.txt" style="display:none" onchange="paImport(this)"></label>
    <button class="btn btn-sm" onclick="paExport()">⇩ CSV</button>
    <button class="btn btn-sm btn-primary" onclick="paTransfer()" title="Summen je Gesellschaft als Lohnaufwand / Arbeitgeberbeiträge / übriger PA ins Budget übertragen">→ Budget ${paState.year}</button>
    <button class="btn btn-sm" onclick="paPasswordModal()" title="Passwort ändern">🔑</button>
    <button class="btn btn-sm" onclick="paLock()" title="Sperren">🔒</button>` : "";
  if (paState.busy) { el.innerHTML = `<div class="full-loading"><div class="loading"></div></div>`; return; }

  // Passwort-Schleuse
  if (!paState.unlocked) {
    if (!p) {
      el.innerHTML = `<div class="card" style="max-width:460px;margin:40px auto;padding:24px;text-align:center">
        <div style="font-size:28px;margin-bottom:8px">🔐</div>
        <div style="font-weight:600;margin-bottom:6px">Passwort noch nicht festgelegt</div>
        ${admin ? `<div style="font-size:12px;color:var(--text-dim);margin-bottom:14px">Als Super-Admin legst du das gemeinsame Passwort für den Personalaufwand einmalig fest.</div><button class="btn btn-primary" onclick="paPasswordModal()">Passwort festlegen</button>`
                : `<div style="font-size:12px;color:var(--text-dim)">Bitte den Super-Admin, das Passwort für diesen Bereich festzulegen.</div>`}
        <div style="font-size:10px;color:var(--text-faint);margin-top:14px">Budget Personalaufwand v${PA_VERSION}</div></div>`;
      return;
    }
    el.innerHTML = `<div class="card" style="max-width:420px;margin:40px auto;padding:24px;text-align:center">
      <div style="font-size:28px;margin-bottom:8px">🔐</div>
      <div style="font-weight:600;margin-bottom:4px">Budget Personalaufwand</div>
      <div style="font-size:12px;color:var(--text-dim);margin-bottom:14px">Dieser Bereich ist zusätzlich passwortgeschützt.</div>
      <form onsubmit="event.preventDefault();paUnlock(document.getElementById('pa-pw').value)" style="display:flex;gap:8px;justify-content:center">
        <input id="pa-pw" type="password" placeholder="Passwort" autofocus style="padding:7px 10px;width:200px">
        <button class="btn btn-primary" type="submit">Öffnen</button></form>
      ${paState.pwError ? `<div style="color:var(--danger);font-size:12px;margin-top:10px">${escape(paState.pwError)}</div>` : ""}
      ${admin ? `<div style="margin-top:14px"><button class="btn btn-sm" onclick="paPasswordModal()">Passwort neu setzen (Super-Admin)</button></div>` : ""}
      <div style="font-size:10px;color:var(--text-faint);margin-top:14px">Gilt für diese Sitzung · Budget Personalaufwand v${PA_VERSION}</div></div>`;
    setTimeout(() => { const i = document.getElementById("pa-pw"); if (i) i.focus(); }, 30);
    return;
  }

  const y = paState.year, ag = paAg(y);
  let rows = paRows(y);
  const ids = rows.map(r => String(r.id));
  if (!paState.order || paState.order.some(id => !ids.includes(id))) {
    // Neu sortieren; noch unbekannte (neue) Zeilen ans Ende
    const known = paState.order ? paState.order.filter(id => ids.includes(id)) : [];
    const base = paState.order ? rows.filter(r => known.includes(String(r.id))) : rows.filter(r => String(r.n || "").trim());
    const sortedKnown = paSortRows(base).map(r => String(r.id));
    const fresh = ids.filter(id => !sortedKnown.includes(id));   // neue/leere Zeilen ans Ende
    paState.order = sortedKnown.concat(fresh);
  } else if (paState.order.length !== ids.length) {
    paState.order = paState.order.concat(ids.filter(id => !paState.order.includes(id)));
  }
  rows.sort((a, b) => paState.order.indexOf(String(a.id)) - paState.order.indexOf(String(b.id)));
  const sums = paSums(rows, ag);
  const years = paYears();
  const inp = (r, f, v, w, extra) => `<input data-f="${f}" value="${escape(v)}" style="width:${w}px;padding:4px 6px;font-size:12px;text-align:${f === "n" ? "left" : "right"}" ${extra || ""} onchange="paSetField(${r.id},'${f}',this.value)">`;
  const td = (h, al) => `<td style="padding:5px 6px;white-space:nowrap;text-align:${al || "right"};font-family:var(--font-mono)">${h}</td>`;
  const tot = (label, o, strong) => `<tr style="border-top:2px solid var(--border);${strong ? "font-weight:700" : "font-weight:600;color:var(--text-dim)"}">
      <td style="padding:6px" colspan="2">${escape(label)} <span style="font-weight:400;font-size:11px;color:var(--text-faint)">(${o.n} MA · ${paFmt(o.fte, 2)} FTE)</span></td>
      <td></td>${td(paFmt(o.fte, 2))}${td(paFmt(o.jahr))}${td(paFmt(o.spesen))}${td(paFmt(o.wb))}${td(paFmt(o.agB))}${td(paFmt(o.totalLohn))}${td("<b>" + paFmt(o.total) + "</b>")}<td></td></tr>`;
  el.innerHTML = `
    <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:14px">
      <label style="font-size:12px;color:var(--text-dim)">Budgetjahr <select onchange="paSetYear(this.value)" style="padding:4px 6px;font-size:12px;margin-left:4px">${years.map(v => `<option ${v === y ? "selected" : ""}>${v}</option>`).join("")}<option value="${Math.max(...years) + 1}">${Math.max(...years) + 1} (neu)</option></select></label>
      <label style="font-size:12px;color:var(--text-dim)">Arbeitgeberbeiträge <input type="number" step="0.1" value="${ag}" style="width:64px;padding:4px 6px;font-size:12px;margin-left:4px;text-align:right" onchange="paSetAg(this.value)"> % <span style="color:var(--text-faint)">(gilt für alle Mitarbeitenden)</span></label>
      ${!rows.length && years.some(v => v !== y && paRows(v).length) ? `<span style="font-size:12px;color:var(--text-dim)">Leer — <a href="#" onclick="paCopyYear(${years.filter(v => v !== y && paRows(v).length).pop()});return false" style="color:var(--accent)">Zeilen aus ${years.filter(v => v !== y && paRows(v).length).pop()} übernehmen</a></span>` : ""}
    </div>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px">
      ${PA_GES.map(g => `<div class="card stat-card"><div class="stat-label">${escape(g)} · Lohnkosten</div><div class="stat-value">${paFmt(sums[g].total)}</div><div style="font-size:11px;color:var(--text-faint)">${sums[g].n} MA · ${paFmt(sums[g].fte, 2)} FTE</div></div>`).join("")}
      <div class="card stat-card"><div class="stat-label">Total Lohnkosten ${y}</div><div class="stat-value">${paFmt(sums.gesamt.total)}</div><div style="font-size:11px;color:var(--text-faint)">${sums.gesamt.n} MA · ${paFmt(sums.gesamt.fte, 2)} FTE</div></div>
    </div>
    <div class="card" style="padding:12px 14px;overflow-x:auto">
      <table id="pa-table" style="width:100%;font-size:12px;border-collapse:collapse">
        <tr style="color:var(--text-dim);font-size:11px">
          <th style="text-align:left;padding:4px 6px;cursor:pointer" title="Nach Name sortieren" onclick="paState.sort='n';paResort()">Name ${paState.sort === "n" ? "▾" : ""}</th>
          <th style="text-align:left;padding:4px 6px;cursor:pointer" title="Nach Firma sortieren" onclick="paState.sort='g';paResort()">Firma ${paState.sort === "g" ? "▾" : ""}</th>
          <th style="text-align:right;padding:4px 6px">Lohn bei 100 %<br><span style="font-weight:400">pro Monat</span></th>
          <th style="text-align:right;padding:4px 6px">Pensum</th>
          <th style="text-align:right;padding:4px 6px">Jahreslohn<br><span style="font-weight:400">Lohn × 12 × Pensum</span></th>
          <th style="text-align:right;padding:4px 6px">Spesen</th>
          <th style="text-align:right;padding:4px 6px">Weiterbildung</th>
          <th style="text-align:right;padding:4px 6px">Arbeitgeber-<br>beiträge ${ag} %</th>
          <th style="text-align:right;padding:4px 6px">Total Lohn</th>
          <th style="text-align:right;padding:4px 6px">Total Lohnkosten</th><th></th></tr>
        ${rows.length ? rows.map(r => { const c = paCalc(r, ag); return `<tr style="border-top:1px solid var(--border-soft)">
          <td style="padding:4px 6px">${inp(r, "n", r.n, 160)}</td>
          <td style="padding:4px 6px"><select style="padding:4px 6px;font-size:12px" onchange="paSetField(${r.id},'g',this.value)">${PA_GES.map(g => `<option ${g === r.g ? "selected" : ""}>${g}</option>`).join("")}</select></td>
          <td style="padding:4px 6px;text-align:right">${inp(r, "l", c.lohn, 90, 'type="number" step="50"')}</td>
          <td style="padding:4px 6px;text-align:right">${inp(r, "p", c.pensum, 60, 'type="number" step="0.05" min="0" max="1" title="1 = 100 %, 0.8 = 80 % (80 wird zu 0.8)"')}</td>
          ${td(paFmt(c.jahr))}
          <td style="padding:4px 6px;text-align:right">${inp(r, "s", c.spesen, 80, 'type="number" step="100"')}</td>
          <td style="padding:4px 6px;text-align:right">${inp(r, "w", c.wb, 80, 'type="number" step="100"')}</td>
          ${td(paFmt(c.agB))}${td(paFmt(c.totalLohn))}${td("<b>" + paFmt(c.total) + "</b>")}
          <td style="padding:4px 6px;text-align:right"><button class="btn btn-sm" style="color:var(--danger)" onclick="paDeleteRow(${r.id})" title="Zeile löschen">✕</button></td></tr>`; }).join("")
        : `<tr><td colspan="11" class="empty">Noch keine Mitarbeitenden für ${y}. «＋ Mitarbeiter» oder CSV-Import (Spalten wie Vorlage: Name; Firma; Lohn bei 100%; Pensum; Spesen; Weiterbildung).</td></tr>`}
        ${rows.length ? PA_GES.filter(g => sums[g].n).map(g => tot("Total " + g, sums[g])).join("") + tot("Total Lohnkosten " + y, sums.gesamt, true) : ""}
      </table>
      <div style="font-size:10px;color:var(--text-faint);margin-top:8px">Jahreslohn = Lohn × 12 × Pensum · Total Lohn = Jahreslohn + Arbeitgeberbeiträge · Total Lohnkosten = Total Lohn + Spesen + Weiterbildung. «→ Budget ${y}» schreibt je Gesellschaft Lohnaufwand (Σ Jahreslohn), Arbeitgeberbeiträge (Σ AG-Beiträge) und übrigen Personalaufwand (Σ Spesen + Weiterbildung) in den Budgetvergleich, Monatsverteilung 1/12. · Budget Personalaufwand v${PA_VERSION}</div>
    </div>`;
}
