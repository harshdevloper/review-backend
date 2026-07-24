import { franc } from 'franc-min';

const LANGUAGE_NAMES: Record<string, string> = {
  eng: 'English',
  spa: 'Spanish',
  por: 'Portuguese',
  fra: 'French',
  deu: 'German',
  ind: 'Indonesian',
  jpn: 'Japanese',
  kor: 'Korean',
  cmn: 'Chinese',
  arb: 'Arabic',
  hin: 'Hindi',
  rus: 'Russian',
  ita: 'Italian',
  nld: 'Dutch',
  tur: 'Turkish',
  vie: 'Vietnamese',
  tha: 'Thai',
  pol: 'Polish',
  ukr: 'Ukrainian',
  ron: 'Romanian',
  swe: 'Swedish',
  dan: 'Danish',
  nob: 'Norwegian',
  fin: 'Finnish',
  ces: 'Czech',
  ell: 'Greek',
  heb: 'Hebrew',
  zlm: 'Malay',
  ben: 'Bengali',
  tam: 'Tamil',
  tel: 'Telugu',
  mar: 'Marathi',
  guj: 'Gujarati',
  kan: 'Kannada',
  mal: 'Malayalam',
  urd: 'Urdu',
  pan: 'Punjabi',
  hun: 'Hungarian',
  bul: 'Bulgarian',
  hrv: 'Croatian',
  srp: 'Serbian',
  slk: 'Slovak',
};

// ISO 639-1 (used by the `hl` Play Store query param) -> ISO 639-3 display name,
// used as the fallback for text too short/ambiguous for franc to classify.
const ISO_639_1_NAMES: Record<string, string> = {
  en: 'English', es: 'Spanish', pt: 'Portuguese', fr: 'French', de: 'German',
  id: 'Indonesian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', ar: 'Arabic',
  hi: 'Hindi', ru: 'Russian', it: 'Italian', nl: 'Dutch', tr: 'Turkish',
  vi: 'Vietnamese', th: 'Thai', pl: 'Polish', uk: 'Ukrainian', ro: 'Romanian',
  sv: 'Swedish', da: 'Danish', no: 'Norwegian', fi: 'Finnish', cs: 'Czech',
  el: 'Greek', he: 'Hebrew', ms: 'Malay', bn: 'Bengali', ta: 'Tamil',
  te: 'Telugu', mr: 'Marathi', gu: 'Gujarati', kn: 'Kannada', ml: 'Malayalam',
  ur: 'Urdu', pa: 'Punjabi', hu: 'Hungarian', bg: 'Bulgarian', hr: 'Croatian',
  sr: 'Serbian', sk: 'Slovak',
};

// Below this length, franc's trigram statistics are too noisy to trust
// (short reviews like "awesome" get confidently misclassified). Fall back
// to the locale the reviews were fetched in instead of guessing.
const MIN_RELIABLE_LENGTH = 25;

export function detectLanguage(text: string, fallbackLocale: string): string {
  const fallback = ISO_639_1_NAMES[fallbackLocale] ?? 'English';
  if (text.trim().length < MIN_RELIABLE_LENGTH) return fallback;

  const code = franc(text, { minLength: MIN_RELIABLE_LENGTH });
  if (code === 'und') return fallback;
  return LANGUAGE_NAMES[code] ?? fallback;
}
