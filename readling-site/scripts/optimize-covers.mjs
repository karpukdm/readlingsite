import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BOOKS = join(ROOT, 'src/data/books.json');
const OUT_DIR = join(ROOT, 'public/covers');

const translitMap = {
  'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh','з':'z',
  'и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r',
  'с':'s','т':'t','у':'u','ф':'f','х':'kh','ц':'ts','ч':'ch','ш':'sh',
  'щ':'shch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya',
};
const toSlug = (title) => title.toLowerCase().split('')
  .map(ch => translitMap[ch] ?? ch).join('')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const VARIANTS = [
  { name: '',     width: 320 },
  { name: '@2x',  width: 480 },
  { name: '-lg',  width: 720 },
];

const QUALITY = 78;

async function fetchBuf(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'readling-cover-optimizer/1.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const books = JSON.parse(await readFile(BOOKS, 'utf8'));
  const force = process.argv.includes('--force');

  let done = 0, skipped = 0, failed = 0;
  for (const book of books) {
    const slug = toSlug(book.title);
    const url = book.imageUrl;
    if (!url) { console.warn(`! no imageUrl for ${slug}`); failed++; continue; }

    const targets = VARIANTS.map(v => ({
      ...v,
      path: join(OUT_DIR, `${slug}${v.name}.webp`),
    }));
    if (!force && targets.every(t => existsSync(t.path))) {
      skipped++;
      continue;
    }

    try {
      const src = await fetchBuf(url);
      const meta = await sharp(src).metadata();
      const srcW = meta.width || 0;

      for (const t of targets) {
        const targetW = Math.min(t.width, srcW || t.width);
        await sharp(src)
          .resize({ width: targetW, withoutEnlargement: true })
          .webp({ quality: QUALITY, effort: 5 })
          .toFile(t.path);
      }
      done++;
      process.stdout.write(`✔ ${slug} (src ${srcW}px)\n`);
    } catch (err) {
      failed++;
      console.error(`✗ ${slug}: ${err.message}`);
    }
  }
  console.log(`\nDone: ${done}, skipped: ${skipped}, failed: ${failed}`);
}

main().catch(err => { console.error(err); process.exit(1); });
