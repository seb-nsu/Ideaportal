import net from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { closePool, withSystem } from '../src/db/pool.js';
import { detectType, MAX_ATTACHMENT_BYTES, sanitizeFilename, scanForViruses } from '../src/lib/attachments.js';
import { checkBoundary } from '../src/lib/boundary.js';
import { HttpError } from '../src/lib/errors.js';
import { guessMapping, parseCsv, parseTable } from '../src/lib/importer.js';
import { renderPdf, type Block } from '../src/lib/pdf.js';
import { enforce, hit, LIMITS, purgeRateLimits, RateLimitError } from '../src/lib/ratelimit.js';
import { defaultSettings } from '../src/lib/settings.js';
import { resetDb } from './helpers.js';

// Unit tests of small library modules that had no direct tests: rate limits (R1-44), PDF writer
// (R2-42), import parser (R1-39), attachment checks (R1-13) and the boundary check (R1-18).

const originalFactor = config.rateLimitFactor;

beforeAll(async () => {
  await resetDb();
});

afterEach(() => {
  config.rateLimitFactor = originalFactor;
  delete process.env.CLAMAV_HOST;
  delete process.env.CLAMAV_PORT;
});

afterAll(async () => {
  await closePool();
});

describe('rate limits (R1-44)', () => {
  it('counts hits per bucket and key and reports the remaining window once exceeded', async () => {
    config.rateLimitFactor = 1;
    const max = LIMITS.resetAccount.max;
    const results = await withSystem(async (c) => {
      const out: (number | null)[] = [];
      for (let i = 0; i <= max; i++) out.push(await hit(c, 'resetAccount', 'Someone@Example.org'));
      return out;
    });
    expect(results.slice(0, max)).toEqual(Array(max).fill(null));
    const retry = results[max]!;
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(LIMITS.resetAccount.windowSeconds);
    // Keys are case-insensitive and stored only as a hash.
    const rows = await withSystem(
      async (c) => (await c.query<{ key_hash: string; hits: number }>(`SELECT key_hash, hits FROM rate_limits WHERE bucket = 'resetAccount'`)).rows,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].hits).toBe(max + 1);
    expect(rows[0].key_hash).not.toContain('someone');
    // The first hit over the limit is a security event, exactly once.
    await withSystem((c) => hit(c, 'resetAccount', 'someone@example.org'));
    const events = await withSystem(async (c) => (await c.query(`SELECT detail FROM security_events WHERE bucket = 'resetAccount'`)).rows);
    expect(events).toHaveLength(1);
    expect(events[0].detail).toMatchObject({ max, windowSeconds: LIMITS.resetAccount.windowSeconds });
  });

  it('enforce throws 429 with retry information and calls onExceeded in the same transaction', async () => {
    config.rateLimitFactor = 1;
    const exceeded: string[] = [];
    for (let i = 0; i < LIMITS.operatorIp.max; i++) await enforce([['operatorIp', '203.0.113.9']]);
    const err = await enforce(
      [
        ['operatorIp', '203.0.113.9'],
        ['resetIp', null],
      ],
      async (_c, bucket) => {
        exceeded.push(bucket);
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as RateLimitError).status).toBe(429);
    expect((err as RateLimitError).retryAfter).toBeGreaterThan(0);
    expect(exceeded).toEqual(['operatorIp']);
    // Another key in the same bucket is not affected; empty keys are skipped.
    await expect(
      enforce([
        ['operatorIp', '203.0.113.10'],
        ['loginAccount', undefined],
      ]),
    ).resolves.toBeUndefined();
  });

  it('factor 0 switches limits off, factors scale them', async () => {
    config.rateLimitFactor = 0;
    const off = await withSystem(async (c) => {
      const out: (number | null)[] = [];
      for (let i = 0; i < 5; i++) out.push(await hit(c, 'signupIp', 'factor-zero'));
      return out;
    });
    expect(off.every((r) => r === null)).toBe(true);
    config.rateLimitFactor = 0.2; // signupIp: max 5 → 1
    const scaled = await withSystem(async (c) => [await hit(c, 'signupIp', 'scaled'), await hit(c, 'signupIp', 'scaled')]);
    expect(scaled[0]).toBeNull();
    expect(scaled[1]).not.toBeNull();
  });

  it('purges expired counters', async () => {
    await withSystem((c) => c.query(`UPDATE rate_limits SET window_start = now() - interval '2 days' WHERE bucket = 'signupIp'`));
    const removed = await withSystem((c) => purgeRateLimits(c));
    expect(removed).toBeGreaterThanOrEqual(1);
    const left = await withSystem(async (c) => (await c.query(`SELECT count(*)::int AS n FROM rate_limits WHERE bucket = 'signupIp'`)).rows[0].n);
    expect(left).toBe(0);
  });
});

describe('PDF writer (R2-42)', () => {
  const pdfText = (buf: Buffer) => buf.toString('latin1');

  it('writes a valid PDF skeleton with title, fonts and cross-reference table', () => {
    const buf = renderPdf(
      [
        { kind: 'title', text: 'Nachweis' },
        { kind: 'text', text: 'Hallo Welt' },
      ],
      { title: 'Test (1)', footer: 'Fuß' },
    );
    const s = pdfText(buf);
    expect(s.startsWith('%PDF-1.4')).toBe(true);
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(s).toContain('/BaseFont /Helvetica ');
    expect(s).toContain('/BaseFont /Helvetica-Bold');
    expect(s).toContain('(Hallo Welt) Tj');
    // Parentheses in strings are escaped, the title lands in the info dictionary.
    expect(s).toContain('/Title (Test \\(1\\))');
    // The xref offset points at the xref keyword.
    const startxref = Number(/startxref\n(\d+)/.exec(s)![1]);
    expect(s.slice(startxref, startxref + 4)).toBe('xref');
    // Every object offset in the xref table points at "<n> 0 obj".
    const offsets = [...s.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((o, i) => expect(s.slice(o).startsWith(`${i + 1} 0 obj`)).toBe(true));
  });

  it('encodes umlauts, € and dashes in WinAnsi and replaces unsupported characters', () => {
    const s = pdfText(renderPdf([{ kind: 'text', text: 'Äpfel – 5 € 🙂' }], { title: 't', footer: 'f' }));
    expect(s).toContain('(\\304pfel \\226 5 \\200 ?) Tj');
  });

  it('wraps long text and breaks pages, every page has a numbered footer', () => {
    const long = Array.from({ length: 400 }, (_, i) => `Wort${i}`).join(' ');
    const blocks: Block[] = [
      { kind: 'heading', text: 'Abschnitt' },
      { kind: 'row', label: 'Feld', value: long },
      { kind: 'bullet', text: long },
      { kind: 'space' },
      { kind: 'text', text: long, small: true },
    ];
    const s = pdfText(renderPdf(blocks, { title: 't', footer: 'Ideenportal' }));
    const count = Number(/\/Count (\d+)/.exec(s)![1]);
    expect(count).toBeGreaterThan(1);
    expect(s).toContain(`Seite 1 von ${count}`);
    expect(s).toContain(`Seite ${count} von ${count}`);
    expect([...s.matchAll(/\/Type \/Page /g)]).toHaveLength(count);
    // Empty row values are shown as a dash.
    expect(pdfText(renderPdf([{ kind: 'row', label: 'Leer', value: '' }], { title: 't', footer: 'f' }))).toContain('(\\226) Tj');
  });
});

describe('import parser (R1-39)', () => {
  it('detects the delimiter, handles quotes, escaped quotes, line breaks and the byte order mark', () => {
    expect(parseCsv('\uFEFFTitel;Nutzen\r\n"A; mit Semikolon";"Sagt ""hallo"""\n\nB;"zwei\nZeilen"')).toEqual([
      ['Titel', 'Nutzen'],
      ['A; mit Semikolon', 'Sagt "hallo"'],
      ['B', 'zwei\nZeilen'],
    ]);
    expect(parseCsv('title,benefit\nx,y')).toEqual([
      ['title', 'benefit'],
      ['x', 'y'],
    ]);
    // A last line without line break and empty lines.
    expect(parseCsv('a;b\n;\n c ; d')).toEqual([
      ['a', 'b'],
      [' c ', ' d'],
    ]);
  });

  it('guesses the mapping from German and English headers, each column once', () => {
    expect(guessMapping(['Betreff', 'Ausgangslage', 'Vorschlag', 'Mehrwert', 'Kategorie', 'E-Mail'])).toEqual({
      title: 0,
      problem: 1,
      solution: 2,
      benefit: 3,
      topic: 4,
      email: 5,
    });
    expect(guessMapping([' TITLE ', 'description', 'unbekannt'])).toEqual({ title: 0, solution: 1 });
    expect(guessMapping([])).toEqual({});
  });

  it('parses CSV and TXT buffers and rejects other file types', async () => {
    expect(await parseTable('ideen.CSV', Buffer.from('Titel;Nutzen\nA;B'))).toEqual([
      ['Titel', 'Nutzen'],
      ['A', 'B'],
    ]);
    expect(await parseTable('ideen.txt', Buffer.from('a,b'))).toEqual([['a', 'b']]);
    await expect(parseTable('ideen.pdf', Buffer.from('%PDF-'))).rejects.toMatchObject({ status: 400 });
  });
});

describe('attachments (R1-13)', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it('limits the size to 10 MB', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(10 * 1024 * 1024);
  });

  it('sanitizes file names: no paths, no special characters, limited length', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Users\\x\\Bericht <1>.pdf')).toBe('Bericht _1_.pdf');
    expect(sanitizeFilename('Übersicht März.xlsx')).toBe('Übersicht März.xlsx');
    expect(sanitizeFilename('a'.repeat(300))).toHaveLength(120);
    expect(sanitizeFilename('dir/')).toBe('datei');
  });

  it('checks the type by content, not by name', () => {
    expect(detectType('bild.PNG', png)).toBe('image/png');
    expect(detectType('foto.jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(detectType('a.gif', Buffer.from('GIF89a'))).toBe('image/gif');
    expect(detectType('a.webp', Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(detectType('a.pdf', Buffer.from('%PDF-1.7'))).toBe('application/pdf');
    expect(detectType('a.docx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]))).toContain('wordprocessingml');
    expect(detectType('notiz.txt', Buffer.from('Grüße'))).toBe('text/plain; charset=utf-8');
    expect(() => detectType('fake.png', Buffer.from('%PDF-1.7'))).toThrow(HttpError);
    expect(() => detectType('binary.txt', Buffer.from([0x41, 0x00, 0x42]))).toThrow(HttpError);
    expect(() => detectType('broken.csv', Buffer.from([0xc3, 0x28]))).toThrow(HttpError);
    expect(() => detectType('tool.exe', Buffer.from('MZ'))).toThrow(HttpError);
    expect(() => detectType('ohne-endung', png)).toThrow(HttpError);
  });

  it('skips the virus scan without CLAMAV_HOST', async () => {
    await expect(scanForViruses(png)).resolves.toBe(false);
  });

  /** Fake clamd that answers every INSTREAM with the given reply. */
  async function fakeClamd(reply: string): Promise<{ port: number; received: Promise<Buffer>; close: () => void }> {
    let resolve!: (b: Buffer) => void;
    const received = new Promise<Buffer>((r) => (resolve = r));
    const server = net.createServer((socket) => {
      const chunks: Buffer[] = [];
      socket.on('data', (d) => {
        chunks.push(d);
        const all = Buffer.concat(chunks);
        // The stream ends with a zero-length chunk.
        if (all.length >= 14 && all.subarray(-4).equals(Buffer.alloc(4))) {
          resolve(all);
          socket.end(reply);
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { port: (server.address() as net.AddressInfo).port, received, close: () => server.close() };
  }

  it('streams the file to clamd and accepts a clean result', async () => {
    const clamd = await fakeClamd('stream: OK\0');
    process.env.CLAMAV_HOST = '127.0.0.1';
    process.env.CLAMAV_PORT = String(clamd.port);
    try {
      await expect(scanForViruses(png)).resolves.toBe(true);
      const data = await clamd.received;
      expect(data.subarray(0, 10).toString('latin1')).toBe('zINSTREAM\0');
      expect(data.readUInt32BE(10)).toBe(png.length);
    } finally {
      clamd.close();
    }
  });

  it('rejects infected files and reports an unreachable scanner as 503', async () => {
    const clamd = await fakeClamd('stream: Eicar-Signature FOUND\0');
    process.env.CLAMAV_HOST = '127.0.0.1';
    process.env.CLAMAV_PORT = String(clamd.port);
    try {
      await expect(scanForViruses(png)).rejects.toMatchObject({ status: 400 });
    } finally {
      clamd.close();
    }
    const closed = net.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as net.AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    process.env.CLAMAV_PORT = String(port);
    await expect(scanForViruses(png)).rejects.toMatchObject({ status: 503, code: 'SCAN_UNAVAILABLE' });
  });
});

describe('boundary check (R1-18)', () => {
  it('finds keywords at word starts, case-insensitive, and names the target channel', () => {
    const settings = {
      ...defaultSettings,
      targetChannels: [
        { id: 'hinweis', name: 'Hinweisgebersystem', kind: 'whistleblowing', contact: 'compliance@example.org', url: 'https://example.org/hinweis' },
      ],
    } as typeof defaultSettings;
    const matches = checkBoundary('Ich möchte einen Fall von KORRUPTION und Mobbing melden.', settings);
    const report = matches.find((x) => x.category === 'report')!;
    expect(report.keywords.sort()).toEqual(['korruption', 'mobbing']);
    expect(report.channel).toEqual({ name: 'Hinweisgebersystem', contact: 'compliance@example.org', url: 'https://example.org/hinweis' });
  });

  it('ignores keywords inside other words and plain ideas', () => {
    expect(checkBoundary('Gestaffelte Pausenzeiten in der Kantine.', defaultSettings)).toEqual([]);
    // "betrug" inside "Gesamtbetrug" is not at a word start.
    const settings = { ...defaultSettings, targetChannels: [] } as typeof defaultSettings;
    expect(checkBoundary('Der Gesamtbetrug... nein: Gesamtbetrag', settings).some((x) => x.category === 'report')).toBe(false);
  });

  it('escapes regular expression characters in configured keywords and reports a missing channel as null', () => {
    const settings = {
      ...defaultSettings,
      targetChannels: [],
      boundaryRules: [{ category: 'custom', label: 'Eigene Regel', channelKind: 'whistleblowing', keywords: ['c++', 'a.b'] }],
    } as typeof defaultSettings;
    expect(checkBoundary('Wir nutzen c++ im Projekt', settings)).toEqual([{ category: 'custom', label: 'Eigene Regel', keywords: ['c++'], channel: null }]);
    expect(checkBoundary('axb', settings)).toEqual([]);
  });
});
