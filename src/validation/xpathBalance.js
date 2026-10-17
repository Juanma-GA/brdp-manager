// Mejoras F, Part 2.3: an XPath that does not parse because of an unbalanced
// parenthesis, bracket or quote, said in plain words -- BRDP-EXT-02640's
// /*[ not(//dmaddres/issno)) ] gave only "XPST0003: Failed to parse script.
// Expected end of input". Counted by code, outside string literals (a ')'
// inside contains(., ')') never counts). The first problem found, in this
// order: an unclosed quote, a closing ) or ] with nothing open (or closing
// the other kind), then what is left open at the end.
// → null | 'missingCloseQuote' | 'extraCloseParen' | 'extraCloseBracket'
//   | 'missingCloseParen' | 'missingCloseBracket'
export function xpathBalanceProblem(expression) {
  const text = String(expression || '');
  const stack = [];
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        // XPath escapes a quote by doubling it: 'it''s'
        if (text[i + 1] === quote) i += 1;
        else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '(' || ch === '[') stack.push(ch);
    else if (ch === ')' || ch === ']') {
      const open = ch === ')' ? '(' : '[';
      if (stack.length === 0 || stack[stack.length - 1] !== open) {
        const extra = ch === ')' ? 'extraCloseParen' : 'extraCloseBracket';
        if (stack.length === 0) return extra;
        // A ")" while a "[" is the innermost open one: either the ")" is
        // extra (the rest balances without it: /*[ not(x)) ]) or the
        // innermost one was never closed (//a[(b]).
        if (xpathBalanceProblem(text.slice(0, i) + text.slice(i + 1)) === null) return extra;
        return stack[stack.length - 1] === '(' ? 'missingCloseParen' : 'missingCloseBracket';
      }
      stack.pop();
    }
  }
  if (quote) return 'missingCloseQuote';
  if (stack.length === 0) return null;
  return stack[stack.length - 1] === '(' ? 'missingCloseParen' : 'missingCloseBracket';
}
