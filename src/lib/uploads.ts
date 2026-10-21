// File uploads. Public images (trail photos, blog covers) are re-encoded with sharp, which
// strips metadata and anything that isn't a real image. Private files (ID documents, buyer
// contracts) live outside the public folder and are only served to admins.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { config } from './config';
import { randomToken } from './util';
import type { Upload } from './http';
import { HttpError } from './http';

const MAX = 5 * 1024 * 1024;
function kindOf(buf: Buffer) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a') return 'png';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'webp';
  if (buf.slice(0, 5).toString() === '%PDF-') return 'pdf';
  return null;
}
function dest(visibility: 'public' | 'private', ext: string) {
  const d = new Date();
  const rel = path.posix.join(`${d.getUTCFullYear()}`, String(d.getUTCMonth() + 1).padStart(2, '0'), `${randomToken(12)}.${ext}`);
  const abs = path.resolve(config.uploadsDir, visibility, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  return { rel, abs };
}

export async function savePublicImage(f: Upload | undefined, maxWidth = 1600) {
  if (!f) return null;
  if (f.data.length > MAX * 2) throw new HttpError(413, 'Image is larger than 10 MB');
  const k = kindOf(f.data);
  if (!k || k === 'pdf') throw new HttpError(400, 'Please upload a JPG, PNG or WebP image');
  const { rel, abs } = dest('public', 'webp');
  await sharp(f.data).rotate().resize({ width: maxWidth, withoutEnlargement: true }).webp({ quality: 80 }).toFile(abs);
  return rel;
}

export function savePrivateFile(f: Upload | undefined, allowPdf = true) {
  if (!f) return null;
  if (f.data.length > MAX) throw new HttpError(413, 'File is larger than 5 MB');
  const k = kindOf(f.data);
  if (!k || (k === 'pdf' && !allowPdf)) throw new HttpError(400, 'Please upload a JPG, PNG or PDF file');
  const { rel, abs } = dest('private', k);
  fs.writeFileSync(abs, f.data, { mode: 0o600 });
  return rel;
}

export function privatePath(rel: string) {
  const root = path.resolve(config.uploadsDir, 'private');
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep) || !fs.existsSync(abs)) return null;
  return abs;
}
