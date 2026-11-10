import net from 'node:net';
import { HttpError, badRequest } from './errors.js';
import { m } from '../i18n/index.js';

// Attachments (R1-13): at most 10 MB, an allow-list of types checked by content (not by
// the name), and a virus scan with ClamAV when CLAMAV_HOST is configured.

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const TYPES: { ext: string[]; mime: string; test: (b: Buffer) => boolean }[] = [
  { ext: ['png'], mime: 'image/png', test: (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) },
  { ext: ['jpg', 'jpeg'], mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: ['gif'], mime: 'image/gif', test: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  { ext: ['webp'], mime: 'image/webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { ext: ['pdf'], mime: 'application/pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { ext: ['docx'], mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', test: isZip },
  { ext: ['xlsx'], mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', test: isZip },
  { ext: ['pptx'], mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', test: isZip },
  { ext: ['txt'], mime: 'text/plain; charset=utf-8', test: isText },
  { ext: ['csv'], mime: 'text/csv; charset=utf-8', test: isText },
];

function isZip(b: Buffer): boolean {
  return b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
}

function isText(b: Buffer): boolean {
  return !b.includes(0) && Buffer.from(b.toString('utf8'), 'utf8').equals(b);
}

export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'datei';
  return base.replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120) || 'datei';
}

/** Returns the trusted MIME type or throws when the type is not allowed or does not match. */
export function detectType(filename: string, data: Buffer): string {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  const type = TYPES.find((t) => t.ext.includes(ext));
  if (!type) throw badRequest(m('files.typeNotAllowed', { types: TYPES.flatMap((t) => t.ext).join(', ') }));
  if (!type.test(data)) throw badRequest(m('files.contentMismatch'));
  return type.mime;
}

/** Scans with clamd (INSTREAM). Returns false if no scanner is configured. */
export async function scanForViruses(data: Buffer): Promise<boolean> {
  const host = process.env.CLAMAV_HOST;
  if (!host) return false;
  const port = Number(process.env.CLAMAV_PORT ?? 3310);
  const reply = await new Promise<string>((resolve, reject) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.write('zINSTREAM\0');
      for (let i = 0; i < data.length; i += 64 * 1024) {
        const chunk = data.subarray(i, i + 64 * 1024);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(chunk.length);
        socket.write(len);
        socket.write(chunk);
      }
      socket.write(Buffer.alloc(4));
    });
    let out = '';
    socket.setTimeout(30_000, () => socket.destroy(new Error('clamd timeout')));
    socket.on('data', (d) => (out += d.toString()));
    socket.on('end', () => resolve(out));
    socket.on('error', reject);
  }).catch(() => {
    throw new HttpError(503, m('files.scanUnavailable'), 'SCAN_UNAVAILABLE');
  });
  if (!reply.includes('OK') || reply.includes('FOUND')) {
    throw badRequest(m('files.scanRejected'));
  }
  return true;
}
