const pptxgen = require("pptxgenjs");
const { applyTheme } = require("/mnt/skills/public/pptx/scripts/apply_theme.js");

const G = "0B6E45", GD = "0A3D2A", GL = "E7F2EC", GM = "8CC5A6", INK = "1E2B26", MUT = "5E6B66",
      RED = "B8322A", REDL = "F8E4E2", AMB = "C98A00", AMBL = "FBF0D6", WHITE = "FFFFFF", LINE = "D5DED9", GRY = "F3F5F4";

const THEME = {
  name: "Ideenportal", headFontFace: "Calibri", bodyFontFace: "Calibri",
  colors: { dk1: INK, lt1: WHITE, dk2: GD, lt2: GL, accent1: G, accent2: GM, accent3: RED, accent4: AMB,
            accent5: "2F6F8F", accent6: MUT, hlink: G, folHlink: GD },
};

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE"; // 13.333 x 7.5
pres.theme = { headFontFace: "Calibri", bodyFontFace: "Calibri" };
pres.title = "Ideenportal – Konzeptvorschlag";
pres.author = "Ideenportal";

pres.defineSlideMaster({
  title: "TITLE", background: { color: GD },
  objects: [
    { placeholder: { options: { name: "kicker", type: "body", x: 0.8, y: 1.5, w: 11, h: 0.4, fontSize: 13, bold: true, color: GM, charSpacing: 2, margin: 0 }, text: "" } },
    { placeholder: { options: { name: "title", type: "title", x: 0.8, y: 2.0, w: 11.5, h: 1.6, fontSize: 54, bold: true, color: WHITE, margin: 0, valign: "top", align: "left" }, text: "" } },
    { placeholder: { options: { name: "sub", type: "body", x: 0.8, y: 3.7, w: 10, h: 0.9, fontSize: 20, color: "D7EBE0", margin: 0, valign: "top" }, text: "" } },
  ],
});
pres.defineSlideMaster({
  title: "CONTENT", background: { color: WHITE },
  margin: [0.5, 0.6, 0.6, 0.6],
  objects: [
    { placeholder: { options: { name: "kicker", type: "body", x: 0.6, y: 0.35, w: 9, h: 0.3, fontSize: 11, bold: true, color: G, charSpacing: 2, margin: 0 }, text: "" } },
    { placeholder: { options: { name: "title", type: "title", x: 0.6, y: 0.65, w: 12.1, h: 0.75, fontSize: 26, bold: true, color: INK, margin: 0, valign: "top", align: "left" }, text: "" } },
    { text: { text: "Ideenportal • Konzeptvorschlag (tool-neutral)", options: { x: 0.6, y: 7.05, w: 6, h: 0.25, fontSize: 9, color: MUT, margin: 0 } } },
  ],
  slideNumber: { x: 12.2, y: 7.05, w: 0.5, h: 0.25, fontSize: 9, color: MUT, align: "right" },
});

let sec = null;
function section(t) { pres.addSection({ title: t }); sec = t; }
function content(kicker, title) {
  const s = pres.addSlide({ masterName: "CONTENT", sectionTitle: sec });
  s.addText(kicker, { placeholder: "kicker" });
  s.addText(title, { placeholder: "title" });
  return s;
}
function box(s, x, y, w, h, fill, opts = {}) {
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, fill: { color: fill }, rectRadius: opts.r ?? 0.08,
    line: opts.line ? { color: opts.line, width: 1 } : { type: "none" }, objectName: opts.name });
}
function txt(s, text, o) { s.addText(text, Object.assign({ isTextBox: true, margin: 0, fontFace: "Calibri", color: INK, valign: "top" }, o)); }
function badge(s, x, y, label, fill = G, d = 0.42, fs = 13) {
  s.addShape(pres.shapes.OVAL, { x, y, w: d, h: d, fill: { color: fill }, line: { type: "none" } });
  txt(s, label, { x, y, w: d, h: d, fontSize: fs, bold: true, color: WHITE, align: "center", valign: "middle" });
}
function bullets(items, o = {}) {
  return items.map((t, i) => ({ text: t, options: { bullet: { indent: 14 }, breakLine: i < items.length - 1, paraSpaceAfter: o.sp ?? 4 } }));
}
const hdr = (t, fill = GD) => ({ text: t, options: { bold: true, color: WHITE, fill: { color: fill }, fontSize: 11, valign: "middle" } });

// ---------------- 1 Title
section("Einstieg");
{
  const s = pres.addSlide({ masterName: "TITLE", sectionTitle: sec });
  s.addText("IDEENMANAGEMENT • KONZEPTVORSCHLAG", { placeholder: "kicker" });
  s.addText("Vom Einfall zur Wirkung", { placeholder: "title" });
  s.addText("Bewertung des Entwurfs, überarbeitetes Zielkonzept und Risiken für ein tool-neutrales Ideenportal", { placeholder: "sub" });
  const chips = [["01", "Bewertung", "Was trägt, was fehlt?"], ["02", "Zielkonzept", "Wie fließen Ideen zur Wirkung?"], ["03", "Risiken & Einführung", "Worauf achten, wie starten?"]];
  chips.forEach((c, i) => {
    const x = 0.8 + i * 3.9;
    box(s, x, 5.1, 3.6, 1.1, "124E37");
    txt(s, c[0], { x: x + 0.25, y: 5.25, w: 0.6, h: 0.35, fontSize: 14, bold: true, color: GM });
    txt(s, c[1], { x: x + 0.85, y: 5.25, w: 2.6, h: 0.35, fontSize: 16, bold: true, color: WHITE });
    txt(s, c[2], { x: x + 0.85, y: 5.65, w: 2.6, h: 0.4, fontSize: 12, color: "C6E0D2" });
  });
  txt(s, "Oktober 2026 • Diskussionsgrundlage", { x: 0.8, y: 6.7, w: 6, h: 0.3, fontSize: 11, color: GM });
}

// ---------------- 2 Gesamturteil
section("Bewertung des Entwurfs");
{
  const s = content("BEWERTUNG DES ENTWURFS", "Gute Prozessbasis – löst aber nur die Hälfte der eigenen Probleme");
  box(s, 0.6, 1.65, 5.0, 4.45, GL);
  badge(s, 0.85, 1.85, "+", G, 0.42, 18);
  txt(s, "Das trägt – behalten", { x: 1.4, y: 1.88, w: 4, h: 0.4, fontSize: 17, bold: true, color: GD });
  txt(s, bullets([
    "Klare Gate-Logik mit zwei Entscheidungspunkten",
    "Rollen mit benanntem Owner und Vertretung gedacht",
    "KI als Assistenz mit Leitplanke „Mensch entscheidet“",
    "Einheitliches Bewertungsraster als Ziel",
    "Wirkungsmessung und Dashboard angelegt",
    "Ist-Analyse benennt die richtigen Probleme",
  ], { sp: 8 }), { x: 0.9, y: 2.5, w: 4.5, h: 3.5, fontSize: 14 });

  box(s, 5.85, 1.65, 6.85, 4.45, REDL);
  badge(s, 6.1, 1.85, "–", RED, 0.42, 18);
  txt(s, "Das fehlt oder hakt – verbessern", { x: 6.65, y: 1.88, w: 5.5, h: 0.4, fontSize: 17, bold: true, color: RED });
  txt(s, bullets([
    "Beteiligung, Kollaboration und Strategiebezug werden im Zielprozess kaum gelöst – nur als Nachtrag (Folie 10/11)",
    "Eine Spur für alles: Kleinverbesserung und Großinnovation durchlaufen 7 Schritte und das Gremium",
    "Gremium entscheidet schon an Q1 – Engpass und Liegezeiten bleiben",
    "Prozess endet bei der Entscheidung: POC, Umsetzung und Nutzennachweis nicht verankert",
    "Keine Fristen, keine Feedback-Pflicht gegenüber Ideengebenden",
    "Raster ohne Skalen, Gewichte und Schwellenwerte",
    "Tool- und IT-lastig (ServiceNow, Demand, Story/Epic, feste Fachdomänen)",
    "Rechtlicher Rahmen fehlt: Betriebsrat, Datenschutz, Erfindungen, Prämien",
  ], { sp: 5 }), { x: 6.15, y: 2.45, w: 6.35, h: 3.6, fontSize: 13 });

  box(s, 0.6, 6.25, 12.1, 0.62, GD);
  txt(s, [{ text: "Empfehlung: ", options: { bold: true, color: GM } },
    { text: "Gate-Logik und KI-Assistenz behalten – das Konzept aber von „Ideen entscheiden“ auf „Ideen zur Wirkung bringen“ erweitern.", options: { color: WHITE } }],
    { x: 0.85, y: 6.25, w: 11.6, h: 0.62, fontSize: 14, valign: "middle" });
}

// ---------------- 3 Lückenanalyse
{
  const s = content("LÜCKENANALYSE", "Welche Ist-Probleme löst der Entwurf wirklich?");
  const lvl = (t) => {
    const m = { kaum: [RED, REDL], teilweise: [AMB, AMBL] }[t];
    return { text: t, options: { bold: true, color: m[0], fill: { color: m[1] }, align: "center", valign: "middle" } };
  };
  const rows = [
    ["Geringe Beteiligung", "kaum", "Nur als Absicht (Folie 10); keine Anlässe, kein Feedback-Versprechen", "Challenges, Feedback-Frist, sichtbare Erfolge, Anerkennung"],
    ["Wenig Kollaboration", "kaum", "Ideengebende nach Einreichung passiv; Community nicht im Ablauf", "Diskussionsphase, Co-Autor:innen, Ideengeber:in arbeitet mit"],
    ["Manuelle Bewertung", "teilweise", "KI-Vorbewertung ja – aber Gremium prüft weiterhin jede Idee", "Triage-Team mit Frist, Schnellspur, Delegationsschwellen"],
    ["Begrenzte Steuerung", "teilweise", "Dashboard erst am Ende (Folie 11); keine Kapazitätsgrenzen", "Funnel-KPIs, Begrenzung paralleler Ausarbeitungen, Kampagnensicht"],
    ["Strategiebezug unklar", "kaum", "Nur „strategische Einordnung auf hoher Flughöhe“ an Q1", "Strategische Challenges, gewichtetes Fit-Kriterium"],
    ["Risiko „Ideenfriedhof“", "kaum", "„Parken mit Review-Datum“; keine Übergabe in Umsetzung", "Gate 3 Wirkungsreview, max. Parkdauer, Budgetanbindung"],
  ];
  const data = [[hdr("Ist-Problem (Entwurf, Folie 2)"), hdr("Gelöst?"), hdr("Was im Entwurf fehlt"), hdr("Lösung im neuen Konzept", G)]];
  rows.forEach((r, i) => {
    const f = i % 2 ? WHITE : GRY;
    data.push([{ text: r[0], options: { bold: true, fill: { color: f } } }, lvl(r[1]),
      { text: r[2], options: { fill: { color: f }, color: MUT } }, { text: r[3], options: { fill: { color: GL }, color: GD, bold: true } }]);
  });
  s.addTable(data, { x: 0.6, y: 1.7, w: 12.1, colW: [2.6, 1.3, 4.3, 3.9], fontSize: 12, fontFace: "Calibri", color: INK,
    rowH: [0.42, 0.68, 0.68, 0.68, 0.68, 0.68, 0.68], valign: "middle", margin: [0.06, 0.12, 0.06, 0.12],
    border: { type: "solid", pt: 0.75, color: LINE } });
  txt(s, "Kein Ist-Problem wird vollständig gelöst. Der Grund: Der Entwurf optimiert die Bewertung, nicht den ganzen Weg von der Anregung bis zur Wirkung.",
    { x: 0.6, y: 6.45, w: 12.1, h: 0.4, fontSize: 13, italic: true, color: GD });
}

// ---------------- 4 Prinzipien
section("Zielkonzept");
{
  const s = content("ZIELKONZEPT", "Fünf Prinzipien für das neue Konzept");
  const P = [
    ["Proportional statt einheitlich", "Der Prüfaufwand folgt der Größe der Idee: Schnellspur für Kleines, Gates nur für Großes."],
    ["Strategie zieht, Basis drückt", "Offene Einreichung plus gezielte Challenges zu strategischen Themenfeldern."],
    ["Jede Idee bekommt eine Antwort", "Verbindliche Fristen, begründete Entscheidungen, jederzeit sichtbarer Status."],
    ["Ideengeber:in bleibt an Bord", "Arbeitet an der Ausarbeitung mit, wird bei Umsetzung genannt und anerkannt."],
    ["Wirkung zählt, nicht Menge", "Erfolg wird am realisierten Nutzen gemessen – nicht an Einreichungszahlen."],
  ];
  const w = 2.26, gap = 0.2;
  P.forEach((p, i) => {
    const x = 0.6 + i * (w + gap);
    box(s, x, 1.8, w, 4.0, i % 2 ? GRY : GL);
    txt(s, String(i + 1), { x: x + 0.25, y: 2.0, w: 1, h: 0.9, fontSize: 48, bold: true, color: G });
    txt(s, p[0], { x: x + 0.25, y: 3.0, w: w - 0.45, h: 0.9, fontSize: 16, bold: true, color: GD });
    txt(s, p[1], { x: x + 0.25, y: 3.95, w: w - 0.45, h: 1.7, fontSize: 13, color: INK });
  });
  box(s, 0.6, 6.05, 12.1, 0.7, GD);
  txt(s, "Diese Prinzipien sind unabhängig von Branche, Unternehmensgröße und Werkzeug – sie sind der Prüfstein für jede spätere Tool- oder Detailentscheidung.",
    { x: 0.85, y: 6.05, w: 11.6, h: 0.7, fontSize: 14, color: WHITE, valign: "middle" });
}

// ---------------- 5 Zielbild Funnel
{
  const s = content("ZIELBILD", "Ein Ideenfluss mit Schnellspur und drei Gates bis zur belegten Wirkung");
  const y = 1.95, h = 1.75, bw = 1.62, dw = 0.98, gap = 0.135;
  const items = [
    ["P", "0", "Anregen", "Offene Einreichung + Challenges zu Strategiefeldern"],
    ["P", "1", "Einreichen & diskutieren", "KI-Assistent, Dubletten-Check, Community kommentiert"],
    ["G", "G1", "Triage", "≤ 10 AT"],
    ["P", "2", "Ausarbeiten", "Pate + Ideengeber:in, Timebox 6 Wochen"],
    ["G", "G2", "Entscheiden", "monatlich"],
    ["P", "3", "Umsetzen / Erproben", "Linie, Projekt, Backlog oder Experiment"],
    ["G", "G3", "Wirkung prüfen", "3–6 Mon."],
    ["P", "4", "Anerkennen & lernen", "Erfolg sichtbar machen, Erkenntnisse teilen"],
  ];
  let x = 0.6; const pos = [];
  items.forEach((it, i) => {
    const w = it[0] === "P" ? bw : dw;
    pos.push({ x, w });
    if (it[0] === "P") {
      box(s, x, y, w, h, GL);
      txt(s, it[1], { x: x + 0.12, y: y + 0.1, w: 0.5, h: 0.35, fontSize: 15, bold: true, color: G });
      txt(s, it[2], { x: x + 0.12, y: y + 0.42, w: w - 0.24, h: 0.55, fontSize: 13, bold: true, color: GD });
      txt(s, it[3], { x: x + 0.12, y: y + 0.98, w: w - 0.24, h: 0.75, fontSize: 10.5, color: INK });
    } else {
      s.addShape(pres.shapes.DIAMOND, { x, y: y + 0.12, w, h: 1.1, fill: { color: GD }, line: { type: "none" } });
      txt(s, it[1], { x, y: y + 0.12, w, h: 1.1, fontSize: 15, bold: true, color: WHITE, align: "center", valign: "middle" });
      txt(s, it[2], { x: x - 0.1, y: y + 1.27, w: w + 0.2, h: 0.25, fontSize: 11, bold: true, color: GD, align: "center" });
      txt(s, it[3], { x: x - 0.1, y: y + 1.5, w: w + 0.2, h: 0.25, fontSize: 10, color: MUT, align: "center" });
    }
    if (i < items.length - 1) {
      s.addShape(pres.shapes.LINE, { x: x + w + 0.01, y: y + 0.67, w: gap - 0.02, h: 0, line: { color: G, width: 1.5, endArrowType: "triangle" } });
    }
    x += w + gap;
  });
  // fast lane
  const g1 = pos[2], p3 = pos[5], g2 = pos[4];
  const ly = 4.15;
  s.addShape(pres.shapes.LINE, { x: g1.x + g1.w / 2, y: y + 1.75, w: 0, h: ly - (y + 1.75) + 0.2, line: { color: AMB, width: 2 } });
  s.addShape(pres.shapes.LINE, { x: g1.x + g1.w / 2, y: ly + 0.2, w: p3.x + p3.w / 2 - (g1.x + g1.w / 2), h: 0, line: { color: AMB, width: 2 } });
  s.addShape(pres.shapes.LINE, { x: p3.x + p3.w / 2, y: y + h, w: 0, h: ly + 0.2 - (y + h), flipV: true, line: { color: AMB, width: 2, endArrowType: "triangle" } });
  box(s, g1.x + g1.w / 2 + 0.3, ly + 0.02, 4.4, 0.36, AMBL, { line: AMB });
  txt(s, "Schnellspur: kleine Ideen direkt in die Umsetzung – ohne Gremium", { x: g1.x + g1.w / 2 + 0.4, y: ly + 0.02, w: 4.25, h: 0.36, fontSize: 10.5, bold: true, color: "7A5400", valign: "middle" });

  // outcome cards
  const cards = [
    ["G1 · Triage-Team", "Welche Spur?", "Schnellspur · Ausarbeiten · Weiterleiten/Zusammenführen · Ablehnen mit Begründung"],
    ["G2 · Gremium oder Bereichsleitung", "Investieren wir?", "Umsetzen · Erproben (POC) · In Vorhaben integrieren · Parken (max. 6 Mon.) · Ablehnen"],
    ["G3 · Pate + Sponsor", "Hat es gewirkt?", "Abschließen & anerkennen · Skalieren · Nachsteuern · Stoppen"],
  ];
  cards.forEach((c, i) => {
    const cx = 0.6 + i * 4.1, cw = 3.9;
    box(s, cx, 4.85, cw, 1.95, WHITE, { line: LINE });
    txt(s, c[0], { x: cx + 0.2, y: 4.98, w: cw - 0.4, h: 0.3, fontSize: 11, bold: true, color: G });
    txt(s, c[1], { x: cx + 0.2, y: 5.3, w: cw - 0.4, h: 0.4, fontSize: 16, bold: true, color: INK });
    txt(s, c[2], { x: cx + 0.2, y: 5.75, w: cw - 0.4, h: 0.95, fontSize: 12, color: MUT });
  });
}

// ---------------- 6 Gate 1 Triage
{
  const s = content("GATE 1 · TRIAGE", "Jede Idee erhält innerhalb von 10 Arbeitstagen eine Richtung");
  const R = [
    ["A", "Schnellspur", AMB, AMBL, "Geringer Aufwand (z. B. < 5 Personentage, < 5 T€), im Verantwortungsbereich eines Teams, geringes Risiko", "Fachbereich setzt um; Ideenmanagement verfolgt den Abschluss"],
    ["B", "Ausarbeiten", G, GL, "Erkennbares Potenzial, bereichsübergreifend oder größerer Aufwand, Strategiebezug", "Pate wird benannt, Timebox 6 Wochen, Ideengeber:in arbeitet mit"],
    ["C", "Weiterleiten / zusammenführen", "2F6F8F", "E3EEF3", "Dublette, bereits in Arbeit oder gehört in einen anderen Prozess (Störung, Beschwerde, Arbeitsschutz …)", "Verknüpfen; Ideengeber:in wird dort beteiligt und informiert"],
    ["D", "Ablehnen", RED, REDL, "Kein erkennbarer Mehrwert, widerspricht Strategie, Recht oder bereits getroffenen Entscheidungen", "Immer mit Begründung und Gesprächsangebot – nie stillschweigend"],
  ];
  R.forEach((r, i) => {
    const x = 0.6 + i * 2.33, w = 2.18;
    box(s, x, 1.7, w, 4.05, r[3]);
    badge(s, x + 0.2, 1.88, r[0], r[2]);
    txt(s, r[1], { x: x + 0.2, y: 2.42, w: w - 0.35, h: 0.65, fontSize: 15, bold: true, color: r[2] });
    txt(s, "WANN", { x: x + 0.2, y: 3.1, w: 1.5, h: 0.25, fontSize: 9.5, bold: true, color: MUT, charSpacing: 1 });
    txt(s, r[4], { x: x + 0.2, y: 3.35, w: w - 0.35, h: 1.3, fontSize: 11.5 });
    txt(s, "DANN", { x: x + 0.2, y: 4.62, w: 1.5, h: 0.25, fontSize: 9.5, bold: true, color: MUT, charSpacing: 1 });
    txt(s, r[5], { x: x + 0.2, y: 4.87, w: w - 0.35, h: 0.85, fontSize: 11.5, bold: true, color: GD });
  });
  const sx = 10.0, sw = 2.7;
  box(s, sx, 1.7, sw, 4.05, GD);
  txt(s, "Spielregeln", { x: sx + 0.2, y: 1.85, w: sw - 0.4, h: 0.35, fontSize: 15, bold: true, color: WHITE });
  txt(s, bullets([
    "Wer: Ideenmanagement + 1–2 Fachvertreter je Domäne",
    "Wie oft: wöchentlich, 30–60 Min.",
    "Rückfrage hält die Frist an – max. 2 Runden",
    "Ohne Antwort nach 15 AT: Idee wird mit Hinweis geschlossen",
    "Kein „Parken“ an G1 – parken ist eine bewusste Entscheidung an G2",
  ], { sp: 6 }), { x: sx + 0.2, y: 2.3, w: sw - 0.35, h: 3.4, fontSize: 11.5, color: "E2F0E8" });
  txt(s, "Schwellenwerte sind Startvorschläge und werden je Organisation festgelegt und nach dem Pilot kalibriert.",
    { x: 0.6, y: 6.0, w: 12.1, h: 0.35, fontSize: 12, italic: true, color: MUT });
}

// ---------------- 7 Gates Überblick
{
  const s = content("ENTSCHEIDUNGSLOGIK", "Drei Gates mit klaren Leitfragen, Entscheidern und Fristen");
  const data = [[hdr("Gate"), hdr("Leitfrage"), hdr("Wer entscheidet"), hdr("Mindest-Input"), hdr("Mögliche Ergebnisse"), hdr("Frist")]];
  const rows = [
    ["G1 Triage", "Welche Spur?", "Triage-Team", "Problem, Idee, Nutzenhypothese, betroffener Bereich – vom KI-Assistenten auf Vollständigkeit geprüft", "Schnellspur · Ausarbeiten · Weiterleiten · Ablehnen", "≤ 10 AT nach Einreichung"],
    ["G2 Entscheidung", "Investieren wir?", "Unter Schwelle: Bereichsleitung\nÜber Schwelle / übergreifend: Gremium", "Ideen-Steckbrief: Nutzen, Aufwandsspanne, Risiken, Betroffene, Score, Umsetzungsweg", "Umsetzen · Erproben (POC) · Integrieren · Parken mit Wiedervorlage · Ablehnen", "Ausarbeitung ≤ 6 Wochen; Termin monatlich"],
    ["G3 Wirkungsreview", "Hat es gewirkt?", "Pate + Sponsor; Bericht an Gremium", "Ist-Nutzen vs. Plan, Erkenntnisse, Folgebedarf", "Abschließen & anerkennen · Skalieren · Nachsteuern · Stoppen", "3–6 Monate nach Umsetzung"],
  ];
  rows.forEach((r, i) => data.push(r.map((c, j) => ({ text: c, options: { bold: j === 0, color: j === 0 ? GD : INK, fill: { color: j === 0 ? GL : (i % 2 ? WHITE : GRY) } } }))));
  s.addTable(data, { x: 0.6, y: 1.7, w: 12.1, colW: [1.55, 1.45, 2.3, 3.0, 2.4, 1.4], fontSize: 12, fontFace: "Calibri",
    rowH: [0.42, 1.15, 1.25, 1.0], valign: "middle", margin: [0.06, 0.1, 0.06, 0.1], border: { type: "solid", pt: 0.75, color: LINE } });
  box(s, 0.6, 5.85, 12.1, 0.95, GL);
  txt(s, [{ text: "Delegation entlastet das Gremium: ", options: { bold: true, color: GD } },
    { text: "Ideen unterhalb einer Schwelle (z. B. < 25 Personentage oder < 25 T€, nur ein Bereich betroffen) entscheidet die Bereichsleitung. Das Gremium sieht nur Großes und Bereichsübergreifendes – max. 5 Ideen pro Termin, Unterlagen 5 AT vorab, Entscheidung mit Begründung und Owner.", options: { color: INK } }],
    { x: 0.85, y: 5.85, w: 11.6, h: 0.95, fontSize: 13, valign: "middle" });
}

// ---------------- 8 Bewertung
{
  const s = content("BEWERTUNGSMODELL", "Zweistufiges Raster: leicht an Gate 1, belastbar an Gate 2");
  box(s, 0.6, 1.7, 4.0, 4.3, GL);
  txt(s, "G1 · QUICK-CHECK", { x: 0.85, y: 1.88, w: 3.5, h: 0.3, fontSize: 11, bold: true, color: G, charSpacing: 1 });
  txt(s, "Drei Fragen – ja / teilweise / nein", { x: 0.85, y: 2.2, w: 3.5, h: 0.4, fontSize: 15, bold: true, color: GD });
  ["Löst die Idee ein relevantes Problem?", "Passt sie zu Strategie oder einem Themenfeld?", "Ist sie grob machbar?"].forEach((q, i) => {
    badge(s, 0.85, 2.85 + i * 0.75, String(i + 1), G, 0.4, 12);
    txt(s, q, { x: 1.4, y: 2.85 + i * 0.75, w: 3.0, h: 0.5, fontSize: 13, valign: "middle" });
  });
  txt(s, "Ergebnis: Spur (A–D), kein Score. Spart Aufwand, wo noch wenig bekannt ist.", { x: 0.85, y: 5.15, w: 3.55, h: 0.7, fontSize: 12, italic: true, color: GD });

  txt(s, "G2 · SCORECARD (Skala 1–5, gewichtet)", { x: 4.9, y: 1.75, w: 7.5, h: 0.3, fontSize: 11, bold: true, color: G, charSpacing: 1 });
  const K = [
    ["Strategischer Fit", 25, "Zahlt auf Unternehmensziele oder ein Themenfeld ein?"],
    ["Kunden- & Mitarbeiternutzen", 25, "Spürbare Verbesserung für wen, wie viele, wie oft?"],
    ["Wirtschaftlicher Nutzen", 20, "Einsparung, Umsatz, vermiedene Risiken/Kosten"],
    ["Umsetzbarkeit", 15, "Aufwand, Know-how, Abhängigkeiten (5 = einfach)"],
    ["Risiko", 15, "Rechtlich, technisch, organisatorisch (5 = gering)"],
  ];
  K.forEach((k, i) => {
    const yy = 2.15 + i * 0.74;
    txt(s, k[0], { x: 4.9, y: yy, w: 2.6, h: 0.3, fontSize: 13, bold: true });
    txt(s, k[2], { x: 4.9, y: yy + 0.3, w: 4.6, h: 0.3, fontSize: 11, color: MUT });
    s.addShape(pres.shapes.RECTANGLE, { x: 9.7, y: yy + 0.12, w: 2.4, h: 0.3, fill: { color: GRY }, line: { type: "none" } });
    s.addShape(pres.shapes.RECTANGLE, { x: 9.7, y: yy + 0.12, w: 2.4 * k[1] / 25, h: 0.3, fill: { color: k[1] >= 25 ? G : GM }, line: { type: "none" } });
    txt(s, k[1] + " %", { x: 12.15, y: yy + 0.08, w: 0.6, h: 0.38, fontSize: 13, bold: true, color: GD, valign: "middle" });
  });
  txt(s, "Gewichte = Vorschlag; Skalenstufen mit Ankerbeispielen hinterlegen.", { x: 4.9, y: 5.85, w: 7.8, h: 0.25, fontSize: 11, italic: true, color: MUT });

  box(s, 0.6, 6.2, 12.1, 0.62, GD);
  txt(s, "Community-Stimmen sind ein Signal für Relevanz, kein Kriterium. Der Score ist eine Entscheidungshilfe: Weicht das Gremium ab, begründet es das. Kalibrierung nach dem ersten Quartal.",
    { x: 0.85, y: 6.2, w: 11.6, h: 0.62, fontSize: 12.5, color: WHITE, valign: "middle" });
}

// ---------------- 9 Rollen
{
  const s = content("BETRIEBSMODELL", "Rollen mit klarem Auftrag und realistischem Zeitbedarf");
  const rows = [
    ["Ideengeber:in", "Reicht ein, beantwortet Rückfragen, arbeitet an der Ausarbeitung mit", "nach Bedarf", ""],
    ["Community", "Kommentiert, ergänzt, unterstützt, steigt als Co-Autor:in ein", "freiwillig", "neu"],
    ["Ideen-Pate/-Patin", "Verantwortet eine Idee von G1 bis G3 – ersetzt das diffuse „Fachteam“", "ca. 5–10 % für die Laufzeit", "neu"],
    ["Fachexpert:innen", "Liefern Input zu Aufwand, Risiken und Abhängigkeiten", "punktuell", ""],
    ["Triage-Team", "Entscheidet Gate 1, wöchentlich", "30–60 Min./Woche", "neu"],
    ["Ideenmanagement", "Prozess, Fristen, Kommunikation, Challenges, Reporting, Moderation", "0,5–1 FTE (größenabhängig)", ""],
    ["Entscheidungsgremium", "Gate 2 für große/übergreifende Ideen, vergibt Ressourcen", "monatlich 60–90 Min.", ""],
    ["Sponsor / Themenfeld-Owner", "Stellt Challenges, nimmt Ergebnisse ab, trägt G3 mit", "je Challenge", "neu"],
    ["Governance", "Betriebsrat, Datenschutz, ggf. Patentstelle: Rahmen und Prüfung", "Einführung + anlassbezogen", "neu"],
  ];
  const data = [[hdr("Rolle"), hdr("Auftrag"), hdr("Zeitbedarf (Richtwert)"), hdr("")]];
  rows.forEach((r, i) => {
    const f = i % 2 ? WHITE : GRY;
    data.push([{ text: r[0], options: { bold: true, color: GD, fill: { color: f } } }, { text: r[1], options: { fill: { color: f } } },
      { text: r[2], options: { fill: { color: f }, color: MUT } },
      r[3] ? { text: r[3], options: { bold: true, color: WHITE, fill: { color: G }, align: "center" } } : { text: "", options: { fill: { color: f } } }]);
  });
  s.addTable(data, { x: 0.6, y: 1.65, w: 12.1, colW: [2.7, 6.0, 2.6, 0.8], fontSize: 12.5, fontFace: "Calibri", color: INK,
    rowH: 0.47, valign: "middle", margin: [0.04, 0.12, 0.04, 0.12], border: { type: "solid", pt: 0.75, color: LINE } });
  txt(s, "Jede Rolle braucht eine benannte Person und eine Vertretung (aus dem Entwurf übernommen). Zeitbudgets werden mit den Führungskräften vereinbart – sonst verdrängt das Tagesgeschäft die Ausarbeitung.",
    { x: 0.6, y: 6.45, w: 12.1, h: 0.5, fontSize: 12, italic: true, color: GD });
}

// ---------------- 10 KI
{
  const s = content("KI-UNTERSTÜTZUNG", "KI hilft an sechs Stellen – sie schlägt vor, Menschen entscheiden");
  const U = [
    ["EINREICHEN", "Einreichungs-Assistent", "Führt im Dialog durch Problem, Ziel und Nutzen; prüft auf Vollständigkeit"],
    ["EINREICHEN", "Dublettensuche", "Zeigt ähnliche Ideen und laufende Vorhaben – Mitmachen statt Doppeln"],
    ["TRIAGE", "Vorsortierung", "Schlägt Themenfeld, Zuständigkeit und Spur vor; Triage-Team bestätigt"],
    ["AUSARBEITEN", "Steckbrief-Entwurf", "Strukturiert Nutzen, Betroffene, Risiken, Aufwandsspanne"],
    ["GATE 2", "Entscheidungsvorlage", "Verdichtet Steckbriefe zu vergleichbaren Vorlagen fürs Gremium"],
    ["LAUFEND", "Muster & Kommunikation", "Fasst Diskussionen zusammen, erkennt Themencluster als Impuls für Challenges"],
  ];
  U.forEach((u, i) => {
    const col = i % 3, row = Math.floor(i / 3);
    const x = 0.6 + col * 2.98, y = 1.7 + row * 2.12, w = 2.83, h = 1.95;
    box(s, x, y, w, h, GL);
    txt(s, u[0], { x: x + 0.2, y: y + 0.15, w: w - 0.4, h: 0.25, fontSize: 9.5, bold: true, color: G, charSpacing: 1 });
    txt(s, u[1], { x: x + 0.2, y: y + 0.42, w: w - 0.4, h: 0.4, fontSize: 14, bold: true, color: GD });
    txt(s, u[2], { x: x + 0.2, y: y + 0.85, w: w - 0.4, h: 1.05, fontSize: 11.5 });
  });
  const lx = 9.6, lw = 3.1;
  box(s, lx, 1.7, lw, 4.07, GD);
  txt(s, "Leitplanken", { x: lx + 0.2, y: 1.85, w: lw - 0.4, h: 0.35, fontSize: 15, bold: true, color: WHITE });
  txt(s, bullets([
    "KI-Inhalte sind gekennzeichnet; der Originaltext bleibt erhalten",
    "Keine automatische Ablehnung, kein KI-Score als alleinige Grundlage",
    "Keine Auswertung oder Bewertung von Personen",
    "Freigabe durch Betriebsrat und Datenschutz vor Start",
    "Kriterien und Prompts dokumentiert, Stichproben-Kontrolle",
  ], { sp: 6 }), { x: lx + 0.2, y: 2.3, w: lw - 0.35, h: 3.4, fontSize: 11.5, color: "E2F0E8" });
  txt(s, "Die Funktionen sind hier anbieter- und toolneutral beschrieben.",
    { x: 0.6, y: 6.1, w: 12.1, h: 0.35, fontSize: 12, italic: true, color: MUT });
}

// ---------------- 11 Aktivierung
{
  const s = content("AKTIVIERUNG & COMMUNITY", "Beteiligung entsteht durch Anlässe, Antworten und Anerkennung");
  const A = [
    ["Anlässe", "2–4 Challenges pro Jahr zu Strategiefeldern – mit Sponsor, Zeitraum und klarer Frage", "Strategiebezug"],
    ["Antworten", "Rückmeldung in 10 AT, Status jederzeit sichtbar, jede Ablehnung begründet", "Vertrauen"],
    ["Zusammenarbeit", "Kommentieren, unterstützen, als Co-Autor:in einsteigen; Ideengeber:in arbeitet mit", "Qualität"],
    ["Anerkennung", "Nennung bei Umsetzung, Erfolgsgeschichten; Prämien nur über eine Betriebsvereinbarung", "Motivation"],
  ];
  A.forEach((a, i) => {
    const x = 0.6 + i * 3.06, w = 2.9;
    box(s, x, 1.75, w, 3.3, i % 2 ? GRY : GL);
    txt(s, "0" + (i + 1), { x: x + 0.25, y: 1.92, w: 1, h: 0.5, fontSize: 26, bold: true, color: G });
    txt(s, a[0], { x: x + 0.25, y: 2.5, w: w - 0.5, h: 0.4, fontSize: 18, bold: true, color: GD });
    txt(s, a[1], { x: x + 0.25, y: 2.98, w: w - 0.5, h: 1.45, fontSize: 12.5 });
    txt(s, "wirkt auf: " + a[2], { x: x + 0.25, y: 4.55, w: w - 0.5, h: 0.3, fontSize: 11, bold: true, color: G });
  });
  box(s, 0.6, 5.3, 12.1, 1.5, GD);
  txt(s, "Führungskräfte sind der größte Hebel", { x: 0.9, y: 5.45, w: 11.5, h: 0.4, fontSize: 16, bold: true, color: WHITE });
  txt(s, "Ideen regelmäßig in Teamrunden aufgreifen • Zeit für Ausarbeitung freigeben • selbst als Pate auftreten • Ablehnungen persönlich erklären. Ohne diese Rolle bleibt das Portal ein Briefkasten – egal wie gut das Werkzeug ist.",
    { x: 0.9, y: 5.9, w: 11.5, h: 0.8, fontSize: 13, color: "D7EBE0" });
}

// ---------------- 12 Anforderungen
{
  const s = content("TOOL-NEUTRALE ANFORDERUNGEN", "Was das Werkzeug können muss – unabhängig vom Anbieter");
  const rows = [
    ["Einreichung", "Formular mit KI-Assistent, Anhänge, mobil nutzbar, vertrauliche Einreichung", "Mehrsprachigkeit, Spracheingabe"],
    ["Zusammenarbeit", "Kommentare, Unterstützen, Co-Autor:innen, Benachrichtigungen", "@-Erwähnungen, Expertensuche"],
    ["Workflow & Gates", "Konfigurierbare Status und Spuren, Fristen mit Eskalation, Rollen und Rechte", "Delegationsschwellen automatisch"],
    ["Bewertung", "Konfigurierbare Scorecard mit Gewichten, Gremiumsansicht, Begründungsfeld", "Kalibrierungs-Auswertung"],
    ["Challenges", "Kampagnen mit Zeitraum, Sponsor und eigenem Formular", "Themencluster per KI"],
    ["Reporting", "Funnel, Durchlaufzeiten, Fristeinhaltung, Nutzen", "Export / BI-Anbindung"],
    ["Integration", "Übergabe an Projekt-, Portfolio- und Backlog-Werkzeuge; Single Sign-on", "Offene API, Webhooks"],
    ["Governance", "Änderungshistorie, Lösch- und Aufbewahrungskonzept, DSGVO-konform, Datenstandort", "Protokollierung der KI-Nutzung"],
  ];
  const data = [[hdr("Bereich"), hdr("Muss", G), hdr("Soll")]];
  rows.forEach((r, i) => {
    const f = i % 2 ? WHITE : GRY;
    data.push([{ text: r[0], options: { bold: true, color: GD, fill: { color: f } } }, { text: r[1], options: { fill: { color: f } } }, { text: r[2], options: { fill: { color: f }, color: MUT } }]);
  });
  s.addTable(data, { x: 0.6, y: 1.65, w: 12.1, colW: [2.2, 6.6, 3.3], fontSize: 12.5, fontFace: "Calibri", color: INK,
    rowH: 0.5, valign: "middle", margin: [0.04, 0.12, 0.04, 0.12], border: { type: "solid", pt: 0.75, color: LINE } });
  box(s, 0.6, 6.3, 12.1, 0.55, GL);
  txt(s, "Umsetzbar mit spezialisierter Ideenmanagement-Software, einer ITSM- oder Low-Code-Plattform oder einer Collaboration-Suite. Die Auswahl erst nach dem Pilot treffen.",
    { x: 0.85, y: 6.3, w: 11.6, h: 0.55, fontSize: 12.5, color: GD, valign: "middle" });
}

// ---------------- 13 KPIs
{
  const s = content("STEUERUNG & WIRKUNG", "Steuerung über Zielwerte für Wirkung – nicht über Menge");
  const K = [
    ["≥ 15 %", "Beteiligung", "Anteil Mitarbeitender mit Idee, Kommentar oder Mitarbeit pro Jahr"],
    ["≥ 90 %", "Fristtreue", "Ideen mit erster Rückmeldung in ≤ 10 AT"],
    ["≤ 60 Tage", "Durchlaufzeit", "Von Einreichung bis Entscheidung an G2"],
    ["≥ 60 %", "Realisierungsquote", "Umgesetzt im Verhältnis zu an G2 freigegeben"],
    ["€ · h · %", "Belegter Nutzen", "Kosten, Zeit oder Qualität – nachgewiesen an G3"],
  ];
  K.forEach((k, i) => {
    const x = 0.6 + i * 2.46, w = 2.3;
    box(s, x, 1.8, w, 2.9, i === 4 ? GD : GL);
    const dark = i === 4;
    txt(s, k[0], { x: x + 0.2, y: 2.0, w: w - 0.4, h: 0.8, fontSize: 30, bold: true, color: dark ? WHITE : G });
    txt(s, k[1], { x: x + 0.2, y: 2.9, w: w - 0.4, h: 0.4, fontSize: 15, bold: true, color: dark ? WHITE : GD });
    txt(s, k[2], { x: x + 0.2, y: 3.35, w: w - 0.4, h: 1.2, fontSize: 12, color: dark ? "D7EBE0" : INK });
  });
  box(s, 0.6, 4.95, 5.95, 1.85, GRY);
  txt(s, "Zusätzlich beobachten", { x: 0.85, y: 5.08, w: 5.5, h: 0.35, fontSize: 14, bold: true, color: GD });
  txt(s, bullets(["Anteil Ideen mit Strategiebezug bzw. aus Challenges", "Anteil Schnellspur vs. Gate-Ideen", "Anzahl paralleler Ausarbeitungen je Pate"]), { x: 0.85, y: 5.5, w: 5.5, h: 1.25, fontSize: 12.5 });
  box(s, 6.75, 4.95, 5.95, 1.85, REDL);
  txt(s, "Nicht darauf steuern", { x: 7.0, y: 5.08, w: 5.5, h: 0.35, fontSize: 14, bold: true, color: RED });
  txt(s, bullets(["Anzahl Einreichungen oder Stimmen als Zielgröße", "Prämien pro eingereichter Idee", "Rankings einzelner Personen oder Teams"]), { x: 7.0, y: 5.5, w: 5.5, h: 1.25, fontSize: 12.5 });
  txt(s, "Zielwerte sind Startannahmen – die Ausgangswerte werden im Pilot gemessen.", { x: 0.6, y: 6.82, w: 8, h: 0.22, fontSize: 10, italic: true, color: MUT });
}

// ---------------- Risks
section("Risiken & Einführung");
const RISKS = [
  ["R1", "Entscheidungsstau im Gremium", 3, 3, "Delegationsschwellen, max. 5 Ideen pro Termin, Unterlagen vorab, Umlaufentscheid"],
  ["R2", "Keine Zeit für Ausarbeitung", 3, 3, "Zeitbudget für Paten vereinbaren, Begrenzung paralleler Ausarbeitungen, Timebox 6 Wochen"],
  ["R3", "Ideenfriedhof nach Freigabe (kein Budget/Kanal)", 2, 3, "Anbindung an Portfolio- und Budgetprozess, Innovationsbudget, Status bis G3 sichtbar"],
  ["R4", "Beteiligung bricht nach dem Start ein", 3, 2, "Challenge-Kalender, Feedback-Frist, Erfolgsgeschichten, Führungskräfte einbinden"],
  ["R5", "Mitbestimmung übergangen", 2, 3, "Betriebsrat ab Konzeptphase; Betriebsvereinbarung zu Prozess, Prämien, Auswertungen und KI"],
  ["R6", "Datenschutz & KI-Compliance", 2, 3, "Datenschutz-Folgenabschätzung, Auftragsverarbeitung, Datenminimierung, KI-Kennzeichnung"],
  ["R7", "Erfindungen & Vertraulichkeit", 1, 3, "Triage-Prüffrage „technische Erfindung?“, vertrauliche Einreichung, Patentstelle einbinden"],
  ["R8", "KI-Fehler & blindes Vertrauen", 2, 2, "Mensch bestätigt jeden Vorschlag, Stichproben, Originaltext bleibt, Feedbackschleife"],
  ["R9", "Bewertungs-Bias (Popularität, Hierarchie)", 2, 2, "Stimmen nur als Signal, Skalen mit Ankern, Begründungspflicht, Kalibrierung"],
  ["R10", "Schöngerechneter Nutzen", 2, 2, "Annahmen dokumentieren, Plausibilisierung durch Controlling, Nachweis an G3"],
  ["R11", "Fehlanreize durch Mengen-KPIs/Prämien", 2, 2, "Wirkungs-KPIs, Prämie nur bei belegtem Nutzen, transparente Regeln"],
  ["R12", "Tool vor Prozess / Overengineering", 2, 2, "Pilot mit Minimalumfang, Anforderungen nach Pilot finalisieren, Konfiguration statt Entwicklung"],
  ["R13", "Widerstand & Kränkung", 2, 2, "Ideengeber:in als Co-Owner, Kommunikationsleitfaden, Führungskräfte als Paten"],
];
{
  const s = content("RISIKEN · ÜBERSICHT", "13 Risiken – sechs davon müssen vor dem Start gelöst sein");
  const ox = 1.9, oy = 1.75, cw = 1.75, ch = 1.45;
  const heat = (w, a) => { const v = w * a; return v >= 6 ? ["E3A29C", RED] : v >= 4 ? ["F3D58A", AMB] : ["CFE6D9", G]; };
  for (let w = 3; w >= 1; w--) for (let a = 1; a <= 3; a++) {
    const x = ox + (a - 1) * cw, y = oy + (3 - w) * ch;
    s.addShape(pres.shapes.RECTANGLE, { x, y, w: cw - 0.05, h: ch - 0.05, fill: { color: heat(w, a)[0] }, line: { type: "none" } });
    const ids = RISKS.filter(r => r[2] === w && r[3] === a).map(r => r[0]);
    if (ids.length) txt(s, ids.join("  "), { x: x + 0.08, y: y + 0.08, w: cw - 0.2, h: ch - 0.2, fontSize: 13, bold: true, color: INK, align: "center", valign: "middle" });
  }
  ["gering", "mittel", "hoch"].forEach((l, i) => {
    txt(s, l, { x: ox + i * cw, y: oy + 3 * ch + 0.02, w: cw, h: 0.25, fontSize: 10.5, color: MUT, align: "center" });
    txt(s, ["hoch", "mittel", "gering"][i], { x: ox - 0.75, y: oy + i * ch + ch / 2 - 0.15, w: 0.68, h: 0.3, fontSize: 10.5, color: MUT, align: "right" });
  });
  txt(s, "Auswirkung →", { x: ox, y: oy + 3 * ch + 0.28, w: 3 * cw, h: 0.25, fontSize: 11, bold: true, color: INK, align: "center" });
  txt(s, "Wahrscheinlichkeit", { x: 0.0, y: oy + 1.3 * ch, w: 1.6, h: 0.3, fontSize: 11, bold: true, color: INK, align: "center", rotate: 270 });

  const kx = 7.4, kw = 5.3;
  txt(s, "KRITISCH – VOR START LÖSEN", { x: kx, y: 1.75, w: kw, h: 0.3, fontSize: 11, bold: true, color: RED, charSpacing: 1 });
  RISKS.filter(r => r[2] * r[3] >= 6).forEach((r, i) => {
    const y = 2.1 + i * 0.77;
    box(s, kx, y, kw, 0.7, REDL);
    txt(s, r[0], { x: kx + 0.15, y, w: 0.55, h: 0.7, fontSize: 13, bold: true, color: RED, valign: "middle" });
    txt(s, [{ text: r[1], options: { bold: true, breakLine: true } }, { text: r[4], options: { color: MUT, fontSize: 10.5 } }],
      { x: kx + 0.7, y: y + 0.04, w: kw - 0.85, h: 0.66, fontSize: 12, valign: "middle" });
  });
  txt(s, "Bewertung: Wahrscheinlichkeit × Auswirkung (je 1–3), Einschätzung auf Basis typischer Einführungen – im Projekt zu validieren.",
    { x: 0.6, y: 6.75, w: 6.5, h: 0.25, fontSize: 9, italic: true, color: MUT });
}
function riskTable(list, title) {
  const s = content("RISIKEN · MASSNAHMEN", title);
  const lv = (v) => { const m = { 3: ["hoch", RED, REDL], 2: ["mittel", AMB, AMBL], 1: ["gering", G, GL] }[v]; return { text: m[0], options: { bold: true, color: m[1], fill: { color: m[2] }, align: "center" } }; };
  const data = [[hdr("ID"), hdr("Risiko"), hdr("Wahrsch."), hdr("Auswirkung"), hdr("Gegenmaßnahme", G)]];
  list.forEach((r, i) => {
    const f = i % 2 ? WHITE : GRY;
    data.push([{ text: r[0], options: { bold: true, color: GD, fill: { color: f } } }, { text: r[1], options: { bold: true, fill: { color: f } } }, lv(r[2]), lv(r[3]), { text: r[4], options: { fill: { color: f } } }]);
  });
  s.addTable(data, { x: 0.6, y: 1.65, w: 12.1, colW: [0.6, 3.3, 1.1, 1.2, 5.9], fontSize: 12, fontFace: "Calibri", color: INK,
    rowH: [0.4].concat(list.map(() => 0.6)), valign: "middle", margin: [0.04, 0.1, 0.04, 0.1], border: { type: "solid", pt: 0.75, color: LINE } });
  return s;
}
{
  const s = riskTable(RISKS.slice(0, 7), "Organisation, Kapazität und Recht – hier entscheidet sich der Erfolg");
  txt(s, "Rechtlicher Hinweis (DE): Das betriebliche Vorschlagswesen ist nach § 87 Abs. 1 Nr. 12 BetrVG, technische Einrichtungen zur Leistungs- oder Verhaltenskontrolle (Dashboards, KI) nach Nr. 6 mitbestimmungspflichtig. Technische Erfindungen fallen unter das ArbnErfG. Keine Rechtsberatung – mit Rechtsabteilung prüfen.",
    { x: 0.6, y: 6.4, w: 12.1, h: 0.55, fontSize: 10.5, italic: true, color: MUT });
}
{
  const s = riskTable(RISKS.slice(7), "Qualität, Anreize und Akzeptanz – die schleichenden Risiken");
  box(s, 0.6, 6.0, 12.1, 0.8, GL);
  txt(s, "Gemeinsames Muster: Diese Risiken bauen sich langsam auf. Darum gehören Kalibrierung der Bewertung und ein Rückblick auf KPIs und Fehlanreize fest in jedes Quartal.",
    { x: 0.85, y: 6.0, w: 11.6, h: 0.8, fontSize: 13, color: GD, valign: "middle" });
}

// ---------------- Roadmap
{
  const s = content("EINFÜHRUNG", "Erst Rahmen, dann Pilot – das Werkzeug folgt den Erkenntnissen");
  const P = [
    ["Monat 1–2", "Klären", ["Rollen und Personen benennen", "Schwellenwerte und Scorecard festlegen", "Betriebsrat und Datenschutz einbinden", "Muss-Anforderungen abstimmen"]],
    ["Monat 3–5", "Pilotieren", ["1–2 Bereiche + 1 Challenge", "Mit vorhandenem Werkzeug oder Minimallösung", "Ausgangswerte der KPIs messen", "Fristen und Gates im Alltag testen"]],
    ["Monat 6", "Auswerten", ["Scorecard und Schwellen kalibrieren", "Werkzeug auswählen", "Betriebsvereinbarung finalisieren", "Go/No-go für den Rollout"]],
    ["ab Monat 7", "Ausrollen & skalieren", ["Weitere Bereiche anschließen", "Challenge-Kalender etablieren", "Erste Wirkungsreviews (G3)", "Quartalsweise nachsteuern"]],
  ];
  const y = 2.0;
  P.forEach((p, i) => {
    const x = 0.6 + i * 3.06, w = 2.9;
    badge(s, x + 0.2, y, String(i + 1), i === 1 ? AMB : G);
    txt(s, p[0], { x: x + 0.75, y: y + 0.05, w: 2.0, h: 0.32, fontSize: 12, bold: true, color: MUT });
    box(s, x, y + 0.7, w, 3.6, i === 1 ? AMBL : GL);
    txt(s, p[1], { x: x + 0.2, y: y + 0.88, w: w - 0.4, h: 0.45, fontSize: 18, bold: true, color: GD });
    txt(s, bullets(p[2], { sp: 8 }), { x: x + 0.2, y: y + 1.45, w: w - 0.35, h: 2.75, fontSize: 13 });
  });
  box(s, 0.6, 6.45, 12.1, 0.45, GD);
  txt(s, "Der Pilot ist der wichtigste Schritt, um Risiken zu senken: Er prüft Fristen, Kapazität und Akzeptanz, bevor in ein Werkzeug investiert wird.",
    { x: 0.85, y: 6.45, w: 11.6, h: 0.45, fontSize: 12.5, color: WHITE, valign: "middle" });
}

// ---------------- Decisions + questions
{
  const s = content("NÄCHSTE SCHRITTE", "Sechs Grundsatzentscheidungen – und offene Fragen an den Auftraggeber");
  const D = ["Geltungsbereich: alle Ideen inkl. KVP oder nur Digitales/Prozesse?", "Schwellenwerte für Schnellspur und Delegation an G2",
    "Besetzung von Triage-Team und Gremium (inkl. Vertretung)", "Gewichtung der Scorecard", "Anerkennungsmodell: immateriell, Prämie oder beides?", "Umfang des KI-Einsatzes und Freigabeweg"];
  txt(s, "ENTSCHEIDEN", { x: 0.6, y: 1.7, w: 6, h: 0.3, fontSize: 11, bold: true, color: G, charSpacing: 1 });
  D.forEach((d, i) => {
    const y = 2.05 + i * 0.75;
    box(s, 0.6, y, 6.6, 0.64, GL);
    badge(s, 0.75, y + 0.12, String(i + 1), G, 0.4, 12);
    txt(s, d, { x: 1.3, y, w: 5.8, h: 0.64, fontSize: 13, valign: "middle" });
  });
  const qx = 7.5, qw = 5.2;
  box(s, qx, 1.7, qw, 4.95, GD);
  txt(s, "Offene Fragen", { x: qx + 0.25, y: 1.85, w: qw - 0.5, h: 0.4, fontSize: 16, bold: true, color: WHITE });
  txt(s, bullets([
    "Wie groß ist die Organisation (Mitarbeitende, Standorte, Sprachen)?",
    "Gibt es einen Betriebsrat und eine Vereinbarung zum Vorschlagswesen?",
    "Gibt es ein bestehendes KVP-/Vorschlagswesen, das abgelöst oder integriert wird?",
    "Gibt es ein Budget für die Umsetzung freigegebener Ideen?",
    "Sind anonyme oder vertrauliche Einreichungen gewünscht?",
    "Ist das Zielwerkzeug gesetzt oder offen?",
  ], { sp: 9 }), { x: qx + 0.25, y: 2.35, w: qw - 0.45, h: 4.2, fontSize: 13, color: "E2F0E8" });
}

(async () => {
  const out = "/tmp/claude-0/-home-claude/caf65b12-bd5a-52e1-b7e5-ce979b063fca/scratchpad/Ideenportal_Konzept_v2.pptx";
  await pres.writeFile({ fileName: out });
  await applyTheme(out, THEME);
  console.log("ok");
})();
