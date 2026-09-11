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
  'screen-grammar.png',
  'screen-grammar-explain.png',
  'screen-chat.png',
  'og-default.png',
];

// Кадры, которые показываются на главной внутри карточек режимов, нужны ещё и
// в промежуточных ширинах: слот там 472px на десктопе и 308px на мобильном, а
// исходник — 2000px. Без этих вариантов две картинки съедали 80% байтов
// страницы на 360px при кратности 7.2×.
// Шаг до 1600w нужен ретине: 430@3x (iPhone Pro Max) требует 1044px, 768@2x
// (iPad портретом) — 1372px, 1440@3x — 1416px. Без промежуточных вариантов все
// три брали исходные 2000w, то есть 397KB.
const RESPONSIVE_WIDTHS = {
  'screen-immersion-wide.png': [640, 960, 1280, 1600],
  'screen-parallel-wide.png': [640, 960, 1280, 1600],
  // Кадр героя главной: слот 280 CSS-px, то есть исходные 834px нужны только
  // при DPR 3. Это LCP-элемент страницы, и на DPR 1–2 он тянул втрое больше
  // нужного.
  'screen-parallel.png': [280, 560],
  // Кадры грамматики и чата с персонажами: в герое своих страниц слот 280
  // CSS-px, в карточках на главной — 240. Исходник тот же, что у остальных
  // скриншотов, 834px, то есть без вариантов DPR 1 тянул бы втрое больше нужного.
  'screen-grammar.png': [280, 560],
  'screen-grammar-explain.png': [280, 560],
  'screen-chat.png': [280, 560],
};

async function main() {
  const force = process.argv.includes('--force');
  let done = 0, skipped = 0;

  for (const name of FILES_TO_CONVERT) {
    const src = join(PUBLIC, name);
    if (!existsSync(src)) { console.warn(`! missing ${name}`); continue; }
    const stem = basename(name, extname(name));
    const out = join(PUBLIC, stem + '.webp');

    if (force || !existsSync(out)) {
      const before = (await stat(src)).size;
      await sharp(src).webp({ quality: QUALITY, effort: 5 }).toFile(out);
      const after = (await stat(out)).size;
      const pct = ((1 - after/before) * 100).toFixed(0);
      console.log(`✔ ${name}: ${(before/1024).toFixed(0)} KB → ${(after/1024).toFixed(0)} KB (-${pct}%)`);
      done++;
    } else {
      skipped++;
    }

    // Каждый вариант проверяется отдельно, а не заодно с базовым webp: иначе
    // после первого прогона `npm run screens` их больше не создаёт. Цена
    // отсутствующего варианта высокая — браузер, выбрав его из srcset, не
    // откатывается на PNG из <img>, и слот рендерится пустым.
    for (const width of RESPONSIVE_WIDTHS[name] ?? []) {
      const variant = join(PUBLIC, `${stem}-${width}.webp`);
      if (!force && existsSync(variant)) { skipped++; continue; }
      await sharp(src).resize({ width }).webp({ quality: QUALITY, effort: 5 }).toFile(variant);
      console.log(`  ↳ ${width}w: ${((await stat(variant)).size / 1024).toFixed(0)} KB`);
      done++;
    }
  }
  console.log(`\nDone: ${done}, skipped: ${skipped}`);
}

main().catch(err => { console.error(err); process.exit(1); });
