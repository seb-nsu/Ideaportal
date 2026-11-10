import { readSheet } from 'read-excel-file/node';
import { badRequest } from './errors.js';
import { m } from '../i18n/index.js';

// Import of existing ideas from CSV or Excel (R1-39).

export const IMPORT_FIELDS = ['title', 'problem', 'solution', 'benefit', 'topic', 'email'] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export type Mapping = Partial<Record<ImportField, number>>;

const SYNONYMS: Record<ImportField, string[]> = {
  title: ['titel', 'title', 'name', 'kurztitel', 'betreff'],
  problem: ['problem', 'ausgangslage', 'ist-zustand', 'situation'],
  solution: ['lösung', 'loesung', 'idee', 'beschreibung', 'vorschlag', 'solution', 'description'],
  benefit: ['nutzen', 'vorteil', 'benefit', 'mehrwert'],
  topic: ['themenfeld', 'thema', 'kategorie', 'topic', 'category'],
  email: ['e-mail', 'email', 'mail', 'einreicher', 'ideengeber', 'autor', 'author'],
};

export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, '');
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export async function parseTable(filename: string, data: Buffer): Promise<string[][]> {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'csv' || ext === 'txt') return parseCsv(data.toString('utf8'));
  if (ext === 'xlsx') {
    const rows = await readSheet(data);
    return rows.map((r) => r.map((c) => (c == null ? '' : c instanceof Date ? c.toISOString().slice(0, 10) : String(c))));
  }
  throw badRequest(m('files.importType'));
}

export function guessMapping(headers: string[]): Mapping {
  const mapping: Mapping = {};
  const used = new Set<number>();
  for (const field of IMPORT_FIELDS) {
    const idx = headers.findIndex((h, i) => !used.has(i) && SYNONYMS[field].includes(h.trim().toLowerCase()));
    if (idx >= 0) {
      mapping[field] = idx;
      used.add(idx);
    }
  }
  return mapping;
}
