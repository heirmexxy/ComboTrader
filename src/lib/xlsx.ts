// Minimal Excel (.xlsx) reader for contact imports: returns the first worksheet as rows of text cells.
// An .xlsx file is a zip of XML files; we read the zip directory, inflate the parts we need (workbook, shared
// strings, first sheet) and pull out the cell values. No dependency, no formulas, no styles: just the text.
import { inflateRawSync } from 'node:zlib';

export const isXlsx = (buf: Buffer) => buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50; // "PK\x03\x04"
export const isOldXls = (buf: Buffer) => buf.length >= 8 && buf.readUInt32LE(0) === 0xe011cfd0; // pre-2007 .xls

function unzip(buf: Buffer) {
  // End of central directory record: the last 22+ bytes, signature 0x06054b50.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This file is not a readable .xlsx workbook.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map<string, () => Buffer>();
  for (let n = 0; n < count && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    files.set(name, () => {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      return method === 0 ? data : inflateRawSync(data);
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, '&');
/** Text of every <t> in a string item (rich text has several runs). */
const texts = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join('');
/** "AB12" → column index 27 (0-based). */
const colIndex = (ref: string) => { let n = 0; for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

/** The first worksheet as rows of cells (strings), blank rows dropped. */
export function xlsxRows(buf: Buffer): string[][] {
  const z = unzip(buf);
  const read = (name: string) => { const f = z.get(name); return f ? f().toString('utf8') : ''; };
  const shared = [...read('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]));
  // The first sheet in workbook order (its file name is in the workbook's relationships).
  const wb = read('xl/workbook.xml'), rels = read('xl/_rels/workbook.xml.rels');
  const rid = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb)?.[1];
  const target = rid ? new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1] || new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels)?.[1] : null;
  const sheetPath = target ? (target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`) : 'xl/worksheets/sheet1.xml';
  const sheet = read(sheetPath) || read('xl/worksheets/sheet1.xml');
  if (!sheet) throw new Error('No worksheet found in this .xlsx file.');
  const rows: string[][] = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    let next = 0;
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], inner = cm[2] || '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const i = ref ? colIndex(ref) : next;
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let val = '';
      if (type === 's' && v !== undefined) val = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') val = texts(inner);
      else if (v !== undefined) val = unxml(v);
      while (row.length < i) row.push('');
      row[i] = val.trim();
      next = i + 1;
    }
    if (row.some((c) => c)) rows.push(row);
  }
  return rows;
}
