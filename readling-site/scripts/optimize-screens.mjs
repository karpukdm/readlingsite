import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, '..', 'public');

const QUALITY = 82;
const FILES_TO_CONVERT = [
  'logo.png',
  'duolingo-logo.png',
  'badge-google-play.png',
  'screen-immersion.png',
  'screen-immersion-wide.png',
  'screen-parallel.png',
  'screen-parallel-wide.png',
  'screen-catalog.png',
  'screen-fill-word.png',
  'screen-flashcards.png',
  'screen-sentence-puzzle.png',
  'screen-training.png',
  'og-default.png',
];

async function main() {
  const force = process.argv.includes('--force');
  let done = 0, skipped = 0;

  for (const name of FILES_TO_CONVERT) {
    const src = join(PUBLIC, name);
    if (!existsSync(src)) { console.warn(`! missing ${name}`); continue; }
    const out = join(PUBLIC, basename(name, extname(name)) + '.webp');
    if (!force && existsSync(out)) { skipped++; continue; }

    const before = (await stat(src)).size;
    await sharp(src).webp({ quality: QUALITY, effort: 5 }).toFile(out);
    const after = (await stat(out)).size;
    const pct = ((1 - after/before) * 100).toFixed(0);
    console.log(`✔ ${name}: ${(before/1024).toFixed(0)} KB → ${(after/1024).toFixed(0)} KB (-${pct}%)`);
    done++;
  }
  console.log(`\nDone: ${done}, skipped: ${skipped}`);
}

main().catch(err => { console.error(err); process.exit(1); });
