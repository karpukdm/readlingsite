const translitMap: Record<string, string> = {
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo',
  'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
  'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
  'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch',
  'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
};

export function toSlug(title: string): string {
  return title
    .toLowerCase()
    .split('')
    .map(ch => translitMap[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export const complexityToLevel: Record<number, string> = {
  1: 'A1',
  2: 'A2',
  3: 'B1',
  4: 'B2',
  5: 'C1',
  6: 'C2',
};

export const genreLabels: Record<string, string> = {
  CLASSIC: 'Классика',
  FICTION: 'Художественная литература',
  SCIENCE_FICTION: 'Научная фантастика',
  FANTASY: 'Фэнтези',
  ADVENTURE: 'Приключения',
  MYSTERY: 'Детектив',
  HORROR: 'Ужасы',
  ROMANCE: 'Романтика',
  DRAMA: 'Драма',
  HISTORICAL: 'Историческая литература',
  PHILOSOPHY: 'Философия',
  BIOGRAPHY: 'Биография',
  CHILDRENS: 'Детская литература',
  POETRY: 'Поэзия',
  NON_FICTION: 'Нон-фикшн',
  SELF_HELP: 'Саморазвитие',
  YOUNG_ADULT: 'Подростковая литература',
};

export const genreVocabularyHints: Record<string, string> = {
  CLASSIC: 'литературная лексика, архаизмы, развёрнутые описательные конструкции',
  FICTION: 'современная разговорная и литературная лексика',
  SCIENCE_FICTION: 'технические термины, неологизмы, описание вымышленных миров',
  FANTASY: 'описательная лексика, имена собственные, лексика боя и магии',
  ADVENTURE: 'глаголы движения, географические термины, описания природы',
  MYSTERY: 'юридическая и криминалистическая лексика, диалоги-допросы',
  HORROR: 'описательная и эмоциональная лексика, конструкции напряжения',
  ROMANCE: 'эмоциональная лексика, диалоги, идиомы чувств',
  DRAMA: 'диалоги, разговорная речь, эмоциональные конструкции',
  HISTORICAL: 'архаизмы, исторические термины, описания эпох',
  PHILOSOPHY: 'абстрактная лексика, сложные синтаксические конструкции',
  BIOGRAPHY: 'нарративные конструкции, лексика биографий и интервью',
  CHILDRENS: 'простая лексика, частотные слова, короткие предложения',
  POETRY: 'образная лексика, метафоры, ритмические конструкции',
  NON_FICTION: 'специальная и научно-популярная лексика',
  SELF_HELP: 'мотивационная лексика, императивы, бизнес-словарь',
  YOUNG_ADULT: 'современный сленг, школьная лексика, диалоги ровесников',
};

export function extractSnippet(text: string, maxLen: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  const truncated = cleaned.slice(0, maxLen);
  const lastSentenceEnd = Math.max(
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf('! '),
    truncated.lastIndexOf('? ')
  );
  if (lastSentenceEnd > maxLen * 0.5) {
    return truncated.slice(0, lastSentenceEnd + 1);
  }
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated) + '…';
}
