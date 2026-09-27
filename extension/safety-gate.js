/*
 * validate-article.js
 * Code gates for the unattended article-editing pipeline.
 *
 * Plain, dependency-free JavaScript. Works in Node 18+ (require it, or run it as a CLI)
 * and can be pasted as a whole into an n8n "Code" node (then call the functions directly).
 * Regex/string parsing only (no DOM). Every pattern is written so a 1 MB article is
 * processed in well under two seconds, even when the HTML is broken.
 *
 * Main functions (see automation/README.md for the full pipeline):
 *   parseEditorOutput(text)                               -> { ok, status, html, meta, errors }
 *   findNewLinks(originalHtml, editedHtml, options)        -> [href, ...]
 *   checkLinks(urls, { fetchFn, timeoutMs, concurrency })  -> Promise<[{ url, status, verdict, error }]>
 *   sanitizeLinks(originalHtml, editedHtml, options, deadUrls) -> { html, removed }
 *   validateArticle(originalHtml, editedHtml, options)     -> { pass, errors, warnings, stats }
 *   filterAuditIssues(editedHtml, audit, extra)            -> audit with verified issues only
 *   processEditorOutput(originalHtml, llmText, options)    -> Promise<{ action, html, ... }>
 *   stripEndMarkers(html, marker)                          -> html without <!-- APU-END --> comments
 *   runSafetyGate(referenceHtml, aiHtml, options)          -> Promise<{ ok, html, errors, warnings, removedLinks, linkResults, stats }>
 *
 * Browser extension: the same file is shipped as extension/safety-gate.js (byte-identical) and loaded with
 * importScripts('safety-gate.js'); it then exposes one global object, self.SafetyGate (see the end of the file).
 *
 * CLI:
 *   node automation/validate-article.js --original orig.html --output llm-output.txt --site a.com,b.com
 *        [--searches N] [--faq auto|no] [--title "Post title"] [--last-checked yes|no|auto]
 *        [--today YYYY-MM-DD] [--no-link-check] [--write-html out.html] [--report report.json]
 *   exit codes: 0 publish, 2 keep_original, 3 skip, 1 usage/IO error.
 *   --write-html and --report files from an earlier run are deleted first, so a stale file never survives.
 *
 * Fail-closed rule: anything unexpected => action "keep_original" (the live article is not touched).
 */

const VALIDATE_ARTICLE_VERSION = '1.2.0';

const MARKER_HTML = '<<<ARTICLE_HTML>>>';
const MARKER_META = '<<<META_JSON>>>';
const MARKER_END = '<<<END>>>';
// Browser mode (AI chat websites): the prompt makes <!-- APU-END --> the article's last line. No marker = cut off.
const DEFAULT_END_MARKER = 'APU-END';

const DEFAULT_FORBIDDEN_LINK_DOMAINS = [
  'reddit.com', 'quora.com', 'pinterest.com', 'medium.com', 'facebook.com', 'instagram.com',
  'tiktok.com', 'x.com', 'twitter.com', 'blogspot.com', 'amzn.to'
];

// Short links and search/grounding redirect hosts. Always unwrapped when NEW (reason "redirect"), even when
// options.forbiddenLinkDomains replaces the default list: their target is unknown and they often expire.
const REDIRECT_LINK_DOMAINS = [
  'vertexaisearch.cloud.google.com', 't.co', 'bit.ly', 'goo.gl', 'tinyurl.com', 'ow.ly', 'lnkd.in', 'rebrand.ly',
  'shorturl.at', 'buff.ly', 'is.gd', 'cutt.ly', 'rb.gy', 'tiny.cc', 't.ly', 'v.gd', 'amzn.to', 'a.co'
];
// Search-engine click-through redirect addresses (google.com/url?..., bing.com/ck/..., duckduckgo.com/l/...).
const SEARCH_REDIRECT_RE = /^https?:\/\/(?:www\.)?(?:google\.[a-z.]{2,12}\/url\?|bing\.com\/ck\/|duckduckgo\.com\/l\/)/i;
// Domain parking / for-sale hosts: a new link that redirects here points to a lapsed domain.
const PARKING_HOSTS = ['hugedomains.com', 'sedo.com', 'sedoparking.com', 'dan.com', 'afternic.com', 'godaddy.com',
  'bodis.com', 'parkingcrew.net', 'above.com', 'undeveloped.com'];
// Tracking query parameters removed from NEW links (search tools add utm_source=openai and similar).
const TRACKING_PARAM_RE = /^(?:utm_[a-z0-9_]*|srsltid|gclid|gclsrc|dclid|fbclid|msclkid|mc_cid|mc_eid|_ga|_gl|yclid|gad_source|igshid)$/i;

const ERROR_CODES = [
  'PARSE_MISSING_MARKER', 'PARSE_META_JSON', 'PARSE_EMPTY_HTML', 'CONFIG_MISSING',
  'IMG_COUNT', 'IMG_CHANGED', 'MEDIA_COUNT', 'MEDIA_CHANGED', 'ELEMENT_COUNT', 'EMBED_URL_MISSING',
  'SHORTCODE_MISSING', 'SHORTCODE_ADDED', 'LINK_MISSING', 'LINK_ATTR_CHANGED', 'ID_MISSING',
  'PLUGIN_BLOCK_CHANGED', 'MEDIA_BLOCK_CHANGED', 'BLOCK_MARKUP_MISMATCH', 'BLOCK_COMMENTS_IN_CLASSIC',
  'SCRIPT_CHANGED', 'SPECIAL_COMMENT_MISSING', 'MALFORMED_COMMENT', 'FORBIDDEN_TAG',
  'FIRST_ELEMENT_NOT_P', 'STRAY_TEXT', 'HEADING_ORDER', 'PLACEHOLDER', 'MARKDOWN', 'OMISSION_MARKER', 'CODE_FENCE',
  'JSONLD_INVALID', 'JSONLD_TYPE', 'TAG_UNBALANCED', 'BLOCK_UNBALANCED', 'CONTENT_LOSS', 'CONTENT_RETENTION',
  'WORD_RATIO_EXTREME', 'DUPLICATE_CONTENT', 'LAST_CHECKED_WITHOUT_RESEARCH', 'LAST_CHECKED_NOT_ALLOWED',
  'NEW_NUMBER_WITHOUT_RESEARCH', 'NUMBER_MISSING', 'NEW_INTERNAL_LINK', 'BAD_NEW_LINK', 'BOX_DUPLICATED',
  'SECTION_DUPLICATED', 'NEW_FAQ_NOT_ALLOWED', 'TITLE_IN_BODY', 'INTERNAL_ERROR', 'END_MARKER_MISSING', 'TABLE_LOSS'
];

const WARNING_CODES = [
  'AI_PHRASE', 'WORD_RATIO_HIGH', 'BOX_LIMIT', 'FAQ_SCHEMA_MISMATCH', 'META_LENGTH', 'META_JSON_INVALID', 'NEW_CONCLUSION',
  'EMOJI_ADDED', 'LINK_IN_HEADING', 'DUPLICATE_NEW_LINK', 'SOURCES_MISMATCH', 'NEW_HTML_COMMENT',
  'LINK_CHECK_UNAVAILABLE', 'LINK_CHECK_INCONCLUSIVE', 'SITE_DOMAINS_INFERRED', 'LIST_LOSS', 'CLASSIC_CONVERSION'
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
// Elements whose attributes must stay exactly the same (nth element vs nth element, like <img>).
const MEDIA_COMPARE_TAGS = ['source', 'iframe', 'video', 'audio', 'embed', 'object', 'track', 'ins', 'form', 'button'];
const FORBIDDEN_TAGS = ['h1', 'title', 'html', 'head', 'body', 'style', 'meta', 'link',
  'textarea', 'template', 'xmp', 'plaintext', 'noembed', 'noframes', 'select', 'input', 'base'];
// Block-level containers: text outside all of them (and outside block comments) is "bare" top-level text.
const BLOCK_CONTAINER_TAGS = ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead',
  'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'blockquote', 'figure', 'figcaption', 'details', 'summary', 'section',
  'article', 'aside', 'header', 'footer', 'nav', 'main', 'pre', 'form', 'fieldset', 'picture', 'video', 'audio', 'iframe',
  'object', 'noscript', 'center', 'textarea', 'select', 'button', 'label', 'address', 'map', 'svg', 'math', 'template'];
// A new <p>-closing block tag implicitly ends an open <p> (HTML parsing rule), so unclosed <p> tags do not hide text.
const P_CLOSING_TAGS = ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'dl', 'table', 'blockquote', 'figure',
  'details', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'main', 'pre', 'form', 'fieldset', 'address', 'center'];
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
  // "TODO" only in placeholder shapes ([TODO / TODO:), so Spanish/Portuguese "TODO lo que..." is not a placeholder.
  ['{{', /\{\{/g], ['}}', /\}\}/g], ['[VERIFY', /\[VERIFY/gi], ['[TODO', /\[TODO/gi], ['TODO:', /\bTODO\s*:/g],
  ['TBD', /\bTBD\b(?!\w)/g], ['href="#"', /\bhref\s*=\s*(["'])#\1/gi], ['REAL-URL', /REAL-URL/gi], ['PASTE YOUR', /PASTE YOUR/g],
  ['lorem ipsum', /lorem ipsum/gi], ['[insert', /\[insert/gi], ['[add ', /\[add /gi], ['[link', /\[link/gi],
  ['your-site', /your-site/gi], ['yourdomain', /yourdomain/gi], ['example.com', /example\.com/gi],
  ['[bracket placeholder]', /\[(?:your|image|photo|picture|screenshot|chart|graphic|source|citation|url|name|date|year|price|number|brand|product|city|country|author)\b[^\]]{0,80}\]/gi],
  ['XX', /\bX{2,}\b/g]
];
// Placeholder shapes inside JSON-LD string values (FAQ schema).
// (TODO:/TBD are case-sensitive: Spanish "todo:" is a normal word.)
const JSONLD_PLACEHOLDER_RE = /\{\{[^}]{0,40}\}\}|\[(?:VERIFY|verify|Verify|TODO|todo)\b|\bTODO\s*:|\bTBD\b|REAL-URL|real-url|PASTE YOUR|paste your/;

// Markdown and search-tool citation artifacts (counted as edited minus original, visible text outside <pre>/<code>).
const MARKDOWN_PATTERNS = [
  ['markdown link [text](url)', /\]\((?:https?:|\/)/g],
  ['markdown bold **text**', /\*\*[^*\s][^*]{0,200}?\*\*/g],
  ['citation mark \u3010\u2026\u3011', /\u3010[^\u3011]{0,40}\u3011/g],
  ['citation mark [cite\u2026]', /\[cite[^\]]{0,20}\]/gi],
  ['numeric citation [n]', /(?:^|[^\w\]])\[\d{1,2}\](?!\()/g]
];
const MARKDOWN_HEADING_RE = /(?:^|\n)[ \t]{0,3}#{1,6}[ \t]+\S/g;

// "Rest of the article unchanged" and similar omission notes. OMISSION_PATTERNS are tested on SHORT text blocks
// only (a paragraph of <= 20 words that is just the note), so normal sentences ("the content stays unchanged when you
// switch themes" inside a longer paragraph) are not caught. OMISSION_NOTE_RE (a bracketed/parenthesised note) and
// OMISSION_COMMENT_RE (new HTML comments) apply anywhere.
const OMISSION_PATTERNS = [
  /\b(?:rest|remainder) of (?:the |this )?(?:article|post|content|text|html|page|document)\b/gi,
  /\b(?:article|post|content|html|everything else|all else|other sections|remaining (?:content|text|sections?|paragraphs?))\s+(?:remains?|stays?|is|are|was|were|left|kept)\s+(?:unchanged|as is|as before|intact)\b/gi,
  /\bunchanged from (?:the )?original\b/gi,
  /^\s*[\[(]?\s*(?:\.\.\.|…)\s*[\])]?\s*$/g,
  /\b(?:omitted|truncated|shortened|abbreviated) for (?:brevity|length|space)\b/gi,
  /\bcontent (?:continues|omitted|truncated)\b/gi,
  /\b(?:same|continues) as (?:in )?(?:the )?original\b/gi
];
const OMISSION_NOTE_RE = /[\[(][^\])\n]{0,80}\b(?:unchanged|omitted|truncated|continues|continued|same as (?:the )?original|as before|rest of (?:the |this )?(?:article|post|content|text|html)|remainder of|remaining (?:sections?|content|text))\b[^\])\n]{0,80}[\])]/gi;
const OMISSION_COMMENT_RE = /unchanged|omitted|truncated|continues|continued|rest of|remainder|same as (?:the )?original|as before|\.\.\.|\u2026|\bsnip\b/i;

// Words of the model's own around the article (chat text). Anchored at the start of a new bare text segment
// or of the article's visible text; LLM_CHATTER_ANY_RE may appear anywhere (counted as new occurrences).
const CHATTER_START_RE = new RegExp('^(?:' + [
  "here(?:'s|\\u2019s| is| are)\\s+(?:the|your)\\s+(?:(?:complete|full|fully|final|updated|revised|edited|improved|rewritten|fixed|new|corrected|polished|optimi[sz]ed|seo[- ]optimi[sz]ed)\\s+){0,3}(?:article|html|version|post|content|edit|rewrite|draft)\\b",
  'below (?:is|are) (?:the|your)\\s+(?:(?:complete|full|final|updated|revised|edited|improved|rewritten|fixed)\\s+){0,3}(?:article|html|version|post|content)\\b',
  '(?:sure|certainly|of course|absolutely)[,!.]\\s+(?:here|i\\b|below)',
  "i(?:'ve|\\u2019ve| have)?\\s+(?:kept|made|added|removed|changed|edited|updated|revised|rewrote|rewritten|improved|preserved)\\s+(?:all|every|the|your|some|a few|several|these|those|it|this)\\b[^.!?]{0,40}?\\b(?:images?|links?|article|content|text|headings?|structure|changes|edits|html|markup|shortcodes?|blocks?|formatting|sections?)\\b",
  '(?:the\\s+)?(?:complete|full|final|fixed|edited|updated|revised|improved|rewritten)\\s+(?:article|html|version)(?:\\s+html)?\\s*:?\\s*$',
  'article html\\s*:?\\s*$',
  '(?:```)?\\s*(?:html?|json|xml|markup)\\s*:?\\s*$',
  'end of (?:the )?(?:article|html)\\b'
].join('|') + ')', 'i');
const LLM_CHATTER_ANY_RE = /\blet me know if you(?:'d|\u2019d| would)? (?:like|want|need) (?:me to |any |more |further |other |additional |some )*(?:changes?|edits?|revisions?|adjustments?|tweaks?|modifications?|anything else)\b|\bas an ai language model\b|\bas a (?:large )?language model\b|\bi hope (?:these|this|the) (?:edits?|changes|revisions?|version|rewrite) helps?\b/gi;

// FAQ section headings in the user's languages (a FAQ counts as present when a heading matches).
const FAQ_HEADING_RE = /\bfaqs?\b|frequently asked|common questions|questions? (?:and|&) answers?|\bq ?& ?a\b|h\u00e4ufig gestellte fragen|h\u00e4ufige fragen|preguntas frecuentes|questions fr\u00e9quentes|foire aux questions|domande frequenti|perguntas frequentes|veelgestelde vragen|vanliga fr\u00e5gor|ofte stillede sp\u00f8rgsm\u00e5l|ofte stilte sp\u00f8rsm\u00e5l|usein kysyt|najcz\u0119\u015bciej zadawane pytania|cz\u0119sto zadawane pytania|s\u0131k\u00e7a sorulan sorular|\u0447\u0430\u0441\u0442\u043e \u0437\u0430\u0434\u0430\u0432\u0430\u0435\u043c\u044b\u0435 \u0432\u043e\u043f\u0440\u043e\u0441\u044b|\u09b8\u09be\u09a7\u09be\u09b0\u09a3 \u09aa\u09cd\u09b0\u09b6\u09cd\u09a8|\u09aa\u09cd\u09b0\u09be\u09af\u09bc\u09b6\u0987 \u099c\u09bf\u099c\u09cd\u099e\u09be\u09b8\u09bf\u09a4|\u09b8\u099a\u09b0\u09be\u099a\u09b0 \u099c\u09bf\u099c\u09cd\u099e\u09be\u09b8\u09bf\u09a4|\u0905\u0915\u094d\u0938\u0930 \u092a\u0942\u091b\u0947 \u091c\u093e\u0928\u0947 \u0935\u093e\u0932\u0947/i;

// Freshness / verification claims that need research (webSearchCount 0 => hard error when new).
// A date-like span right after the claim word ("Updated: September 2026", "updated for 2026", "reviewed 27.09.2026");
// "the rules were updated in 2023" (a fact, after was/were/been) is not a freshness claim.
const FRESHNESS_PATTERNS = [
  /(?<!\b(?:was|were|been|being|is|are|be|get|gets|got)\s)\b(?:last updated|updated|verified|fact[- ]checked|reviewed)\b\s*(?::|on|in|for|as of|-|\u2013)?\s*(?:\d{1,2}(?:st|nd|rd|th)?\.?\s+)?(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+)?(?:\d{1,2}(?:st|nd|rd|th)?,?\s+)?(?:\d{1,2}[./-]\d{1,2}[./-])?(?:19|20)\d\d\b/gi,
  /\b(?:prices|figures|facts|dates|data)\s+(?:were\s+|are\s+|have been\s+)?(?:verified|checked|confirmed)\b/gi
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

// Tag pattern: quote-aware, no catastrophic backtracking (the three alternatives start with different characters).
// Quoted values are not length-capped, so big data-URI images are still seen as <img> tags.
const ATTRS_SRC = '(?:[^<>"\']|"[^"]*"|\'[^\']*\')*';
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
  n = n || 90;
  s = toStr(s);
  if (s.length > n * 4 + 200) s = s.slice(0, n * 4 + 200);
  s = s.replace(/\s+/g, ' ').trim();
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

/** CRLF / CR line endings -> LF, so a Windows-saved original and the model's LF output compare equal. */
function normalizeNewlines(s) {
  s = toStr(s);
  return s.indexOf('\r') < 0 ? s : s.replace(/\r\n?/g, '\n');
}

/** Source of the <!-- MARKER --> comment pattern (whitespace-tolerant; used case-insensitively). */
function endMarkerSrc(marker) {
  return '<!--\\s*' + escapeRe(toStr(marker).trim() || DEFAULT_END_MARKER) + '\\s*-->';
}

function hasEndMarker(html, marker) {
  return new RegExp(endMarkerSrc(marker), 'i').test(toStr(html));
}

/**
 * Removes every <!-- APU-END --> end marker (or <!-- marker -->). A marker on its own line is removed with that
 * line (and its newline); a marker next to other content is removed alone, so no line break of the article changes.
 */
function stripEndMarkers(html, marker) {
  html = toStr(html);
  if (html.indexOf('<!--') < 0) return html;
  const src = endMarkerSrc(marker);
  return html.replace(new RegExp('^[ \\t]*' + src + '[ \\t]*(?:\\r?\\n|$)', 'gim'), '').replace(new RegExp(src, 'gi'), '');
}

/** Entries of multiset `b` that occur more often than in multiset `a`: [[key, extra], ...]. */
function multisetExcess(a, b) {
  const out = [];
  for (const entry of b) {
    const d = entry[1] - (a.get(entry[0]) || 0);
    if (d > 0) out.push([entry[0], d]);
  }
  return out;
}

/** Sorted [start, end) ranges of well-formed HTML comments. */
function commentRanges(html) {
  const out = [];
  let pos = 0;
  for (;;) {
    const s = html.indexOf('<!--', pos);
    if (s < 0) break;
    const e = html.indexOf('-->', s + 4);
    if (e < 0) break;
    out.push([s, e + 3]);
    pos = e + 3;
  }
  return out;
}

/** Ranges the link sanitizer must never touch: scripts (incl. JSON-LD), <style> elements and HTML comments. */
function protectedRanges(html) {
  const ranges = scanScripts(html).map(function (s) { return [s.start, s.end]; });
  if (html.toLowerCase().indexOf('<style') >= 0) {
    for (const st of scanElements(html, ['style'], true)) ranges.push([st.start, st.end]);
  }
  for (const c of commentRanges(html)) ranges.push(c);
  ranges.sort(function (a, b) { return a[0] - b[0]; });
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/** true when index `i` lies inside one of the sorted, non-overlapping ranges (binary search). */
function inRanges(ranges, i) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid][0] > i) hi = mid - 1;
    else if (ranges[mid][1] <= i) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Removes <script>, <style> (and optionally other raw-text elements) with an O(n) scan. */
function removeRawElements(html, names, replacement) {
  html = toStr(html);
  replacement = replacement === undefined ? ' ' : replacement;
  let out = html;
  for (const name of names) {
    if (out.toLowerCase().indexOf('<' + name) < 0) continue;
    const openRe = new RegExp('<' + name + '(?=[\\s>/])[^<>]{0,2000}>', 'gi');
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
  const openRe = /<script(?=[\s>/])[^<>]{0,2000}>/gi;
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
  const lastClose = {}; // name -> { index, len }: the next closer found by the previous search (reused while still ahead)
  const out = [];
  let m;
  while ((m = openRe.exec(html))) {
    const name = m[1].toLowerCase();
    if (noClose[name]) continue;
    if (/\/\s*$/.test(m[2]) && name !== 'a') continue; // self-closing form, no content
    const from = m.index + m[0].length;
    let c = null;
    const lc = lastClose[name];
    if (lc && lc.index >= from) {
      c = lc;
    } else {
      const cre = closeRes[name] || (closeRes[name] = new RegExp('</' + escapeRe(name) + '\\s*>', 'gi'));
      cre.lastIndex = from;
      const found = cre.exec(html);
      if (!found) { noClose[name] = true; continue; }
      c = { index: found.index, len: found[0].length };
      lastClose[name] = c;
    }
    const cEnd = c.index + c.len;
    out.push({
      name: name,
      attrStr: m[2],
      start: m.index,
      contentStart: m.index + m[0].length,
      contentEnd: c.index,
      end: cEnd,
      openTag: m[0],
      inner: html.slice(m.index + m[0].length, c.index)
    });
    if (skipInner) openRe.lastIndex = cEnd;
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
// Shared global regexes: only ever used with String.prototype.replace (which resets lastIndex itself).
const INLINE_TAG_RE_G = new RegExp(INLINE_TAG_RE_SRC, 'gi');
const ANY_TAG_RE_G = new RegExp('<\\/?[a-zA-Z][a-zA-Z0-9:-]*(?=[\\s>/])' + ATTRS_SRC + '>', 'g');
const SHORTCODE_RE_G = new RegExp(SHORTCODE_SRC, 'gi');

/** Visible text: scripts/styles/comments removed, inline tags removed, block tags -> space, entities decoded. */
function visibleText(html, opts) {
  opts = opts || {};
  let s = opts.isMarkup ? toStr(html) : markupOf(html);
  if (s.indexOf('<') >= 0) {
    s = s.replace(INLINE_TAG_RE_G, '');
    s = s.replace(ANY_TAG_RE_G, ' ');
  }
  s = decodeEntities(s);
  if (opts.stripShortcodes && s.indexOf('[') >= 0) s = s.replace(SHORTCODE_RE_G, ' ');
  return s.replace(/[\s\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]+/g, ' ').trim();
}

/** Text with line structure kept (tags -> newline), <pre>/<code> removed: used to spot markdown "## Heading" lines. */
function lineText(markup) {
  let s = toStr(markup);
  if (/<(?:pre|code)(?=[\s>\/])/i.test(s)) s = removeRawElements(s, ['pre', 'code'], '\n');
  return decodeEntities(s.replace(ANY_TAG_RE_G, '\n'));
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

// Second-level labels under which a country code needs three labels (bbc.co.uk, abc.net.au, gov.uk...).
const SECOND_LEVEL_LABELS = ['co', 'com', 'org', 'net', 'gov', 'ac', 'edu', 'gob', 'go', 'or', 'ne', 'nic', 'mil', 'ltd', 'plc', 'sch', 'nhs', 'police'];

/** Approximate registrable domain ("www.bbc.co.uk" -> "bbc.co.uk", "en.example.com" -> "example.com"). */
function registrableHost(host) {
  host = normalizeHost(host);
  if (!host || host.charAt(0) === '[' || /^[\d.]+$/.test(host)) return host;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  if (tld.length === 2 && SECOND_LEVEL_LABELS.indexOf(sld) >= 0) return labels.slice(-3).join('.');
  return labels.slice(-2).join('.');
}

/**
 * Own-site domains guessed from the original when options.siteDomains is empty: the hosts that serve its
 * /wp-content/uploads/ files (images, links to media), as registrable domains. Jetpack CDN (i0.wp.com/site/...) unwrapped.
 */
function inferSiteDomains(originalHtml) {
  const out = [];
  const re = /(?:https?:)?\/\/([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?\/((?:[a-z0-9.-]+\.[a-z]{2,}\/)?)wp-content\/uploads\//gi;
  const s = toStr(originalHtml);
  let m;
  let guard = 0;
  while ((m = re.exec(s)) && guard++ < 5000) {
    let host = m[1].toLowerCase();
    if (/^i\d\.wp\.com$/.test(host) && m[2]) host = m[2].slice(0, -1).toLowerCase();
    const r = registrableHost(host);
    if (r && out.indexOf(r) < 0) out.push(r);
  }
  return out;
}

/** Fills opts.siteDomains from the original when it is empty (sets opts.siteDomainsInferred). */
function resolveSiteDomains(opts, originalHtml) {
  if (!opts.siteDomains.length) {
    const inferred = inferSiteDomains(originalHtml);
    if (inferred.length) {
      opts.siteDomains = inferred;
      opts.siteDomainsInferred = true;
    }
  }
  return opts;
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
  // Browser mode knows only whether the prompt allowed web search: false = no research (same as 0 searches,
  // and it wins over a search count); true = unknown / some research (the search count, if any, is kept).
  if (o.webSearchAllowed === false || (typeof o.webSearchAllowed === 'string' && /^\s*(no|false|off|0)\s*$/i.test(o.webSearchAllowed))) wsc = 0;
  let allowNewFaq = true;
  if (o.allowNewFaq === false || (typeof o.allowNewFaq === 'string' && /^\s*(no|false|off|0)\s*$/i.test(o.allowNewFaq))) allowNewFaq = false;
  let lastCheckedLine = 'auto';
  if (o.lastCheckedLine === false || (typeof o.lastCheckedLine === 'string' && /^\s*(no|false|off|0)\s*$/i.test(o.lastCheckedLine))) lastCheckedLine = 'no';
  else if (o.lastCheckedLine === true || (typeof o.lastCheckedLine === 'string' && /^\s*(yes|true|on|1)\s*$/i.test(o.lastCheckedLine))) lastCheckedLine = 'yes';
  const todayM = typeof o.today === 'string' ? /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/.exec(o.today) : null;
  const num = function (v, d) { return typeof v === 'number' && isFinite(v) ? v : d; };
  return {
    siteDomains: siteDomains,
    siteDomainsInferred: false,
    webSearchCount: wsc,
    allowNewFaq: allowNewFaq,
    lastCheckedLine: lastCheckedLine,
    today: todayM ? todayM[1] + '-' + todayM[2] + '-' + todayM[3] : '',
    minWordRatio: num(o.minWordRatio, 0.8),
    maxWordRatio: num(o.maxWordRatio, 5),
    minRetention: num(o.minRetention, 0.75),
    forbiddenLinkDomains: uniq(forbidden.map(normalizeHost).filter(Boolean)),
    checkLinks: o.checkLinks !== false,
    fetchFn: typeof o.fetchFn === 'function' ? o.fetchFn : undefined,
    linkTimeoutMs: num(o.linkTimeoutMs, 10000),
    linkConcurrency: num(o.linkConcurrency, 4),
    verifiedUrls: uniq(toList(o.verifiedUrls).map(function (u) { return decodeEntities(u).trim(); }).filter(Boolean)),
    meta: o.meta && typeof o.meta === 'object' ? o.meta : null,
    deadUrls: Array.isArray(o.deadUrls) ? o.deadUrls : [],
    postTitle: typeof o.postTitle === 'string' ? o.postTitle : '',
    endMarker: typeof o.endMarker === 'string' ? o.endMarker.trim() : '',
    requireEndMarker: o.requireEndMarker === true
  };
}

function isBareHomepage(p) {
  return (p.path === '' || p.path === '/') && !p.query;
}

/**
 * url -> removal reason. Entries: a string (dead), { url, verdict: 'dead' }, or { url, reason } with reason
 * 'dead' | 'redirect' | 'unverified'. Objects with another verdict (e.g. a checkLinks 'ok'/'unknown' result) are ignored.
 */
function normalizeDeadList(deadUrls) {
  const s = new Map();
  for (const d of (Array.isArray(deadUrls) ? deadUrls : [])) {
    let u = d;
    let reason = 'dead';
    if (d && typeof d === 'object') {
      if (d.reason) reason = toStr(d.reason);
      else if (d.verdict && d.verdict !== 'dead') continue;
      u = d.url;
    }
    u = decodeEntities(toStr(u)).trim();
    if (u && !s.has(u)) s.set(u, reason);
  }
  return s;
}

/**
 * Decides what to do with a NEW link (href not in the original). Returns null (keep) or a reason string.
 * Reasons: fragment, javascript, not_web_link, relative, bad_scheme, invalid_url, internal, forbidden_domain,
 * redirect, dead, unverified, deep_link_without_research.
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
  if (hostMatches(p.host, REDIRECT_LINK_DOMAINS) || SEARCH_REDIRECT_RE.test(h)) return 'redirect';
  if (deadSet && deadSet.has(h)) return typeof deadSet.get === 'function' ? (deadSet.get(h) || 'dead') : 'dead';
  if (opts.webSearchCount === 0 && !isBareHomepage(p)) return 'deep_link_without_research';
  return null;
}

/** Removes tracking parameters (utm_*, gclid, fbclid, srsltid...) from a URL; returns it unchanged when there are none. */
function stripTrackingParamsFromUrl(url) {
  const q = url.indexOf('?');
  if (q < 0) return url;
  const hashAt = url.indexOf('#', q);
  const base = url.slice(0, q);
  const query = url.slice(q + 1, hashAt < 0 ? url.length : hashAt);
  const hash = hashAt < 0 ? '' : url.slice(hashAt);
  const parts = query.split('&');
  const kept = parts.filter(function (part) {
    let name = part.split('=')[0];
    try { name = decodeURIComponent(name); } catch (e) { /* keep raw */ }
    return part !== '' && !TRACKING_PARAM_RE.test(name.trim());
  });
  if (kept.length === parts.filter(function (x) { return x !== ''; }).length) return url;
  return base + (kept.length ? '?' + kept.join('&') : '') + hash;
}

function escapeAttr(s) {
  return toStr(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Rewrites the href of every NEW <a> (not in the original, outside scripts/styles/comments) without tracking parameters.
 * Returns { html, changed: [{ from, to }] }.
 */
function stripTrackingParams(originalHtml, editedHtml, origHrefs) {
  let html = toStr(editedHtml);
  const changed = [];
  if (!/[?&](?:amp;)?(?:utm_|srsltid|gclid|gclsrc|dclid|fbclid|msclkid|mc_[ce]id|_ga|_gl|yclid|gad_source|igshid)/i.test(html)) {
    return { html: html, changed: changed };
  }
  origHrefs = origHrefs || hrefSet(originalHtml);
  const prot = protectedRanges(html);
  const re = new RegExp('<a(?=[\\s>/])(' + ATTRS_SRC + ')>', 'gi');
  let out = '';
  let pos = 0;
  let m;
  while ((m = re.exec(html))) {
    if (inRanges(prot, m.index)) continue;
    const attrs = parseAttrs(m[1]);
    if (!Object.prototype.hasOwnProperty.call(attrs, 'href')) continue;
    const href = attrs.href.trim();
    if (origHrefs.has(href)) continue;
    const clean = stripTrackingParamsFromUrl(href);
    if (clean === href) continue;
    const newTag = m[0].replace(/(\shref\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s"'<>`]+)/i, function (all, pre) { return pre + '"' + escapeAttr(clean) + '"'; });
    out += html.slice(pos, m.index) + newTag;
    pos = m.index + m[0].length;
    changed.push({ from: href, to: clean });
  }
  if (!changed.length) return { html: html, changed: changed };
  return { html: out + html.slice(pos), changed: changed };
}

/** Set of decoded href values of <a>/<area> tags (scripts and comments ignored). */
function hrefSet(html, isMarkup) {
  const set = new Set();
  forEachTag(isMarkup ? toStr(html) : markupOf(html), function (t) {
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
  const res = { ok: false, status: null, html: '', meta: null, errors: [], warnings: [] };
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
    // META is only logged (apart from web_research_used). A formatting slip such as an unescaped 17" must not
    // throw away a good article: when the status can still be read, continue with defaults and the stricter
    // web_research_used = false.
    const sm = /"status"\s*:\s*"\s*(edited|skipped)\s*"/i.exec(metaText);
    if (!sm || Array.isArray(meta)) {
      err('PARSE_META_JSON', 'META section is not a valid JSON object.');
      res.html = html;
      return res;
    }
    meta = { status: sm[1].toLowerCase(), web_research_used: false };
    res.warnings.push({ code: 'META_JSON_INVALID', message: 'META is not valid JSON; only its status ("' + meta.status + '") was used, and web_research_used is treated as false.' });
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
  const orig = hrefSet(normalizeNewlines(originalHtml));
  return uniq(hrefList(normalizeNewlines(editedHtml)).filter(function (h) { return !orig.has(h); }));
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

  // Accepts fetch-style { status }, n8n/request-style { statusCode } and string statuses.
  function statusOf(r) {
    if (!r || typeof r !== 'object') return null;
    const v = typeof r.status === 'number' ? r.status : (typeof r.statusCode === 'number' ? r.statusCode :
      (/^\d{3}$/.test(toStr(r.status)) ? Number(r.status) : (/^\d{3}$/.test(toStr(r.statusCode)) ? Number(r.statusCode) : null)));
    return v;
  }
  // HTTP status carried by a thrown error (axios: e.response.status, n8n: e.httpCode / e.statusCode).
  function errorStatus(e) {
    if (!e || typeof e !== 'object') return null;
    const s = (e.response && (e.response.status || e.response.statusCode)) || e.statusCode || e.httpCode || e.status;
    return /^\d{3}$/.test(toStr(s)) ? Number(s) : null;
  }
  // A 2xx/3xx answer that is really a failure: a deep URL redirected to the homepage (soft 404),
  // or a redirect to a domain-parking host.
  function softFailure(url, finalUrl) {
    if (!finalUrl || typeof finalUrl !== 'string') return '';
    const a = parseUrl(url);
    const b = parseUrl(finalUrl);
    if (!a || !b) return '';
    if (b.host !== a.host && hostMatches(b.host, PARKING_HOSTS)) return 'redirected to a domain-parking page (' + b.host + ')';
    const deep = a.path !== '' && a.path !== '/';
    if (deep && (b.path === '' || b.path === '/') && registrableHost(a.host) === registrableHost(b.host)) {
      return 'soft 404: redirected to the homepage';
    }
    return '';
  }
  function finishOk(result) {
    const soft = softFailure(result.url, result.finalUrl);
    if (soft) { result.verdict = 'dead'; result.error = soft; }
    return result;
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
      headStatus = statusOf(r);
      if (r && typeof r.url === 'string' && r.url) result.finalUrl = r.url;
    } catch (e) {
      headError = e;
      headStatus = errorStatus(e);
      if (headStatus !== null) headError = null;
    }
    if (headError) {
      const c = classifyFetchError(headError);
      if (c.error === 'timeout') { result.verdict = 'unknown'; result.error = 'timeout'; return result; }
    } else if (headStatus !== null && headStatus >= 200 && headStatus < 400) {
      result.status = headStatus;
      result.verdict = 'ok';
      result.method = 'HEAD';
      return finishOk(result);
    }
    // Fallback: GET (for 403/405/501, other errors, and network errors).
    try {
      const r = await request(url, 'GET');
      const st = statusOf(r);
      result.status = st;
      result.method = 'GET';
      if (r && typeof r.url === 'string' && r.url) result.finalUrl = r.url;
      result.verdict = st === null ? 'unknown' : classifyStatus(st);
      if (result.verdict !== 'ok') result.error = 'HTTP ' + st + (headStatus !== null ? ' (HEAD ' + headStatus + ')' : '');
      else finishOk(result);
    } catch (e) {
      const es = errorStatus(e);
      result.method = 'GET';
      if (es !== null) {
        result.status = es;
        result.verdict = classifyStatus(es);
        result.error = result.verdict === 'ok' ? '' : 'HTTP ' + es + (headStatus !== null ? ' (HEAD ' + headStatus + ')' : '');
      } else {
        const c = classifyFetchError(e);
        result.status = headStatus;
        result.verdict = c.verdict;
        result.error = c.error;
      }
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
  const noEnd = {};
  let tried = 0;
  for (const h of heads) {
    if (!isSourcesHeadingText(visibleText(h.inner))) continue;
    if (++tried > 10) break; // a real article has one Sources list; bound the work on broken input
    const leadRe = /(?:\s|<!--[\s\S]*?-->)*/y;
    leadRe.lastIndex = h.end;
    const lead = leadRe.exec(html);
    const listStart = h.end + (lead ? lead[0].length : 0);
    const lm = /^<(ol|ul)(?=[\s>])/i.exec(html.slice(listStart, listStart + 8));
    if (!lm) continue;
    const listTag = lm[1].toLowerCase();
    if (noEnd[listTag]) continue;
    const listEnd = elementEnd(html, listStart, listTag);
    if (listEnd < 0) { noEnd[listTag] = true; continue; }
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
  originalHtml = normalizeNewlines(originalHtml);
  resolveSiteDomains(opts, originalHtml);
  const origHrefs = hrefSet(originalHtml);
  const deadSet = normalizeDeadList(deadUrls === undefined ? opts.deadUrls : deadUrls);
  const removed = [];
  const seenRemoved = new Set();
  const record = function (url, reason, where) {
    const k = url + '\u0000' + reason + '\u0000' + (where || '');
    if (seenRemoved.has(k)) return;
    seenRemoved.add(k);
    removed.push(where ? { url: url, reason: reason, where: where } : { url: url, reason: reason });
  };
  const decide = function (href) {
    const h = decodeEntities(toStr(href)).trim();
    if (origHrefs.has(h)) return null;
    return decideNewLink(h, opts, deadSet);
  };
  // 0) Tracking parameters (utm_source=openai, gclid, ...) are removed from new links.
  const tracked = stripTrackingParams(originalHtml, normalizeNewlines(editedHtml), origHrefs);
  let html = tracked.html;
  // Anchors inside scripts (document.write widgets, JSON-LD text), <style> and comments are never touched.
  let prot = protectedRanges(html);

  // 1) Sources lists: drop whole items whose only link(s) get removed; drop an emptied section.
  const sections = findSourcesSections(html).filter(function (sec) { return !inRanges(prot, sec.headingStart); });
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
  if (sections.length) prot = protectedRanges(html);
  const anchors = scanElements(html, ['a'], true);
  if (anchors.length) {
    let out = '';
    let pos = 0;
    for (const a of anchors) {
      if (inRanges(prot, a.start)) continue;
      const attrs = parseAttrs(a.attrStr);
      if (!Object.prototype.hasOwnProperty.call(attrs, 'href')) continue;
      let reason = decide(attrs.href);
      if (!reason && !origHrefs.has(attrs.href.trim()) && /<img(?=[\s>\/])/i.test(a.inner)) reason = 'image_link';
      if (!reason) continue;
      record(attrs.href.trim(), reason);
      out += html.slice(pos, a.start) + a.inner;
      pos = a.end;
    }
    html = out + html.slice(pos);
  }
  return { html: html, removed: removed, changed: tracked.changed };
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
  const imgAnchors = [];
  const ids = [];
  const anchors = [];
  const media = {};
  for (const t of MEDIA_COMPARE_TAGS) media[t] = [];
  const boxes = {};
  for (const b of BOX_TYPES) boxes[b.key] = 0;
  const boxRes = BOX_TYPES.map(function (b) { return new RegExp('background(?:-color)?\\s*:\\s*#' + b.color + '(?![0-9a-f])', 'i'); });
  let eventAttrs = 0;
  let lastHeadingId = '';
  forEachTag(A.markup, function (t) {
    if (t.closing) { close[t.name] = (close[t.name] || 0) + 1; return; }
    open[t.name] = (open[t.name] || 0) + 1;
    const isMedia = Object.prototype.hasOwnProperty.call(media, t.name);
    if (t.attrStr.indexOf('=') < 0 && t.name !== 'img' && !isMedia) return;
    const attrs = parseAttrs(t.attrStr);
    if (t.name === 'img') { imgs.push(attrs); imgAnchors.push(lastHeadingId); }
    if (isMedia) media[t.name].push(attrs);
    if (/^h[1-6]$/.test(t.name) && attrs.id) lastHeadingId = attrs.id;
    if (t.name === 'a' && Object.prototype.hasOwnProperty.call(attrs, 'href')) {
      anchors.push({ href: attrs.href.trim(), rel: toStr(attrs.rel).toLowerCase().split(/\s+/).filter(Boolean) });
    }
    if (Object.prototype.hasOwnProperty.call(attrs, 'id') && attrs.id !== '') ids.push(attrs.id);
    for (const k of Object.keys(attrs)) if (/^on[a-z]+$/.test(k)) eventAttrs++;
    if (attrs.style) {
      for (let i = 0; i < BOX_TYPES.length; i++) if (boxRes[i].test(attrs.style)) boxes[BOX_TYPES[i].key]++;
    }
  });
  // <style> elements are stripped from the markup view, so count them separately (outside scripts).
  open.style = countMatches(stripComments(removeRawElements(html, ['script'], ' ')), /<style(?=[\s>\/])/gi);
  A.open = open;
  A.close = close;
  A.imgs = imgs;
  A.imgAnchors = imgAnchors;
  // Every <img opener, even one whose attributes are broken (unclosed quote) and so not parsed as a tag.
  A.rawImgCount = countMatches(A.markup, /<img(?=[\s\/>])/gi);
  A.media = media;
  A.anchors = anchors;
  A.ids = ids;
  A.boxes = boxes;
  A.eventAttrs = eventAttrs;
  A.hrefs = hrefSet(A.markup, true);
  A.text = visibleText(A.markup, { isMarkup: true });
  A.wordList = A.text.replace(SHORTCODE_RE_G, ' ').toLowerCase()
    .match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]|[\p{L}\p{N}][\p{L}\p{N}\p{M}'\u2019_.-]*/gu) || [];
  A.words = A.wordList.length;
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
  // Script openers that are not complete JSON-LD blocks (catches unclosed <script src=...> too).
  A.nonJsonLdScriptOpeners = countMatches(stripComments(html), /<script(?=[\s>\/])/gi) - A.jsonld.length;
  A.badComments = countBadComments(html);
  A.plainComments = plainComments(html);
  const scRe = new RegExp(SHORTCODE_SRC, 'gi');
  A.shortcodes = A.markup.match(scRe) || [];
  A.embedUrls = embedUrlLines(A.markup);
  return A;
}

/** Counts "<!--" that never close, or whose comment body contains another "<!--" (a stray or nested opener). */
function countBadComments(html) {
  html = removeRawElements(toStr(html), ['script', 'style'], ' ');
  let bad = 0;
  let pos = 0;
  for (;;) {
    const s = html.indexOf('<!--', pos);
    if (s < 0) break;
    const e = html.indexOf('-->', s + 4);
    if (e < 0) { bad++; break; }
    const inner = html.indexOf('<!--', s + 4);
    if (inner >= 0 && inner < e) bad++;
    pos = e + 3;
  }
  return bad;
}

/** Bodies (whitespace-collapsed) of well-formed comments that are not block delimiters or more/nextpage/noteaser. */
function plainComments(html) {
  html = removeRawElements(toStr(html), ['script', 'style'], ' ');
  const out = [];
  for (const r of commentRanges(html)) {
    const body = html.slice(r[0] + 4, r[1] - 3).replace(/\s+/g, ' ').trim();
    if (/^\/?wp:/.test(body) || /^(?:more\b|nextpage$|noteaser$)/i.test(body)) continue;
    out.push(body);
  }
  return out;
}

/** URLs that stand alone on a line (optionally in <p>/<div>/<figure>): classic oEmbed lines and wp:embed wrapper text. */
function embedUrlLines(markup) {
  const out = [];
  if (markup.indexOf('http') < 0) return out;
  for (const line of markup.split('\n')) {
    if (line.length > 2100 || line.indexOf('http') < 0) continue;
    const t = decodeEntities(line.replace(/<\/?(?:p|div|figure|span|center)(?=[\s>\/])[^<>]*>/gi, '')).trim();
    if (/^https?:\/\/[^\s<>"']+$/i.test(t)) out.push(t);
  }
  return out;
}

const BLOCK_CONTAINER_SET = {};
for (const t of BLOCK_CONTAINER_TAGS) BLOCK_CONTAINER_SET[t] = true;
const P_CLOSING_SET = {};
for (const t of P_CLOSING_TAGS) P_CLOSING_SET[t] = true;

/**
 * Visible text that sits outside every block-level element ("bare" top-level text), split into wpautop-style
 * paragraphs (blank lines). In block-editor content this is text between blocks; in classic content it is
 * text written without <p>. `markup` is the comment/script-free view.
 */
function bareTextSegments(markup) {
  const segs = [];
  const re = new RegExp(TAG_SRC, 'g');
  const stack = [];
  const count = {};
  let last = 0;
  let m;
  while ((m = re.exec(markup))) {
    const name = m[2].toLowerCase();
    if (BLOCK_CONTAINER_SET[name] !== true) continue;
    if (!stack.length && m.index > last) segs.push(markup.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] === '/') {
      if (count[name]) {
        const i = stack.lastIndexOf(name);
        for (let k = i; k < stack.length; k++) count[stack[k]]--;
        stack.length = i;
      }
    } else if (!/\/\s*$/.test(m[3])) {
      if (count.p && stack[stack.length - 1] === 'p' && P_CLOSING_SET[name]) { stack.pop(); count.p--; }
      stack.push(name);
      count[name] = (count[name] || 0) + 1;
    }
  }
  if (!stack.length && markup.length > last) segs.push(markup.slice(last));
  const out = [];
  for (const seg of segs) {
    if (!/\S/.test(seg)) continue;
    for (const chunk of seg.split(/\n[ \t\u00a0]*\n/)) {
      const t = visibleText(chunk, { isMarkup: true, stripShortcodes: true });
      if (t) out.push(t);
    }
  }
  return out;
}

function hasFaq(A) {
  if (A.jsonld.some(function (j) { return j.hasFaq; })) return true;
  if (A.allHeadings.some(function (h) { return FAQ_HEADING_RE.test(h.text); })) return true;
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
  const noCloser = new Set();
  const noEnd = new Set();
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
      if (bm && !/\/\s*-->$/.test(raw) && !noCloser.has(bm[1])) {
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
        if (closeEnd < 0) noCloser.add(bm[1]);
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
    if (head.charAt(0) === '<' && head.charAt(1) === '/') {
      const gt = html.indexOf('>', pos);
      if (gt < 0) return { kind: 'empty' };
      pos = gt + 1;
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
      let end = noEnd.has(tag) ? -1 : elementEnd(html, pos, tag);
      if (end < 0) { noEnd.add(tag); end = Math.min(n, pos + 2000); }
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
      if (INLINE_TAGS.indexOf(tag) >= 0 && text) {
        // An inline wrapper with text at the very top (Google-Docs <span style="font-weight: 400;">, <strong>Brand</strong> ...)
        // is intro text, like a bare text node: the editor may rewrite it.
        const lt2 = html.indexOf('<', end);
        const seg2 = html.slice(pos, lt2 < 0 ? n : lt2);
        const firstLine2 = visibleText(seg2.split(/\n/)[0] || '');
        return { kind: 'text', tag: tag, raw: short(el, 160), text: visibleText(seg2), firstLine: firstLine2 || text };
      }
      const ot = new RegExp(TAG_SRC, 'y');
      ot.lastIndex = pos;
      const openTag = ot.exec(html);
      const style = openTag ? parseAttrs(openTag[3]).style : '';
      const isBox = !!(style && /background(?:-color)?\s*:\s*#(eef3fe|fdf8e3|f5f7fa|fdeced|eafaf1|eef3f7)/i.test(style));
      if (!isBox && openTag && /^(div|section|article|main|center)$/.test(tag)) {
        // Plain wrapper (e.g. a Group block): look at what it starts with.
        pos = pos + openTag[0].length;
        continue;
      }
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
    // firstLine: wpautop turns a single newline into <br> and a blank line into a new paragraph, so a bare
    // title line above the intro is only the first line of this text.
    return { kind: 'text', raw: short(seg, 120), text: visibleText(seg), firstLine: visibleText(seg.split(/\n/)[0] || '') };
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

/** "Last checked" LINES (followed by a date), not "since you last checked your tyres". */
function lastCheckedSnippets(text) {
  const out = [];
  const re = /last checked\s*(?::|on\b|-|\u2013)?\s*(?=\d|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b)[^.!?]{0,60}/gi;
  let m;
  while ((m = re.exec(text))) out.push(normalizeForMatch(m[0]));
  return out;
}

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}]/u;

/* ------------------------------------------------------------------ */
/* Helpers used by validateArticle                                      */
/* ------------------------------------------------------------------ */

const CUR_SYM_SRC = '[$\\u20ac\\u00a3\\u00a5\\u20b9\\u09f3\\u20a9\\u20bd\\u20ba]';
const NUM_SRC = '\\d(?:[\\d,.]*\\d)?';
const RANGE_SRC = '\\s*(?:-|\\u2013|\\u2014|to|bis|a|\\u00e0)\\s*';
// Currency words ("pounds" is left out on purpose: it is also a weight unit).
const CUR_WORD_SRC = '(?:(?:us\\s?|u\\.s\\.\\s?)?dollars?|usd|euros?|eur|gbp|aud|cad|nzd|sek|nok|dkk|chf|pln|z\\u0142|kr|inr|rupees?|bdt|taka|yen|jpy)';
const FIG_CUR_PRE_RE = new RegExp('(' + CUR_SYM_SRC + ')\\s?(' + NUM_SRC + ')(?:' + RANGE_SRC + CUR_SYM_SRC + '?\\s?(' + NUM_SRC + '))?', 'g');
const FIG_CUR_SUF_RE = new RegExp('(' + NUM_SRC + ')(?:' + RANGE_SRC + '(' + NUM_SRC + '))?\\s?(' + CUR_SYM_SRC + '|' + CUR_WORD_SRC + '(?![\\p{L}]))', 'giu');
const FIG_PCT_RE = new RegExp('(' + NUM_SRC + ')(?:' + RANGE_SRC + '(' + NUM_SRC + '))?\\s?(?:%|percent(?![\\p{L}])|per cent(?![\\p{L}])|prozent(?![\\p{L}])|por ciento(?![\\p{L}])|pour cent(?![\\p{L}]))', 'giu');
const FIG_YEAR_RE = /(?<!\d)(?:19|20)\d\d(?!\d)/g;
const FIG_NUM_RE = new RegExp(NUM_SRC, 'g');

function normFigure(n) {
  return toStr(n).replace(/[,\s\u00a0\u202f']/g, '').replace(/\.+$/, '').replace(/\.0{1,2}$/, '');
}

/**
 * Figures a no-research edit must neither invent nor drop: currency amounts, percentages and years.
 * Returns { tokens: Map(display -> numeric value), numbers: Set(every number in the text) }.
 */
function figureInfo(text) {
  const t = toStr(text);
  const tokens = new Map();
  const numbers = new Set();
  let m;
  const add = function (display, value) { if (value && !tokens.has(display)) tokens.set(display, value); };
  FIG_CUR_PRE_RE.lastIndex = 0;
  while ((m = FIG_CUR_PRE_RE.exec(t))) {
    add(m[1] + normFigure(m[2]), normFigure(m[2]));
    if (m[3]) add(m[1] + normFigure(m[3]), normFigure(m[3]));
  }
  FIG_CUR_SUF_RE.lastIndex = 0;
  while ((m = FIG_CUR_SUF_RE.exec(t))) {
    const cur = m[3].toLowerCase();
    add(normFigure(m[1]) + ' ' + cur, normFigure(m[1]));
    if (m[2]) add(normFigure(m[2]) + ' ' + cur, normFigure(m[2]));
  }
  FIG_PCT_RE.lastIndex = 0;
  while ((m = FIG_PCT_RE.exec(t))) {
    add(normFigure(m[1]) + '%', normFigure(m[1]));
    if (m[2]) add(normFigure(m[2]) + '%', normFigure(m[2]));
  }
  FIG_YEAR_RE.lastIndex = 0;
  while ((m = FIG_YEAR_RE.exec(t))) add(m[0], m[0]);
  FIG_NUM_RE.lastIndex = 0;
  while ((m = FIG_NUM_RE.exec(t))) numbers.add(normFigure(m[0]));
  return { tokens: tokens, numbers: numbers };
}

/** Share of the original's words (multiset) that are still present in the edit. */
function wordRetention(O, E) {
  if (!O.wordList.length) return 1;
  const cE = new Map();
  for (const w of E.wordList) cE.set(w, (cE.get(w) || 0) + 1);
  const cO = new Map();
  for (const w of O.wordList) cO.set(w, (cO.get(w) || 0) + 1);
  let hit = 0;
  for (const entry of cO) hit += Math.min(entry[1], cE.get(entry[0]) || 0);
  return hit / O.wordList.length;
}

/** Heading/list blocks whose comment does not match the tag (wp:heading level vs <hN>, wp:list ordered vs <ol>). */
function blockMarkupMismatches(A) {
  const out = [];
  for (const t of A.tokens) {
    if (t.closing || t.selfClosing || (t.name !== 'heading' && t.name !== 'list')) continue;
    const jm = /^<!--\s*wp:[a-z0-9_\/-]+\s*([\s\S]*?)\s*-->$/.exec(t.raw);
    let attrs = {};
    if (jm && jm[1] && jm[1].charAt(0) === '{') {
      try { attrs = JSON.parse(jm[1]); } catch (e) { continue; }
    }
    if (!attrs || typeof attrs !== 'object') attrs = {};
    const after = A.raw.slice(t.end, t.end + 400);
    if (t.name === 'heading') {
      const hm = /^\s*<h([1-6])(?=[\s>\/])/i.exec(after);
      if (!hm) continue;
      const want = typeof attrs.level === 'number' ? attrs.level : 2;
      if (Number(hm[1]) !== want) out.push(short(t.raw, 60) + ' wraps <h' + hm[1] + '>');
    } else {
      const lm = /^\s*<(ul|ol)(?=[\s>\/])/i.exec(after);
      if (!lm) continue;
      const isOl = lm[1].toLowerCase() === 'ol';
      if (isOl !== (attrs.ordered === true)) out.push(short(t.raw, 60) + ' wraps <' + lm[1].toLowerCase() + '>');
    }
  }
  return out;
}

/** String values of a JSON-LD object that are empty or hold a placeholder. */
function jsonLdPlaceholders(data) {
  const bad = [];
  let seen = 0;
  const visit = function (v, depth) {
    if (depth > 12 || ++seen > 20000 || bad.length > 5) return;
    if (typeof v === 'string') {
      if (!v.trim()) bad.push('(empty text)');
      else if (JSONLD_PLACEHOLDER_RE.test(v)) bad.push(v);
    } else if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
    } else if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) visit(v[k], depth + 1);
    }
  };
  visit(data, 0);
  return bad;
}

/** Headings that may keep a skipped level: the first heading, the first after a title H1, and jump targets. */
function headingJumpKeys(headings) {
  const keys = new Set();
  const key = function (h) { return h.level + '|' + normalizeForMatch(h.text); };
  let prev = 0;
  let seenNonTitle = false;
  for (const h of headings) {
    if (h.level === 1) { prev = 1; continue; }
    if (!seenNonTitle && h.level !== 2) keys.add(key(h));
    seenNonTitle = true;
    if (prev && h.level > prev + 1) keys.add(key(h));
    prev = h.level;
  }
  return keys;
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** Patterns for today's date in common written forms (numeric forms work in any language). */
function todayDatePatterns(today) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(toStr(today));
  if (!m) return [];
  const y = m[1];
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const mm = (mo < 10 ? '0?' : '') + mo;
  const dd = (d < 10 ? '0?' : '') + d;
  const name = MONTH_NAMES[mo - 1] || 'x';
  const mon = '(?:' + name + '|' + name.slice(0, 3) + '\\.?)';
  return [
    new RegExp('\\b' + y + '-' + m[2] + '-' + m[3] + '\\b', 'g'),
    new RegExp('\\b' + dd + '[./-]\\s?' + mm + '[./-]\\s?' + y + '\\b', 'g'),
    new RegExp('\\b' + mm + '/' + dd + '/' + y + '\\b', 'g'),
    new RegExp('\\b' + mon + '\\s+' + d + '(?:st|nd|rd|th)?,?\\s+' + y + '\\b', 'gi'),
    new RegExp('\\b' + d + '(?:st|nd|rd|th)?\\.?\\s+(?:of\\s+)?' + mon + ',?\\s+' + y + '\\b', 'gi')
  ];
}

const BLOCK_BREAK_RE_G = new RegExp('<\\/?(?:' + BLOCK_CONTAINER_TAGS.join('|') + '|hr)(?=[\\s>/])' + ATTRS_SRC + '>', 'gi');
const CHATTER_END_RE = /(?:(?:^|[.!?]\s+)i(?:'ve|\u2019ve| have)?\s+(?:kept|made|added|removed|changed|edited|updated|revised|rewrote|rewritten|improved|preserved)\s+(?:all|every|the|your|some|a few|several|these|those|it|this)\b[^.!?]{0,40}?\b(?:images?|links?|article|content|text|headings?|structure|changes|edits|html|markup|shortcodes?|blocks?|formatting|sections?)\b[^.!?]{0,120}|\bhope this helps)[.!?]?\s*$/i;

/**
 * Paragraph-like text chunks: text between block-level tags, also split on blank lines (wpautop).
 * Cached on the analysis object; chunks over 20000 characters are skipped (not a paragraph).
 */
function textChunks(A) {
  if (A.chunks) return A.chunks;
  A.chunks = A.markup.replace(BLOCK_BREAK_RE_G, '\n\n').split(/\n[ \t\u00a0]*\n/)
    .filter(function (c) { return c.length <= 20000 && /\S/.test(c); })
    .map(function (c) { return visibleText(c, { isMarkup: true }); })
    .filter(Boolean);
  return A.chunks;
}

function isFaqHeading(h) {
  return FAQ_HEADING_RE.test(h.text) && !/\?\s*$/.test(h.text);
}

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

  // CRLF (Windows) originals compare equal to the model's LF output.
  let originalN = normalizeNewlines(originalHtml);
  let editedN = normalizeNewlines(editedHtml);
  // Browser mode: the prompt ends the article with <!-- APU-END -->. A reply without it was cut off (truncated).
  // The markers themselves are not part of the article and are compared (and saved) without them.
  const endMarker = opts.endMarker || (opts.requireEndMarker ? DEFAULT_END_MARKER : '');
  if (endMarker) {
    if (opts.requireEndMarker && !hasEndMarker(editedN, endMarker)) {
      error('END_MARKER_MISSING', 'The end marker <!-- ' + endMarker + ' --> is missing: the AI reply was probably cut off (truncated).');
    }
    originalN = stripEndMarkers(originalN, endMarker);
    editedN = stripEndMarkers(editedN, endMarker);
  }
  resolveSiteDomains(opts, originalN);
  if (opts.siteDomainsInferred) {
    warn('SITE_DOMAINS_INFERRED', 'No site domain given; using ' + opts.siteDomains.join(', ') + ' (from the original\'s upload URLs).');
  }
  const O = analyze(originalN);
  const E = analyze(editedN);
  const edited = E.raw;
  const origIdSet = new Set(O.ids);

  // --- Images -----------------------------------------------------------
  if (O.imgs.length !== E.imgs.length) {
    error('IMG_COUNT', 'Image count changed: original ' + O.imgs.length + ', edited ' + E.imgs.length + '.');
  } else if (O.rawImgCount !== E.rawImgCount) {
    error('IMG_COUNT', '<img> tag count changed (including broken tags): original ' + O.rawImgCount + ', edited ' + E.rawImgCount + '.');
  }
  const nImg = Math.min(O.imgs.length, E.imgs.length);
  const idsE = new Set(E.ids);
  for (let i = 0; i < nImg; i++) {
    const a = O.imgs[i];
    const b = E.imgs[i];
    const keys = uniq(Object.keys(a).concat(Object.keys(b))).filter(function (k) { return k !== 'alt'; });
    const diff = keys.filter(function (k) { return a[k] !== b[k]; });
    if (diff.length) {
      error('IMG_CHANGED', 'Image #' + (i + 1) + ' (' + short(a.src || b.src || '', 80) + ') changed attribute(s): ' + diff.join(', ') + '.');
    }
    if (O.imgs.length === E.imgs.length) {
      // Moved to another section: the nearest heading id above it is now a different original heading.
      const ha = O.imgAnchors[i];
      const hb = E.imgAnchors[i];
      if (ha !== hb && (hb === '' ? idsE.has(ha) : origIdSet.has(hb))) {
        error('IMG_CHANGED', 'Image #' + (i + 1) + ' (' + short(a.src || '', 60) + ') moved to another section (' +
          (ha ? 'was under #' + ha : 'was above the first heading') + ', now ' + (hb ? 'under #' + hb : 'above #' + ha) + ').');
      }
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
  for (const t of MEDIA_COMPARE_TAGS) {
    const la = O.media[t];
    const lb = E.media[t];
    const n = Math.min(la.length, lb.length);
    for (let i = 0; i < n; i++) {
      const keys = uniq(Object.keys(la[i]).concat(Object.keys(lb[i])));
      const diff = keys.filter(function (k) { return la[i][k] !== lb[i][k]; });
      if (diff.length) error('MEDIA_CHANGED', '<' + t + '> #' + (i + 1) + ' changed attribute(s): ' + diff.join(', ') + '.');
    }
  }
  const euE = multiset(E.embedUrls);
  for (const entry of multiset(O.embedUrls)) {
    if ((euE.get(entry[0]) || 0) < entry[1]) error('EMBED_URL_MISSING', 'Embed URL line (video/post embed) missing, moved into text or linked: ' + short(entry[0], 100));
  }

  // --- Tables and lists (product/affiliate tables, step lists) ------------------------------------
  const tablesO = O.open.table || 0;
  const tablesE = E.open.table || 0;
  const rowsO = O.open.tr || 0;
  const rowsE = E.open.tr || 0;
  if (tablesE < tablesO || rowsE < rowsO) {
    error('TABLE_LOSS', 'Table content lost: original ' + tablesO + ' table(s) with ' + rowsO + ' row(s), edited ' +
      tablesE + ' table(s) with ' + rowsE + ' row(s).');
  }
  const itemsO = O.open.li || 0;
  const itemsE = E.open.li || 0;
  if (itemsO && itemsE < itemsO * 0.7) {
    warn('LIST_LOSS', 'List items dropped by ' + Math.round((1 - itemsE / itemsO) * 100) + '%: original ' + itemsO + ', edited ' + itemsE + '.');
  }

  // --- Shortcodes -----------------------------------------------------------
  const scO = multiset(O.shortcodes);
  const scE = multiset(E.shortcodes);
  for (const entry of scO) {
    const have = scE.get(entry[0]) || 0;
    if (have < entry[1]) error('SHORTCODE_MISSING', 'Shortcode missing or changed: ' + short(entry[0], 100));
  }
  for (const entry of multisetExcess(scO, scE)) {
    error('SHORTCODE_ADDED', 'New shortcode or [bracketed] text: ' + short(entry[0], 100));
  }

  // --- Links and ids -----------------------------------------------------------
  for (const h of O.hrefs) {
    if (!E.hrefs.has(h)) error('LINK_MISSING', 'Original link removed or changed: ' + short(h, 120));
  }
  const relNeeded = new Map();
  for (const a of O.anchors) {
    const toks = ['nofollow', 'sponsored', 'ugc'].filter(function (t) { return a.rel.indexOf(t) >= 0; });
    relNeeded.set(a.href, relNeeded.has(a.href) ? relNeeded.get(a.href).filter(function (t) { return toks.indexOf(t) >= 0; }) : toks);
  }
  const relReported = new Set();
  for (const a of E.anchors) {
    const need = relNeeded.get(a.href);
    if (!need || !need.length || relReported.has(a.href)) continue;
    const miss = need.filter(function (t) { return a.rel.indexOf(t) < 0; });
    if (miss.length) {
      relReported.add(a.href);
      error('LINK_ATTR_CHANGED', 'Link ' + short(a.href, 100) + ' lost rel="' + miss.join(' ') + '".');
    }
  }
  const oLead = leadingItem(O.raw);
  // The post title (an H1 that is the original's first heading, even below a leading image) may be deleted with its id.
  const titleIsFirstHeading = (oLead.kind === 'element' && oLead.tag === 'h1') ||
    (O.headings.length > 0 && O.headings[0].level === 1);
  let titleIds = new Set();
  if (titleIsFirstHeading && !E.open.h1) {
    const h1 = scanElements(O.markupNoPlugin, ['h1'], true)[0];
    if (h1) titleIds = new Set(parseAttrsIds(O.markupNoPlugin.slice(h1.start, h1.end)));
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
  // A block-editor original returned with NO block comments at all (older "clean HTML" prompts strip them):
  // WordPress shows it as one Classic block. Not damage, so the media-block and block-balance checks are
  // skipped; plugin blocks (checked above) must still be there.
  const classicConversion = O.tokens.length > 0 && E.tokens.length === 0;
  if (classicConversion) {
    warn('CLASSIC_CONVERSION', 'The edit has no block comments (<!-- wp:... -->) although the original has ' + O.tokens.length +
      ': WordPress will show it as a Classic block.');
  }
  const mediaOpeners = function (A) {
    return A.tokens.filter(function (t) { return !t.closing && MEDIA_BLOCKS.indexOf(t.name) >= 0; }).map(function (t) { return t.raw; });
  };
  const mbO = multiset(mediaOpeners(O));
  const mbE = multiset(mediaOpeners(E));
  for (const entry of mbO) {
    if (classicConversion) break;
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
    if (classicConversion) break;
    if (Math.abs(bbE[name]) > Math.abs(bbO[name] || 0)) {
      error('BLOCK_UNBALANCED', 'Block wp:' + name + ' has ' + Math.abs(bbE[name]) + ' unmatched opener/closer comment(s).');
    }
  }
  if (!O.tokens.length && E.tokens.length) {
    // In WordPress, one block comment makes has_blocks() true and switches off wpautop for the whole post.
    error('BLOCK_COMMENTS_IN_CLASSIC', 'Block comments (<!-- wp:... -->) added to a classic-editor article (' + E.tokens.length + ').');
  }
  for (const entry of multisetExcess(multiset(blockMarkupMismatches(O)), multiset(blockMarkupMismatches(E)))) {
    error('BLOCK_MARKUP_MISMATCH', 'Block comment does not match its tag: ' + entry[0] + '.');
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
  const faqPluginO = O.blocks.some(function (b) { return b.name === 'yoast/faq-block' || b.name === 'rank-math/faq-block'; });
  const faqLdO = O.jsonld.some(function (j) { return j.hasFaq; });
  for (const j of E.jsonld) {
    if (origScriptSet.has(j.raw)) continue;
    if (!j.valid) { error('JSONLD_INVALID', 'JSON-LD block is not valid JSON: ' + short(j.raw, 100)); continue; }
    if (!j.isFaq) error('JSONLD_TYPE', 'New JSON-LD block with @type ' + (j.types.join(', ') || '(none)') + ' (only FAQPage may be added).');
    else if (faqPluginO && !faqLdO) error('JSONLD_TYPE', 'New FAQPage JSON-LD although the FAQ is a plugin block (the plugin already outputs FAQ schema).');
    const bad = jsonLdPlaceholders(j.data);
    if (bad.length) error('PLACEHOLDER', 'Placeholder or empty value inside JSON-LD: ' + bad.map(function (x) { return '"' + short(x, 40) + '"'; }).join(', '));
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
  if (E.badComments > O.badComments) {
    error('MALFORMED_COMMENT', 'Unclosed or nested "<!--" added (' + (E.badComments - O.badComments) + '): it can hide the rest of the page.');
  }

  // --- Forbidden tags --------------------------------------------------------------------
  for (const t of FORBIDDEN_TAGS) {
    let a = O.open[t] || 0;
    // The original's title H1 must be deleted; it gives no allowance for another H1.
    if (t === 'h1' && titleIsFirstHeading) a = Math.max(0, a - 1);
    const b = E.open[t] || 0;
    if (b > a) error('FORBIDDEN_TAG', 'New <' + t + '> tag(s) added (' + (b - a) + ').');
  }
  const doctypeRe = /<!doctype\b/gi;
  if (countMatches(edited, doctypeRe) > countMatches(O.raw, doctypeRe)) error('FORBIDDEN_TAG', 'New <!doctype> added.');
  if (E.nonJsonLdScriptOpeners > O.nonJsonLdScriptOpeners) {
    error('FORBIDDEN_TAG', 'New or unclosed <script> tag(s) added (' + (E.nonJsonLdScriptOpeners - O.nonJsonLdScriptOpeners) + ').');
  }
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
    const b = looseNormalize(opts.postTitle);
    const a1 = looseNormalize(eLead.text || '');
    const a2 = looseNormalize(eLead.firstLine || '');
    if (b && (a1 === b || a2 === b)) error('TITLE_IN_BODY', 'The article starts with a line that only repeats the post title.');
  }

  // --- Stray text: the model's own words around or between the article's parts ------------
  const bareO = bareTextSegments(O.markup);
  const bareE = bareTextSegments(E.markup);
  const bareShow = new Map();
  for (const s of bareE) bareShow.set(normalizeForMatch(s), s);
  const newBare = multisetExcess(multiset(bareO.map(normalizeForMatch)), multiset(bareE.map(normalizeForMatch)));
  let strayFound = false;
  for (const entry of newBare) {
    const shown = bareShow.get(entry[0]) || entry[0];
    // Original without any bare text (block editor, or fully wrapped classic): any new bare text is stray.
    // Original with bare-text paragraphs (classic wpautop): only chat-like lines.
    if (!bareO.length || CHATTER_START_RE.test(shown)) {
      strayFound = true;
      error('STRAY_TEXT', 'Text outside the article\'s paragraphs/blocks: "' + short(shown, 90) + '"');
    }
  }
  if (!strayFound && O.tokens.length && eLead.kind === 'text' && oLead.kind !== 'text') {
    strayFound = true;
    error('STRAY_TEXT', 'The article starts with text outside any block: "' + short(eLead.text || eLead.raw, 90) + '"');
  }
  if (!strayFound && CHATTER_START_RE.test(E.text.slice(0, 300)) && !CHATTER_START_RE.test(O.text.slice(0, 300))) {
    error('STRAY_TEXT', 'The article starts with chat text: "' + short(E.text, 90) + '"');
  }
  if (CHATTER_END_RE.test(E.text.slice(-400)) && !CHATTER_END_RE.test(O.text.slice(-400))) {
    error('STRAY_TEXT', 'The article ends with a note about the edit: "' + short(E.text.slice(-120), 90) + '"');
  }
  if (countMatches(E.text, LLM_CHATTER_ANY_RE) > countMatches(O.text, LLM_CHATTER_ANY_RE)) {
    error('STRAY_TEXT', 'Chat text added (for example "let me know if you would like...", "hope this helps").');
  }

  // --- Headings (relative: a skipped level the original already had at the same heading is kept) ----------
  if (E.headings.length) {
    const allowed = headingJumpKeys(O.headings);
    const key = function (h) { return h.level + '|' + normalizeForMatch(h.text); };
    const firstReal = E.headings[0];
    if (firstReal.level !== 2 && !(firstReal.level > 2 && allowed.has(key(firstReal)))) {
      error('HEADING_ORDER', 'The first heading must be <h2>; found <h' + firstReal.level + '> "' + short(firstReal.text, 60) + '".');
    }
    for (let i = 1; i < E.headings.length; i++) {
      const prev = E.headings[i - 1].level;
      const cur = E.headings[i].level;
      if (cur > prev + 1 && !allowed.has(key(E.headings[i]))) {
        error('HEADING_ORDER', 'Heading level jumps from h' + prev + ' to h' + cur + ' at "' + short(E.headings[i].text, 60) + '".');
      }
    }
  }

  // --- Placeholders / fences / markdown / omission notes ------------------------------------------
  const found = [];
  for (const p of PLACEHOLDER_PATTERNS) {
    const d = countMatches(E.markup, p[1]) - countMatches(O.markup, p[1]);
    if (d > 0) found.push(p[0] + (d > 1 ? ' (x' + d + ')' : ''));
  }
  if (found.length) error('PLACEHOLDER', 'Placeholder text added: ' + found.join(', '));
  if (countOccurrences(edited, '```') > countOccurrences(O.raw, '```')) error('CODE_FENCE', 'Markdown code fence (```) found in the HTML.');
  const noCodeText = function (A) {
    return /<(?:pre|code)(?=[\s>\/])/i.test(A.markup) ? visibleText(removeRawElements(A.markup, ['pre', 'code'], ' '), { isMarkup: true }) : A.text;
  };
  const tcO = noCodeText(O);
  const tcE = noCodeText(E);
  const md = [];
  for (const p of MARKDOWN_PATTERNS) {
    const d = countMatches(tcE, p[1]) - countMatches(tcO, p[1]);
    if (d > 0) md.push(p[0] + (d > 1 ? ' (x' + d + ')' : ''));
  }
  if (E.markup.indexOf('#') >= 0) {
    const dh = countMatches(lineText(E.markup), MARKDOWN_HEADING_RE) - countMatches(lineText(O.markup), MARKDOWN_HEADING_RE);
    if (dh > 0) md.push('markdown heading "## ..."' + (dh > 1 ? ' (x' + dh + ')' : ''));
  }
  if (md.length) error('MARKDOWN', 'Markdown or search-tool citation marks in the HTML: ' + md.join(', '));
  const om = [];
  const shortO = textChunks(O).filter(function (c) { return countWords(c) <= 20; });
  const shortE = textChunks(E).filter(function (c) { return countWords(c) <= 20; });
  const countIn = function (list, re) { let n = 0; for (const c of list) n += countMatches(c, re); return n; };
  for (const re of OMISSION_PATTERNS) {
    if (countIn(shortE, re) > countIn(shortO, re)) {
      const hit = shortE.filter(function (c) { return countMatches(c, re) > 0; })[0];
      om.push('"' + short(hit || '', 60) + '"');
    }
  }
  if (countMatches(E.text, OMISSION_NOTE_RE) > countMatches(O.text, OMISSION_NOTE_RE)) {
    OMISSION_NOTE_RE.lastIndex = 0;
    const m = OMISSION_NOTE_RE.exec(E.text);
    OMISSION_NOTE_RE.lastIndex = 0;
    om.push('"' + short(m ? m[0] : '', 60) + '"');
  }
  const newComments = multisetExcess(multiset(O.plainComments), multiset(E.plainComments));
  for (const entry of newComments) {
    if (OMISSION_COMMENT_RE.test(entry[0]) || OMISSION_PATTERNS.some(function (re) { return countMatches(entry[0], re) > 0; })) {
      om.push('comment <!-- ' + short(entry[0], 60) + ' -->');
    } else {
      warn('NEW_HTML_COMMENT', 'New HTML comment (it is published in the page source): <!-- ' + short(entry[0], 80) + ' -->');
    }
  }
  if (om.length) error('OMISSION_MARKER', 'Part of the article looks skipped ("rest unchanged" note): ' + om.join(', '));

  // --- Tag balance ---------------------------------------------------------------------------
  for (const t of BALANCED_TAGS) {
    const a = Math.abs((O.open[t] || 0) - (O.close[t] || 0));
    const b = Math.abs((E.open[t] || 0) - (E.close[t] || 0));
    if (b > a) error('TAG_UNBALANCED', '<' + t + '> is unbalanced: ' + (E.open[t] || 0) + ' opening vs ' + (E.close[t] || 0) + ' closing tags.');
  }

  // --- Words -----------------------------------------------------------------------------
  const ratio = O.words ? E.words / O.words : (E.words ? Infinity : 1);
  // A very thin original may legitimately grow to about 600 words.
  const extremeLimit = O.words ? Math.max(opts.maxWordRatio, 600 / O.words) : opts.maxWordRatio;
  if (ratio < opts.minWordRatio) {
    error('CONTENT_LOSS', 'Visible text shrank to ' + Math.round(ratio * 100) + '% of the original (' + E.words + ' vs ' + O.words + ' words).');
  }
  if (ratio > extremeLimit) {
    error('WORD_RATIO_EXTREME', 'Visible text grew ' + (isFinite(ratio) ? ratio.toFixed(1) + 'x' : 'from nothing') + ' (' + E.words + ' vs ' + O.words + ' words): runaway or duplicated output.');
  } else if (ratio > 3) {
    warn('WORD_RATIO_HIGH', 'Visible text grew ' + ratio.toFixed(1) + 'x (' + E.words + ' vs ' + O.words + ' words).');
  }
  const retention = wordRetention(O, E);
  if (O.words >= 100 && retention < opts.minRetention) {
    error('CONTENT_RETENTION', 'Only ' + Math.round(retention * 100) + '% of the original\'s words are still in the edit (minimum ' +
      Math.round(opts.minRetention * 100) + '%): whole parts were probably dropped.');
  }

  // --- Duplicate content --------------------------------------------------------------------
  const classicMode = !O.tokens.length;
  const blockTexts = function (A) {
    if (classicMode) {
      // Classic content: paragraphs are blank-line separated text (wpautop) as well as block elements.
      return textChunks(A).map(normalizeForMatch).filter(function (t) { return countWords(t) >= 12; });
    }
    // Leaf paragraphs/items only (bounded size): broken or nested markup must not make this quadratic.
    return scanElements(A.markup, ['p', 'li'], false)
      .filter(function (el) { return el.contentEnd - el.contentStart <= 5000 && !/<(?:p|li)(?=[\s>\/])/i.test(el.inner); })
      .map(function (el) { return normalizeForMatch(visibleText(el.inner, { isMarkup: true })); })
      .filter(function (t) { return countWords(t) >= 12; });
  };
  const dO = multiset(blockTexts(O));
  const dE = multiset(blockTexts(E));
  for (const entry of dE) {
    if (entry[1] >= 2 && (dO.get(entry[0]) || 0) < entry[1]) {
      error('DUPLICATE_CONTENT', 'Text repeated ' + entry[1] + ' times: "' + short(entry[0], 80) + '"');
    }
  }

  // --- Last checked, freshness claims, figures without research ------------------------------------
  const lcO = multiset(lastCheckedSnippets(O.text));
  const lcE = multiset(lastCheckedSnippets(E.text));
  const lcNew = multisetExcess(lcO, lcE);
  if (opts.webSearchCount === 0) {
    for (const entry of lcNew) {
      error('LAST_CHECKED_WITHOUT_RESEARCH', 'A new or changed "Last checked" line was added without any web research: "' + short(entry[0], 60) + '"');
    }
    for (const re of FRESHNESS_PATTERNS) {
      if (countMatches(E.text, re) > countMatches(O.text, re)) {
        re.lastIndex = 0;
        const m = re.exec(E.text);
        re.lastIndex = 0;
        error('LAST_CHECKED_WITHOUT_RESEARCH', 'An "updated"/"verified" claim was added without any web research: "' + short(m ? m[0] : '', 60) + '"');
      }
    }
    for (const re of todayDatePatterns(opts.today)) {
      if (countMatches(E.text, re) > countMatches(O.text, re)) {
        error('LAST_CHECKED_WITHOUT_RESEARCH', 'Today\'s date (' + opts.today + ') was added without any web research.');
        break;
      }
    }
    // Shortcode attributes (width="800" ...) are not article figures.
    const fO = figureInfo(O.text.indexOf('[') >= 0 ? O.text.replace(SHORTCODE_RE_G, ' ') : O.text);
    const fE = figureInfo(E.text.indexOf('[') >= 0 ? E.text.replace(SHORTCODE_RE_G, ' ') : E.text);
    const added = [];
    for (const entry of fE.tokens) if (!fO.tokens.has(entry[0]) && !fO.numbers.has(entry[1])) added.push(entry[0]);
    if (added.length) error('NEW_NUMBER_WITHOUT_RESEARCH', 'New price, percentage or year without any web research: ' + added.slice(0, 10).join(', '));
    const lost = [];
    for (const entry of fO.tokens) if (!fE.tokens.has(entry[0]) && !fE.numbers.has(entry[1])) lost.push(entry[0]);
    if (lost.length) error('NUMBER_MISSING', 'Price, percentage or year from the original is gone: ' + lost.slice(0, 10).join(', '));
  }
  if (opts.lastCheckedLine === 'no') {
    for (const entry of lcNew) {
      error('LAST_CHECKED_NOT_ALLOWED', 'A new or changed "Last checked" line was added although "Last checked line" is "no": "' + short(entry[0], 60) + '"');
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
  for (const a of scanElements(E.markup, ['a'], true)) {
    const attrs = parseAttrs(a.attrStr);
    if (!Object.prototype.hasOwnProperty.call(attrs, 'href') || O.hrefs.has(attrs.href.trim())) continue;
    if (/<img(?=[\s>\/])/i.test(a.inner)) error('BAD_NEW_LINK', 'New link wrapped around an image: ' + short(attrs.href, 120));
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
  // Rule 5: never a second FAQ, Sources list or Last checked line.
  const sectionCounts = [
    ['FAQ section', function (A) { return A.allHeadings.filter(isFaqHeading).length; }],
    ['Sources section', function (A) { return A.allHeadings.filter(function (h) { return isSourcesHeadingText(h.text); }).length; }],
    ['"Last checked" line', function (A) { return lastCheckedSnippets(A.text).length; }]
  ];
  for (const sc of sectionCounts) {
    const a = sc[1](O);
    const c = sc[1](E);
    if (c > Math.max(1, a)) error('SECTION_DUPLICATED', sc[0] + ' appears ' + c + ' times (max ' + Math.max(1, a) + ').');
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
    wordRetention: Math.round(retention * 1000) / 1000,
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

// Citation marks a search tool may add to a quote: [1], \u30103\u2020source\u3011, [cite: 1], ([site.com](url)).
const QUOTE_CITATION_RE = /\[\d{1,2}\]|\u3010[^\u3011]{0,60}\u3011|\[cite[^\]]{0,40}\]|\(\[[^\]]{0,80}\]\([^)]{0,300}\)\)/gi;

/** Corpus prepared once per audit: normalised strings plus a token index for the fuzzy fallback. */
function quoteCorpus(text) {
  const n = normalizeForMatch(text);
  const l = looseNormalize(text);
  const tokens = l ? l.split(' ') : [];
  const index = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const list = index.get(t);
    if (list) list.push(i); else index.set(t, [i]);
  }
  return { n: n, l: l, tokens: tokens, index: index };
}

/**
 * Fuzzy fallback: at least 80% of the quote's words appear, in order, inside a window of 1.5x the quote's
 * length in the article (a lightly paraphrased quote). Bounded work per quote.
 */
function fuzzyQuoteFound(qTokens, corpus) {
  const m = qTokens.length;
  if (m < 5 || !corpus.tokens.length) return false;
  const need = Math.ceil(m * 0.8);
  const w = Math.ceil(m * 1.5);
  const T = corpus.tokens;
  const starts = new Set();
  for (let k = 0; k <= m - need; k++) {
    const list = corpus.index.get(qTokens[k]);
    if (list) for (const i of list) starts.add(i);
  }
  let budget = 3000000;
  const prev = new Array(m + 1);
  const cur = new Array(m + 1);
  for (const st of starts) {
    const end = Math.min(T.length, st + w);
    if ((end - st) * m > budget) return false;
    budget -= (end - st) * m;
    for (let j = 0; j <= m; j++) prev[j] = 0;
    for (let i = st; i < end; i++) {
      cur[0] = 0;
      for (let j = 1; j <= m; j++) {
        cur[j] = T[i] === qTokens[j - 1] ? prev[j - 1] + 1 : (prev[j] > cur[j - 1] ? prev[j] : cur[j - 1]);
      }
      for (let j = 0; j <= m; j++) prev[j] = cur[j];
      if (prev[m] >= need) return true;
    }
  }
  return false;
}

function quoteFound(quote, corpus) {
  let q = decodeEntities(toStr(quote));
  if (/<[a-zA-Z\/]/.test(q)) q = visibleText(q);
  q = q.replace(QUOTE_CITATION_RE, ' ');
  q = normalizeForMatch(q).replace(/^["'\s]+|["'\s]+$/g, '');
  if (!q) return false;
  if (corpus.n.indexOf(q) >= 0) return true;
  const ql = looseNormalize(q);
  if (ql && corpus.l.indexOf(ql) >= 0) return true;
  if (/\.\.\./.test(q)) {
    const parts = q.split(/\.\.\./).map(looseNormalize).filter(Boolean);
    if (parts.length) {
      let pos = 0;
      let all = true;
      for (const p of parts) {
        const i = corpus.l.indexOf(p, pos);
        if (i < 0) { all = false; break; }
        pos = i + p.length;
      }
      if (all) return true;
    }
  }
  return ql ? fuzzyQuoteFound(ql.split(' '), corpus) : false;
}

/**
 * Keeps only audit issues whose quote really occurs in the edited article's visible text (exact after
 * normalisation, or a close paraphrase). extra.originalHtml (optional): quotes of "info_lost" issues may also
 * come from the original.
 * effectiveVerdict never turns the auditor's "fix" into "pass" just because a high issue's quote was not found:
 * such issues stay blocking and are returned in retryIssues for the retry's Extra instructions.
 */
function filterAuditIssues(editedHtml, audit, extra) {
  extra = extra || {};
  const parsed = parseAuditReply(audit);
  if (!parsed) {
    return { verdict: 'reject', effectiveVerdict: 'reject', issues: [], dropped: [], retryIssues: [], blocking: true, valid: false,
      error: 'Audit reply is not a valid JSON object.' };
  }
  const corpus = quoteCorpus(visibleText(editedHtml) + ' | ' + attributeText(editedHtml));
  const origCorpus = extra.originalHtml ? quoteCorpus(visibleText(extra.originalHtml)) : null;
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
    let ok = quoteFound(issue.quote, corpus);
    if (!ok && origCorpus && toStr(issue.category) === 'info_lost') ok = quoteFound(issue.quote, origCorpus);
    if (ok) kept.push(issue);
    else dropped.push(Object.assign({}, issue, { dropReason: 'quote not found in the edited text' }));
  }
  const keptHigh = kept.some(function (i) { return i.severity === 'high'; });
  const droppedHigh = dropped.filter(function (i) { return i && i.severity === 'high' && i.dropReason === 'quote not found in the edited text'; });
  const verdict = toStr(parsed.verdict).trim().toLowerCase();
  let effectiveVerdict;
  if (verdict === 'reject') effectiveVerdict = 'reject';
  else if (verdict !== 'pass' && verdict !== 'fix') effectiveVerdict = 'reject';
  else if (keptHigh) effectiveVerdict = 'fix';
  else if (verdict === 'fix' && droppedHigh.length) effectiveVerdict = 'fix'; // unmatched quote: never downgraded to pass
  else effectiveVerdict = 'pass';
  const rank = { high: 0, medium: 1, low: 2 };
  const retryIssues = kept.concat(effectiveVerdict === 'fix' ? droppedHigh.map(function (i) {
    return Object.assign({}, i, { quoteNotFound: true });
  }) : []).sort(function (a, b) { return (rank[a.severity] || 0) - (rank[b.severity] || 0); });
  const out = Object.assign({}, parsed, {
    verdict: verdict || parsed.verdict, effectiveVerdict: effectiveVerdict, issues: kept, dropped: dropped,
    retryIssues: retryIssues, blocking: effectiveVerdict !== 'pass', valid: true
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* 7. processEditorOutput                                               */
/* ------------------------------------------------------------------ */

/**
 * HTTP-checks the NEW http(s) links that the link rules would keep (opts = normalized options) and turns the
 * results into removals: dead, redirected to another site, or a deep link that could not be verified.
 * Returns Promise<{ linkResults, removals: [{ url, reason }], warnings }>.
 */
async function linkCheckRemovals(newLinks, opts) {
  const res = { linkResults: [], removals: [], warnings: [] };
  const removals = res.removals;
  const toCheck = (newLinks || []).filter(function (h) {
    const p = parseUrl(h);
    return p && (p.scheme === 'http' || p.scheme === 'https') && decideNewLink(h, opts, null) === null;
  });
  if (!toCheck.length) return res;
  const fetchAvailable = typeof opts.fetchFn === 'function' ||
    (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function');
  try {
    res.linkResults = await checkLinks(toCheck, { fetchFn: opts.fetchFn, timeoutMs: opts.linkTimeoutMs, concurrency: opts.linkConcurrency });
  } catch (e) {
    res.linkResults = toCheck.map(function (u) { return { url: u, status: null, verdict: 'unknown', error: 'link check failed' }; });
  }
  const verified = new Set();
  for (const u of opts.verifiedUrls) { verified.add(u); verified.add(u.replace(/\/+$/, '')); }
  for (const r of res.linkResults) {
    const p = parseUrl(r.url);
    if (r.verdict === 'dead') {
      removals.push({ url: r.url, reason: 'dead' });
    } else if (r.verdict === 'ok') {
      // Redirected to another site (grounding/redirect service, moved or sold domain): the page we'd link is unknown.
      const f = r.finalUrl ? parseUrl(r.finalUrl) : null;
      if (p && f && f.validHost && registrableHost(f.host) !== registrableHost(p.host)) removals.push({ url: r.url, reason: 'redirect' });
    } else if (p && !isBareHomepage(p) && !verified.has(r.url) && !verified.has(r.url.replace(/\/+$/, ''))) {
      // Could not be checked (no fetch, 401/403/429, timeout): a deep link nobody verified is not published.
      removals.push({ url: r.url, reason: 'unverified' });
    }
  }
  if (!fetchAvailable) {
    res.warnings.push({ code: 'LINK_CHECK_UNAVAILABLE', message: 'No fetch function: new links could not be checked; deep links were removed, homepages kept.' });
  } else if (res.linkResults.length && res.linkResults.every(function (r) { return r.verdict === 'unknown'; })) {
    res.warnings.push({ code: 'LINK_CHECK_INCONCLUSIVE', message: 'Every new link came back "unknown" (' + short(res.linkResults[0].error, 60) + '): check the network or firewall.' });
  }
  return res;
}

async function processEditorOutput(originalHtml, llmText, options) {
  const original = toStr(originalHtml);
  let opts = null;
  const out = {
    action: 'keep_original', html: original, meta: null, errors: [], warnings: [],
    removedLinks: [], changedLinks: [], linkResults: [], stats: null, changed: false
  };
  try {
    opts = normalizeOptions(options);
    const originalN = normalizeNewlines(original);
    const parsed = parseEditorOutput(llmText);
    out.meta = parsed.meta;
    out.warnings = (parsed.warnings || []).slice();
    if (parsed.ok && parsed.status === 'skipped') {
      out.action = 'skip';
      return out;
    }
    if (!parsed.ok) {
      out.errors = parsed.errors;
      return out;
    }
    // Unknown search count + model says it did no research => treat as no research (stricter).
    if (opts.webSearchCount === null && parsed.meta && (parsed.meta.web_research_used === false ||
      /^\s*(?:false|no)\s*$/i.test(toStr(parsed.meta.web_research_used)))) opts.webSearchCount = 0;

    // Own site: required to catch new internal links. Guessed from upload URLs when not given; else fail closed.
    resolveSiteDomains(opts, originalN);
    if (!opts.siteDomains.length) {
      out.errors = [{ code: 'CONFIG_MISSING', message: 'No site domain: set siteDomains (CLI --site) so new internal links can be found.' }];
      return out;
    }
    if (opts.siteDomainsInferred) {
      out.warnings.push({ code: 'SITE_DOMAINS_INFERRED', message: 'No site domain given; using ' + opts.siteDomains.join(', ') + ' (from the original\'s upload URLs).' });
    }

    const origHrefs = hrefSet(originalN);
    const cleaned = stripTrackingParams(originalN, normalizeNewlines(parsed.html), origHrefs);
    out.changedLinks = cleaned.changed;
    const editedHtml = cleaned.html;
    const newLinks = findNewLinks(originalN, editedHtml, opts);
    const removals = [];
    if (opts.checkLinks) {
      const lc = await linkCheckRemovals(newLinks, opts);
      out.linkResults = lc.linkResults;
      Array.prototype.push.apply(removals, lc.removals);
      out.warnings = out.warnings.concat(lc.warnings);
    }
    const san = sanitizeLinks(originalN, editedHtml, opts, removals);
    out.removedLinks = san.removed;
    const v = validateArticle(originalN, san.html, Object.assign({}, opts, { meta: parsed.meta, deadUrls: removals }));
    out.errors = v.errors;
    out.warnings = out.warnings.concat(v.warnings);
    out.stats = v.stats;
    out.candidateHtml = san.html;
    if (v.pass) {
      out.action = 'publish';
      out.html = san.html;
      out.changed = san.html !== originalN;
    }
  } catch (e) {
    out.action = 'keep_original';
    out.html = original;
    out.errors.push({ code: 'INTERNAL_ERROR', message: 'Validator crashed: ' + short(e && (e.stack || e.message) || e, 300) });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 8. runSafetyGate (browser extension: AI chat websites, no META)      */
/* ------------------------------------------------------------------ */

/**
 * One call for the browser extension's Safety Gate: strip end markers -> find new links -> check them
 * (options.checkLinks, options.fetchFn) -> sanitize links -> validateArticle. Never throws.
 * options: the validateArticle/processEditorOutput options, plus webSearchAllowed, endMarker, requireEndMarker.
 * ok = true only when nothing failed; html is then the sanitized, marker-free HTML to save. When ok is false,
 * nothing may be saved: html is the (marker-free) reference and candidateHtml the rejected edit.
 */
async function runSafetyGate(referenceHtml, aiHtml, options) {
  const reference = toStr(referenceHtml);
  const out = {
    ok: false, html: reference, errors: [], warnings: [], removedLinks: [], changedLinks: [], linkResults: [],
    stats: null, changed: false
  };
  try {
    const opts = normalizeOptions(options);
    const marker = opts.endMarker || DEFAULT_END_MARKER;
    const originalN = stripEndMarkers(normalizeNewlines(reference), marker);
    const raw = normalizeNewlines(aiHtml);
    const markerFound = hasEndMarker(raw, marker);
    const edited = stripEndMarkers(raw, marker);
    out.html = originalN;
    if (opts.requireEndMarker && !markerFound) {
      out.errors.push({ code: 'END_MARKER_MISSING', message: 'The end marker <!-- ' + marker + ' --> is missing: the AI reply was probably cut off (truncated).' });
    }
    if (!edited.trim()) {
      out.errors.push({ code: 'PARSE_EMPTY_HTML', message: 'The edited HTML is empty.' });
      return out;
    }
    // Own site: required to catch new internal links. Guessed from upload URLs when not given; else fail closed.
    resolveSiteDomains(opts, originalN);
    if (!opts.siteDomains.length) {
      out.errors.push({ code: 'CONFIG_MISSING', message: 'No site domain: set siteDomains so new internal links can be found.' });
      return out;
    }
    if (opts.siteDomainsInferred) {
      out.warnings.push({ code: 'SITE_DOMAINS_INFERRED', message: 'No site domain given; using ' + opts.siteDomains.join(', ') + ' (from the original\'s upload URLs).' });
    }
    const cleaned = stripTrackingParams(originalN, edited, hrefSet(originalN));
    out.changedLinks = cleaned.changed;
    const newLinks = findNewLinks(originalN, cleaned.html, opts);
    let removals = [];
    if (opts.checkLinks) {
      const lc = await linkCheckRemovals(newLinks, opts);
      out.linkResults = lc.linkResults;
      removals = lc.removals;
      out.warnings = out.warnings.concat(lc.warnings);
    }
    const san = sanitizeLinks(originalN, cleaned.html, opts, removals);
    out.removedLinks = san.removed;
    // The markers are already stripped (and checked above).
    const v = validateArticle(originalN, san.html, Object.assign({}, opts, { deadUrls: removals, endMarker: '', requireEndMarker: false }));
    out.errors = out.errors.concat(v.errors);
    out.warnings = out.warnings.concat(v.warnings);
    out.stats = Object.assign({}, v.stats, { endMarkerFound: markerFound, newLinks: newLinks.length });
    out.candidateHtml = san.html;
    if (v.pass && !out.errors.length) {
      out.ok = true;
      out.html = san.html;
      out.changed = san.html !== originalN;
    }
  } catch (e) {
    out.ok = false;
    out.html = reference;
    out.errors.push({ code: 'INTERNAL_ERROR', message: 'Safety Gate crashed: ' + short(e && (e.stack || e.message) || e, 300) });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* CLI                                                                  */
/* ------------------------------------------------------------------ */

const CLI_USAGE = 'Usage: node validate-article.js --original orig.html --output llm-output.txt --site a.com,b.com ' +
  '[--searches N] [--faq auto|no] [--title "Post title"] [--last-checked yes|no|auto] [--today YYYY-MM-DD] ' +
  '[--no-link-check] [--write-html out.html] [--report report.json]';

function parseCliArgs(argv) {
  const a = { site: [], searches: null, faq: 'auto', linkCheck: true, lastChecked: 'auto' };
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
    else if (k === '--title') { a.title = need(i, k); i++; }
    else if (k === '--last-checked') {
      const v = need(i, k).toLowerCase(); i++;
      if (v !== 'auto' && v !== 'no' && v !== 'yes') throw new Error('--last-checked must be yes, no or auto');
      a.lastChecked = v;
    }
    else if (k === '--today') {
      const v = need(i, k); i++;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('--today must be YYYY-MM-DD');
      a.today = v;
    }
    else if (k === '--no-link-check') a.linkCheck = false;
    else if (k === '--write-html') { a.writeHtml = need(i, k); i++; }
    else if (k === '--report') { a.report = need(i, k); i++; }
    else if (k === '--help' || k === '-h') a.help = true;
    else throw new Error('Unknown argument: ' + k);
  }
  if (!a.help && (!a.original || !a.output)) throw new Error('--original and --output are required');
  if (!a.help && !a.site.length) throw new Error('--site is required (your own domain, e.g. --site tubetyre.com)');
  return a;
}

/** Output files named on the command line (read even when the rest of the arguments are invalid). */
function cliOutputTargets(argv) {
  const t = { files: [], inputs: [] };
  for (let i = 0; i + 1 < argv.length; i++) {
    const v = argv[i + 1];
    if (/^--/.test(v)) continue;
    if (argv[i] === '--write-html' || argv[i] === '--report') t.files.push(v);
    if (argv[i] === '--original' || argv[i] === '--output') t.inputs.push(v);
  }
  return t;
}

async function runCli(argv) {
  const fs = require('fs');
  const path = require('path');
  // Delete the --write-html / --report files of an earlier run FIRST, whatever happens next (usage error,
  // unreadable input, keep_original), so a stale final.html can never be uploaded. Inputs are never deleted.
  const targets = cliOutputTargets(argv);
  const inputs = targets.inputs.map(function (f) { return path.resolve(f); });
  let clash = false;
  for (const f of targets.files) {
    if (inputs.indexOf(path.resolve(f)) >= 0) { clash = true; continue; }
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {
      process.stderr.write('Cannot delete old output file ' + f + ': ' + e.message + '\n');
      return 1;
    }
  }
  let args;
  try {
    if (clash) throw new Error('--write-html and --report must not be the same file as --original or --output');
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
    postTitle: args.title || '',
    lastCheckedLine: args.lastChecked,
    today: args.today || '',
    checkLinks: args.linkCheck
  });
  const code = result.action === 'publish' ? 0 : (result.action === 'skip' ? 3 : 2);
  try {
    if (args.writeHtml && result.action === 'publish') fs.writeFileSync(args.writeHtml, result.html, 'utf8');
    if (args.report) fs.writeFileSync(args.report, JSON.stringify(result, null, 2), 'utf8');
  } catch (e) {
    try { if (args.writeHtml && fs.existsSync(args.writeHtml)) fs.unlinkSync(args.writeHtml); } catch (e2) { /* ignore */ }
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
    runSafetyGate: runSafetyGate,
    stripEndMarkers: stripEndMarkers,
    runCli: runCli,
    ERROR_CODES: ERROR_CODES,
    WARNING_CODES: WARNING_CODES,
    DEFAULT_FORBIDDEN_LINK_DOMAINS: DEFAULT_FORBIDDEN_LINK_DOMAINS,
    REDIRECT_LINK_DOMAINS: REDIRECT_LINK_DOMAINS,
    BOX_TYPES: BOX_TYPES,
    _internal: {
      visibleText: visibleText, countWords: countWords, decodeEntities: decodeEntities, normalizeOptions: normalizeOptions,
      parseUrl: parseUrl, decideNewLink: decideNewLink, findSourcesSections: findSourcesSections, leadingItem: leadingItem,
      blockTokens: blockTokens, normalizeForMatch: normalizeForMatch, classifyFetchError: classifyFetchError,
      registrableHost: registrableHost, inferSiteDomains: inferSiteDomains, stripTrackingParamsFromUrl: stripTrackingParamsFromUrl,
      bareTextSegments: bareTextSegments, figureInfo: figureInfo, markupOf: markupOf, hasEndMarker: hasEndMarker
    }
  };
}

// Browser extension (classic service worker: importScripts('safety-gate.js')) and other hosts without
// CommonJS: one global object, self.SafetyGate. Node keeps module.exports above; nothing is added there.
(function (root) {
  if (!root) return;
  root.SafetyGate = {
    VERSION: VALIDATE_ARTICLE_VERSION,
    runSafetyGate: runSafetyGate,
    stripEndMarkers: stripEndMarkers,
    filterAuditIssues: filterAuditIssues,
    validateArticle: validateArticle,
    sanitizeLinks: sanitizeLinks,
    checkLinks: checkLinks,
    findNewLinks: findNewLinks,
    ERROR_CODES: ERROR_CODES,
    WARNING_CODES: WARNING_CODES
  };
})(typeof self !== 'undefined' && self ? self
  : (typeof module === 'undefined' && typeof globalThis !== 'undefined' ? globalThis : null));

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  runCli(process.argv.slice(2)).then(function (code) {
    process.exitCode = code;
  }, function (e) {
    process.stderr.write('Fatal: ' + (e && e.stack || e) + '\n');
    process.exitCode = 1;
  });
}
