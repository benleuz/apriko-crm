/* ============ Gastroführer (Spielwiese) ============
   Kriterien 1–5 gewichten («egal» = nicht gewertet) und als
   Netzdiagramm (Radar) darstellen. Mehrere Profile lassen sich
   anlegen und überlagern (z.B. eigenes Wunschprofil vs. Restaurant).
   Speicherung lokal im Browser (localStorage). */

const GF_VERSION = "1.90.0";
const GF_KRITERIEN = [
  { id: "preis", label: "Preisniveau" },
  { id: "ambiente", label: "Ambiente" },
  { id: "wein", label: "Weinkarte" },
  { id: "essen", label: "Essen" },
  { id: "sehen", label: "Sehen und gesehen werden" },
  { id: "opt1", label: "Weitere Option 1" },
  { id: "opt2", label: "Weitere Option 2" }
];
const GF_COLORS = ["#7c9a3c", "#d97706", "#2563eb", "#db2777", "#0d9488", "#7c3aed"];

const gfState = (() => {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem("gf-profiles") || "null"); } catch (e) {}
  return {
    profiles: Array.isArray(saved) && saved.length ? saved : [{ name: "Mein Profil", w: {} }],
    active: 0,
    labels: (() => { try { return JSON.parse(localStorage.getItem("gf-labels") || "{}"); } catch (e) { return {}; } })()
  };
})();
function gfSave() { try { localStorage.setItem("gf-profiles", JSON.stringify(gfState.profiles)); localStorage.setItem("gf-labels", JSON.stringify(gfState.labels)); } catch (e) {} }
function gfLabel(k) { return gfState.labels[k.id] || k.label; }

function gfSet(kid, v) { const p = gfState.profiles[gfState.active]; if (v === "egal") delete p.w[kid]; else p.w[kid] = parseInt(v, 10); gfSave(); render(); }
function gfSelect(i) { gfState.active = i; render(); }
function gfAdd() { gfState.profiles.push({ name: "Profil " + (gfState.profiles.length + 1), w: {} }); gfState.active = gfState.profiles.length - 1; gfSave(); render(); }
function gfRename(i, name) { gfState.profiles[i].name = (name || "").trim() || ("Profil " + (i + 1)); gfSave(); render(); }
function gfRemove(i) { if (gfState.profiles.length <= 1) { toast("Das letzte Profil kann nicht gelöscht werden.", true); return; } gfState.profiles.splice(i, 1); gfState.active = Math.max(0, Math.min(gfState.active, gfState.profiles.length - 1)); gfSave(); render(); }
function gfRenameKrit(kid, name) { const k = GF_KRITERIEN.find(x => x.id === kid); if (!k) return; const n = (name || "").trim(); if (n && n !== k.label) gfState.labels[kid] = n; else delete gfState.labels[kid]; gfSave(); render(); }
function gfReset() { gfState.profiles[gfState.active].w = {}; gfSave(); render(); }

/* ---------- Netzdiagramm (SVG) ---------- */
function gfRadar(profiles, size) {
  const S = size || 420, cx = S / 2, cy = S / 2, R = S / 2 - 58;
  const n = GF_KRITERIEN.length;
  const ang = i => -Math.PI / 2 + i * 2 * Math.PI / n;
  const pt = (i, r) => [cx + Math.cos(ang(i)) * r, cy + Math.sin(ang(i)) * r];
  const ring = lvl => GF_KRITERIEN.map((k, i) => pt(i, R * lvl / 5).join(",")).join(" ");
  // Achsen, die in KEINEM Profil gewertet sind → grau
  const used = GF_KRITERIEN.map(k => profiles.some(p => p.w[k.id] !== undefined));
  let svg = `<svg viewBox="0 0 ${S} ${S}" width="100%" style="max-width:${S}px;display:block;margin:0 auto" font-family="inherit">`;
  for (let l = 1; l <= 5; l++) svg += `<polygon points="${ring(l)}" fill="${l % 2 ? "rgba(127,127,127,.06)" : "none"}" stroke="var(--border)" stroke-width="1"/>`;
  GF_KRITERIEN.forEach((k, i) => {
    const [x, y] = pt(i, R), [lx, ly] = pt(i, R + 30);
    svg += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="var(--border)" stroke-width="1"/>`;
    const anchor = Math.abs(lx - cx) < 8 ? "middle" : lx > cx ? "start" : "end";
    const words = gfLabel(k).split(" "); const lines = [];
    let cur = ""; words.forEach(w => { if ((cur + " " + w).trim().length > 14 && cur) { lines.push(cur); cur = w; } else cur = (cur + " " + w).trim(); }); if (cur) lines.push(cur);
    const dy0 = ly < cy ? -(lines.length - 1) * 12 : 0;
    svg += `<text x="${lx}" y="${ly + 4 + dy0}" text-anchor="${anchor}" font-size="11" fill="${used[i] ? "var(--text)" : "var(--text-faint)"}" ${used[i] ? "" : 'font-style="italic"'}>${lines.map((t, j) => `<tspan x="${lx}" dy="${j ? 12 : 0}">${escape(t)}${!used[i] && j === lines.length - 1 ? " (egal)" : ""}</tspan>`).join("")}</text>`;
  });
  // Stufenbeschriftung 1–5 entlang der ersten Achse
  for (let l = 1; l <= 5; l++) { const [x, y] = pt(0, R * l / 5); svg += `<text x="${x + 5}" y="${y + 3}" font-size="9" fill="var(--text-faint)">${l}</text>`; }
  profiles.forEach((p, pi) => {
    const col = GF_COLORS[pi % GF_COLORS.length];
    // Nur gewertete Achsen verbinden; «egal»-Achsen werden übersprungen
    const pts = GF_KRITERIEN.map((k, i) => p.w[k.id] !== undefined ? pt(i, R * p.w[k.id] / 5) : null).filter(Boolean);
    if (pts.length >= 3) svg += `<polygon points="${pts.map(q => q.join(",")).join(" ")}" fill="${col}" fill-opacity="${p === profiles[gfState.active] || profiles.length === 1 ? 0.28 : 0.14}" stroke="${col}" stroke-width="2"/>`;
    else if (pts.length === 2) svg += `<line x1="${pts[0][0]}" y1="${pts[0][1]}" x2="${pts[1][0]}" y2="${pts[1][1]}" stroke="${col}" stroke-width="2"/>`;
    GF_KRITERIEN.forEach((k, i) => { if (p.w[k.id] === undefined) return; const [x, y] = pt(i, R * p.w[k.id] / 5); svg += `<circle cx="${x}" cy="${y}" r="4" fill="${col}" stroke="var(--bg, #fff)" stroke-width="1.5"><title>${escape(p.name)} · ${escape(gfLabel(k))}: ${p.w[k.id]}</title></circle>`; });
  });
  svg += `</svg>`;
  return svg;
}

/* ---------- Rendering ---------- */
function renderGastro(el) {
  document.getElementById("view-actions").innerHTML = `<button class="btn btn-sm" onclick="gfAdd()">＋ Profil</button><button class="btn btn-sm" onclick="gfReset()" title="Aktives Profil zurücksetzen">↺</button>`;
  const P = gfState.profiles, a = gfState.active, cur = P[a];
  const tabs = P.map((p, i) => `<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;border:2px solid ${GF_COLORS[i % GF_COLORS.length]};background:${i === a ? GF_COLORS[i % GF_COLORS.length] : "transparent"};color:${i === a ? "#fff" : "inherit"};cursor:pointer;font-size:12px" onclick="gfSelect(${i})">
      <span style="width:8px;height:8px;border-radius:50%;background:${i === a ? "#fff" : GF_COLORS[i % GF_COLORS.length]}"></span>${escape(p.name)}</span>`).join("");
  const rows = GF_KRITERIEN.map(k => {
    const v = cur.w[k.id];
    const btn = (val, lbl) => `<button class="btn btn-sm" style="min-width:34px;padding:3px 0;${(val === "egal" ? v === undefined : v === val) ? `background:${GF_COLORS[a % GF_COLORS.length]};color:#fff;border-color:${GF_COLORS[a % GF_COLORS.length]}` : ""}" onclick="gfSet('${k.id}','${val}')">${lbl}</button>`;
    return `<tr style="border-top:1px solid var(--border)">
      <td style="padding:8px 8px 8px 0;font-weight:600;min-width:170px"><span contenteditable="true" spellcheck="false" style="outline:none;border-bottom:1px dashed var(--border)" title="Klicken zum Umbenennen" onblur="gfRenameKrit('${k.id}',this.textContent)" onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur();}">${escape(gfLabel(k))}</span></td>
      <td style="padding:8px 0"><div style="display:flex;gap:4px;flex-wrap:wrap">${btn("egal", "egal")}${[1, 2, 3, 4, 5].map(n => btn(n, n)).join("")}</div></td>
      <td style="padding:8px;color:var(--text-dim);font-size:11px;white-space:nowrap">${v === undefined ? "nicht gewertet" : v === 1 ? "unwichtig" : v === 5 ? "sehr wichtig" : ""}</td></tr>`;
  }).join("");
  const gewertet = GF_KRITERIEN.filter(k => cur.w[k.id] !== undefined);
  const avg = gewertet.length ? gewertet.reduce((s, k) => s + cur.w[k.id], 0) / gewertet.length : null;
  el.innerHTML = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px">${tabs}
      <span style="flex:1"></span>
      <input value="${escape(cur.name)}" style="font-size:12px;padding:4px 8px;width:180px" title="Profil umbenennen" onchange="gfRename(${a},this.value)">
      ${P.length > 1 ? `<button class="btn btn-sm" onclick="gfRemove(${a})" title="Aktives Profil löschen">✕</button>` : ""}</div>
    <div style="display:grid;grid-template-columns:minmax(300px,1fr) minmax(320px,460px);gap:16px;align-items:start">
      <div class="card" style="padding:14px 16px">
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px">Bewertung für <b>${escape(cur.name)}</b> — 1 = unwichtig, 5 = sehr wichtig, «egal» = wird nicht gewertet. Kriteriennamen sind anklickbar und umbenennbar.</div>
        <table style="width:100%;font-size:13px;border-collapse:collapse">${rows}</table>
        <div style="font-size:11px;color:var(--text-faint);margin-top:8px">${gewertet.length} von ${GF_KRITERIEN.length} Kriterien gewertet${avg !== null ? " · Ø " + avg.toFixed(1) : ""}</div>
      </div>
      <div class="card" style="padding:14px 16px">
        ${gfRadar(P)}
        <div style="display:flex;gap:12px;flex-wrap:wrap;justify-content:center;margin-top:6px;font-size:11px">${P.map((p, i) => `<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${GF_COLORS[i % GF_COLORS.length]};vertical-align:middle;margin-right:4px"></span>${escape(p.name)}</span>`).join("")}</div>
        <div style="font-size:10px;color:var(--text-faint);text-align:center;margin-top:8px">Alle Profile werden überlagert; das aktive Profil ist kräftiger. Achsen, die in keinem Profil gewertet sind, erscheinen grau. · Gastroführer v${GF_VERSION}</div>
      </div>
    </div>`;
}
