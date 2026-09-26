/*
 * validate-article.js
 * Code gates for the unattended article-editing pipeline.
 *
 * Plain, dependency-free JavaScript. Works in Node 18+ (require it, or run it as a CLI)
 * and can be pasted as a whole into an n8n "Code" node (then call the functions directly).
 * Regex/string parsing only (no DOM). Every pattern is written so a 300 KB article is
 * processed in well under a second, even when the HTML is broken.
 *
 * Main functions (see automation/README.md for the full pipeline):
 *   parseEditorOutput(text)                               -> { ok, status, html, meta, errors }
 *   findNewLinks(originalHtml, editedHtml, options)        -> [href, ...]
 *   checkLinks(urls, { fetchFn, timeoutMs, concurrency })  -> Promise<[{ url, status, verdict, error }]>
 *   sanitizeLinks(originalHtml, editedHtml, options, deadUrls) -> { html, removed }
 *   validateArticle(originalHtml, editedHtml, options)     -> { pass, errors, warnings, stats }
 *   filterAuditIssues(editedHtml, audit, extra)            -> audit with verified issues only
 *   processEditorOutput(originalHtml, llmText, options)    -> Promise<{ action, html, ... }>
 *
 * CLI:
 *   node automation/validate-article.js --original orig.html --output llm-output.txt
 *        [--site a.com,b.com] [--searches N] [--faq auto|no] [--no-link-check]
 *        [--write-html out.html] [--report report.json]
 *   exit codes: 0 publish, 2 keep_original, 3 skip, 1 usage/IO error.
 *
 * Fail-closed rule: anything unexpected => action "keep_original" (the live article is not touched).
 */

const VALIDATE_ARTICLE_VERSION = '1.0.0';

const MARKER_HTML = '<<<ARTICLE_HTML>>>';
const MARKER_META = '<<<META_JSON>>>';
const MARKER_END = '<<<END>>>';

const DEFAULT_FORBIDDEN_LINK_DOMAINS = [
  'reddit.com', 'quora.com', 'pinterest.com', 'medium.com', 'facebook.com', 'instagram.com',
  'tiktok.com', 'x.com', 'twitter.com', 'blogspot.com', 'amzn.to'
];

const ERROR_CODES = [
  'PARSE_MISSING_MARKER', 'PARSE_META_JSON', 'PARSE_EMPTY_HTML',
  'IMG_COUNT', 'IMG_CHANGED', 'MEDIA_COUNT', 'ELEMENT_COUNT', 'SHORTCODE_MISSING', 'LINK_MISSING', 'ID_MISSING',
  'PLUGIN_BLOCK_CHANGED', 'MEDIA_BLOCK_CHANGED', 'SCRIPT_CHANGED', 'SPECIAL_COMMENT_MISSING', 'FORBIDDEN_TAG',
  'FIRST_ELEMENT_NOT_P', 'HEADING_ORDER', 'PLACEHOLDER', 'CODE_FENCE', 'JSONLD_INVALID', 'JSONLD_TYPE',
  'TAG_UNBALANCED', 'BLOCK_UNBALANCED', 'CONTENT_LOSS', 'WORD_RATIO_EXTREME', 'DUPLICATE_CONTENT',
  'LAST_CHECKED_WITHOUT_RESEARCH', 'NEW_INTERNAL_LINK', 'BAD_NEW_LINK', 'BOX_DUPLICATED', 'NEW_FAQ_NOT_ALLOWED',
  'TITLE_IN_BODY', 'INTERNAL_ERROR'
];

const WARNING_CODES = [
  'AI_PHRASE', 'WORD_RATIO_HIGH', 'BOX_LIMIT', 'FAQ_SCHEMA_MISMATCH', 'META_LENGTH', 'NEW_CONCLUSION',
  'EMOJI_ADDED', 'LINK_IN_HEADING', 'DUPLICATE_NEW_LINK', 'SOURCES_MISMATCH'
];

const BOX_TYPES = [
  { key: 'quickAnswer', label: 'Quick Answer', color: 'eef3fe', max: 1, hard: true },
  { key: 'keyTakeaways', label: 'Key Takeaways', color: 'fdf8e3', max: 1, hard: true },
  { key: 'atAGlance', label: 'At a Glance', color: 'f5f7fa', max: 1, hard: true },
  { key: 'warning', label: 'Warning', color: 'fdeced', max: 2, hard: false },
  { key: 'proTip', label: 'Pro Tip', color: 'eafaf1', max: 2, hard: false },
  { key: 'note', label: 'Note', color: 'eef3f7', max: 1, hard: false }
];

const MEDIA_TAGS = ['picture', 'source', 'video', 'audio', 'iframe', 'embed', 'object', 'figure', 'figcaption', 'noscript'];
const COUNTED_ELEMENTS = ['form', 'button', 'ins'];
const FORBIDDEN_TAGS = ['h1', 'title', 'html', 'head', 'body', 'style', 'meta', 'link'];
const BALANCED_TAGS = ['p', 'div', 'span', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'details', 'summary',
  'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'a', 'strong', 'em', 'figure', 'figcaption'];
const VOID_TAGS = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'];
const MEDIA_BLOCKS = ['image', 'gallery', 'video', 'audio', 'embed', 'cover', 'media-text', 'file'];
const INLINE_TAGS = ['a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i', 'ins', 'kbd',
  'mark', 'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var', 'wbr'];
const SOURCES_HEADINGS = ['sources', 'source', 'references', 'sources and references', 'references and sources',
  'quellen', 'fuentes', 'fonti', 'fontes', 'bronnen', 'kallor', 'k\u00e4llor', 'kilder', 'lahteet', 'l\u00e4hteet', 'zrodla', '\u017ar\u00f3d\u0142a',
  'sources et r\u00e9f\u00e9rences', 'r\u00e9f\u00e9rences', 'referenzen', 'referencias', 'riferimenti', 'refer\u00eancias'];

const PLACEHOLDER_PATTERNS = [
  ['{{', /\{\{/g], ['}}', /\}\}/g], ['[VERIFY', /\[VERIFY/gi], ['[TODO', /\[TODO/gi], ['TODO', /\bTODO\b/g],
  ['TBD', /\bTBD\b/g], ['href="#"', /\bhref\s*=\s*(["'])#\1/gi], ['REAL-URL', /REAL-URL/gi], ['PASTE YOUR', /PASTE YOUR/g],
  ['lorem ipsum', /lorem ipsum/gi], ['[insert', /\[insert/gi], ['[add ', /\[add /gi], ['[link', /\[link/gi],
  ['your-site', /your-site/gi], ['yourdomain', /yourdomain/gi], ['example.com', /example\.com/gi]
];

const AI_PHRASES = [
  ["in today's fast-paced world", /in today'?s fast[- ]paced world/g],
  ['ever-evolving', /\bever[- ]evolving\b/g],
  ['when it comes to', /\bwhen it comes to\b/g],
  ['plays a crucial role', /\bplay(?:s|ed|ing)? a crucial role\b/g],
  ['the world of', /\bthe world of\b/g],
  ['delve', /\bdelv(?:e|es|ed|ing)\b/g],
  ['dive into', /\b(?:dive|dives|diving|dived|dove) into\b/g],
  ['unlock', /\bunlock(?:s|ed|ing)?\b/g],
  ['unleash', /\bunleash(?:es|ed|ing)?\b/g],
  ['game-changer', /\bgame[- ]changer/g],
  ['navigate the landscape', /\bnavigat(?:e|es|ed|ing) the (?:[a-z-]+ )?landscape\b/g],
  ["it's important to note", /\b(?:it'?s|it is) important to note\b/g],
  ['a testament to', /\ba testament to\b/g],
  ['elevate', /\belevat(?:e|es|ed|ing)\b/g],
  ['seamless', /\bseamless(?:ly)?\b/g],
  ['look no further', /\blook no further\b/g],
  ['in conclusion', /\bin conclusion\b/g]
];

// Shortcode per SPEC: \[\/?[a-z][a-z0-9_-]*(?:\s[^\]]*)?\/?\]  (attribute part bounded for speed)
const SHORTCODE_SRC = '\\[\\/?[a-z][a-z0-9_-]*(?:\\s[^\\]\\[]{0,4000})?\\/?\\]';

// Tag pattern: quote-aware, bounded, no catastrophic backtracking.
const ATTRS_SRC = '(?:[^<>"\']|"[^"]{0,10000}"|\'[^\']{0,10000}\')*';
const TAG_SRC = '<(\\/?)([a-zA-Z][a-zA-Z0-9:-]*)(?=[\\s\\/>])(' + ATTRS_SRC + ')>';

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ndash: '\u2013', mdash: '\u2014',
  lsquo: '\u2018', rsquo: '\u2019', sbquo: '\u201a', ldquo: '\u201c', rdquo: '\u201d', bdquo: '\u201e',
  hellip: '\u2026', copy: '\u00a9', reg: '\u00ae', trade: '\u2122', deg: '\u00b0', euro: '\u20ac', pound: '\u00a3',
  yen: '\u00a5', cent: '\u00a2', times: '\u00d7', divide: '\u00f7', frac12: '\u00bd', frac14: '\u00bc', frac34: '\u00be',
  middot: '\u00b7', bull: '\u2022', laquo: '\u00ab', raquo: '\u00bb', lsaquo: '\u2039', rsaquo: '\u203a', prime: '\u2032',
  Prime: '\u2033', minus: '\u2212', plusmn: '\u00b1', sup1: '\u00b9', sup2: '\u00b2', sup3: '\u00b3', micro: '\u00b5',
  para: '\u00b6', sect: '\u00a7', shy: '', zwj: '', zwnj: '', thinsp: '\u2009', ensp: '\u2002', emsp: '\u2003',
  larr: '\u2190', rarr: '\u2192', uarr: '\u2191', darr: '\u2193', harr: '\u2194', le: '\u2264', ge: '\u2265', ne: '\u2260',
  asymp: '\u2248', infin: '\u221e', iexcl: '\u00a1', iquest: '\u00bf', ordm: '\u00ba', ordf: '\u00aa', dagger: '\u2020',
  szlig: '\u00df', auml: '\u00e4', ouml: '\u00f6', uuml: '\u00fc', Auml: '\u00c4', Ouml: '\u00d6', Uuml: '\u00dc',
  aacute: '\u00e1', eacute: '\u00e9', iacute: '\u00ed', oacute: '\u00f3', uacute: '\u00fa', yacute: '\u00fd',
  Aacute: '\u00c1', Eacute: '\u00c9', Iacute: '\u00cd', Oacute: '\u00d3', Uacute: '\u00da',
  agrave: '\u00e0', egrave: '\u00e8', igrave: '\u00ec', ograve: '\u00f2', ugrave: '\u00f9',
  Agrave: '\u00c0', Egrave: '\u00c8', acirc: '\u00e2', ecirc: '\u00ea', icirc: '\u00ee', ocirc: '\u00f4', ucirc: '\u00fb',
  atilde: '\u00e3', otilde: '\u00f5', ntilde: '\u00f1', Ntilde: '\u00d1', aring: '\u00e5', Aring: '\u00c5',
  aelig: '\u00e6', AElig: '\u00c6', oslash: '\u00f8', Oslash: '\u00d8', ccedil: '\u00e7', Ccedil: '\u00c7',
  euml: '\u00eb', iuml: '\u00ef', yuml: '\u00ff', oelig: '\u0153', scaron: '\u0161', Scaron: '\u0160'
};

/* ------------------------------------------------------------------ */
/* Small helpers                                                        */
/* ------------------------------------------------------------------ */

function toStr(v) {
  return typeof v === 'string' ? v : (v === null || v === undefined ? '' : String(v));
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
}

function decodeEntities(s) {
  s = toStr(s);
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, function (m, e) {
    if (e.charAt(0) === '#') {
      const code = (e.charAt(1) === 'x' || e.charAt(1) === 'X') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return m;
      if (code === 0) return m;
      try { return String.fromCodePoint(code); } catch (err) { return m; }
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, e) ? NAMED_ENTITIES[e] : m;
  });
}

function countMatches(s, re) {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(s)) {
    n++;
    if (re.lastIndex === 0) break;
  }
  re.lastIndex = 0;
  return n;
}

function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  for (;;) {
    i = hay.indexOf(needle, i);
    if (i < 0) return n;
    n++;
    i += needle.length;
  }
}

function multiset(list) {
  const m = new Map();
  for (const x of list) m.set(x, (m.get(x) || 0) + 1);
  return m;
}

function short(s, n) {
  s = toStr(s).replace(/\s+/g, ' ').trim();
  n = n || 90;
  return s.length > n ? s.slice(0, n - 1) + '\u2026' : s;
}

function uniq(list) {
  const seen = new Set();
  const out = [];
  for (const x of list) {
    if (!seen.has(x)) { seen.add(x); out.push(x); }
  }
  return out;
}

/** Removes <script>, <style> (and optionally other raw-text elements) with an O(n) scan. */
function removeRawElements(html, names, replacement) {
  html = toStr(html);
  replacement = replacement === undefined ? ' ' : replacement;
  let out = html;
  for (const name of names) {
    if (out.toLowerCase().indexOf('<' + name) < 0) continue;
    const openRe = new RegExp('<' + name + '(?=[\\s>/])[^>]{0,3000}>', 'gi');
    const closeRe = new RegExp('</' + name + '\\s*>', 'gi');
    let res = '';
    let last = 0;
    let m;
    while ((m = openRe.exec(out))) {
      closeRe.lastIndex = m.index + m[0].length;
      const c = closeRe.exec(out);
      if (!c) break;
      res += out.slice(last, m.index) + replacement;
      last = c.index + c[0].length;
      openRe.lastIndex = last;
    }
    out = res + out.slice(last);
  }
  return out;
}

function scanScripts(html) {
  html = toStr(html);
  const out = [];
  const openRe = /<script(?=[\s>/])[^>]{0,3000}>/gi;
  const closeRe = /<\/script\s*>/gi;
  let m;
  while ((m = openRe.exec(html))) {
    closeRe.lastIndex = m.index + m[0].length;
    const c = closeRe.exec(html);
    if (!c) break;
    const openTag = m[0];
    const typeM = /\btype\s*=\s*["']?\s*([^"'\s>]+)/i.exec(openTag);
    const type = typeM ? typeM[1].toLowerCase() : '';
    out.push({
      start: m.index,
      end: c.index + c[0].length,
      raw: html.slice(m.index, c.index + c[0].length),
      openTag: openTag,
      body: html.slice(m.index + openTag.length, c.index),
      isJsonLd: type === 'application/ld+json'
    });
    openRe.lastIndex = c.index + c[0].length;
  }
  return out;
}

function stripComments(html) {
  html = toStr(html);
  if (html.indexOf('<!--') < 0) return html;
  let res = '';
  let pos = 0;
  for (;;) {
    const s = html.indexOf('<!--', pos);
    if (s < 0) break;
    const e = html.indexOf('-->', s + 4);
    if (e < 0) break;
    res += html.slice(pos, s) + ' ';
    pos = e + 3;
  }
  return res + html.slice(pos);
}

/** HTML without scripts, styles and comments: the view used for element/attribute checks. */
function markupOf(html) {
  return stripComments(removeRawElements(html, ['script', 'style'], ' '));
}

function parseAttrs(attrStr) {
  const out = {};
  const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/g;
  let m;
  attrStr = toStr(attrStr);
  while ((m = re.exec(attrStr))) {
    const name = m[1].toLowerCase();
    if (Object.prototype.hasOwnProperty.call(out, name)) continue;
    const v = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : ''));
    out[name] = decodeEntities(v);
  }
  return out;
}

function forEachTag(html, fn) {
  const re = new RegExp(TAG_SRC, 'g');
  let m;
  while ((m = re.exec(html))) {
    fn({ closing: m[1] === '/', name: m[2].toLowerCase(), attrStr: m[3], raw: m[0], index: m.index });
  }
}

/**
 * Finds elements (non-overlapping per name unless nested) of the given names with their inner HTML.
 * Uses lazy close search with a per-name "no more closers" memo so broken HTML stays O(n).
 */
function scanElements(html, names, skipInner) {
  html = toStr(html);
  const openRe = new RegExp('<(' + names.map(escapeRe).join('|') + ')(?=[\\s>/])(' + ATTRS_SRC + ')>', 'gi');
  const closeRes = {};
  const noClose = {};
  const out = [];
  let m;
  while ((m = openRe.exec(html))) {
    const name = m[1].toLowerCase();
    if (noClose[name]) continue;
    if (/\/\s*$/.test(m[2]) && name !== 'a') continue; // self-closing form, no content
    const cre = closeRes[name] || (closeRes[name] = new RegExp('</' + escapeRe(name) + '\\s*>', 'gi'));
    cre.lastIndex = m.index + m[0].length;
    const c = cre.exec(html);
    if (!c) { noClose[name] = true; continue; }
    out.push({
      name: name,
      attrStr: m[2],
      start: m.index,
      contentStart: m.index + m[0].length,
      contentEnd: c.index,
      end: c.index + c[0].length,
      openTag: m[0],
      inner: html.slice(m.index + m[0].length, c.index)
    });
    if (skipInner) openRe.lastIndex = c.index + c[0].length;
  }
  return out;
}

/** Depth-aware end of the element that starts at `pos` (index after its closing tag), or -1. */
function elementEnd(html, pos, name) {
  const re = new RegExp('<(\\/?)' + escapeRe(name) + '(?=[\\s>/])(' + ATTRS_SRC + ')>', 'gi');
  re.lastIndex = pos;
  let depth = 0;
  let m;
  let guard = 0;
  while ((m = re.exec(html)) && guard++ < 100000) {
    if (m[1] === '/') {
      depth--;
      if (depth <= 0) return m.index + m[0].length;
    } else if (!/\/\s*$/.test(m[2])) {
      depth++;
    } else if (depth === 0) {
      return m.index + m[0].length;
    }
  }
  return -1;
}

/* ------------------------------------------------------------------ */
/* Visible text and words                                               */
/* ------------------------------------------------------------------ */

const INLINE_TAG_RE_SRC = '<\\/?(?:' + INLINE_TAGS.join('|') + ')(?=[\\s>/])' + ATTRS_SRC + '>';

/** Visible text: scripts/styles/comments removed, inline tags removed, block tags -> space, entities decoded. */
function visibleText(html, opts) {
  opts = opts || {};
  let s = markupOf(html);
  s = s.replace(new RegExp(INLINE_TAG_RE_SRC, 'gi'), '');
  s = s.replace(new RegExp('<\\/?[a-zA-Z][a-zA-Z0-9:-]*(?=[\\s>/])' + ATTRS_SRC + '>', 'g'), ' ');
  s = decodeEntities(s);
  if (opts.stripShortcodes) s = s.replace(new RegExp(SHORTCODE_SRC, 'gi'), ' ');
  return s.replace(/[\s\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]+/g, ' ').trim();
}

function countWords(text) {
  const m = toStr(text).match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]|[\p{L}\p{N}][\p{L}\p{N}\p{M}'\u2019_.-]*/gu);
  return m ? m.length : 0;
}

/** Normalisation used for quote matching: curly quotes/dashes/spaces unified, lower case, whitespace collapsed. */
function normalizeForMatch(s) {
  return toStr(s)
    .replace(/[\u2018\u2019\u201a\u201b\u2032`\u00b4]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033\u00ab\u00bb]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u00ad\u200b\u200c\u200d\ufeff]/g, '')
    .replace(/[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g, ' ')
    .toLowerCase()
    .trim();
}

function looseNormalize(s) {
  return normalizeForMatch(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/* ------------------------------------------------------------------ */
/* URLs and options                                                     */
/* ------------------------------------------------------------------ */

function normalizeHost(h) {
  h = toStr(h).trim().toLowerCase();
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  h = h.split(/[\/?#]/)[0];
  const at = h.lastIndexOf('@');
  if (at >= 0) h = h.slice(at + 1);
  if (h.charAt(0) !== '[') h = h.replace(/:\d*$/, '');
  h = h.replace(/\.+$/, '').replace(/^www\d?\./, '');
  return h;
}

/** Minimal URL parser (no dependency on the URL class). Returns null for relative/invalid values. */
function parseUrl(u) {
  u = toStr(u).trim();
  let m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^\/?#\s]*)([^?#\s]*)(\?[^#\s]*)?(#\S*)?$/.exec(u);
  if (!m) {
    const pr = /^\/\/([^\/?#\s]*)([^?#\s]*)(\?[^#\s]*)?(#\S*)?$/.exec(u);
    if (!pr) return null;
    m = [u, 'https', pr[1], pr[2], pr[3], pr[4]];
  }
  const scheme = m[1].toLowerCase();
  const authority = m[2];
  const host = normalizeHost(authority);
  const validHost = /^(?:[a-z0-9\u00a1-\uffff](?:[a-z0-9\u00a1-\uffff-]{0,62})?)(?:\.[a-z0-9\u00a1-\uffff](?:[a-z0-9\u00a1-\uffff-]{0,62})?)*$/i.test(host) ||
    /^\[[0-9a-f:.]+\]$/i.test(host);
  return { scheme: scheme, host: host, validHost: validHost && host.length > 0, path: m[3] || '', query: m[4] || '', hash: m[5] || '' };
}

function hostMatches(host, domains) {
  if (!host) return false;
  for (const d of domains) {
    if (!d) continue;
    if (host === d || host.slice(-(d.length + 1)) === '.' + d) return true;
  }
  return false;
}

function toList(v) {
  if (Array.isArray(v)) return v.map(toStr);
  if (typeof v === 'string') return v.split(/[,\s]+/);
  return [];
}

function normalizeOptions(options) {
  const o = options || {};
  const siteDomains = uniq(toList(o.siteDomains).map(normalizeHost).filter(Boolean));
  const forbidden = o.forbiddenLinkDomains === undefined || o.forbiddenLinkDomains === null
    ? DEFAULT_FORBIDDEN_LINK_DOMAINS.slice()
    : toList(o.forbiddenLinkDomains);
  let wsc = null;
  if (typeof o.webSearchCount === 'number' && isFinite(o.webSearchCount)) wsc = Math.max(0, o.webSearchCount);
  else if (typeof o.webSearchCount === 'string' && /^\s*\d+\s*$/.test(o.webSearchCount)) wsc = parseInt(o.webSearchCount, 10);
  else if (o.webSearchCount === false || (typeof o.webSearchCount === 'string' && /^\s*no\s*$/i.test(o.webSearchCount))) wsc = 0;
  let allowNewFaq = true;
  if (o.allowNewFaq === false || (typeof o.allowNewFaq === 'string' && /^\s*(no|false|off|0)\s*$/i.test(o.allowNewFaq))) allowNewFaq = false;
  const num = function (v, d) { return typeof v === 'number' && isFinite(v) ? v : d; };
  return {
    siteDomains: siteDomains,
    webSearchCount: wsc,
    allowNewFaq: allowNewFaq,
    minWordRatio: num(o.minWordRatio, 0.8),
    maxWordRatio: num(o.maxWordRatio, 5),
    forbiddenLinkDomains: uniq(forbidden.map(normalizeHost).filter(Boolean)),
    checkLinks: o.checkLinks !== false,
    fetchFn: typeof o.fetchFn === 'function' ? o.fetchFn : undefined,
    linkTimeoutMs: num(o.linkTimeoutMs, 10000),
    linkConcurrency: num(o.linkConcurrency, 4),
    meta: o.meta && typeof o.meta === 'object' ? o.meta : null,
    deadUrls: Array.isArray(o.deadUrls) ? o.deadUrls : [],
    postTitle: typeof o.postTitle === 'string' ? o.postTitle : ''
  };
}

function isBareHomepage(p) {
  return (p.path === '' || p.path === '/') && !p.query;
}

function normalizeDeadList(deadUrls) {
  const s = new Set();
  for (const d of (Array.isArray(deadUrls) ? deadUrls : [])) {
    let u = d;
    if (d && typeof d === 'object') {
      if (d.verdict && d.verdict !== 'dead') continue;
      u = d.url;
    }
    u = decodeEntities(toStr(u)).trim();
    if (u) s.add(u);
  }
  return s;
}

/**
 * Decides what to do with a NEW link (href not in the original). Returns null (keep) or a reason string.
 * Reasons: fragment, javascript, not_web_link, relative, bad_scheme, invalid_url, internal, forbidden_domain,
 * dead, deep_link_without_research.
 */
function decideNewLink(href, opts, deadSet) {
  const h = decodeEntities(toStr(href)).trim();
  if (!h || h.charAt(0) === '#') return 'fragment';
  if (/^\s*javascript:/i.test(h) || /^\s*(?:data|vbscript):/i.test(h)) return 'javascript';
  if (/^(?:mailto|tel|sms|callto|whatsapp):/i.test(h)) return 'not_web_link';
  const p = parseUrl(h);
  if (!p) {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(h) && !/^[a-zA-Z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:[\/?#]|$)/i.test(h)) return 'bad_scheme';
    return 'relative';
  }
  if (p.scheme !== 'http' && p.scheme !== 'https') return 'bad_scheme';
  if (!p.validHost) return 'invalid_url';
  if (hostMatches(p.host, opts.siteDomains)) return 'internal';
  if (hostMatches(p.host, opts.forbiddenLinkDomains)) return 'forbidden_domain';
  if (deadSet && deadSet.has(h)) return 'dead';
  if (opts.webSearchCount === 0 && !isBareHomepage(p)) return 'deep_link_without_research';
  return null;
}

/** Set of decoded href values of <a>/<area> tags (scripts and comments ignored). */
function hrefSet(html) {
  const set = new Set();
  forEachTag(markupOf(html), function (t) {
    if (t.closing || (t.name !== 'a' && t.name !== 'area')) return;
    const a = parseAttrs(t.attrStr);
    if (Object.prototype.hasOwnProperty.call(a, 'href')) set.add(a.href.trim());
  });
  return set;
}

function hrefList(html) {
  const list = [];
  forEachTag(markupOf(html), function (t) {
    if (t.closing || t.name !== 'a') return;
    const a = parseAttrs(t.attrStr);
    if (Object.prototype.hasOwnProperty.call(a, 'href')) list.push(a.href.trim());
  });
  return list;
}

/* ------------------------------------------------------------------ */
/* 1. parseEditorOutput                                                 */
/* ------------------------------------------------------------------ */

function defaultMeta() {
  return {
    status: '', skip_reason: '', language: '', editor: '', intent: '', focus_keyword: '', secondary_keywords: [],
    seo_titles: [], meta_description: '', web_research_used: false, external_links_added: [], facts_changed: [],
    unverified_kept: [], notes: []
  };
}

function stripOuterFence(s, langRe) {
  const t = s.trim();
  const m = /^```[ \t]*([a-zA-Z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)\r?\n?```[ \t]*$/.exec(t);
  if (m && (!m[1] || langRe.test(m[1]))) return m[2].trim();
  return t;
}

function parseEditorOutput(text) {
  const res = { ok: false, status: null, html: '', meta: null, errors: [] };
  const err = function (code, message) { res.errors.push({ code: code, message: message }); };
  if (typeof text !== 'string' || !text.length) {
    err('PARSE_MISSING_MARKER', 'The editor reply is empty.');
    return res;
  }
  const first = text.indexOf(MARKER_HTML);
  if (first < 0) {
    err('PARSE_MISSING_MARKER', 'Marker ' + MARKER_HTML + ' not found.');
    return res;
  }
  const metaIdx = text.indexOf(MARKER_META, first + MARKER_HTML.length);
  if (metaIdx < 0) {
    err('PARSE_MISSING_MARKER', 'Marker ' + MARKER_META + ' not found (reply truncated or malformed).');
    return res;
  }
  const endIdx = text.indexOf(MARKER_END, metaIdx + MARKER_META.length);
  if (endIdx < 0) {
    err('PARSE_MISSING_MARKER', 'Marker ' + MARKER_END + ' not found: the reply was probably cut off (truncated).');
    return res;
  }
  // If the model mentioned the start marker before the real one, use the last one before META.
  const start = text.lastIndexOf(MARKER_HTML, metaIdx);
  let html = text.slice(start + MARKER_HTML.length, metaIdx);
  html = stripOuterFence(html, /^(html?|xml|markup)$/i);
  let metaText = text.slice(metaIdx + MARKER_META.length, endIdx).trim();
  metaText = stripOuterFence(metaText, /^(json|javascript|js)$/i);

  let meta = null;
  try {
    meta = JSON.parse(metaText);
  } catch (e1) {
    const a = metaText.indexOf('{');
    const b = metaText.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try { meta = JSON.parse(metaText.slice(a, b + 1)); } catch (e2) { meta = null; }
    }
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    err('PARSE_META_JSON', 'META section is not a valid JSON object.');
    res.html = html;
    return res;
  }
  const status = typeof meta.status === 'string' ? meta.status.trim().toLowerCase() : '';
  if (status !== 'edited' && status !== 'skipped') {
    err('PARSE_META_JSON', 'META "status" must be "edited" or "skipped" (got ' + JSON.stringify(meta.status) + ').');
  }
  const full = defaultMeta();
  for (const k of Object.keys(meta)) full[k] = meta[k];
  for (const k of ['secondary_keywords', 'seo_titles', 'external_links_added', 'facts_changed', 'unverified_kept', 'notes']) {
    if (!Array.isArray(full[k])) full[k] = full[k] === undefined || full[k] === null || full[k] === '' ? [] : [full[k]];
  }
  if (status) full.status = status;
  res.meta = full;
  res.status = status || null;
  res.html = html;
  if (status === 'edited' && !html.trim()) {
    err('PARSE_EMPTY_HTML', 'META status is "edited" but the HTML section is empty.');
  }
  res.ok = res.errors.length === 0;
  return res;
}

/* ------------------------------------------------------------------ */
/* 2. findNewLinks                                                      */
/* ------------------------------------------------------------------ */

/** Unique decoded hrefs of <a> tags in the edited HTML that are not hrefs in the original. */
function findNewLinks(originalHtml, editedHtml, options) {
  const orig = hrefSet(originalHtml);
  return uniq(hrefList(editedHtml).filter(function (h) { return !orig.has(h); }));
}

/* ------------------------------------------------------------------ */
/* 3. checkLinks                                                        */
/* ------------------------------------------------------------------ */

function errorCodes(e) {
  const codes = [];
  const texts = [];
  const seen = new Set();
  const walk = function (x, depth) {
    if (!x || depth > 5 || seen.has(x)) return;
    if (typeof x !== 'object' && typeof x !== 'function') { texts.push(String(x)); return; }
    seen.add(x);
    if (x.code) codes.push(String(x.code));
    if (x.name) texts.push(String(x.name));
    if (x.message) texts.push(String(x.message));
    if (x.cause) walk(x.cause, depth + 1);
    if (Array.isArray(x.errors)) for (const y of x.errors) walk(y, depth + 1);
  };
  walk(e, 0);
  return { codes: codes, text: codes.join(' ') + ' ' + texts.join(' ') };
}

function classifyFetchError(e) {
  const info = errorCodes(e);
  const t = info.text;
  if (/TimeoutError|AbortError|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|timed? ?out|aborted/i.test(t)) {
    return { verdict: 'unknown', error: 'timeout' };
  }
  if (/ENOTFOUND|getaddrinfo ENOTFOUND|EAI_NONAME|ENODATA/i.test(t)) return { verdict: 'dead', error: 'DNS lookup failed (ENOTFOUND)' };
  if (/ECONNREFUSED/i.test(t)) return { verdict: 'dead', error: 'connection refused (ECONNREFUSED)' };
  if (/CERT|SSL|TLS|self[- ]signed|unable to verify|ERR_TLS|EPROTO/i.test(t)) return { verdict: 'dead', error: 'TLS/certificate error' };
  return { verdict: 'unknown', error: short(t || 'network error', 160) };
}

function classifyStatus(status) {
  if (status >= 200 && status < 400) return 'ok';
  if (status === 404 || status === 410) return 'dead';
  if (status >= 500 && status < 600) return 'dead';
  return 'unknown';
}

function checkLinks(urls, opts) {
  opts = opts || {};
  const list = Array.isArray(urls) ? urls.map(function (u) { return decodeEntities(toStr(u)).trim(); }) : [];
  let fetchFn = opts.fetchFn;
  if (typeof fetchFn !== 'function') {
    fetchFn = (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function') ? globalThis.fetch.bind(globalThis) : null;
  }
  const timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : 10000;
  const concurrency = Math.max(1, Math.min(16, typeof opts.concurrency === 'number' ? Math.floor(opts.concurrency) : 4));
  const cache = new Map();

  function request(url, method) {
    let timer = null;
    let controller = null;
    try { controller = typeof AbortController === 'function' ? new AbortController() : null; } catch (e) { controller = null; }
    const init = {
      method: method,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ArticleLinkCheck/1.0; +https://wordpress.org/)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    };
    if (controller) init.signal = controller.signal;
    const timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        try { if (controller) controller.abort(); } catch (e) { /* ignore */ }
        const te = new Error('Request timed out after ' + timeoutMs + ' ms');
        te.name = 'TimeoutError';
        reject(te);
      }, timeoutMs);
    });
    let p;
    try { p = Promise.resolve(fetchFn(url, init)); } catch (e) { p = Promise.reject(e); }
    return Promise.race([p, timeout]).then(function (res) {
      clearTimeout(timer);
      try { if (res && res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(function () {}); } catch (e) { /* ignore */ }
      return res;
    }, function (e) {
      clearTimeout(timer);
      throw e;
    });
  }

  async function checkOne(url) {
    const result = { url: url, status: null, verdict: 'unknown', error: '' };
    if (!fetchFn) { result.error = 'no fetch function available'; return result; }
    const p = parseUrl(url);
    if (!p || (p.scheme !== 'http' && p.scheme !== 'https') || !p.validHost) {
      result.verdict = 'dead';
      result.error = 'invalid URL';
      return result;
    }
    let headStatus = null;
    let headError = null;
    try {
      const r = await request(url, 'HEAD');
      headStatus = r && typeof r.status === 'number' ? r.status : null;
      if (r && r.url) result.finalUrl = r.url;
    } catch (e) {
      headError = e;
    }
    if (headError) {
      const c = classifyFetchError(headError);
      if (c.error === 'timeout') { result.verdict = 'unknown'; result.error = 'timeout'; return result; }
    } else if (headStatus !== null && headStatus >= 200 && headStatus < 400) {
      result.status = headStatus;
      result.verdict = 'ok';
      result.method = 'HEAD';
      return result;
    }
    // Fallback: GET (for 403/405/501, other errors, and network errors).
    try {
      const r = await request(url, 'GET');
      const st = r && typeof r.status === 'number' ? r.status : null;
      result.status = st;
      result.method = 'GET';
      if (r && r.url) result.finalUrl = r.url;
      result.verdict = st === null ? 'unknown' : classifyStatus(st);
      if (result.verdict !== 'ok') result.error = 'HTTP ' + st + (headStatus !== null ? ' (HEAD ' + headStatus + ')' : '');
    } catch (e) {
      const c = classifyFetchError(e);
      result.status = headStatus;
      result.verdict = c.verdict;
      result.error = c.error;
    }
    return result;
  }

  function cached(url) {
    if (!cache.has(url)) {
      cache.set(url, checkOne(url).catch(function (e) {
        return { url: url, status: null, verdict: 'unknown', error: 'checker error: ' + short(e && e.message, 120) };
      }));
    }
    return cache.get(url);
  }

  const results = new Array(list.length);
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const i = next++;
      const r = await cached(list[i]);
      results[i] = Object.assign({}, r, { url: list[i] });
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(concurrency, list.length); i++) workers.push(worker());
  return Promise.all(workers).then(function () { return results; });
}

/* ------------------------------------------------------------------ */
/* Block comments (Gutenberg)                                           */
/* ------------------------------------------------------------------ */

function blockTokens(html) {
  html = toStr(html);
  const tokens = [];
  if (html.indexOf('wp:') < 0) return tokens;
  const re = /<!--\s*(\/?)wp:([a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)?)(?=[\s\/]|-->)/g;
  let m;
  while ((m = re.exec(html))) {
    const end = html.indexOf('-->', m.index + m[0].length);
    if (end < 0) break;
    const raw = html.slice(m.index, end + 3);
    const selfClosing = m[1] !== '/' && /\/\s*$/.test(html.slice(m.index + 4, end));
    tokens.push({ closing: m[1] === '/', selfClosing: selfClosing, name: m[2], start: m.index, end: end + 3, raw: raw });
    re.lastIndex = end + 3;
  }
  return tokens;
}

function extractBlocks(html, tokens) {
  const blocks = [];
  const stack = [];
  const openCount = {};
  for (const t of tokens) {
    if (t.selfClosing) {
      blocks.push({ name: t.name, start: t.start, end: t.end, raw: t.raw, opener: t.raw, selfClosing: true });
    } else if (!t.closing) {
      stack.push(t);
      openCount[t.name] = (openCount[t.name] || 0) + 1;
    } else if (openCount[t.name]) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].name === t.name) {
          const open = stack[i];
          for (let j = i; j < stack.length; j++) openCount[stack[j].name]--;
          stack.length = i;
          blocks.push({ name: t.name, start: open.start, end: t.end, raw: html.slice(open.start, t.end), opener: open.raw, selfClosing: false });
          break;
        }
      }
    }
  }
  for (const open of stack) {
    blocks.push({ name: open.name, start: open.start, end: open.end, raw: open.raw, opener: open.raw, selfClosing: false, unclosed: true });
  }
  return blocks;
}

function removeRanges(html, ranges) {
  if (!ranges.length) return html;
  ranges = ranges.slice().sort(function (a, b) { return a[0] - b[0]; });
  let out = '';
  let pos = 0;
  for (const r of ranges) {
    if (r[1] <= pos) continue;
    const s = Math.max(r[0], pos);
    out += html.slice(pos, s) + ' ';
    pos = r[1];
  }
  return out + html.slice(pos);
}

/* ------------------------------------------------------------------ */
/* Sources section                                                      */
/* ------------------------------------------------------------------ */

function isSourcesHeadingText(text) {
  const t = normalizeForMatch(text).replace(/[:.\s]+$/, '').trim();
  return SOURCES_HEADINGS.indexOf(t) >= 0;
}

/** Finds "<h2>Sources</h2>" (h2-h4, several languages) followed by an <ol>/<ul>. */
function findSourcesSections(html) {
  const out = [];
  const heads = scanElements(html, ['h2', 'h3', 'h4'], true);
  for (const h of heads) {
    if (!isSourcesHeadingText(visibleText(h.inner))) continue;
    const leadRe = /(?:\s|<!--[\s\S]*?-->)*/y;
    leadRe.lastIndex = h.end;
    const lead = leadRe.exec(html);
    const listStart = h.end + (lead ? lead[0].length : 0);
    const lm = /^<(ol|ul)(?=[\s>])/i.exec(html.slice(listStart, listStart + 8));
    if (!lm) continue;
    const listTag = lm[1].toLowerCase();
    const listEnd = elementEnd(html, listStart, listTag);
    if (listEnd < 0) continue;
    out.push({ headingStart: h.start, headingEnd: h.end, listStart: listStart, listEnd: listEnd, listTag: listTag });
  }
  return out;
}

/**
 * Computes a removal of html[s,e) that keeps Gutenberg block comments balanced:
 * extends backwards over one adjacent block opener, forwards over matching closers, and keeps
 * (re-emits) any block comment that would otherwise be left unmatched.
 */
function balancedCut(html, s, e) {
  const before = html.slice(Math.max(0, s - 600), s);
  const bm = /<!--\s*wp:[a-z][a-z0-9_\/-]*(?:\s[^>]*?)?-->\s*$/.exec(before);
  if (bm && !/\/\s*-->\s*$/.test(bm[0])) s = s - bm[0].length;
  let tokens = blockTokens(html.slice(s, e));
  let stack = [];
  const compute = function () {
    stack = [];
    const unmatched = [];
    for (const t of tokens) {
      if (t.selfClosing) continue;
      if (!t.closing) stack.push(t);
      else if (stack.length && stack[stack.length - 1].name === t.name) stack.pop();
      else unmatched.push(t);
    }
    return unmatched;
  };
  compute();
  // Consume closers right after the range that close openers inside it.
  for (let guard = 0; guard < 20 && stack.length; guard++) {
    const re = /\s*<!--\s*\/wp:([a-z][a-z0-9_\/-]*)\s*-->/y;
    re.lastIndex = e;
    const m = re.exec(html);
    if (!m || m[1] !== stack[stack.length - 1].name) break;
    e = e + m[0].length;
    tokens = blockTokens(html.slice(s, e));
    compute();
  }
  const unmatched = compute();
  const keep = unmatched.concat(stack).sort(function (a, b) { return a.start - b.start; }).map(function (t) { return t.raw; });
  return { start: s, end: e, replacement: keep.length ? keep.join('\n') : '' };
}

/* ------------------------------------------------------------------ */
/* 4. sanitizeLinks                                                     */
/* ------------------------------------------------------------------ */

function sanitizeLinks(originalHtml, editedHtml, options, deadUrls) {
  const opts = normalizeOptions(options);
  const origHrefs = hrefSet(originalHtml);
  const deadSet = normalizeDeadList(deadUrls === undefined ? opts.deadUrls : deadUrls);
  const removed = [];
  const seenRemoved = new Set();
  const record = function (url, reason, where) {
    const k = url + '\u0000' + reason;
    if (seenRemoved.has(k)) return;
    seenRemoved.add(k);
    removed.push(where ? { url: url, reason: reason, where: where } : { url: url, reason: reason });
  };
  const decide = function (href) {
    const h = decodeEntities(toStr(href)).trim();
    if (origHrefs.has(h)) return null;
    return decideNewLink(h, opts, deadSet);
  };
  let html = toStr(editedHtml);

  // 1) Sources lists: drop whole items whose only link(s) get removed; drop an emptied section.
  const sections = findSourcesSections(html);
  for (let i = sections.length - 1; i >= 0; i--) {
    const sec = sections[i];
    const listHtml = html.slice(sec.listStart, sec.listEnd);
    const items = scanElements(listHtml, ['li'], true);
    const cuts = [];
    let remaining = 0;
    for (const li of items) {
      const anchors = scanElements(li.inner, ['a'], true).map(function (a) {
        const attrs = parseAttrs(a.attrStr);
        return Object.prototype.hasOwnProperty.call(attrs, 'href') ? attrs.href : null;
      }).filter(function (h) { return h !== null; });
      const reasons = anchors.map(decide);
      if (anchors.length && reasons.every(function (r) { return r; })) {
        anchors.forEach(function (h, k) { record(decodeEntities(h).trim(), reasons[k], 'sources'); });
        cuts.push(balancedCut(listHtml, li.start, li.end));
      } else {
        remaining++;
      }
    }
    if (!cuts.length) continue;
    if (remaining === 0) {
      const cut = balancedCut(html, sec.headingStart, sec.listEnd);
      html = html.slice(0, cut.start) + cut.replacement + html.slice(cut.end);
    } else {
      let newList = listHtml;
      for (let k = cuts.length - 1; k >= 0; k--) {
        newList = newList.slice(0, cuts[k].start) + cuts[k].replacement + newList.slice(cuts[k].end);
      }
      html = html.slice(0, sec.listStart) + newList + html.slice(sec.listEnd);
    }
  }

  // 2) Unwrap every other removable new link (keep its anchor text).
  const anchors = scanElements(html, ['a'], true);
  if (anchors.length) {
    let out = '';
    let pos = 0;
    for (const a of anchors) {
      const attrs = parseAttrs(a.attrStr);
      if (!Object.prototype.hasOwnProperty.call(attrs, 'href')) continue;
      const reason = decide(attrs.href);
      if (!reason) continue;
      record(attrs.href.trim(), reason);
      out += html.slice(pos, a.start) + a.inner;
      pos = a.end;
    }
    html = out + html.slice(pos);
  }
  return { html: html, removed: removed };
}

/* ------------------------------------------------------------------ */
/* Analysis used by validateArticle                                     */
/* ------------------------------------------------------------------ */

function jsonLdTypes(obj) {
  const types = [];
  const add = function (t) {
    if (Array.isArray(t)) t.forEach(add);
    else if (typeof t === 'string') types.push(t);
  };
  const visit = function (o) {
    if (Array.isArray(o)) { o.forEach(visit); return; }
    if (!o || typeof o !== 'object') return;
    if (o['@type'] !== undefined) add(o['@type']);
    if (Array.isArray(o['@graph'])) o['@graph'].forEach(visit);
  };
  visit(obj);
  return types;
}

function analyze(html) {
  html = toStr(html);
  const A = { raw: html };
  A.scripts = scanScripts(html);
  A.markup = markupOf(html);
  A.tokens = blockTokens(html);
  A.blocks = extractBlocks(html, A.tokens);
  A.pluginBlocks = A.blocks.filter(function (b) { return b.name.indexOf('/') >= 0; });
  const pluginRanges = A.pluginBlocks.filter(function (b) { return !b.selfClosing && !b.unclosed; }).map(function (b) { return [b.start, b.end]; });
  A.markupNoPlugin = markupOf(removeRanges(html, pluginRanges));

  const open = {};
  const close = {};
  const imgs = [];
  const ids = [];
  const boxes = {};
  for (const b of BOX_TYPES) boxes[b.key] = 0;
  const boxRes = BOX_TYPES.map(function (b) { return new RegExp('background(?:-color)?\\s*:\\s*#' + b.color + '(?![0-9a-f])', 'i'); });
  let eventAttrs = 0;
  forEachTag(A.markup, function (t) {
    if (t.closing) { close[t.name] = (close[t.name] || 0) + 1; return; }
    open[t.name] = (open[t.name] || 0) + 1;
    if (t.attrStr.indexOf('=') < 0 && t.name !== 'img') return;
    const attrs = parseAttrs(t.attrStr);
    if (t.name === 'img') imgs.push(attrs);
    if (Object.prototype.hasOwnProperty.call(attrs, 'id') && attrs.id !== '') ids.push(attrs.id);
    for (const k of Object.keys(attrs)) if (/^on[a-z]+$/.test(k)) eventAttrs++;
    if (attrs.style) {
      for (let i = 0; i < BOX_TYPES.length; i++) if (boxRes[i].test(attrs.style)) boxes[BOX_TYPES[i].key]++;
    }
  });
  A.open = open;
  A.close = close;
  A.imgs = imgs;
  A.ids = ids;
  A.boxes = boxes;
  A.eventAttrs = eventAttrs;
  A.hrefs = hrefSet(html);
  A.text = visibleText(html);
  A.words = countWords(A.text.replace(new RegExp(SHORTCODE_SRC, 'gi'), ' '));
  A.headings = scanElements(A.markupNoPlugin, ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'], true).map(function (h) {
    return { level: parseInt(h.name.charAt(1), 10), text: visibleText(h.inner), inner: h.inner };
  });
  A.allHeadings = scanElements(A.markup, ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'], true).map(function (h) {
    return { level: parseInt(h.name.charAt(1), 10), text: visibleText(h.inner), inner: h.inner };
  });
  A.jsonld = A.scripts.filter(function (s) { return s.isJsonLd; }).map(function (s) {
    let data = null;
    let valid = true;
    try { data = JSON.parse(s.body.trim().replace(/^<!\[CDATA\[|\]\]>$/g, '')); } catch (e) { valid = false; }
    const types = valid ? jsonLdTypes(data) : [];
    return {
      raw: s.raw, valid: valid, data: data, types: types,
      isFaq: valid && types.length > 0 && types.every(function (t) { return t === 'FAQPage'; }),
      hasFaq: types.indexOf('FAQPage') >= 0
    };
  });
  const scRe = new RegExp(SHORTCODE_SRC, 'gi');
  A.shortcodes = A.markup.match(scRe) || [];
  return A;
}

function hasFaq(A) {
  if (A.jsonld.some(function (j) { return j.hasFaq; })) return true;
  if (A.allHeadings.some(function (h) { return /faq|frequently asked/i.test(h.text); })) return true;
  if (A.open.details) return true;
  if (A.blocks.some(function (b) { return b.name === 'yoast/faq-block' || b.name === 'rank-math/faq-block'; })) return true;
  return false;
}

/** First meaningful item of the article (skipping comments, scripts, plugin blocks, empty paragraphs). */
function leadingItem(html) {
  html = toStr(html);
  let pos = 0;
  const n = html.length;
  const shortcodeRe = new RegExp(SHORTCODE_SRC, 'iy');
  for (let guard = 0; guard < 400 && pos < n; guard++) {
    const ws = /\S/g;
    ws.lastIndex = pos;
    const w = ws.exec(html);
    if (!w) return { kind: 'empty' };
    pos = w.index;
    const head = html.slice(pos, pos + 40);
    if (head.indexOf('<!--') === 0) {
      const end = html.indexOf('-->', pos + 4);
      if (end < 0) return { kind: 'empty' };
      const raw = html.slice(pos, end + 3);
      const bm = /^<!--\s*wp:([a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*)/.exec(raw);
      if (bm && !/\/\s*-->$/.test(raw)) {
        const re = new RegExp('<!--\\s*(\\/?)wp:' + escapeRe(bm[1]) + '(?=[\\s/]|-->)', 'g');
        re.lastIndex = end + 3;
        let depth = 1;
        let m;
        let closeEnd = -1;
        while ((m = re.exec(html))) {
          const e2 = html.indexOf('-->', m.index);
          if (e2 < 0) break;
          const self = /\/\s*$/.test(html.slice(m.index + 4, e2));
          if (m[1] === '/') depth--;
          else if (!self) depth++;
          re.lastIndex = e2 + 3;
          if (depth === 0) { closeEnd = e2 + 3; break; }
        }
        pos = closeEnd > 0 ? closeEnd : end + 3;
      } else {
        pos = end + 3;
      }
      continue;
    }
    if (/^<(script|style)(?=[\s>])/i.test(head)) {
      const name = /^<(script|style)/i.exec(head)[1].toLowerCase();
      const cre = new RegExp('</' + name + '\\s*>', 'gi');
      cre.lastIndex = pos;
      const c = cre.exec(html);
      if (!c) return { kind: 'empty' };
      pos = c.index + c[0].length;
      continue;
    }
    if (head.charAt(0) === '<') {
      const tm = /^<([a-zA-Z][a-zA-Z0-9-]*)(?=[\s>\/])/.exec(head);
      if (!tm) return { kind: 'text', raw: short(html.slice(pos, pos + 120)) };
      const tag = tm[1].toLowerCase();
      if (tag === 'img') {
        const t = new RegExp(TAG_SRC, 'y');
        t.lastIndex = pos;
        const im = t.exec(html);
        const attrs = im ? parseAttrs(im[3]) : {};
        return { kind: 'image', tag: tag, key: attrs.src || '', raw: short(im ? im[0] : head, 120) };
      }
      if (VOID_TAGS.indexOf(tag) >= 0) {
        const vt = new RegExp(TAG_SRC, 'y');
        vt.lastIndex = pos;
        const vm = vt.exec(html);
        const vEnd = vm ? pos + vm[0].length : pos + head.length;
        if (tag === 'br') { pos = vEnd; continue; }
        return { kind: 'element', tag: tag, raw: html.slice(pos, vEnd), isBox: false, text: '' };
      }
      let end = elementEnd(html, pos, tag);
      if (end < 0) end = Math.min(n, pos + 2000);
      const el = html.slice(pos, end);
      const inner = el.replace(/^<[^>]*>/, '');
      const text = visibleText(inner, { stripShortcodes: true });
      const hasImg = /<img(?=[\s>\/])/i.test(el);
      if (tag === 'figure' || tag === 'picture' || (!text && hasImg && /^(p|div|a|span|center)$/.test(tag))) {
        const im = new RegExp(TAG_SRC.replace('([a-zA-Z][a-zA-Z0-9:-]*)', '(img)'), 'i').exec(el);
        const attrs = im ? parseAttrs(im[3]) : {};
        return { kind: 'image', tag: tag, key: attrs.src || el, raw: short(el, 160) };
      }
      if (tag === 'p') {
        const plain = visibleText(inner);
        if (!plain) { pos = end; continue; }
        const sc = new RegExp('^' + SHORTCODE_SRC + '$', 'i').exec(plain);
        if (sc) return { kind: 'shortcode', tag: 'p', key: sc[0], raw: short(el, 160) };
        return { kind: 'p', tag: 'p', raw: short(el, 160), text: plain };
      }
      const style = /style\s*=\s*"([^"]*)"/i.exec(el.slice(0, 600));
      const isBox = !!(style && /background(?:-color)?\s*:\s*#(eef3fe|fdf8e3|f5f7fa|fdeced|eafaf1|eef3f7)/i.test(style[1]));
      return { kind: 'element', tag: tag, raw: el, isBox: isBox, text: text };
    }
    if (head.charAt(0) === '[') {
      shortcodeRe.lastIndex = pos;
      const sc = shortcodeRe.exec(html);
      if (sc) return { kind: 'shortcode', key: sc[0], raw: short(sc[0], 160) };
    }
    const lt = html.indexOf('<', pos);
    const seg = html.slice(pos, lt < 0 ? n : lt);
    if (!visibleText(seg, { stripShortcodes: true })) { pos = lt < 0 ? n : lt; continue; }
    return { kind: 'text', raw: short(seg, 120), text: visibleText(seg) };
  }
  return { kind: 'empty' };
}

function faqQuestionsFromJsonLd(data) {
  const out = [];
  const visit = function (o) {
    if (Array.isArray(o)) { o.forEach(visit); return; }
    if (!o || typeof o !== 'object') return;
    const t = o['@type'];
    if (t === 'FAQPage' || (Array.isArray(t) && t.indexOf('FAQPage') >= 0)) {
      const me = Array.isArray(o.mainEntity) ? o.mainEntity : (o.mainEntity ? [o.mainEntity] : []);
      for (const q of me) if (q && typeof q === 'object') out.push(toStr(q.name));
    }
    if (Array.isArray(o['@graph'])) o['@graph'].forEach(visit);
  };
  visit(data);
  return out;
}

function lastCheckedSnippets(text) {
  const out = [];
  const re = /last checked\b[^.!?]{0,60}/gi;
  let m;
  while ((m = re.exec(text))) out.push(normalizeForMatch(m[0]));
  return out;
}

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}]/u;

/* ------------------------------------------------------------------ */
/* 5. validateArticle                                                   */
/* ------------------------------------------------------------------ */

function validateArticle(originalHtml, editedHtml, options) {
  const opts = normalizeOptions(options);
  const errors = [];
  const warnings = [];
  const perCode = {};
  const MAX_PER_CODE = 8;
  const push = function (list, code, message) {
    perCode[code] = (perCode[code] || 0) + 1;
    if (perCode[code] <= MAX_PER_CODE) list.push({ code: code, message: message });
    else if (perCode[code] === MAX_PER_CODE + 1) list.push({ code: code, message: 'More ' + code + ' problems not listed.' });
  };
  const error = function (code, message) { push(errors, code, message); };
  const warn = function (code, message) { push(warnings, code, message); };

  const O = analyze(originalHtml);
  const E = analyze(editedHtml);
  const edited = E.raw;

  // --- Images -----------------------------------------------------------
  if (O.imgs.length !== E.imgs.length) {
    error('IMG_COUNT', 'Image count changed: original ' + O.imgs.length + ', edited ' + E.imgs.length + '.');
  }
  const nImg = Math.min(O.imgs.length, E.imgs.length);
  for (let i = 0; i < nImg; i++) {
    const a = O.imgs[i];
    const b = E.imgs[i];
    const keys = uniq(Object.keys(a).concat(Object.keys(b))).filter(function (k) { return k !== 'alt'; });
    const diff = keys.filter(function (k) { return a[k] !== b[k]; });
    if (diff.length) {
      error('IMG_CHANGED', 'Image #' + (i + 1) + ' (' + short(a.src || b.src || '', 80) + ') changed attribute(s): ' + diff.join(', ') + '.');
    }
  }

  // --- Media and special elements ---------------------------------------------
  for (const t of MEDIA_TAGS) {
    const a = O.open[t] || 0;
    const b = E.open[t] || 0;
    if (a !== b) error('MEDIA_COUNT', '<' + t + '> count changed: original ' + a + ', edited ' + b + '.');
  }
  for (const t of COUNTED_ELEMENTS) {
    const a = O.open[t] || 0;
    const b = E.open[t] || 0;
    if (a !== b) error('ELEMENT_COUNT', '<' + t + '> count changed: original ' + a + ', edited ' + b + '.');
  }

  // --- Shortcodes -----------------------------------------------------------
  const scO = multiset(O.shortcodes);
  const scE = multiset(E.shortcodes);
  for (const entry of scO) {
    const have = scE.get(entry[0]) || 0;
    if (have < entry[1]) error('SHORTCODE_MISSING', 'Shortcode missing or changed: ' + short(entry[0], 100));
  }

  // --- Links and ids -----------------------------------------------------------
  for (const h of O.hrefs) {
    if (!E.hrefs.has(h)) error('LINK_MISSING', 'Original link removed or changed: ' + short(h, 120));
  }
  const idsE = new Set(E.ids);
  const oLead = leadingItem(O.raw);
  let titleIds = new Set();
  if (oLead.kind === 'element' && oLead.tag === 'h1' && !E.open.h1) {
    titleIds = new Set(parseAttrsIds(oLead.raw));
  }
  for (const id of uniq(O.ids)) {
    if (!idsE.has(id) && !titleIds.has(id)) error('ID_MISSING', 'id="' + short(id, 80) + '" from the original is missing.');
  }

  // --- Blocks --------------------------------------------------------------------
  const pbO = multiset(O.pluginBlocks.map(function (b) { return b.raw; }));
  const pbE = multiset(E.pluginBlocks.map(function (b) { return b.raw; }));
  for (const entry of pbO) {
    if ((pbE.get(entry[0]) || 0) < entry[1]) {
      const name = /wp:([a-z0-9_\/-]+)/.exec(entry[0]);
      error('PLUGIN_BLOCK_CHANGED', 'Plugin block changed or removed: wp:' + (name ? name[1] : '?') + ' (' + short(entry[0], 70) + ')');
    }
  }
  const mediaOpeners = function (A) {
    return A.tokens.filter(function (t) { return !t.closing && MEDIA_BLOCKS.indexOf(t.name) >= 0; }).map(function (t) { return t.raw; });
  };
  const mbO = multiset(mediaOpeners(O));
  const mbE = multiset(mediaOpeners(E));
  for (const entry of mbO) {
    if ((mbE.get(entry[0]) || 0) < entry[1]) error('MEDIA_BLOCK_CHANGED', 'Media block comment changed or removed: ' + short(entry[0], 120));
  }
  const blockBalance = function (A) {
    const m = {};
    for (const t of A.tokens) {
      if (t.selfClosing) continue;
      m[t.name] = (m[t.name] || 0) + (t.closing ? -1 : 1);
    }
    return m;
  };
  const bbO = blockBalance(O);
  const bbE = blockBalance(E);
  for (const name of Object.keys(bbE)) {
    if (Math.abs(bbE[name]) > Math.abs(bbO[name] || 0)) {
      error('BLOCK_UNBALANCED', 'Block wp:' + name + ' has ' + Math.abs(bbE[name]) + ' unmatched opener/closer comment(s).');
    }
  }

  // --- Scripts and JSON-LD --------------------------------------------------------------
  const scriptKey = function (s) { return s.raw; };
  const sE = multiset(E.scripts.map(scriptKey));
  const origMustKeep = [];
  for (const s of O.scripts) {
    if (!s.isJsonLd) origMustKeep.push(s.raw);
  }
  for (const j of O.jsonld) if (!j.isFaq) origMustKeep.push(j.raw);
  for (const entry of multiset(origMustKeep)) {
    if ((sE.get(entry[0]) || 0) < entry[1]) error('SCRIPT_CHANGED', 'Script changed or removed: ' + short(entry[0], 100));
  }
  const origScriptSet = new Set(O.scripts.map(scriptKey));
  for (const j of E.jsonld) {
    if (origScriptSet.has(j.raw)) continue;
    if (!j.valid) { error('JSONLD_INVALID', 'JSON-LD block is not valid JSON: ' + short(j.raw, 100)); continue; }
    if (!j.isFaq) error('JSONLD_TYPE', 'New JSON-LD block with @type ' + (j.types.join(', ') || '(none)') + ' (only FAQPage may be added).');
  }
  const faqBlocksE = E.jsonld.filter(function (j) { return j.hasFaq; }).length;
  const faqBlocksO = O.jsonld.filter(function (j) { return j.hasFaq; }).length;
  if (faqBlocksE > Math.max(1, faqBlocksO)) error('JSONLD_TYPE', 'More than one FAQPage JSON-LD block (' + faqBlocksE + ').');

  // --- Special comments -------------------------------------------------------------
  const special = [['<!--more-->', /<!--\s*more\b[\s\S]{0,300}?-->/gi], ['<!--nextpage-->', /<!--\s*nextpage\s*-->/gi]];
  for (const sp of special) {
    const a = countMatches(O.raw, sp[1]);
    const b = countMatches(edited, sp[1]);
    if (b < a) error('SPECIAL_COMMENT_MISSING', sp[0] + ' missing: original ' + a + ', edited ' + b + '.');
  }

  // --- Forbidden tags --------------------------------------------------------------------
  for (const t of FORBIDDEN_TAGS) {
    const a = O.open[t] || 0;
    const b = E.open[t] || 0;
    if (b > a) error('FORBIDDEN_TAG', 'New <' + t + '> tag(s) added (' + (b - a) + ').');
  }
  const doctypeRe = /<!doctype\b/gi;
  if (countMatches(edited, doctypeRe) > countMatches(O.raw, doctypeRe)) error('FORBIDDEN_TAG', 'New <!doctype> added.');
  const plainScripts = function (A) { return A.scripts.filter(function (s) { return !s.isJsonLd; }).length; };
  if (plainScripts(E) > plainScripts(O)) error('FORBIDDEN_TAG', 'New <script> tag(s) added (' + (plainScripts(E) - plainScripts(O)) + ').');
  if (E.eventAttrs > O.eventAttrs) error('FORBIDDEN_TAG', 'New inline event handler attribute(s) (on...=) added.');

  // --- First element --------------------------------------------------------------------
  const eLead = leadingItem(edited);
  if (!(eLead.kind === 'p' || eLead.kind === 'text' || eLead.kind === 'empty')) {
    let same = false;
    if (eLead.kind === 'image') same = oLead.kind === 'image' && oLead.key === eLead.key;
    else if (eLead.kind === 'shortcode') same = oLead.kind === 'shortcode' && oLead.key === eLead.key;
    else if (eLead.kind === 'element') {
      same = oLead.kind === 'element' && oLead.raw === eLead.raw && !/^h[1-6]$/.test(eLead.tag) && !eLead.isBox;
    }
    if (!same) {
      error('FIRST_ELEMENT_NOT_P', 'The article must start with an intro <p>; it starts with ' +
        (eLead.tag ? '<' + eLead.tag + '>' : eLead.kind) + ': ' + short(eLead.raw, 100));
    }
  }
  if (opts.postTitle && (eLead.kind === 'p' || eLead.kind === 'text' || eLead.kind === 'element')) {
    const a = looseNormalize(eLead.text || '');
    const b = looseNormalize(opts.postTitle);
    if (a && b && a === b) error('TITLE_IN_BODY', 'The article starts with a line that only repeats the post title.');
  }

  // --- Headings -------------------------------------------------------------------------
  if (E.headings.length) {
    if (E.headings[0].level !== 2) {
      error('HEADING_ORDER', 'The first heading must be <h2>; found <h' + E.headings[0].level + '> "' + short(E.headings[0].text, 60) + '".');
    }
    for (let i = 1; i < E.headings.length; i++) {
      const prev = E.headings[i - 1].level;
      const cur = E.headings[i].level;
      if (cur > prev + 1) {
        error('HEADING_ORDER', 'Heading level jumps from h' + prev + ' to h' + cur + ' at "' + short(E.headings[i].text, 60) + '".');
      }
    }
  }

  // --- Placeholders / fences ------------------------------------------------------------
  const found = [];
  for (const p of PLACEHOLDER_PATTERNS) {
    const d = countMatches(E.markup, p[1]) - countMatches(O.markup, p[1]);
    if (d > 0) found.push(p[0] + (d > 1 ? ' (x' + d + ')' : ''));
  }
  if (found.length) error('PLACEHOLDER', 'Placeholder text added: ' + found.join(', '));
  if (countOccurrences(edited, '```') > countOccurrences(O.raw, '```')) error('CODE_FENCE', 'Markdown code fence (```) found in the HTML.');

  // --- Tag balance ---------------------------------------------------------------------------
  for (const t of BALANCED_TAGS) {
    const a = Math.abs((O.open[t] || 0) - (O.close[t] || 0));
    const b = Math.abs((E.open[t] || 0) - (E.close[t] || 0));
    if (b > a) error('TAG_UNBALANCED', '<' + t + '> is unbalanced: ' + (E.open[t] || 0) + ' opening vs ' + (E.close[t] || 0) + ' closing tags.');
  }

  // --- Words -----------------------------------------------------------------------------
  const ratio = O.words ? E.words / O.words : (E.words ? Infinity : 1);
  if (ratio < opts.minWordRatio) {
    error('CONTENT_LOSS', 'Visible text shrank to ' + Math.round(ratio * 100) + '% of the original (' + E.words + ' vs ' + O.words + ' words).');
  }
  if (ratio > opts.maxWordRatio) {
    error('WORD_RATIO_EXTREME', 'Visible text grew ' + (isFinite(ratio) ? ratio.toFixed(1) + 'x' : 'from nothing') + ' (' + E.words + ' vs ' + O.words + ' words): runaway or duplicated output.');
  } else if (ratio > 3) {
    warn('WORD_RATIO_HIGH', 'Visible text grew ' + ratio.toFixed(1) + 'x (' + E.words + ' vs ' + O.words + ' words).');
  }

  // --- Duplicate content --------------------------------------------------------------------
  const blockTexts = function (A) {
    return scanElements(A.markup, ['p', 'li'], false).map(function (el) { return normalizeForMatch(visibleText(el.inner)); })
      .filter(function (t) { return countWords(t) >= 12; });
  };
  const dO = multiset(blockTexts(O));
  const dE = multiset(blockTexts(E));
  for (const entry of dE) {
    if (entry[1] >= 2 && (dO.get(entry[0]) || 0) < entry[1]) {
      error('DUPLICATE_CONTENT', 'Text repeated ' + entry[1] + ' times: "' + short(entry[0], 80) + '"');
    }
  }

  // --- Last checked -------------------------------------------------------------------------
  if (opts.webSearchCount === 0) {
    const lcO = multiset(lastCheckedSnippets(O.text));
    const lcE = multiset(lastCheckedSnippets(E.text));
    for (const entry of lcE) {
      if ((lcO.get(entry[0]) || 0) < entry[1]) {
        error('LAST_CHECKED_WITHOUT_RESEARCH', 'A new or changed "Last checked" line was added without any web research: "' + short(entry[0], 60) + '"');
      }
    }
  }

  // --- New links (defence in depth) -------------------------------------------------------------
  const deadSet = normalizeDeadList(opts.deadUrls);
  const newLinks = [];
  for (const h of uniq(hrefList(edited))) {
    if (O.hrefs.has(h)) continue;
    newLinks.push(h);
    const reason = decideNewLink(h, opts, deadSet);
    if (reason === 'internal') error('NEW_INTERNAL_LINK', 'New internal link: ' + short(h, 120));
    else if (reason) error('BAD_NEW_LINK', 'New link not allowed (' + reason + '): ' + short(h, 120));
  }
  const newExternal = newLinks.filter(function (h) {
    const p = parseUrl(h);
    return p && (p.scheme === 'http' || p.scheme === 'https') && !hostMatches(p.host, opts.siteDomains);
  });

  // --- Boxes ------------------------------------------------------------------------------------
  for (const b of BOX_TYPES) {
    const a = O.boxes[b.key];
    const c = E.boxes[b.key];
    if (c > Math.max(b.max, a)) {
      if (b.hard) error('BOX_DUPLICATED', b.label + ' box appears ' + c + ' times (max ' + Math.max(b.max, a) + ').');
      else warn('BOX_LIMIT', b.label + ' boxes: ' + c + ' (limit ' + Math.max(b.max, a) + ').');
    }
  }

  // --- FAQ ------------------------------------------------------------------------------------------
  const faqO = hasFaq(O);
  const faqE = hasFaq(E);
  if (opts.allowNewFaq === false && !faqO && faqE) {
    error('NEW_FAQ_NOT_ALLOWED', 'A new FAQ was added although "Add new FAQ" is "no".');
  }
  const faqLd = E.jsonld.filter(function (j) { return j.valid && j.hasFaq; });
  if (faqLd.length) {
    const qs = [];
    for (const j of faqLd) Array.prototype.push.apply(qs, faqQuestionsFromJsonLd(j.data));
    const details = E.open.details || 0;
    if (qs.length !== details) warn('FAQ_SCHEMA_MISMATCH', 'FAQPage schema has ' + qs.length + ' question(s) but the page has ' + details + ' <details> item(s).');
    const textN = normalizeForMatch(E.text);
    const textL = looseNormalize(E.text);
    for (const q of qs) {
      const qn = normalizeForMatch(decodeEntities(q));
      if (!qn || (textN.indexOf(qn) < 0 && textL.indexOf(looseNormalize(q)) < 0)) {
        warn('FAQ_SCHEMA_MISMATCH', 'FAQPage question not found in the visible text: "' + short(q, 80) + '"');
      }
    }
  }

  // --- Meta lengths ---------------------------------------------------------------------------------
  if (opts.meta) {
    const titles = Array.isArray(opts.meta.seo_titles) ? opts.meta.seo_titles : [];
    const t0 = toStr(titles[0]);
    const tl = Array.from(t0).length;
    if (tl < 30 || tl > 65) warn('META_LENGTH', 'SEO title is ' + tl + ' characters (want 30-65).');
    const md = toStr(opts.meta.meta_description);
    const ml = Array.from(md).length;
    if (ml < 120 || ml > 165) warn('META_LENGTH', 'Meta description is ' + ml + ' characters (want 120-165).');
  }

  // --- Conclusion, emoji, AI phrases ---------------------------------------------------------------------
  const conclRe = /\bconclusion\b|\bfinal thoughts\b/i;
  if (E.allHeadings.some(function (h) { return conclRe.test(h.text); }) && !O.allHeadings.some(function (h) { return conclRe.test(h.text); })) {
    warn('NEW_CONCLUSION', 'A Conclusion section was added although the original had none.');
  }
  if (!EMOJI_RE.test(O.text) && EMOJI_RE.test(E.text)) warn('EMOJI_ADDED', 'Emoji added although the original had none.');
  const tO = normalizeForMatch(O.text);
  const tE = normalizeForMatch(E.text);
  const phrases = [];
  for (const p of AI_PHRASES) {
    const d = countMatches(tE, p[1]) - countMatches(tO, p[1]);
    if (d > 0) phrases.push(p[0] + (d > 1 ? ' (x' + d + ')' : ''));
  }
  if (phrases.length) warn('AI_PHRASE', 'Banned phrase(s) added: ' + phrases.join(', '));

  // --- Links in headings, duplicate new links, Sources -------------------------------------------------
  for (const h of E.allHeadings) {
    const hrefs = hrefList(h.inner).filter(function (x) { return !O.hrefs.has(x); });
    if (hrefs.length) warn('LINK_IN_HEADING', 'New link inside heading "' + short(h.text, 60) + '".');
  }
  const sections = findSourcesSections(edited);
  const bodyHtml = removeRanges(edited, sections.map(function (s) { return [s.headingStart, s.listEnd]; }));
  const bodyLinks = hrefList(bodyHtml);
  const bodyCount = multiset(bodyLinks);
  for (const h of newExternal) {
    if ((bodyCount.get(h) || 0) > 1) warn('DUPLICATE_NEW_LINK', 'New link used ' + bodyCount.get(h) + ' times in the body: ' + short(h, 100));
  }
  for (const s of sections) {
    const links = hrefList(edited.slice(s.listStart, s.listEnd));
    if (!links.length) warn('SOURCES_MISMATCH', 'Sources section has no links.');
    for (const l of uniq(links)) {
      if (!bodyCount.get(l)) warn('SOURCES_MISMATCH', 'Sources lists a URL that the article body does not link: ' + short(l, 100));
    }
  }

  // --- Stats ---------------------------------------------------------------------------------------------
  const headingCounts = { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 };
  for (const k of Object.keys(headingCounts)) headingCounts[k] = E.open[k] || 0;
  const stats = {
    images: E.imgs.length,
    imagesOriginal: O.imgs.length,
    wordsOriginal: O.words,
    wordsEdited: E.words,
    wordRatio: isFinite(ratio) ? Math.round(ratio * 1000) / 1000 : null,
    newExternalLinks: newExternal.length,
    boxes: E.boxes,
    headings: headingCounts
  };
  return { pass: errors.length === 0, errors: errors, warnings: warnings, stats: stats };
}

function parseAttrsIds(elHtml) {
  const ids = [];
  forEachTag(toStr(elHtml), function (t) {
    if (t.closing) return;
    const a = parseAttrs(t.attrStr);
    if (a.id) ids.push(a.id);
  });
  return ids;
}

/* ------------------------------------------------------------------ */
/* 6. filterAuditIssues                                                 */
/* ------------------------------------------------------------------ */

function parseAuditReply(audit) {
  if (audit && typeof audit === 'object') return audit;
  const s = toStr(audit).trim();
  if (!s) return null;
  const tryParse = function (x) { try { return JSON.parse(x); } catch (e) { return null; } };
  let r = tryParse(stripOuterFence(s, /^(json|javascript|js)$/i));
  if (!r) {
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) r = tryParse(s.slice(a, b + 1));
  }
  return r && typeof r === 'object' && !Array.isArray(r) ? r : null;
}

function attributeText(html) {
  const parts = [];
  forEachTag(markupOf(html), function (t) {
    if (t.closing || t.attrStr.indexOf('=') < 0) return;
    const a = parseAttrs(t.attrStr);
    if (a.alt) parts.push(a.alt);
    if (a.title) parts.push(a.title);
  });
  return parts.join(' | ');
}

function quoteFound(quote, corpusN, corpusL) {
  let q = decodeEntities(toStr(quote));
  if (/<[a-zA-Z\/]/.test(q)) q = visibleText(q);
  q = normalizeForMatch(q).replace(/^["'\s]+|["'\s]+$/g, '');
  if (!q) return false;
  if (corpusN.indexOf(q) >= 0) return true;
  const ql = looseNormalize(q);
  if (ql && corpusL.indexOf(ql) >= 0) return true;
  if (/\.\.\./.test(q)) {
    const parts = q.split(/\.\.\./).map(looseNormalize).filter(Boolean);
    if (!parts.length) return false;
    let pos = 0;
    for (const p of parts) {
      const i = corpusL.indexOf(p, pos);
      if (i < 0) return false;
      pos = i + p.length;
    }
    return true;
  }
  return false;
}

/**
 * Keeps only audit issues whose quote really occurs in the edited article's visible text.
 * extra.originalHtml (optional): quotes of "info_lost" issues may also come from the original.
 */
function filterAuditIssues(editedHtml, audit, extra) {
  extra = extra || {};
  const parsed = parseAuditReply(audit);
  if (!parsed) {
    return { verdict: 'reject', effectiveVerdict: 'reject', issues: [], dropped: [], blocking: true, valid: false,
      error: 'Audit reply is not a valid JSON object.' };
  }
  const corpus = visibleText(editedHtml) + ' | ' + attributeText(editedHtml);
  const corpusN = normalizeForMatch(corpus);
  const corpusL = looseNormalize(corpus);
  let origN = null;
  let origL = null;
  if (extra.originalHtml) {
    const oc = visibleText(extra.originalHtml);
    origN = normalizeForMatch(oc);
    origL = looseNormalize(oc);
  }
  const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
  const kept = [];
  const dropped = [];
  for (const raw of issues) {
    if (!raw || typeof raw !== 'object') { dropped.push({ issue: raw, dropReason: 'not an object' }); continue; }
    const issue = Object.assign({}, raw);
    let sev = toStr(issue.severity).trim().toLowerCase();
    if (sev !== 'high' && sev !== 'medium' && sev !== 'low') {
      issue.severity_original = issue.severity;
      sev = 'high';
    }
    issue.severity = sev;
    let ok = quoteFound(issue.quote, corpusN, corpusL);
    if (!ok && origN !== null && toStr(issue.category) === 'info_lost') ok = quoteFound(issue.quote, origN, origL);
    if (ok) kept.push(issue);
    else dropped.push(Object.assign({}, issue, { dropReason: 'quote not found in the edited text' }));
  }
  const blocking = kept.some(function (i) { return i.severity === 'high'; });
  const verdict = toStr(parsed.verdict).trim().toLowerCase();
  let effectiveVerdict;
  if (verdict === 'reject') effectiveVerdict = 'reject';
  else if (verdict !== 'pass' && verdict !== 'fix') effectiveVerdict = 'reject';
  else effectiveVerdict = blocking ? 'fix' : 'pass';
  const out = Object.assign({}, parsed, {
    verdict: verdict || parsed.verdict, effectiveVerdict: effectiveVerdict, issues: kept, dropped: dropped, blocking: blocking, valid: true
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* 7. processEditorOutput                                               */
/* ------------------------------------------------------------------ */

async function processEditorOutput(originalHtml, llmText, options) {
  const original = toStr(originalHtml);
  let opts = null;
  const out = {
    action: 'keep_original', html: original, meta: null, errors: [], warnings: [],
    removedLinks: [], linkResults: [], stats: null, changed: false
  };
  try {
    opts = normalizeOptions(options);
    const parsed = parseEditorOutput(llmText);
    out.meta = parsed.meta;
    if (parsed.ok && parsed.status === 'skipped') {
      out.action = 'skip';
      return out;
    }
    if (!parsed.ok) {
      out.errors = parsed.errors;
      return out;
    }
    // Unknown search count + model says it did no research => treat as no research (stricter).
    if (opts.webSearchCount === null && parsed.meta && parsed.meta.web_research_used === false) opts.webSearchCount = 0;

    const newLinks = findNewLinks(original, parsed.html, opts);
    let dead = [];
    if (opts.checkLinks) {
      const toCheck = newLinks.filter(function (h) {
        const p = parseUrl(h);
        return p && (p.scheme === 'http' || p.scheme === 'https') && decideNewLink(h, opts, null) === null;
      });
      if (toCheck.length) {
        try {
          out.linkResults = await checkLinks(toCheck, { fetchFn: opts.fetchFn, timeoutMs: opts.linkTimeoutMs, concurrency: opts.linkConcurrency });
        } catch (e) {
          out.linkResults = toCheck.map(function (u) { return { url: u, status: null, verdict: 'unknown', error: 'link check failed' }; });
        }
        dead = out.linkResults.filter(function (r) { return r.verdict === 'dead'; }).map(function (r) { return r.url; });
      }
    }
    const san = sanitizeLinks(original, parsed.html, opts, dead);
    out.removedLinks = san.removed;
    const v = validateArticle(original, san.html, Object.assign({}, opts, { meta: parsed.meta, deadUrls: dead }));
    out.errors = v.errors;
    out.warnings = v.warnings;
    out.stats = v.stats;
    out.candidateHtml = san.html;
    if (v.pass) {
      out.action = 'publish';
      out.html = san.html;
      out.changed = san.html !== original;
    }
  } catch (e) {
    out.action = 'keep_original';
    out.html = original;
    out.errors.push({ code: 'INTERNAL_ERROR', message: 'Validator crashed: ' + short(e && (e.stack || e.message) || e, 300) });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* CLI                                                                  */
/* ------------------------------------------------------------------ */

const CLI_USAGE = 'Usage: node validate-article.js --original orig.html --output llm-output.txt ' +
  '[--site a.com,b.com] [--searches N] [--faq auto|no] [--no-link-check] [--write-html out.html] [--report report.json]';

function parseCliArgs(argv) {
  const a = { site: [], searches: null, faq: 'auto', linkCheck: true };
  const need = function (i, name) {
    if (i + 1 >= argv.length || /^--/.test(argv[i + 1])) throw new Error('Missing value for ' + name);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--original') { a.original = need(i, k); i++; }
    else if (k === '--output') { a.output = need(i, k); i++; }
    else if (k === '--site') { a.site = need(i, k).split(',').map(function (s) { return s.trim(); }).filter(Boolean); i++; }
    else if (k === '--searches') {
      const v = need(i, k); i++;
      if (!/^\d+$/.test(v)) throw new Error('--searches must be a whole number');
      a.searches = parseInt(v, 10);
    }
    else if (k === '--faq') {
      const v = need(i, k).toLowerCase(); i++;
      if (v !== 'auto' && v !== 'no') throw new Error('--faq must be auto or no');
      a.faq = v;
    }
    else if (k === '--no-link-check') a.linkCheck = false;
    else if (k === '--write-html') { a.writeHtml = need(i, k); i++; }
    else if (k === '--report') { a.report = need(i, k); i++; }
    else if (k === '--help' || k === '-h') a.help = true;
    else throw new Error('Unknown argument: ' + k);
  }
  if (!a.help && (!a.original || !a.output)) throw new Error('--original and --output are required');
  return a;
}

async function runCli(argv) {
  const fs = require('fs');
  let args;
  try {
    args = parseCliArgs(argv);
  } catch (e) {
    process.stderr.write(e.message + '\n' + CLI_USAGE + '\n');
    return 1;
  }
  if (args.help) { process.stdout.write(CLI_USAGE + '\n'); return 0; }
  let original;
  let output;
  try {
    original = fs.readFileSync(args.original, 'utf8');
    output = fs.readFileSync(args.output, 'utf8');
  } catch (e) {
    process.stderr.write('Cannot read input: ' + e.message + '\n');
    return 1;
  }
  const result = await processEditorOutput(original, output, {
    siteDomains: args.site,
    webSearchCount: args.searches,
    allowNewFaq: args.faq !== 'no',
    checkLinks: args.linkCheck
  });
  const code = result.action === 'publish' ? 0 : (result.action === 'skip' ? 3 : 2);
  try {
    if (args.writeHtml) {
      if (result.action === 'publish') fs.writeFileSync(args.writeHtml, result.html, 'utf8');
      else if (fs.existsSync(args.writeHtml)) fs.unlinkSync(args.writeHtml); // never leave a stale file to upload
    }
    if (args.report) fs.writeFileSync(args.report, JSON.stringify(result, null, 2), 'utf8');
  } catch (e) {
    process.stderr.write('Cannot write output: ' + e.message + '\n');
    return 1;
  }
  const printable = Object.assign({}, result);
  printable.htmlLength = toStr(result.html).length;
  delete printable.html;
  delete printable.candidateHtml;
  process.stdout.write(JSON.stringify(printable, null, 2) + '\n');
  return code;
}

/* ------------------------------------------------------------------ */
/* Exports                                                              */
/* ------------------------------------------------------------------ */

if (typeof module !== 'undefined' && module && module.exports) {
  module.exports = {
    VERSION: VALIDATE_ARTICLE_VERSION,
    parseEditorOutput: parseEditorOutput,
    findNewLinks: findNewLinks,
    checkLinks: checkLinks,
    sanitizeLinks: sanitizeLinks,
    validateArticle: validateArticle,
    filterAuditIssues: filterAuditIssues,
    processEditorOutput: processEditorOutput,
    runCli: runCli,
    ERROR_CODES: ERROR_CODES,
    WARNING_CODES: WARNING_CODES,
    DEFAULT_FORBIDDEN_LINK_DOMAINS: DEFAULT_FORBIDDEN_LINK_DOMAINS,
    BOX_TYPES: BOX_TYPES,
    _internal: {
      visibleText: visibleText, countWords: countWords, decodeEntities: decodeEntities, normalizeOptions: normalizeOptions,
      parseUrl: parseUrl, decideNewLink: decideNewLink, findSourcesSections: findSourcesSections, leadingItem: leadingItem,
      blockTokens: blockTokens, normalizeForMatch: normalizeForMatch, classifyFetchError: classifyFetchError
    }
  };
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  runCli(process.argv.slice(2)).then(function (code) {
    process.exitCode = code;
  }, function (e) {
    process.stderr.write('Fatal: ' + (e && e.stack || e) + '\n');
    process.exitCode = 1;
  });
}
