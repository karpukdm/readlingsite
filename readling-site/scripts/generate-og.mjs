import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BOOKS = join(ROOT, 'src/data/books.json');
const COVERS_DIR = join(ROOT, 'public/covers');
const OUT_DIR = join(ROOT, 'public/og-books');

const translitMap = {
  'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh','з':'z',
  'и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r',
  'с':'s','т':'t','у':'u','ф':'f','х':'kh','ц':'ts','ч':'ch','ш':'sh',
  'щ':'shch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya',
};
const toSlug = (title) => title.toLowerCase().split('')
  .map(ch => translitMap[ch] ?? ch).join('')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const complexityToLevel = { 1:'A1', 2:'A2', 3:'B1', 4:'B2', 5:'C1', 6:'C2' };

const W = 1200, H = 630;
const COVER_W = 280, COVER_H = 420;
const COVER_X = 80, COVER_Y = (H - COVER_H) / 2;

function escapeXml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Грубая обёртка длинного заголовка в N строк по maxChars символов в строке
function wrapTitle(title, maxChars = 22, maxLines = 3) {
  const words = title.split(/\s+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).trim().length <= maxChars) {
      current = (current + ' ' + word).trim();
    } else {
      if (current) lines.push(current);
      current = word;
      if (lines.length === maxLines - 1) break;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  // последняя строка с ... если длинно
  if (lines.length === maxLines && current && current.length > maxChars) {
    lines[maxLines - 1] = current.slice(0, maxChars - 1) + '…';
  }
  return lines;
}

function buildSvg({ title, author, level, mode }) {
  const titleLines = wrapTitle(title, 22, 3);
  const titleFontSize = titleLines.length >= 3 ? 48 : titleLines.length === 2 ? 56 : 64;
  const titleLineHeight = titleFontSize * 1.1;
  const titleStartY = 240 - ((titleLines.length - 1) * titleLineHeight) / 2;

  const textX = 440;

  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#F5F7FB"/>
        <stop offset="100%" stop-color="#E3ECFA"/>
      </linearGradient>
      <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="8" stdDeviation="12" flood-opacity="0.18"/>
      </filter>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#bg)"/>
    <rect x="0" y="0" width="${W}" height="6" fill="#007AFF"/>

    <!-- Brand -->
    <text x="${textX}" y="120" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
          font-size="22" font-weight="700" fill="#007AFF" letter-spacing="2">READLING</text>
    <text x="${textX}" y="150" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
          font-size="16" fill="#6E6E73">Английский по книгам</text>

    <!-- Title -->
    ${titleLines.map((line, i) => `
      <text x="${textX}" y="${titleStartY + i * titleLineHeight}"
            font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
            font-size="${titleFontSize}" font-weight="700" fill="#1D1D1F">${escapeXml(line)}</text>
    `).join('')}

    <!-- Author -->
    <text x="${textX}" y="${titleStartY + titleLines.length * titleLineHeight + 30}"
          font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
          font-size="28" fill="#48484A">${escapeXml(author)}</text>

    <!-- Tags -->
    <g transform="translate(${textX}, 510)">
      <rect x="0" y="0" rx="14" ry="14" width="80" height="36" fill="#007AFF"/>
      <text x="40" y="24" font-family="-apple-system, BlinkMacSystemFont, sans-serif"
            font-size="16" font-weight="700" fill="white" text-anchor="middle">${level}</text>

      <rect x="92" y="0" rx="14" ry="14" width="${mode === 'погружение' ? 180 : 220}" height="36"
            fill="#EBF3FF" stroke="#B7D4FE"/>
      <text x="${92 + (mode === 'погружение' ? 90 : 110)}" y="24"
            font-family="-apple-system, BlinkMacSystemFont, sans-serif"
            font-size="15" font-weight="600" fill="#007AFF" text-anchor="middle">
        ${mode === 'погружение' ? 'Режим погружения' : 'Параллельное чтение'}
      </text>
    </g>
  </svg>`;
}

async function processBook(book, force) {
  const slug = toSlug(book.title);
  if (book.title.includes('Guide') || book.title.includes('Руководство')) return 'skip';
  const outPath = join(OUT_DIR, `${slug}.png`);
  if (!force && existsSync(outPath)) return 'cached';

  const coverPath = join(COVERS_DIR, `${slug}@2x.webp`);
  if (!existsSync(coverPath)) {
    console.warn(`! no cover for ${slug}`);
    return 'fail';
  }

  const complexity = book.complexity ?? 4;
  const level = complexityToLevel[complexity] || 'B1';

  const svg = buildSvg({
    title: book.title,
    author: book.author,
    level,
    mode: book.mode,
  });

  const coverBuf = await sharp(coverPath)
    .resize(COVER_W, COVER_H, { fit: 'cover', position: 'center' })
    .toBuffer();

  // Сначала SVG-фон, потом обложку с тенью поверх
  await sharp(Buffer.from(svg))
    .composite([
      { input: coverBuf, left: COVER_X, top: Math.round(COVER_Y) },
    ])
    .png({ quality: 88, compressionLevel: 9 })
    .toFile(outPath);

  return 'done';
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const books = JSON.parse(await readFile(BOOKS, 'utf8'));
  const force = process.argv.includes('--force');

  let done = 0, cached = 0, skip = 0, fail = 0;
  for (const book of books) {
    const res = await processBook(book, force);
    if (res === 'done') { done++; process.stdout.write(`✔ ${toSlug(book.title)}\n`); }
    else if (res === 'cached') cached++;
    else if (res === 'skip') skip++;
    else fail++;
  }
  console.log(`\nDone: ${done}, cached: ${cached}, skipped: ${skip}, failed: ${fail}`);
}

main().catch(err => { console.error(err); process.exit(1); });
