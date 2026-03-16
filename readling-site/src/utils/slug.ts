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
