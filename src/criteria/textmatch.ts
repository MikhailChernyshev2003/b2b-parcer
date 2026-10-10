/**
 * Morphology-aware text matching for Russian.
 *
 * Keywords and tender texts are tokenized and each Cyrillic token is reduced
 * to its stem (Snowball/Porter algorithm for Russian), so "цифровой продукт"
 * matches "цифровые продукты", "разработка" matches "разработке", etc.
 * Multi-word keywords match only as a consecutive phrase (token sequence).
 * Latin/numeric tokens (1С, BI, PostgreSQL) are compared as-is (lowercased).
 *
 * Stems are compared fuzzily (prefix, min 4 chars, length diff <= 2) because
 * the Snowball stemmer can yield different bases for forms of the same word
 * (e.g. "система" -> "систем", but "систем" -> "сист").
 */

const VOWELS = "аеиоуыэюя";

const PERFECTIVE_1 = /(ив|ивши|ившись|ыв|ывши|ывшись)$/;
const PERFECTIVE_2 = /([ая])(в|вши|вшись)$/;
const REFLEXIVE = /(с[яь])$/;
const ADJECTIVE =
  /(ее|ие|ые|ое|ими|ыми|ей|ий|ый|ой|ем|им|ым|ом|его|ого|ему|ому|их|ых|ую|юю|ая|яя|ою|ею)$/;
const PARTICIPLE_1 = /(ивш|ывш|ующ)$/;
const PARTICIPLE_2 = /([ая])(ем|нн|вш|ющ|щ)$/;
const VERB_1 =
  /(ила|ыла|ена|ейте|уйте|ите|или|ыли|ей|уй|ил|ыл|им|ым|ен|ило|ыло|ено|ят|ует|уют|ит|ыт|ены|ить|ыть|ишь|ую|ю)$/;
const VERB_2 = /([ая])(ла|на|ете|йте|ли|й|л|ем|н|ло|но|ет|ют|ны|ть|ешь|нно)$/;
const NOUN =
  /(а|ев|ов|ие|ье|е|иями|ями|ами|еи|ии|и|ией|ей|ой|ий|й|иям|ям|ием|ем|ам|ом|о|у|ах|иях|ях|ы|ь|ию|ью|ю|ия|ья|я)$/;
const SUPERLATIVE = /(ейше|ейш)$/;
const DERIVATIONAL = /(ост|ость)$/;

/** Snowball stemmer for a single lowercase Russian word. */
export function stemRu(word: string): string {
  const w = word.replace(/ё/g, "е");
  // RV = region after the first vowel.
  let rvStart = -1;
  for (let i = 0; i < w.length; i++) {
    if (VOWELS.includes(w[i]!)) {
      rvStart = i + 1;
      break;
    }
  }
  if (rvStart < 0 || rvStart >= w.length) return w;
  const head = w.slice(0, rvStart);
  let rv = w.slice(rvStart);

  // Step 1: perfective gerund, else (reflexive?) adjectival / verb / noun.
  let done = false;
  if (PERFECTIVE_1.test(rv)) {
    rv = rv.replace(PERFECTIVE_1, "");
    done = true;
  } else if (PERFECTIVE_2.test(rv)) {
    rv = rv.replace(PERFECTIVE_2, "$1");
    done = true;
  }
  if (!done) {
    rv = rv.replace(REFLEXIVE, "");
    if (ADJECTIVE.test(rv)) {
      rv = rv.replace(ADJECTIVE, "");
      if (PARTICIPLE_1.test(rv)) rv = rv.replace(PARTICIPLE_1, "");
      else rv = rv.replace(PARTICIPLE_2, "$1");
    } else if (VERB_1.test(rv)) {
      rv = rv.replace(VERB_1, "");
    } else if (VERB_2.test(rv)) {
      rv = rv.replace(VERB_2, "$1");
    } else {
      rv = rv.replace(NOUN, "");
    }
  }

  // Step 2: drop trailing "и".
  rv = rv.replace(/и$/, "");
  // Step 3: derivational suffix (in R2; approximated within RV).
  if (DERIVATIONAL.test(rv)) rv = rv.replace(DERIVATIONAL, "");
  // Step 4: superlative, double н, soft sign.
  if (/нн$/.test(rv)) rv = rv.slice(0, -1);
  rv = rv.replace(SUPERLATIVE, "");
  if (/нн$/.test(rv)) rv = rv.slice(0, -1);
  rv = rv.replace(/ь$/, "");

  return head + rv;
}

/** Split text into lowercase tokens; stem Cyrillic tokens. */
export function tokenizeStems(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-zа-яё0-9][a-zа-яё0-9]*/g) ?? [];
  return raw.map((t) => (/[а-яё]/.test(t) ? stemRu(t) : t));
}

export interface PreparedText {
  raw: string; // lowercased original (for substring fallback)
  stems: string[]; // stemmed tokens
}

export function prepareText(text: string): PreparedText {
  const raw = text.toLowerCase();
  return { raw, stems: tokenizeStems(raw) };
}

/**
 * Fuzzy stem equality: exact, or one is a prefix of the other (stemmer can
 * produce different bases for forms of the same word: "систем" vs "сист").
 */
function stemEq(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.length - short.length <= 2 && long.startsWith(short);
}

/** True if the needle (word or phrase) occurs in the prepared text. */
export function phraseMatches(prep: PreparedText, needle: string): boolean {
  const n = needle.trim().toLowerCase();
  if (!n) return false;
  // Substring fallback for long-enough needles keeps partial roots working
  // ("электродвигател"); short needles would false-match inside other words.
  if (n.length >= 5 && prep.raw.includes(n)) return true;
  const nStems = tokenizeStems(n);
  if (!nStems.length) return false;
  const T = prep.stems;
  outer: for (let i = 0; i <= T.length - nStems.length; i++) {
    for (let j = 0; j < nStems.length; j++) {
      if (!stemEq(T[i + j]!, nStems[j]!)) continue outer;
    }
    return true;
  }
  return false;
}

/** Which of the needles occur in the text (morphology-aware). */
export function matchAny(prep: PreparedText, needles: string[]): string[] {
  return needles.filter((n) => n.trim() && phraseMatches(prep, n));
}
