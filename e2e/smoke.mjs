import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Browser smoke test with accessibility check (WCAG 2.1 AA, axe-core) for the self-service
// flows: landing page, sign-up, join link, import, co-authors, attachments, merging,
// "Mein Konto", demo and login. Needs a running server with DEMO_MODE=true.
// Usage: node smoke.mjs [screenshot-dir]

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const OUT = process.argv[2] ?? 'screenshots';
mkdirSync(OUT, { recursive: true });
const TMP = os.tmpdir();
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const errors = [];
const axeFindings = [];
const stamp = Date.now().toString(36);

async function page(viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport, locale: 'de-DE' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => m.type() === 'error' && !m.text().includes('401') && errors.push(`console: ${m.text()}`));
  return p;
}
async function axe(p, name) {
  const r = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  for (const v of r.violations) axeFindings.push(`${name}: ${v.id} (${v.impact}) – ${v.nodes.length} – ${v.nodes[0]?.target}`);
}
const shot = (p, name, fullPage = true) => p.screenshot({ path: `${OUT}/${name}.png`, fullPage });

// 1. Landing page
const anon = await page();
await anon.goto(BASE);
await anon.waitForSelector('.hero');
await shot(anon, '20-landing');
await axe(anon, 'landing');

// 2. Sign-up of a new workspace
await anon.getByRole('link', { name: 'Arbeitsbereich anlegen' }).first().click();
await axe(anon, 'registrieren');
await anon.getByLabel('Name des Teams oder der Organisation').fill(`Capstone Team ${stamp}`);
await anon.getByLabel('Dein Name', { exact: true }).fill('Paula Produkt');
await anon.getByLabel('E-Mail-Adresse', { exact: true }).fill(`paula-${stamp}@capstone.example`);
await anon.getByLabel('Passwort', { exact: true }).fill('Capstone-Passwort-1');
await shot(anon, '21-registrieren');
await anon.getByRole('checkbox', { name: /Datenschutzhinweis/ }).check();
await anon.getByRole('button', { name: 'Arbeitsbereich anlegen' }).click();
await anon.waitForSelector('header.topbar nav');
await anon.getByRole('button', { name: 'Überspringen' }).click();
await anon.waitForSelector('text=Beispielidee');
await shot(anon, '22-start-neuer-arbeitsbereich');

// 3. Join link
await anon.getByRole('link', { name: 'Verwaltung' }).first().click();
await anon.getByRole('tab', { name: 'Personen', exact: true }).click();
await anon.getByRole('textbox', { name: 'Einladungslink' }).waitFor();
const link = await anon.getByRole('textbox', { name: 'Einladungslink' }).inputValue();
await shot(anon, '23-einladungslink');
await axe(anon, 'personen');
const colleague = await page();
await colleague.goto(link);
await colleague.waitForSelector('h1:has-text("beitreten")');
await axe(colleague, 'beitreten');
await shot(colleague, '24-beitreten');
await colleague.getByLabel('Dein Name', { exact: true }).fill('Kai Kollege');
await colleague.getByLabel('E-Mail-Adresse', { exact: true }).fill(`kai-${stamp}@capstone.example`);
await colleague.getByLabel('Passwort', { exact: true }).fill('Kollegen-Passwort-1');
await colleague.getByRole('checkbox', { name: /Datenschutzhinweis/ }).check();
await colleague.getByRole('button', { name: 'Konto anlegen' }).click();
await colleague.waitForSelector('header.topbar nav');
await colleague.getByRole('button', { name: 'Überspringen' }).click();

// 4. Import tab
await anon.getByRole('tab', { name: 'Import', exact: true }).click();
const csv = 'Titel;Problem;Lösung;Nutzen;E-Mail\nPapierlose Reisekosten;Belege gehen verloren;App;Zeit;\nKaffeemaschine zweite Etage;Lange Wege;Zweite Maschine;Weniger Wege;\n';
writeFileSync(path.join(TMP, 'import.csv'), csv);
await anon.getByLabel('Datei auswählen').setInputFiles(path.join(TMP, 'import.csv'));
await anon.waitForSelector('text=Spalten zuordnen');
await shot(anon, '25-import-vorschau');
await axe(anon, 'import');
await anon.getByRole('button', { name: /Idee\(n\) importieren/ }).click();
await anon.waitForSelector('text=2 Idee(n) importiert');

// 5. Data tab with workspace delete dialog
await anon.getByRole('tab', { name: 'Daten', exact: true }).click();
await anon.getByRole('button', { name: 'Arbeitsbereich löschen …' }).click();
await anon.getByRole('dialog').waitFor();
await shot(anon, '26-arbeitsbereich-loeschen', false);
await axe(anon, 'loeschen-dialog');
await anon.getByRole('button', { name: 'Abbrechen' }).click();

// 6. Idea detail: co-author, attachment, merge
await colleague.getByRole('link', { name: 'Idee einreichen' }).first().click();
await colleague.getByLabel('Titel').fill('Reisekosten digital abrechnen');
await colleague.getByLabel('Welches Problem siehst du?').fill('Die Reisekostenabrechnung auf Papier kostet viel Zeit und Belege gehen verloren.');
await colleague.getByRole('button', { name: 'Weiter' }).click();
await colleague.getByLabel('Deine Idee').fill('Belege mit dem Smartphone fotografieren.');
await colleague.getByLabel('Welchen Nutzen erwartest du?').fill('Schnellere Erstattung.');
await colleague.getByRole('button', { name: 'Weiter' }).click();
await colleague.getByLabel('Themenfeld').selectOption({ index: 1 });
await colleague.getByRole('button', { name: 'Weiter' }).click();
await colleague.getByRole('checkbox', { name: /Ich reiche eine Idee ein/ }).check();
await colleague.getByRole('button', { name: 'Absenden' }).click();
await colleague.waitForURL(/\/ideen\//);
const ideaUrl = colleague.url();
await colleague.getByText(/^Weitere Aktionen/).click();
await colleague.getByLabel('Person hinzufügen').fill('Paula');
await colleague.getByRole('button', { name: 'Paula Produkt' }).click();
await colleague.getByRole('button', { name: 'Hinzufügen' }).click();
await colleague.waitForSelector('text=mit Paula Produkt');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
writeFileSync(path.join(TMP, 'skizze.png'), png);
await colleague.getByLabel('Datei anhängen').setInputFiles(path.join(TMP, 'skizze.png'));
await colleague.waitForSelector('a:has-text("skizze.png")');
await shot(colleague, '27-idee-coautor-anhang');
await axe(colleague, 'idee-coautor-anhang');

await anon.goto(ideaUrl);
await anon.getByText(/^Weitere Aktionen/).click();
await anon.getByRole('button', { name: 'Mit anderer Idee zusammenführen' }).click();
await anon.getByLabel('Zielidee suchen').fill('Reisekosten');
await anon.getByRole('radio', { name: /Papierlose Reisekosten/ }).check();
await anon.getByLabel('Begründung').last().fill('Gleiche Idee wie aus dem Import.');
await shot(anon, '28-zusammenfuehren');
await axe(anon, 'zusammenfuehren');
await anon.getByRole('button', { name: 'Zusammenführen', exact: true }).click();
await anon.waitForSelector('text=Diese Idee wurde mit');
await shot(anon, '29-zusammengefuehrt');

// 7. Account page: absence and notifications
await colleague.goto(`${BASE}/konto`);
await colleague.getByRole('tab', { name: 'Abwesenheit' }).click();
await colleague.getByRole('searchbox', { name: 'Vertretung' }).fill('Paula');
await colleague.getByRole('button', { name: 'Paula Produkt' }).click();
await colleague.getByLabel('Bis').fill('2026-12-31');
await colleague.getByRole('button', { name: 'Abwesenheit eintragen' }).click();
await colleague.waitForSelector('text=vertreten durch');
await colleague.getByRole('tab', { name: 'Benachrichtigungen' }).click();
await colleague.getByRole('radio', { name: 'Einmal am Tag als Zusammenfassung' }).check();
await colleague.getByRole('button', { name: 'Speichern' }).click();
await colleague.waitForSelector('text=Gespeichert.');
await shot(colleague, '30-mein-konto');
await axe(colleague, 'konto');

// The first-start dialog appears once per role after the session is loaded; close it when it shows.
async function dismissOnboarding(p) {
  const skip = p.getByRole('button', { name: 'Überspringen' });
  try {
    await skip.waitFor({ state: 'visible', timeout: 2000 });
    await skip.click();
  } catch {
    // not shown
  }
}

// 8. Demo with role switch
const demo = await page();
await demo.goto(`${BASE}/#demo`);
await demo.getByRole('button', { name: /Triage-Team/ }).click();
await demo.waitForSelector('.demo-banner');
await dismissOnboarding(demo);
await shot(demo, '31-demo-triage');
await axe(demo, 'demo');
await demo.locator('.demo-banner').getByRole('button', { name: 'Admin' }).click();
await demo.waitForSelector('text=Du bist als Alex Admin angemeldet');

// 8b. Release 2: AI settings, committee with Gate 2 brief, idea with AI analyses, portfolio, success page
await demo.getByRole('link', { name: 'Verwaltung' }).first().click();
await demo.getByRole('tab', { name: 'KI', exact: true }).click();
await demo.waitForSelector('text=Modell je Aufgabe');
await shot(demo, '40-einstellungen-ki');
await axe(demo, 'einstellungen-ki');
await demo.locator('.demo-banner').getByRole('button', { name: /Triage/ }).click();
await demo.waitForSelector('.demo-banner');
await demo.goto(`${BASE}/gremium`);
await dismissOnboarding(demo);
await demo.getByRole('link', { name: 'Innovationsgremium' }).first().click();
await demo.getByRole('button', { name: /Vorlage erstellen/ }).click();
await demo.waitForSelector('#h-brief ~ article, .ai-result');
await shot(demo, '41-gremium-vorlage');
await axe(demo, 'gremium');
await demo.locator('.ai-result h3 a').first().click();
await demo.waitForSelector('#h-ai');
await demo.locator('details.ai-result summary', { hasText: 'Business Case' }).click();
await shot(demo, '42-idee-ki-analysen');
await axe(demo, 'idee-ki');
await demo.goto(`${BASE}/portfolio`);
await demo.waitForSelector('h1');
await shot(demo, '43-portfolio');
await axe(demo, 'portfolio');
await demo.goto(`${BASE}/erfolge`);
await demo.waitForSelector('h1');
await shot(demo, '44-erfolge');
await axe(demo, 'erfolge');
await demo.goto(`${BASE}/einreichen`);
await demo.getByText('Hilfe beim Formulieren').click();
await demo.getByRole('button', { name: /Ideen-Coach/ }).click();
await demo.waitForSelector('.coach-log li');
await demo.getByLabel('Deine Antwort').fill('In der Kantine gibt es mittags immer lange Schlangen an der Kasse.');
await demo.getByRole('button', { name: 'Senden' }).click();
await demo.waitForFunction(() => document.querySelectorAll('.coach-log li').length >= 3);
await shot(demo, '45-ideen-coach');
await axe(demo, 'coach');

// 8c. Phase 1: dashboard with throughput times, privacy proofs, skip link, reflow at 320 px (WCAG 1.4.10)
await demo.locator('.demo-banner').getByRole('button', { name: 'Admin' }).click();
await demo.waitForSelector('text=Du bist als Alex Admin angemeldet');
await demo.goto(`${BASE}/dashboard`);
await demo.waitForSelector('#h-throughput');
await shot(demo, '46-dashboard-durchlaufzeiten');
await axe(demo, 'dashboard');
await demo.goto(`${BASE}/ki-nachweise`);
await demo.waitForSelector('h1');
await shot(demo, '47-ki-nachweise');
await axe(demo, 'ki-nachweise');
// The skip link is the first focusable element and becomes visible on focus (WCAG 2.4.1).
const firstFocusable = await demo.evaluate(() => document.querySelector('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')?.className ?? '');
if (!firstFocusable.includes('skip-link')) errors.push(`first focusable element is not the skip link: ${firstFocusable}`);
await demo.locator('.skip-link').focus();
if (!(await demo.locator('.skip-link').isVisible())) errors.push('skip link not visible on focus');
const narrowCtx = await browser.newContext({ viewport: { width: 320, height: 640 }, locale: 'de-DE', storageState: await demo.context().storageState() });
const narrow = await narrowCtx.newPage();
narrow.on('pageerror', (e) => errors.push(e.message));
for (const route of ['/', '/ideen', '/einreichen', '/aufgaben', '/dashboard', '/ki-nachweise', '/hilfe']) {
  await narrow.goto(`${BASE}${route}`);
  await narrow.waitForSelector('h1');
  const overflow = await narrow.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) {
    // Name the widest element that sticks out, so the finding can be fixed without guessing.
    const culprit = await narrow.evaluate(() => {
      let worst = null;
      const clipped = (el) => {
        for (let p = el.parentElement; p; p = p.parentElement) if (/(auto|scroll|hidden)/.test(getComputedStyle(p).overflowX)) return true;
        return false;
      };
      for (const el of document.querySelectorAll('body *')) {
        if (clipped(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.right > window.innerWidth + 1 && (!worst || r.width < worst.w)) worst = { w: r.width, d: `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}` };
      }
      return worst?.d ?? '?';
    });
    axeFindings.push(`reflow 320px ${route}: ${overflow}px horizontal scroll (${culprit})`);
  }
}
await shot(narrow, '48-reflow-320');

// 9. Login without workspace field, mobile landing
const mobile = await page({ width: 390, height: 844 });
await mobile.goto(`${BASE}/login`);
await axe(mobile, 'login');
await mobile.getByLabel('E-Mail-Adresse', { exact: true }).fill(`kai-${stamp}@capstone.example`);
await mobile.getByLabel('Passwort', { exact: true }).fill('Kollegen-Passwort-1');
await mobile.getByRole('button', { name: 'Anmelden' }).click();
await mobile.waitForSelector('header.topbar nav.bottombar');
await shot(mobile, '32-mobil-start');
const mobileAnon = await page({ width: 390, height: 844 });
await mobileAnon.goto(BASE);
await mobileAnon.waitForSelector('.hero');
await shot(mobileAnon, '33-mobil-landing');

await browser.close();
console.log('JS errors:', errors.length ? errors : 'none');
console.log('axe:', axeFindings.length ? axeFindings : 'none');
if (errors.length || axeFindings.length) process.exit(1);
