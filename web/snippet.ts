// A search snippet is a slice of markdown with highlight markers (\u0001 … \u0002).
// Shown as a one-paragraph preview, the way Mail and Messages show a message:
// the words, not the "##", "**" and backticks around them. "__" stays: it is
// more often a name (__init__) than emphasis.

const M = '[\\u0001\\u0002]*';

/** The snippet as plain prose, highlight markers kept where they were. */
export function plainSnippet(snippet: string): string {
  return snippet
    .split('\n')
    .filter((line) => !/^\s*(```|~~~)/.test(line))
    .map((line) =>
      line
        .replace(new RegExp(`^(${M})\\s{0,3}#{1,6}\\s+`), '$1')
        .replace(new RegExp(`^(${M})\\s*(?:[-*+]|\\d+[.)])\\s+(?:\\[[ xX]\\]\\s+)?`), '$1')
        .replace(new RegExp(`^(${M})\\s*>\\s?`), '$1')
        .replace(/!?\[([^\]\n]*)\]\([^)\s]*\)/g, '$1')
        .replace(/\*\*|`+/g, '')
        .trim(),
    )
    .filter((line) => line.replace(/[\u0001\u0002]/g, ''))
    .join(' ');
}
