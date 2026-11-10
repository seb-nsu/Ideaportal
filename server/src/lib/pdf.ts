// Minimal PDF writer for text documents (privacy proof R2-42, works agreement R3-12):
// A4 pages, Helvetica in WinAnsi encoding (covers German umlauts, ß and €), headings,
// paragraphs with line wrapping and simple key-value rows. No external dependency.

export type Block =
  | { kind: 'title'; text: string }
  | { kind: 'heading'; text: string }
  | { kind: 'text'; text: string; small?: boolean }
  | { kind: 'row'; label: string; value: string }
  | { kind: 'bullet'; text: string }
  | { kind: 'space' };

const PAGE = { w: 595.28, h: 841.89, margin: 56 };

// Average glyph widths of Helvetica per 1000 units; good enough for wrapping.
const WIDTH: Record<string, number> = { ' ': 278, i: 222, l: 222, j: 222, t: 278, f: 278, r: 333, I: 278, '.': 278, ',': 278, ':': 278, ';': 278, '(': 333, ')': 333, '-': 333, m: 833, w: 722, M: 833, W: 944 };
const charWidth = (c: string, bold: boolean) => (WIDTH[c] ?? (c >= 'A' && c <= 'Z' ? 667 : 556)) * (bold ? 1.05 : 1);
const textWidth = (s: string, size: number, bold = false) => [...s].reduce((n, c) => n + charWidth(c, bold), 0) * (size / 1000);

function wrap(text: string, size: number, width: number, bold = false): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (textWidth(next, size, bold) <= width || !line) line = next;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

// WinAnsi (CP1252) for the characters outside Latin-1 that German texts use.
const CP1252: Record<string, number> = { '€': 0x80, '„': 0x84, '…': 0x85, '–': 0x96, '—': 0x97, '“': 0x93, '”': 0x94, '‘': 0x91, '’': 0x92, '•': 0x95 };

function encode(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = CP1252[ch] ?? ch.codePointAt(0)!;
    if (code > 255) out += '?';
    else if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
    else if (code < 32 || code > 126) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += ch;
  }
  return out;
}

interface Line { text: string; size: number; bold: boolean; x: number; gapBefore: number }

function layout(blocks: Block[]): Line[] {
  const width = PAGE.w - 2 * PAGE.margin;
  const lines: Line[] = [];
  for (const b of blocks) {
    if (b.kind === 'space') lines.push({ text: '', size: 6, bold: false, x: 0, gapBefore: 0 });
    else if (b.kind === 'title') wrap(b.text, 18, width, true).forEach((t, i) => lines.push({ text: t, size: 18, bold: true, x: 0, gapBefore: i ? 0 : 0 }));
    else if (b.kind === 'heading') wrap(b.text, 12, width, true).forEach((t, i) => lines.push({ text: t, size: 12, bold: true, x: 0, gapBefore: i ? 0 : 10 }));
    else if (b.kind === 'text') wrap(b.text, b.small ? 8.5 : 10, width).forEach((t) => lines.push({ text: t, size: b.small ? 8.5 : 10, bold: false, x: 0, gapBefore: 0 }));
    else if (b.kind === 'bullet') wrap(b.text, 10, width - 14).forEach((t, i) => lines.push({ text: i ? t : `• ${t}`, size: 10, bold: false, x: i ? 9 : 0, gapBefore: 0 }));
    else if (b.kind === 'row') {
      const labelWidth = 150;
      const value = wrap(b.value || '–', 10, width - labelWidth);
      value.forEach((t, i) => {
        if (i === 0) lines.push({ text: b.label, size: 10, bold: true, x: 0, gapBefore: 2 });
        lines.push({ text: t, size: 10, bold: false, x: labelWidth, gapBefore: i === 0 ? -1 : 0 });
      });
    }
  }
  return lines;
}

/** Renders the blocks into a PDF; every page has a footer with the page number. */
export function renderPdf(blocks: Block[], meta: { title: string; footer: string }): Buffer {
  const lines = layout(blocks);
  const pages: string[] = [];
  let ops = '';
  let y = PAGE.h - PAGE.margin;
  let lastSize = 10;
  const flush = () => {
    pages.push(ops);
    ops = '';
    y = PAGE.h - PAGE.margin;
  };
  for (const l of lines) {
    // A value printed next to its label shares the label's baseline.
    if (l.gapBefore === -1) y += lastSize * 1.35;
    else y -= l.gapBefore;
    const step = l.size * 1.35;
    if (y - step < PAGE.margin + 20) flush();
    y -= step;
    lastSize = l.size;
    if (l.text) ops += `BT /${l.bold ? 'F2' : 'F1'} ${l.size} Tf ${(PAGE.margin + l.x).toFixed(2)} ${y.toFixed(2)} Td (${encode(l.text)}) Tj ET\n`;
  }
  flush();

  const objects: string[] = [];
  const add = (body: string) => objects.push(body) - 1 + 1; // 1-based object number
  const catalog = add('');
  const pagesObj = add('');
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  pages.forEach((content, i) => {
    const footer = `BT /F1 8 Tf ${PAGE.margin} 30 Td (${encode(`${meta.footer} · Seite ${i + 1} von ${pages.length}`)}) Tj ET\n`;
    const stream = content + footer;
    const contentObj = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${contentObj} 0 R >>`));
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const info = add(`<< /Title (${encode(meta.title)}) /Producer (Ideenportal) >>`);

  let pdf = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
