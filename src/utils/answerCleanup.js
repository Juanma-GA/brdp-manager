// Barrido final 1/2, Part 3: the internal name of the schema cards block.
// The Ask prompt gives the cards under the heading "SCHEMA FACTS" and says
// "the user does not see this block by that name; if you refer to it, call
// it the schema card" -- and still a real Mistral answer wrote "según los
// **SCHEMA FACTS**:" and "la tarjeta de esquema proporcionada (SCHEMA
// FACTS)" (ask-open-question-no-disclaimer, c8e8fac). The prompt stays as it
// is; the application cleans the text the user sees, the same way for every
// AI answer shown as it is (Ask, the test review, the Proposal check, the
// suggested Definition / Proposal).
//
// Pure (no React, no API), importable from Node like src/prompts/.
// - "(SCHEMA FACTS)" after the words it names → removed.
// - "el SCHEMA FACTS", "del bloque SCHEMA FACTS", "the SCHEMA FACTS
//   block", "SCHEMA FACTS" alone → "el esquema" / "the schema" by the
//   answer's language, with the article the sentence needs ("del
//   esquema", "al esquema", "en el esquema", "según el esquema"). After a
//   Spanish plural article ("los SCHEMA FACTS lo confirman") → "las fichas
//   del esquema", so the plural verb still agrees.
// - With or without **bold**, *italics* or __underscores__ around the name.
// - Never inside a fenced code block, an inline `code` span, a quotation
//   ("…", “…”, «…») or a Markdown blockquote ("> …") -- and not at all when
//   the user's own question uses the name (then it is their word).

const MARK = '(?:\\*\\*|__|\\*|_)?';
const NAME = `${MARK}SCHEMA[ \\t]+FACTS${MARK}`;
const ES_HINT = /[áéíóúñ¿¡]|\b(?:el|la|los|las|de|del|que|en|según|para|una?|es|son|puede|esquema|elemento|atributo)\b/gi;
const EN_HINT = /\b(?:the|of|and|is|are|can|in|to|element|attribute|schema|which|this|that)\b/gi;

export function answerLanguage(text) {
  // The internal name itself ("SCHEMA") and code are not the answer's
  // language.
  const prose = String(text ?? '').replace(/```[\s\S]*?(?:```|(?![\s\S]))|`[^`\n]*`/g, ' ').replace(/SCHEMA\s+FACTS/g, ' ');
  const es = (prose.match(ES_HINT) || []).length;
  const en = (prose.match(EN_HINT) || []).length;
  return es > en ? 'es' : 'en';
}

const capitalizeLike = (source, word) => (/^[A-ZÁÉÍÓÚ]/.test(source) ? word[0].toUpperCase() + word.slice(1) : word);

function cleanProse(text, lang) {
  let out = text;
  // "(SCHEMA FACTS)" → removed, with the space before it.
  out = out.replace(new RegExp(`[ \\t]*\\(\\s*${NAME}\\s*\\)`, 'g'), '');
  if (lang === 'es') {
    const block = '(?:bloque[ \\t]+(?:de[ \\t]+)?)?';
    // A plural article keeps the sentence's plural verb in agreement:
    // "los SCHEMA FACTS lo confirman" → "las fichas del esquema lo
    // confirman"; a singular one (or "bloque") → "el esquema".
    // "de los SCHEMA FACTS" / "a los …" → "de las fichas del esquema".
    out = out.replace(new RegExp(`\\b([Dd]e|[Aa])[ \\t]+(?:los|las)[ \\t]+${NAME}`, 'g'), (m, prep) => `${prep} las fichas del esquema`);
    out = out.replace(new RegExp(`\\b([Dd]e|[Aa])[ \\t]+(?:los|las|el|la)[ \\t]+${block}${NAME}`, 'g'), (m, prep) => `${prep}l esquema`);
    out = out.replace(new RegExp(`\\b([Dd]el|[Aa]l)[ \\t]+${block}${NAME}`, 'g'), (m, prep) => `${prep} esquema`);
    out = out.replace(new RegExp(`\\b(los|las|Los|Las)[ \\t]+${NAME}`, 'g'), (m, art) => `${capitalizeLike(art, 'las')} fichas del esquema`);
    // "el SCHEMA FACTS", "los bloques…", "el bloque SCHEMA FACTS" → "el esquema".
    out = out.replace(new RegExp(`\\b(los|las|el|la|Los|Las|El|La)[ \\t]+${block}${NAME}`, 'g'), (m, art) => `${capitalizeLike(art, 'el')} esquema`);
    // "bloque SCHEMA FACTS" with no article, or the name alone.
    out = out.replace(new RegExp(`\\b([Bb]loque[ \\t]+(?:de[ \\t]+)?)${NAME}`, 'g'), (m, b) => capitalizeLike(b, 'esquema'));
    out = out.replace(new RegExp(NAME, 'g'), (m, offset, whole) => (atSentenceStart(whole, offset) ? 'El esquema' : 'el esquema'));
  } else {
    out = out.replace(new RegExp(`\\b(the|The)[ \\t]+${NAME}(?:[ \\t]+block)?`, 'g'), (m, art) => `${art} schema`);
    out = out.replace(new RegExp(`${NAME}(?:[ \\t]+block)?`, 'g'), (m, offset, whole) => (atSentenceStart(whole, offset) ? 'The schema' : 'the schema'));
  }
  return out;
}

function atSentenceStart(text, offset) {
  const before = text.slice(0, offset).replace(/[*_\s]+$/, '');
  return before === '' || /[.!?:\n]$/.test(before);
}

// The parts of `text` that are never touched, in order: fenced code
// blocks, inline code spans, quotations and blockquote lines.
const PROTECTED_RE = /```[\s\S]*?(?:```|(?![\s\S]))|`[^`\n]*`|"[^"\n]*"|“[^”\n]*”|«[^»\n]*»|^[ \t]*>.*$/gm;

export function cleanInternalNames(text, { userText = '' } = {}) {
  const source = String(text ?? '');
  if (!/SCHEMA[ \t]+FACTS/.test(source)) return source;
  if (/SCHEMA\s+FACTS/i.test(userText)) return source;
  const lang = answerLanguage(source);
  let out = '';
  let last = 0;
  for (const m of source.matchAll(PROTECTED_RE)) {
    out += cleanProse(source.slice(last, m.index), lang) + m[0];
    last = m.index + m[0].length;
  }
  return out + cleanProse(source.slice(last), lang);
}
