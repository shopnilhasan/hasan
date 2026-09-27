// panel.js - Auto Post Updater Pro control panel

// ════════════════════════════════════════════════════════════════
// State
// ════════════════════════════════════════════════════════════════
let state = {
  wpSites: [],
  customAIs: [],
  prompts: [],
  selectedAI: 'grok',
  defaultAIId: 'grok',
  defaultPromptId: null,
  savedSlugDraft: '',
  lastRunSlugs: [],
  processedLinks: [],
  archivedAttemptKeys: [],
  delayBetween: 10,
  backgroundMode: 'on',
  auditRetryEnabled: 'off',
  auditRetryCount: '1',
  auditRetryTiming: 'end',
  htmlRecoveryAudit: 'off',
  htmlRecoveryFailed: 'off',
  htmlRecoveryAnyCode: 'off',
  autoSessionZip: 'on',
  limitGuard: 'off',
  limitMode: 'smart',
  limitFallbackHours: '0',
  modelLimitGuard: 'on',
  modelLimitRetryHours: '0',
  limitResumeMode: 'exact',
  geminiFlashGuard: 'on',
  failStopCount: '5',
  failRetryAfter: '60',
  faqConclAuto: 'off',
  parallelCount: '1',
  fastRecoverAfter: '10',
  fastAnyCode: 'off',
  fastChunkSize: '50',
  fastPasteWait: '10',
  fastStartAfter: '0',
  fastPasteRetries: '3',
  fastManual: 'off',
  // 🛡 Safety Gate + Fact check (v3.46.0)
  gateEnabled: 'on',
  gateLinkCheck: 'on',
  gateNewFaq: 'auto',
  gateSiteDomains: '',
  factCheck: 'on',
  factCheckAiId: '',
  factCheckPromptId: '',
  factCheckOnError: 'keep'
};

const BUILTIN_AIS = [
  { id: 'grok',    name: 'Grok',    url: 'https://grok.com' },
  { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com' },
  { id: 'claude',  name: 'Claude',  url: 'https://claude.ai' },
  { id: 'gemini',  name: 'Gemini',  url: 'https://gemini.google.com/app' }
];

const PRESERVE_PROMPT_TEXT = "Edit the article body below. Improve the wording, readability, structure, and on-page SEO ONLY.\nDo NOT browse, search, or fact-check. Do NOT remove, shorten, or replace anything: keep every product, comparison table, rating, score, list, link, and image (<img>) exactly as given. The result must be the same length or longer than what I paste.\nDo NOT add action checklists, notes, summaries, or any commentary.\nStart with an intro paragraph (no title/H1). Reply with ONLY the complete updated article inside ONE fenced ```html code block, and nothing else.";

const DEFAULT_PROMPTS = [
  {
    id: "p_info_table",
    type: "audit",
    name: "Info Audit Table Fix",
    text: "INFORMATIONAL ARTICLE \u2014 ULTIMATE AUDIT + FIX (v1.0)\nOne prompt for ChatGPT, Grok, Claude, Gemini. Paste only the main article body text, then this prompt. No title, meta, keyword, or topic needed \u2014 I set the title and meta separately in WordPress.\nROLE\nYou are a senior content auditor AND editor/implementer for informational and how-to content. You combine technical SEO, fact-checking, freshness research, readability/UX, and E-E-A-T expertise. You audit the article ruthlessly, then rebuild it with every fix applied and every content gap filled \u2014 fully finished, with zero manual work left for me.\nINPUT\nI give you ONLY the main article body text/HTML \u2014 no page title, no meta description, no <head>. I set the post title and meta separately in WordPress (Rank Math), so the title is NOT in what I paste. Infer the topic, primary keyword, and search intent from the body itself \u2014 never ask me for a title, keyword, or topic.\nParse: headings (H2 and below), body, internal/external links, <img> tags + alt, and any inline JSON-LD.\nRemove any title/H1 from the body; don't add one. Use any title or top H1 in what I paste only to infer the topic \u2014 then delete it, since my WordPress post title (set separately) is already the page's H1. The body output must start at H2 (downgrade any other H1 to H2; when unsure, downgrade rather than delete). Never delete anything else, and never remove images.\nIf I paste no article at all, ask for it \u2014 nothing else.\nRESEARCH & VERIFICATION (do this before auditing)\nIf you can browse/search, USE IT to: verify every fact, stat, date, and claim; check for outdated or superseded information and the latest data as of today; and research the topic so you know what COMPLETE coverage looks like for this query (what top-ranking articles include). Use only real, verifiable sources \u2014 never invent a fact or a URL. If you cannot browse, fix everything you safely can and rewrite any claim you can't verify into safe, accurate wording (do not leave a flag for me).\nPART 1 \u2014 DEEP AUDIT (output this FIRST)\nAudit every category. Quote the exact offending text and name its location. Score each /10 and give an overall /100.\nTopic coverage & completeness \u2014 does the article fully satisfy the search intent? List EXACTLY which subtopics, steps, questions, prerequisites, safety notes, or troubleshooting a top result would cover that are missing. (You WILL write these in Part 2.)\nFactual accuracy \u2014 wrong/unsupported/exaggerated claims; bad stats, dates, specs; contradictions; claims with no source.\nFreshness / outdated info \u2014 superseded data, deprecated methods/standards, stale dates, current-year mismatch, newer developments ignored.\nSEO (body-level) \u2014 heading hierarchy (top level H2, logical H2/H3 nesting, no skipped levels, keyword-rich subheads); natural keyword/LSI usage; search-intent match; featured-snippet/PAA readiness; authoritative external links; image alt text; schema (Article + HowTo if how-to + FAQPage); appropriate length. (Title, meta description, slug, and canonical are set separately in Rank Math \u2014 see the optional Rank Math suggestions below, not the body.)\nReadability & UX \u2014 grade level ~6th\u20138th; run-on sentences; wall-of-text paragraphs; passive voice; jargon; scannability (lists/tables/bold); strong intro hook; clear takeaway/conclusion; mobile readability.\nE-E-A-T & authoritative sourcing \u2014 first-hand specifics, expertise signals, and authoritative source links backing key claims; balanced honest tone.\nEngagement & SERP features \u2014 Quick Answer, Key Takeaways, At a Glance (how-tos), Warning/Pro Tip/Note, FAQ, stat/pull-quote highlight, Sources list. Flag walls of text with no visual hook and any article missing a snippet-optimized Quick Answer.\nAI-content & originality \u2014 robotic AI tells (\"in today's fast-paced world,\" \"it's important to note,\" \"delve into,\" uniform rhythm, filler); repetition; generic fluff vs. specific value.\nTechnical / HTML \u2014 invalid/messy markup, wrong tags, broken/empty links, images missing alt, basic accessibility.\nCompliance \u2014 required disclaimers (medical/financial/legal/safety) where relevant; affiliate disclosure only if affiliate links are present; no misleading claims.\nAudit report format:\nSnapshot: inferred topic/keyword & intent \u2022 word count \u2022 heading map (H2+) \u2022 #internal/#external links \u2022 #images (#missing alt) \u2022 schema found.\nScorecard: table \u2014 Category | /10 | one-line note. Then Overall: X/100 \u2014 verdict.\n\ud83d\udd34 Critical issues: numbered \u2014 issue \u2192 exact quote/location \u2192 why it matters \u2192 fix.\nFindings by category: brief bullets with quotes + specific fixes; \"\u2705 none\" if clean.\nFact-check & freshness log: Claim | Verdict (Accurate/Outdated/Incorrect/Unverifiable) | Source (real URL + date) | Update.\nTopic-coverage gaps: the exact missing sections/questions you will ADD in Part 2.\nRank Math suggestions (optional \u2014 these go in the separate title/meta fields, not the body): a 50\u201360 char SEO title, a ~150\u2013160 char meta description, and the focus keyword.\nAction plan: prioritized \ud83d\udd34/\ud83d\udfe0/\ud83d\udfe1/\ud83d\udfe2.\nPART 2 \u2014 FIX (output the HTML LAST)\nApply EVERY fix from Part 1, FILL every topic-coverage gap (write the missing sections so the article fully covers the topic), and add the engagement/authority elements below where they genuinely help. Then do one final review to confirm nothing else needs changing. Output the COMPLETE corrected article as ONE clean HTML code block.\nHARD RULES (never break)\nNEVER remove, replace, swap, or reorder any image. Every <img> stays with its src + attributes; you may only add/improve alt. Keep images even if you trim the text around them.\nZero manual work for me. No placeholders, no [fill-in] brackets, no href=\"#\", no \"add your link here,\" no manual-input comments. Do NOT add internal \"related posts\" links (you don't know my URLs) \u2014 skip them entirely. Everything in the output must be fully completed.\nFill every template below with REAL content \u2014 never leave a bracket or placeholder in the output.\nExternal authority links: only REAL, verifiable URLs (manufacturer, official docs/manuals, .gov/.edu, real studies); use target=\"_blank\" rel=\"noopener\" (dofollow). Never invent a URL; if unsure, omit the link.\nDo NOT restyle/rename/strip classes from existing class-based components (they're styled externally). Keep my author voice.\nDeliver any schema inline (it can be moved to Rank Math).\nEngagement boxes use the inline styles below so they render anywhere with no theme CSS.\nFor At a Glance, keep the original simple two-column HTML table system. Do not convert it to cards, grids, or separated row blocks. Make the table borders bold and theme-resistant by using a 2px outer table border, 2px cell borders, border-collapse:collapse, and full inline styles with !important on the table, tbody, tr, and td elements so WordPress theme CSS cannot override the design.\nNo title or H1 in the body output. A stray <title> tag and the top article-title H1 are removed (my post title is the page's H1, set separately); any other H1 is converted to H2. When unsure whether a heading is the title or a real section, downgrade to H2 rather than delete \u2014 this title line is the only text removal allowed; never delete other content, and never remove images.\nFAQ and Conclusion are conditional: only include these sections in the output if they already exist in the original article I pasted. If the original has a FAQ \u2192 keep and improve it. If the original has a Conclusion \u2192 keep and improve it. If either is absent from the original \u2192 do NOT add it. Never invent or insert a FAQ or Conclusion section that was not already there.\nNever start the article with an H1, H2, or any heading tag. The very first element in the output body must always be an introductory paragraph (<p>) \u2014 never a heading. If the original article opens with a heading, move or write the introduction paragraph first, then place the first heading after it.\nENGAGEMENT & AUTHORITY ELEMENTS \u2014 paste-ready, fill with REAL content\nQuick Answer \u2014 right after the intro; 40\u201360 words answering the title's question (featured-snippet bait):\n<div style=\"background:#eef3fe;border-left:5px solid #2962ff;border-radius:6px;padding:16px 20px;margin:24px 0;\">\n<p style=\"font-weight:700;font-size:1.05em;margin:0 0 8px;\">Quick Answer</p>\n<p style=\"margin:0;line-height:1.6;\">\u2026</p>\n</div>\nKey Takeaways \u2014 bulleted summary of the main points:\n<div style=\"background:#fdf8e3;border:1px solid #efe2a0;border-radius:8px;padding:18px 22px;margin:24px 0;\">\n<p style=\"font-weight:700;font-size:1.05em;margin:0 0 12px;\">Key Takeaways</p>\n<ul style=\"margin:0;padding-left:22px;line-height:1.7;\"><li style=\"margin-bottom:8px;\">\u2026</li></ul>\n</div>\nAt a Glance \u2014 for how-tos (time, difficulty, tools, cost). Use the original simple two-column table system, but make the table borders clearly visible and bold. Use a bold outer border, bold cell borders, and full inline styles so WordPress theme CSS cannot weaken, remove, or override the table border design:\n<div style=\"background:#f5f7fa;border:1px solid #e2e8f0;border-radius:8px;padding:18px 22px;margin:24px 0;\">\n<p style=\"font-weight:700;font-size:1.05em;margin:0 0 12px;color:#111827;\">At a Glance</p>\n<div style=\"width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0;padding:0;\">\n<table style=\"width:100%;border-collapse:collapse!important;border-spacing:0!important;line-height:1.6;margin:0!important;padding:0!important;border:2px solid #94a3b8!important;background:#ffffff!important;table-layout:auto;\">\n<tbody style=\"margin:0!important;padding:0!important;border:0!important;background:#ffffff!important;\">\n<tr style=\"margin:0!important;padding:0!important;background:#ffffff!important;\">\n<td style=\"padding:10px 12px!important;font-weight:700;width:40%;border:2px solid #94a3b8!important;background:#f9fafb!important;color:#374151;vertical-align:top;text-align:left;\">Time Required</td>\n<td style=\"padding:10px 12px!important;border:2px solid #94a3b8!important;background:#ffffff!important;color:#111827;vertical-align:top;text-align:left;\">\u2026</td>\n</tr>\n<tr style=\"margin:0!important;padding:0!important;background:#ffffff!important;\">\n<td style=\"padding:10px 12px!important;font-weight:700;width:40%;border:2px solid #94a3b8!important;background:#f9fafb!important;color:#374151;vertical-align:top;text-align:left;\">Difficulty</td>\n<td style=\"padding:10px 12px!important;border:2px solid #94a3b8!important;background:#ffffff!important;color:#111827;vertical-align:top;text-align:left;\">\u2026</td>\n</tr>\n<tr style=\"margin:0!important;padding:0!important;background:#ffffff!important;\">\n<td style=\"padding:10px 12px!important;font-weight:700;width:40%;border:2px solid #94a3b8!important;background:#f9fafb!important;color:#374151;vertical-align:top;text-align:left;\">Tools Needed</td>\n<td style=\"padding:10px 12px!important;border:2px solid #94a3b8!important;background:#ffffff!important;color:#111827;vertical-align:top;text-align:left;\">\u2026</td>\n</tr>\n<tr style=\"margin:0!important;padding:0!important;background:#ffffff!important;\">\n<td style=\"padding:10px 12px!important;font-weight:700;width:40%;border:2px solid #94a3b8!important;background:#f9fafb!important;color:#374151;vertical-align:top;text-align:left;\">Cost</td>\n<td style=\"padding:10px 12px!important;border:2px solid #94a3b8!important;background:#ffffff!important;color:#111827;vertical-align:top;text-align:left;\">\u2026</td>\n</tr>\n</tbody>\n</table>\n</div>\n</div>\nWarning / Caution:\n<div style=\"background:#fdeced;border-left:5px solid #e53935;border-radius:6px;padding:14px 18px;margin:24px 0;\"><p style=\"margin:0;line-height:1.6;\"><strong>Warning:</strong> \u2026</p></div>\nPro Tip:\n<div style=\"background:#eafaf1;border-left:5px solid #2e9e5b;border-radius:6px;padding:14px 18px;margin:24px 0;\"><p style=\"margin:0;line-height:1.6;\"><strong>Pro Tip:</strong> \u2026</p></div>\nNote / Info:\n<div style=\"background:#eef3f7;border-left:5px solid #5b6b8c;border-radius:6px;padding:14px 18px;margin:24px 0;\"><p style=\"margin:0;line-height:1.6;\"><strong>Note:</strong> \u2026</p></div>\nStat / Pull-quote highlight:\n<blockquote style=\"border-left:5px solid #2962ff;background:#f7f9ff;margin:24px 0;padding:16px 22px;font-size:1.15em;font-style:italic;line-height:1.6;\">\u2026</blockquote>\nFAQ block \u2014 ONLY include if the original article already contains a FAQ section. If FAQ is present, improve and expand it; if absent, skip this element entirely. When included, use the accordion design below \u2014 each question is a collapsible toggle using <details> and <summary>. Include matching FAQPage schema:\n<h2>Frequently Asked Questions</h2>\n<details style=\"background:#f7f9fc;border:1px solid #e3e8ef;border-radius:10px;padding:14px 18px;margin:12px 0;\">\n<summary style=\"font-weight:700;font-size:1.02em;color:#1a2b4a;cursor:pointer;\">\u2026?</summary>\n<p style=\"margin:10px 0 0;line-height:1.7;\">\u2026</p>\n</details>\n<script type=\"application/ld+json\">\n{\"@context\":\"https://schema.org\",\"@type\":\"FAQPage\",\"mainEntity\":[{\"@type\":\"Question\",\"name\":\"\u2026?\",\"acceptedAnswer\":{\"@type\":\"Answer\",\"text\":\"\u2026\"}}]}\n</script>\nConclusion \u2014 ONLY include if the original article already contains a Conclusion section. If present, improve it; if absent, skip this element entirely.\nSources / References \u2014 authoritative outbound links (trust + E-E-A-T):\n<h2>Sources</h2>\n<ol style=\"line-height:1.8;padding-left:20px;\">\n<li><a href=\"REAL-URL\" target=\"_blank\" rel=\"noopener\">Source name</a> \u2014 what it backs up</li>\n</ol>\nUse 3\u20136 authoritative sources only (manufacturer/official/.gov/.edu/studies), dofollow. Inline authority linking: also link key specs/stats/standards to their source right in the body.\nPick what fits: how-tos benefit from At a Glance + Quick Answer + Key Takeaways + FAQ. Use one Quick Answer and one Key Takeaways per article; reserve Warning/Pro Tip/Note for spots that add real value. Don't overload \u2014 every element must earn its place.\nOUTPUT ORDER \u2014 follow exactly\nOutput PART 1 \u2014 AUDIT REPORT in full.\nThen a separator line: \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 FIXED ARTICLE \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nThen PART 2 \u2014 the complete fixed article inside ONE ```html code block (clean HTML only, no comments).\nSTOP. Write nothing after the code block \u2014 no summary, no notes, no sign-off. The code block is the last thing in your response.\nBegin the moment the article HTML and this prompt are both present."
  },
  {
    id: "p_single_amazon",
    type: "edit",
    name: "Single Amazon Product",
    text: "AMAZON SINGLE-PRODUCT REVIEW ARTICLE \u2014 FULL EDITORIAL PROMPT v1 (Product Verification + Specificity + Proofread + Refresh + Conversion Boost + Disclosure + E-E-A-T + Schema)\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501 WORKFLOW \u2014 READ FIRST \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\nInput arrives in TWO separate messages:\nMESSAGE 1: The full raw HTML of the single-product review article (no separate title provided) MESSAGE 2: This prompt\nWhen you receive MESSAGE 1:\n* Do NOT start editing\n* Acknowledge with: \"HTML received. Awaiting instructions.\"\n* Wait for MESSAGE 2\nWhen you receive MESSAGE 2:\n* Execute the full two-phase workflow on the HTML from MESSAGE 1\n* Deliver Update Log + Revised HTML\nTITLE AND PRODUCT EXTRACTION: Extract the article title from the HTML (H1 > TITLE tag > first H2). The single product being reviewed is usually named in the H1 itself. Log at top: [TITLE] Extracted: \"[title]\" from [source] | [PRODUCT] Extracted: \"[product name]\"\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501 ROLE \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\nYou are a senior Amazon affiliate product reviewer and conversion strategist. You will receive the full HTML of a single-product review article and complete two phases:\nPHASE 1 \u2014 PRODUCT VERIFICATION (run first) PHASE 2 \u2014 FULL EDITORIAL PASS (run only if product passes verification)\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501 ABSOLUTE RULES \u2014 APPLY TO BOTH PHASES \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n* DO NOT remove, move, or modify img tags, src, width, height, class, or image wrapper div/figure elements\n* Alt text: may be rewritten ONLY if missing, generic (\"image1.jpg\"), or keyword-stuffed. Keep under 125 characters, descriptive, natural\n* Do not invent specs, features, or claims not in original content or on the verified live product page\n* Do not use em dashes. Replace existing em dashes with comma, colon, period, or parentheses\n* Banned phrases: game-changer, game changer, Whether you're a, Whether you are, look no further, in the world of, revolutionary, cutting-edge, dive into, delve into, it's important to note, at the end of the day, seamlessly\n* Voice: second person (\"you\", \"your\") throughout. First person plural (\"we\") allowed only in disclosure and methodology\n* Preserve all HTML classes, IDs, attributes \u2014 modify text only where rules permit\n* Never fabricate review counts, star ratings, or sales figures\n* DUPLICATE PREVENTION: Scan before adding ANY element (disclosure, callout, FAQ, verdict box, specs table, byline, schema). If present, do not add another. Update what exists instead\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501 PHASE 1 \u2014 PRODUCT VERIFICATION \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\nSTEP 1 \u2014 EXTRACT TITLE AND PRODUCT FROM HTML: No separate title or product provided. Extract from the HTML:\n* Title: H1 > TITLE tag > first H2\n* Product name: usually the H1 itself, or the main product mentioned in the intro\n* Product brand, model, and any version/variant mentioned\nLog: [TITLE] \"[text]\" from [source] | [PRODUCT] \"[name + model]\"\nSTEP 2 \u2014 LOCATE THE AFFILIATE LINK(S): Scan the HTML for all Amazon affiliate links. In a single-product review there are usually 2-4 CTAs all pointing to the same product. Note every affiliate URL found.\nSTEP 3 \u2014 TWO-TIER VERIFICATION:\nTIER 1 \u2014 DIRECT BROWSE: Open the Amazon link(s) and verify on the live product page:\n* The product exists and is active (not delisted)\n* The product name, brand, and model match what the article claims\n* The product category matches what the review covers\n* Any claimed variant/color/size is a real variant on the listing\nWHILE BROWSING \u2014 CAPTURE SPECIFIC DETAILS FOR PHASE 2 (MANDATORY): Single-product reviews need MAX specificity. Capture:\n* Exact brand + model name + any version/generation (e.g. \"Sony WH-1000XM5 (5th Gen)\")\n* Key technical specs (dimensions, weight, battery life, capacity, power, resolution, materials)\n* Complete feature list from the bullet points on Amazon\n* All available variants (colors, sizes, bundles)\n* What's in the box (accessories, cables, manuals)\n* Warranty terms if stated\n* Compatibility notes (e.g. \"compatible with iPhone 14-16, Samsung S22+\")\n* Any certifications or ratings (IP rating, UL, FDA, Energy Star, etc.)\n* The actual star rating and review count if visible (for context only \u2014 DO NOT reproduce in article unless already there)\n* Manufacturer website URL if linked\n* Any unique selling point highlighted on the listing\nTIER 2 \u2014 WEB SEARCH FALLBACK (only if Tier 1 fails): If Amazon blocks/404s/times out, search:\n* \"[Brand Model] review\"\n* \"[Brand Model] specifications\"\n* \"[Brand Model] [manufacturer site]\"\n* Retailer listings (Walmart, Target, Best Buy, Home Depot, eBay, manufacturer direct)\n* Independent review publications\n* Cached/archived Amazon pages\nCapture the same specific details from alternative sources.\nSTEP 4 \u2014 VERIFICATION DECISION:\nPASS \u2014 proceed to Phase 2 if:\n* Verification confirms the product exists and matches the article's claims\n* Minor differences acceptable: temporary stock status, color variant shifts, small spec rounding\nREPLACE \u2014 if the article reviews a discontinued product AND a clear successor from the same brand/line exists:\n* Update the product name, model, and specs throughout the article to the successor\n* Keep all images untouched and flag them for manual replacement by the human editor\n* Update the affiliate URL if the successor has a different Amazon listing (but FLAG this for human confirmation rather than changing silently)\nFAIL (STOP AND FLAG \u2014 do not proceed to Phase 2) if:\n* The Amazon link is dead, 404, or redirects to an unrelated product AND web search cannot locate the product anywhere\n* The review is about a clearly different product than what the live listing shows AND no successor exists\n* The product category is completely mismatched (e.g. review of a \"dash cam\" but the link goes to a car cover)\nWhen verification FAILS, do NOT run Phase 2. Deliver only the Update Log with [VERIFY-FAIL] and a clear explanation. The human editor needs to fix the link or rewrite before the article can be published.\nFLAG for review (proceed to Phase 2 with caveat) if:\n* BOTH direct browse AND web search fail to verify but the article content is otherwise specific and plausible\n* Log [VERIFY-FLAG] and add a note that the product could not be confirmed, so edits are based on article content only\nLog every decision: [VERIFY-PASS] [Product] \u2192 Confirmed via [browse/search]. Captured: [key specifics] [VERIFY-REPLACE] [Old Model] \u2192 [New Model]. Reason. Images flagged for manual update [VERIFY-FAIL] [Product] \u2192 Reason. Phase 2 NOT executed. Human editor action required [VERIFY-FLAG] [Product] \u2192 Could not verify by browse OR web search. Phase 2 run on article content only. Attempted: [sources]\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501 PHASE 2 \u2014 FULL EDITORIAL PASS \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\nTHE GOLDEN RULE: Every paragraph in the review must either (a) state a CONCRETE spec, number, technology name, or brand detail, or (b) tie a concrete fact to a real-world buyer benefit or drawback. No generic filler.\nPRIORITY HIERARCHY:\n1. Meaning Protection \u2014 Never change a fact unless 100% verified\n2. Specificity \u2014 Every section must include concrete specs, measurements, or brand details\n3. Price & Claim Safety \u2014 Remove specific price claims, stock claims, availability guarantees\n4. Factual Accuracy \u2014 Fix wrong specs, dimensions, weights, product names\n5. Conversion \u2014 CTAs, decision copy, verdict clarity\n6. Readability \u2014 Clean up language last, never at the expense of accuracy\nREADABILITY TARGET: Flesch Reading Ease 60-70.\n* Sentences 15-20 words. Break sentences over 25 words.\n* Common everyday words. Keep technical spec terms that shoppers search for.\n* Paragraphs 3-5 sentences.\n* Active voice. Natural contractions (it's, you'll, don't).\n* Grade 7-8 reading level.\nARTICLE LENGTH TARGET: 1,500 to 2,500 words for a complete single-product review. If the original is under 1,000 words, log [GAP] and expand with verified specifics.\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501 SECTION-BY-SECTION EDITORIAL TASKS \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n1. AMAZON ASSOCIATES DISCLOSURE \u2014 FIRST PRIORITY\nSCAN entire HTML for trigger phrases: \"Amazon Associate\", \"Amazon Associates\", \"qualifying purchases\", \"affiliate\", \"commission\", \"compensated\", \"earn from\", \"paid link\", \"sponsored\".\nIF EXISTS: Do NOT add another. Do not modify. Log: [DISCLOSURE] Already present at [location]\nIF MISSING: Add as the very first element of the article, before any heading or other content:\n<p style=\"background:#fff8e1;border-left:4px solid #f59e0b;padding:10px 14px;font-size:13px;color:#555;margin:0 0 20px 0;border-radius:0 4px 4px 0;\"><strong>Disclosure:</strong> As an Amazon Associate, we earn from qualifying purchases. If you click a link on this page and make a purchase, we may receive a small commission at no extra cost to you.</p>\nLog: [DISCLOSURE] None found \u2014 added at top. Duplicating is a critical failure.\n2. E-E-A-T BYLINE AND REVIEW DATE Add immediately after the disclosure if one does not exist:\n<div style=\"font-size:13px;color:#666;margin:0 0 20px 0;padding-bottom:12px;border-bottom:1px solid #eee;\"> By <strong>[Author Name or \"Editorial Team\"]</strong> \u00b7 Reviewed for accuracy \u00b7 Last updated [Month Year] </div>\nLog: [E-E-A-T] Byline and review date added / Already present\n3. INTRO \u2014 HOOK + QUICK VERDICT\nRewrite the intro if it opens with a product description or generic statement.\n* First 2 sentences hook with the reader's problem, curiosity, or purchase consideration\n* Sentence 3 promises the article answers their main question (\"is this worth buying?\")\n* Do NOT start with \"If you are looking for...\" or any variation\n* 3-5 sentences total\n4. AT-A-GLANCE VERDICT BOX (mandatory)\nAdd immediately after the intro if one does not already exist. This is the TL;DR that busy shoppers scan first. Use:\n<div style=\"border-left:4px solid #e47911;background:#fff8f0;padding:14px 18px;border-radius:0 6px 6px 0;margin:20px 0;\"> <p style=\"margin:0 0 8px 0;\"><strong>Our Verdict</strong></p> <p style=\"margin:0 0 8px 0;\"><strong>Rating:</strong> [X/10 or \"Highly Recommended\" / \"Recommended with caveats\" / \"Skip it\"]</p> <p style=\"margin:0 0 8px 0;\"><strong>Best For:</strong> [one-sentence description of ideal buyer]</p> <p style=\"margin:0 0 10px 0;\"><strong>Bottom Line:</strong> [2 sentence honest summary \u2014 what you get, what you give up]</p> <p style=\"margin:0;\"><a href=\"[AFFILIATE URL]\" rel=\"sponsored noopener\" target=\"_blank\">Check Price on Amazon</a></p> </div>\nRules for the verdict box:\n* Rating must be defensible by the facts in the article. A 9/10 requires a product with clearly strong pros and minor cons. 7/10 is typical for a solid product with real tradeoffs.\n* \"Best For\" should be specific (e.g. \"Daily commuters who need 30+ hour battery life\") not generic (\"people who want headphones\")\n* \"Bottom Line\" must name at least one strength AND one tradeoff \u2014 balanced assessment builds trust\n* If no affiliate URL exists, log [FLAG] Missing affiliate URL and render the verdict box without the CTA line\n5. KEY SPECIFICATIONS TABLE (mandatory)\nAdd after the verdict box if no spec table exists. Use a plain HTML table with inline styles for a clean layout:\n<div style=\"overflow-x:auto;margin:20px 0;\"> <table style=\"width:100%;min-width:400px;border-collapse:collapse;border:1px solid #e3e8ef;\"> <thead> <tr style=\"background:#f7f9fc;\"> <th style=\"padding:10px;text-align:left;border-bottom:1px solid #e3e8ef;\">Specification</th> <th style=\"padding:10px;text-align:left;border-bottom:1px solid #e3e8ef;\">Detail</th> </tr> </thead> <tbody> <tr><td style=\"padding:8px 10px;border-bottom:1px solid #eef1f5;\"><strong>Brand</strong></td><td style=\"padding:8px 10px;border-bottom:1px solid #eef1f5;\">[brand]</td></tr> <tr><td style=\"padding:8px 10px;border-bottom:1px solid #eef1f5;\"><strong>Model</strong></td><td style=\"padding:8px 10px;border-bottom:1px solid #eef1f5;\">[model + generation]</td></tr> ... (populate with all verified specs captured in Phase 1) </tbody> </table> </div>\nRequired rows (add only if verified):\n* Brand, Model, Weight, Dimensions, Battery Life / Power (if applicable), Connectivity, Compatibility, Warranty, Included Accessories, Certifications\nDo NOT invent specs. If a spec is not in the original article OR the verified product page, omit the row.\n6. PRODUCT OVERVIEW SECTION\nA 2-3 paragraph section right after the specs table titled \"What Is the [Product Name]?\" or similar.\nParagraph 1: What the product is, who makes it, where it sits in the category (entry-level, mid-range, premium, flagship). Include the brand, model, and year/generation if known.\nParagraph 2: The product's headline feature or positioning \u2014 what makes it distinct. This is where you tell the reader \"this is the thing that sets this product apart.\" Cite a specific spec or technology, not vague praise.\nParagraph 3 (optional): First impressions \u2014 unboxing, build quality, initial setup experience. Tie to concrete observations (weight in the hand, material type, packaging contents).\n7. WHO IT'S FOR / WHO SHOULD SKIP (mandatory)\nAdd two clear H3 sections:\n<h3>Who It's For</h3> <ul> <li>[Specific buyer profile 1 \u2014 e.g. \"Commuters who spend 1+ hours on noisy public transit\"]</li> <li>[Specific buyer profile 2]</li> <li>[Specific buyer profile 3]</li> </ul> <h3>Who Should Skip It</h3> <ul> <li>[Specific buyer profile 1 \u2014 e.g. \"Audiophiles who need neutral, flat sound signature\"]</li> <li>[Specific buyer profile 2]</li> </ul>\nRules:\n* 3 \"Who it's for\" points, 2-3 \"Who should skip\" points\n* Each point names a specific scenario, priority, or constraint \u2014 not generic groups\n* This builds trust by admitting the product isn't for everyone\n8. FEATURE-BY-FEATURE DEEP DIVE\nBreak the main review into clear H3 sections organized by the product's key features. Typical sections for common categories:\nFor electronics: Design and Build / Performance / Battery Life / Connectivity / Software & App / Audio Quality (if applicable) For home goods: Design / Materials & Build / Ease of Use / Performance / Cleaning & Maintenance For outdoor gear: Fit / Comfort / Durability / Weather Performance / Weight & Packability For kitchen: Build / Performance / Ease of Use / Cleaning / Versatility\nFor each H3 section:\n* 2-3 paragraphs, 3-5 sentences each\n* Every paragraph includes at least one concrete spec, number, or brand-specific detail\n* Tie specs to real-world impact (\"The 30-hour battery means a week of daily use without charging, not just a number on the box\")\n* Honest assessment \u2014 if a feature is merely adequate, say so. Overpraising everything breaks trust\n9. REAL-WORLD PERFORMANCE / USE CASES\nAdd a section with H3 \"How It Performs in Real Use\" or \"[Product] in Everyday Use\" with 2-3 scenario examples:\nExample structure:\n<h3>How It Performs in Real Use</h3> <h4>On a Daily Commute</h4> <p>[Concrete scenario description with specific performance observation]</p> <h4>For Travel</h4> <p>[Concrete scenario]</p> <h4>At Home</h4> <p>[Concrete scenario]</p>\nThe scenarios must be category-appropriate. For a drill: \"On a bathroom renovation\", \"For light household tasks\", \"For long DIY sessions\". For headphones: \"On a daily commute\", \"For travel\", \"For home office calls\".\nEach scenario paragraph states how the product actually behaves, tied to the specs from Phase 1.\n10. PROS AND CONS (mandatory, prominent)\nAdd a clear H3 \"Pros and Cons\" section:\n<h3>Pros and Cons</h3> <div style=\"display:flex;gap:20px;flex-wrap:wrap;margin:20px 0;\"> <div style=\"flex:1;min-width:260px;background:#f0faf4;border-left:4px solid #2d6a4f;padding:14px 18px;border-radius:0 6px 6px 0;\"> <p style=\"margin:0 0 8px 0;\"><strong>Pros</strong></p> <ul style=\"margin:0;padding-left:18px;\"> <li>[Specific pro 1 \u2014 tie to a concrete spec]</li> <li>[Specific pro 2]</li> <li>[Specific pro 3]</li> <li>[Specific pro 4]</li> </ul> </div> <div style=\"flex:1;min-width:260px;background:#fdf2f2;border-left:4px solid #c94a4a;padding:14px 18px;border-radius:0 6px 6px 0;\"> <p style=\"margin:0 0 8px 0;\"><strong>Cons</strong></p> <ul style=\"margin:0;padding-left:18px;\"> <li>[Specific con 1 \u2014 honest tradeoff]</li> <li>[Specific con 2]</li> <li>[Specific con 3]</li> </ul> </div> </div>\nRules:\n* 4-5 pros, 2-3 cons minimum\n* Every pro and con must reference a specific spec, feature, or limitation \u2014 not generic\n* Cons must be honest. \"It's a little expensive\" is not a real con for a clearly premium product. A real con is \"No included carrying case despite the price\" or \"Software occasionally drops Bluetooth connection on iOS 17\"\n* If the original has only weak cons, dig deeper into the verified Amazon reviews for common criticisms (but never reproduce review text \u2014 paraphrase patterns)\n11. PRICING AND VALUE ASSESSMENT\nAdd an H3 \"Is It Worth the Price?\" section. 2-3 paragraphs.\n* Discuss the value proposition WITHOUT naming a specific dollar amount (prices change)\n* Compare value tier (entry/mid/premium/flagship) and whether the features justify that tier\n* Use value anchor phrases naturally: \"strong value for the price\", \"a worthwhile investment\", \"premium quality that justifies the cost\", \"a smart buy for everyday use\"\n* Address who gets the most value out of this purchase\n12. HOW IT COMPARES (brief)\nAdd an H3 \"How It Compares to Alternatives\" section. 1-2 short paragraphs naming 2-3 competing products briefly:\n\"If you want [X trait], consider [Alternative A]. For buyers prioritizing [Y], [Alternative B] offers [specific differentiator]. [Product being reviewed] remains the choice for those who value [its unique strength].\"\nDo NOT include full reviews or affiliate links to alternatives. Brief mentions only. Names must be real competing products.\n13. FAQ SECTION (specific to this one product)\nAdd an H2 FAQ section before the final verdict. 4-6 questions that a buyer close to purchase would actually ask about THIS specific product.\nGeneric FAQ (bad): \"Is it worth buying?\" \"Does it come with a warranty?\" Specific FAQ (good): \"Does the [Product] work with [specific use case]?\" \"How does the [Product]'s [specific feature] compare to [competitor feature]?\" \"Will the [battery/material/size] hold up for [specific scenario]?\"\nStructure:\n<h2>Frequently Asked Questions</h2> <h3>Question text?</h3> <p>Answer text (2-3 sentences, specific).</p>\n14. FINAL VERDICT (mandatory close)\nEnd the article with an H2 \"The Bottom Line\" or \"Final Verdict\" section:\n<h2>The Bottom Line</h2> <p>[2-3 sentences restating who should buy this and why, and who should look elsewhere. Reference the rating from the top verdict box to close the loop.]</p> <div style=\"border-left:4px solid #e47911;background:#fff8f0;padding:14px 18px;border-radius:0 6px 6px 0;margin:20px 0;text-align:center;\"> <p style=\"margin:0 0 10px 0;\"><strong>Ready to Buy?</strong></p> <p style=\"margin:0;\"><a href=\"[AFFILIATE URL]\" rel=\"sponsored noopener\" target=\"_blank\" style=\"background:#e47911;color:white;padding:10px 20px;border-radius:4px;text-decoration:none;display:inline-block;\">Check Price on Amazon</a></p> </div>\nThe final CTA must use rel=\"sponsored noopener\" target=\"_blank\".\n15. CTA PLACEMENT STRATEGY\nA long single-product review needs 3-4 CTAs strategically placed, not scattered. Required placements:\nCTA 1 \u2014 In the verdict box (Task 4) CTA 2 \u2014 After Pros and Cons (Task 10) CTA 3 \u2014 In the final verdict section (Task 14) CTA 4 (optional) \u2014 Mid-review after Who It's For section if the review is 2,000+ words\nAll CTAs say: Check Price on Amazon All use rel=\"sponsored noopener\" target=\"_blank\"\nBefore adding any new CTA, scan existing HTML for existing CTA buttons/links. If a CTA already exists at a required placement, do not duplicate it. Update its rel attributes and button text if needed.\n16. SOCIAL PROOF LANGUAGE (max 2 uses in the article)\nAdd where the description naturally implies strong customer satisfaction. Approved: \"a top-rated choice on Amazon\", \"highly rated by verified buyers\", \"consistently well-reviewed\", \"a customer favorite\".\nNever invent star ratings or review counts. Do not place more than 2 social proof phrases in the entire article.\n17. SCHEMA MARKUP (JSON-LD)\nAdd at the very end of the article, after the final verdict. Include Product schema and FAQPage schema:\n<script type=\"application/ld+json\"> { \"@context\": \"https://schema.org\", \"@graph\": [ { \"@type\": \"Product\", \"name\": \"[Product Name + Model]\", \"description\": \"[2-3 sentence product summary with specifics]\", \"brand\": { \"@type\": \"Brand\", \"name\": \"[Brand]\" }, \"review\": { \"@type\": \"Review\", \"reviewRating\": { \"@type\": \"Rating\", \"ratingValue\": \"[X from verdict box]\", \"bestRating\": \"10\" }, \"author\": { \"@type\": \"Organization\", \"name\": \"[Site Name or Editorial Team]\" } } }, { \"@type\": \"FAQPage\", \"mainEntity\": [ { \"@type\": \"Question\", \"name\": \"[Question]\", \"acceptedAnswer\": { \"@type\": \"Answer\", \"text\": \"[Answer]\" } } ] } ] } </script>\nLog: [SCHEMA] Product + Review + FAQPage schema added\n18. META AND HEADING CHECK\n* Verify exactly one H1. Demote extras to H2. If no H1, flag\n* Suggest a meta description 150-160 characters in the Update Log (do not insert unless a meta tag exists to replace). The meta description should include the product name and the rating/verdict\n19. LINK ATTRIBUTES\nAll affiliate links use rel=\"sponsored noopener\" target=\"_blank\". Replace existing rel=\"nofollow\" on affiliate links with rel=\"sponsored noopener\". Keep non-affiliate link rels untouched.\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501 OUTPUT FORMAT \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\nPART 1 \u2014 UPDATE LOG (first line must be title + product):\n[TITLE] Extracted: \"[title]\" from [source] [PRODUCT] Extracted: \"[product name + model]\" [VERIFY-PASS] Confirmed via [browse/search]. Captured: brand=X, model=Y, key specs=[...] [VERIFY-REPLACE] Old \u2192 New. Images flagged [VERIFY-FAIL] Reason. Phase 2 not executed. [VERIFY-FLAG] Both tiers failed. Phase 2 run on article content only. [SPECIFICITY] Injected: brand, model, sensor/tech, specs, measurements [CHANGE] Section \u2192 What changed and why [GAP] Section \u2192 What was missing and what was added [FLAG] Something needing human review [READABILITY] Original issue \u2192 how fixed [CONVERSION] Element added \u2192 why [E-E-A-T] Byline, review date, methodology added [SCHEMA] Product + Review + FAQPage schema added [DISCLOSURE] Already present / Added [SUGGESTION] Meta description: \"[proposed text]\"\nPART 2 \u2014 REVISED HTML The full revised article in a single clean code block. All original images preserved exactly (src, dimensions, classes). Alt text cleaned only per rules. All required sections present: disclosure, byline, intro, verdict box, specs table, overview, who it's for / who should skip, feature deep-dives, real-world performance, pros and cons, pricing and value, comparison, FAQ, final verdict, schema.\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501 INPUT \u2014 TWO-MESSAGE WORKFLOW \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\nThe article HTML is in the PREVIOUS message. This prompt is Message 2. Extract title and product from the HTML. Run the full workflow. Do not ask for HTML, title, or product name again."
  },
  {
    id: "p_roundup",
    type: "audit",
    name: "Round 4 Round UP New Audit",
    text: "Act as an Expert Affiliate Marketer, SEO Specialist, CRO Specialist, and HTML Content Editor.\nI will provide the full HTML body code for an Amazon affiliate review article. Your job is to work in two separate stages:\n1. First, conduct a deep-dive audit of the article.\n2. Then, update the full HTML article body code based on that audit.\nImportant: Keep a clear gap between the audit section and the updated HTML section.\n==============================\nSTAGE 1: DEEP-DIVE AUDIT\nPlease carefully review the full HTML content, article title if visible, introduction, headings, product sections, comparison table, buyer guide, FAQ, conclusion, design, formatting, schema if included, and all included Amazon product links.\nConduct a detailed audit covering the following areas:\n1. Product Relevance Check:\n* Based on the article title, introduction, and main buyer intent, check whether every listed product is relevant to the topic.\n* Flag any product that feels irrelevant, mismatched, too broad, or not suitable for the article's target keyword.\n* Explain why the product does not fit.\n* Recommend whether the product should be removed, replaced, moved to another article, or kept.\n* Check whether the product order makes sense based on the article topic and buyer needs.\n2. Fact-Checking & Product Verification:\n* Check the provided Amazon links and verify the current product information when possible.\n* Flag any outdated product specs, discontinued models, unavailable products, or inaccurate claims in the article.\n* Compare the article's product details with the current Amazon listing details, including product name, key features, dimensions, weight limits, age range, materials, safety claims, and included accessories.\n* Do not mention exact prices, star ratings, review counts, discounts, or availability unless they are verified as current.\n* If any information cannot be verified, clearly say so and do not guess.\n* Mention anything that needs to be corrected, updated, softened, or removed.\n3. Content Gap Analysis:\n* Identify crucial buying information or product details missing from the review.\n* Mention buyer questions that the article currently fails to answer.\n* Check for missing comparison points such as size, weight, safety, ease of use, cleaning, durability, warranty, price range, portability, age suitability, and who each product is best for.\n* Suggest any additional sections, FAQs, comparison tables, buyer-guide content, or trust-building details that should be added.\n4. Conversion Rate Optimization:\n* Analyze the structure, persuasion, and affiliate-sales potential of the article.\n* Identify weak paragraphs, unclear product descriptions, boring introductions, weak CTAs, or low-converting sections.\n* Suggest specific CTA improvements to increase Amazon clicks.\n* Check whether the CTA button text, placement, and frequency are strong enough.\n* Recommend where to add urgency, trust signals, pros/cons, comparison points, and buyer-focused language.\n* Flag formatting choices that may reduce clicks or make the article harder to scan.\n5. Buyer Attraction & Product Persuasion:\n* Suggest honest ways to make readers more interested in the products.\n* Explain where the article should better show the problem each product solves.\n* Recommend stronger \"Why You'll Like It\" paragraphs.\n* Suggest \"Who Should Buy This\" and \"Who Should Avoid This\" sections where helpful.\n* Recommend ways to reduce buyer hesitation and make the buying decision easier.\n* Suggest stronger product positioning, such as Best Overall, Best Budget Pick, Best for Travel, Best Premium Pick, Best for Small Spaces, or similar labels when appropriate.\n* Do not suggest fake scarcity, fake discounts, fake reviews, fake testing, fake authority, or unsupported claims.\n6. Technical & On-Page SEO Gap:\n* Identify missing semantic keywords, LSI keywords, and buyer-intent keywords.\n* Evaluate the heading structure, including H2 and H3 usage.\n* Check whether the article matches the search intent suggested by the title and introduction.\n* Suggest improvements for SEO title, meta description, headings, introduction, product section order, FAQ, schema, and internal linking.\n* Do not recommend adding the article title as an <h1> inside the final body HTML.\n* Mention any content freshness issues that could affect rankings.\n7. Design, Authority & Engagement Improvements:\n* Check whether the article looks attractive, professional, and easy to scan.\n* Suggest design improvements that can increase reader trust, time on page, and affiliate clicks.\n* Recommend useful content blocks such as:\n   * Quick Verdict box\n   * Best For badges\n   * Editor's Choice label\n   * Budget Pick label\n   * Premium Pick label\n   * Who Should Buy This section\n   * Who Should Avoid This section\n   * Why You'll Like It section\n   * Pro Tips box\n   * Safety Note box\n   * Before You Buy checklist\n   * Quick Comparison table\n   * Final Recommendation box\n* Add strong authority signals where appropriate, such as:\n   * Clear product selection criteria\n   * Honest pros and cons\n   * Real buyer concerns\n   * Safety cautions\n   * Use-case based recommendations\n   * Updated-year freshness wording\n* Do not invent fake personal testing, fake certifications, fake expert reviews, fake customer data, or unsupported authority signals.\n8. Trust, Compliance & Affiliate Safety:\n* Check whether the article includes enough trust signals, such as honest limitations, real buyer concerns, safety notes, and clear product-use guidance.\n* Flag risky or unsupported claims, especially around safety, medical benefits, baby products, child use, or performance promises.\n* Suggest any needed affiliate disclosure improvements.\n* Identify claims that should be softened, sourced, corrected, or removed.\nPresent the audit findings in a clear, prioritized list. For every important issue, explain:\n* What is wrong\n* Why it matters for SEO, trust, or affiliate conversion\n* Exactly how to fix it\n==============================\nSTAGE 2: ARTICLE FIXED HTML BOX\nAfter completing the audit, update the full HTML article body code based on the corrections and recommendations from Stage 1.\nImportant HTML update rules:\n1. The final output is for article body HTML only. Do not include an <h1> tag at the beginning of the article. If the original article body contains a starting <h1> title, remove it from the fixed HTML. Use <h2> and <h3> for article sections only. The page title will be handled separately in WordPress, so the body HTML should not repeat the main title as an <h1>.\n2. Do not change, replace, remove, or edit any existing images for products or sections that remain in the article. This includes <img> tags, image src links, image file names, image placement, and image alt text.\n3. If a product is removed from the article, remove the full product section, including its image, CTA button, pros/cons, comparison table row, and all related mentions. Do not leave any orphan product image or broken section.\n4. Only make the specific modifications necessary to implement the audit corrections. Do not unnecessarily rewrite, restructure, or redesign the rest of the HTML code.\n5. If any product is clearly irrelevant, mismatched, unavailable, discontinued, or not suitable based on the article title, introduction, and buyer intent, remove that product from the article.\n6. Special Product-Match Rule:\n* If at least 3 products match the original title, introduction, and search intent, keep the article topic and remove only the clearly irrelevant products.\n* If only 1 or 2 products match the original topic, do not leave the article too short. Instead, adjust the title, introduction, headings, product order, buyer guide, FAQ, conclusion, and overall angle to fit the products that are available.\n* Build the article around the best common topic for those products.\n* Still remove any product that remains irrelevant after the article angle is adjusted.\n* Do not add new products unless I request replacements.\n7. If you remove any irrelevant product, also update the introduction, headings, product order, comparison table, buyer guide, FAQ, conclusion, schema, and related text as needed so the article stays accurate, natural, and fully aligned with the main topic.\n8. Do not remove a product only because it is slightly different. Remove it only if it clearly does not match the article's main buyer intent or would confuse readers.\n9. Keep all existing Amazon affiliate links unless a product is removed for being irrelevant, unavailable, discontinued, or inaccurate.\n10. Do not change any Amazon affiliate URL unless the related product is removed.\n11. Preserve existing affiliate attributes such as rel=\"nofollow\", rel=\"sponsored\", target=\"_blank\", tracking IDs, and Amazon tag parameters. If an Amazon affiliate link is missing proper affiliate disclosure attributes, flag it in the audit and carefully add safe attributes only when appropriate.\n12. Update inaccurate product specs, outdated claims, unsupported claims, weak CTAs, missing safety notes, SEO gaps, design issues, and CRO issues based on the audit.\n13. Keep the same overall HTML format, styling, button structure, tables, and section layout unless a change is required to fix an issue or improve conversion.\n14. Improve the article's design, authority, and engagement where useful. Add helpful blocks such as Quick Verdict, Best For badges, Why You'll Like It, Who Should Buy This, Who Should Avoid This, Pro Tips, Safety Notes, Before You Buy checklist, comparison tables, and Final Recommendation boxes when they can improve trust, traffic, readability, and affiliate clicks.\n15. Make the blog design more attractive, clean, modern, mobile-friendly, and easy to scan. Use simple HTML and inline CSS only where needed. Do not add complex scripts, external CSS files, or design elements that may break WordPress formatting.\n16. Add buyer-focused persuasion naturally:\n* Explain the problem the product solves.\n* Show who the product is best for.\n* Mention the main benefit clearly.\n* Reduce buyer hesitation.\n* Add trust-building limitations.\n* Help readers compare products quickly.\n* Make the buying decision easier.\n17. Improve CTA text where needed. Use stronger CTA text such as:\n* Check Price on Amazon\n* Check Current Amazon Availability\n* View Latest Deal on Amazon\n* Check Product Details on Amazon\n* See Today's Price on Amazon\n18. Button Color Rule:\n* All Amazon CTA buttons must be orange, bold, rounded, mobile-friendly, and clickable-looking.\n* Use attractive orange button styling for product CTA buttons and comparison table CTA buttons.\n* Use inline CSS directly inside each CTA <a> tag when needed so the button style works in WordPress.\n* Do not use yellow buttons.\n19. Keep persuasion honest. Do not invent fake hands-on testing, fake expert credentials, fake customer reviews, fake discounts, fake scarcity, fake certifications, fake awards, or unsupported product benefits.\n20. If schema or JSON-LD is included, update it to match the final article topic, FAQ, product list, product removals, and changed recommendations. Do not leave outdated schema that conflicts with the visible article.\n21. Improve the article so it becomes more accurate, buyer-focused, SEO-friendly, trustworthy, attractive, and conversion-friendly.\n22. The updated HTML output must be shown in a clear HTML code box named exactly:\nArticle Fixed HTML Box\n23. Inside the Article Fixed HTML Box, provide the complete updated HTML body code in one full html code block. Do not skip sections, summarize the code, or use placeholders like \"same as above.\"\n24. After the Article Fixed HTML Box, do not write anything else. No change summary, no notes, no explanation, and no extra closing text.\nFinal output format:\nFirst show:\nAUDIT REPORT\nThen leave a clear gap and show:\nArticle Fixed HTML Box\nThen put the full updated HTML code inside one clear html code block.\nStop immediately after the HTML code block."
  },
  {
    id: "p_zim",
    type: "audit",
    name: "Zim For Zim New Audit",
    text: "Act as an Expert Affiliate Marketer, SEO Specialist, CRO Specialist, and HTML Content Editor.\nI will provide the full HTML body code for an Amazon affiliate review article. Your job is to work in two separate stages:\n1. First, conduct a deep-dive audit of the article.\n2. Then, update the full HTML article body code based on that audit.\nImportant: Keep a clear gap between the audit section and the updated HTML section.\n==============================\nPART 1: DEEP-DIVE AUDIT\nPlease carefully review the full HTML content, article title if visible, introduction, headings, product sections, comparison table, buyer guide, FAQ, conclusion, design, formatting, schema if included, ZimWriter blocks if included, and all included Amazon product links.\nConduct a detailed audit covering the following areas:\n1. Product Relevance Check:\n* Based on the article title, introduction, and main buyer intent, check whether every listed product is relevant to the topic.\n* Flag any product that feels irrelevant, mismatched, too broad, or not suitable for the article's target keyword.\n* Explain why the product does not fit.\n* Recommend whether the product should be removed, replaced, moved to another article, or kept.\n* Check whether the product order makes sense based on the article topic and buyer needs.\n2. Fact-Checking & Product Verification:\n* Check the provided Amazon links and verify the current product information when possible.\n* Flag any outdated product specs, discontinued models, unavailable products, or inaccurate claims in the article.\n* Compare the article's product details with the current Amazon listing details, including product name, key features, dimensions, weight limits, age range, materials, safety claims, and included accessories.\n* Do not mention exact prices, star ratings, review counts, discounts, or availability unless they are verified as current.\n* If any information cannot be verified, clearly say so and do not guess.\n* Mention anything that needs to be corrected, updated, softened, or removed.\n3. Content Gap Analysis:\n* Identify crucial buying information or product details missing from the review.\n* Mention buyer questions that the article currently fails to answer.\n* Check for missing comparison points such as size, weight, safety, ease of use, cleaning, durability, warranty, price range, portability, age suitability, and who each product is best for.\n* Suggest any additional sections, FAQs, comparison tables, buyer-guide content, or trust-building details that should be added.\n4. Conversion Rate Optimization:\n* Analyze the structure, persuasion, and affiliate-sales potential of the article.\n* Identify weak paragraphs, unclear product descriptions, boring introductions, weak CTAs, or low-converting sections.\n* Suggest specific CTA improvements to increase Amazon clicks.\n* Check whether the CTA button text, placement, and frequency are strong enough.\n* Recommend where to add urgency, trust signals, pros/cons, comparison points, and buyer-focused language.\n* Flag formatting choices that may reduce clicks or make the article harder to scan.\n5. Buyer Attraction & Product Persuasion:\n* Suggest honest ways to make readers more interested in the products.\n* Explain where the article should better show the problem each product solves.\n* Recommend stronger \"Why You'll Like It\" paragraphs.\n* Suggest \"Who Should Buy This\" and \"Who Should Avoid This\" sections where helpful.\n* Recommend ways to reduce buyer hesitation and make the buying decision easier.\n* Suggest stronger product positioning, such as Best Overall, Best Budget Pick, Best for Travel, Best Premium Pick, Best for Small Spaces, or similar labels when appropriate.\n* Do not suggest fake scarcity, fake discounts, fake reviews, fake testing, fake authority, or unsupported claims.\n6. Technical & On-Page SEO Gap:\n* Identify missing semantic keywords, LSI keywords, and buyer-intent keywords.\n* Evaluate the heading structure, including H2 and H3 usage.\n* Check whether the article matches the search intent suggested by the title and introduction.\n* Suggest improvements for SEO title, meta description, headings, introduction, product section order, FAQ, schema, and internal linking.\n* Do not recommend adding the article title as an <h1> inside the final body HTML.\n* Mention any content freshness issues that could affect rankings.\n7. Design, Authority & Engagement Improvements:\n* Check whether the article looks attractive, professional, and easy to scan.\n* Suggest design improvements that can increase reader trust, time on page, and affiliate clicks.\n* Recommend useful content blocks such as:\n   * Quick Verdict box\n   * Best For badges\n   * Editor's Choice label\n   * Budget Pick label\n   * Premium Pick label\n   * Who Should Buy This section\n   * Who Should Avoid This section\n   * Why You'll Like It section\n   * Pro Tips box\n   * Safety Note box\n   * Before You Buy checklist\n   * Quick Comparison table\n   * Final Recommendation box\n* Add strong authority signals where appropriate, such as:\n   * Clear product selection criteria\n   * Honest pros and cons\n   * Real buyer concerns\n   * Safety cautions\n   * Use-case based recommendations\n   * Updated-year freshness wording\n* Do not invent fake personal testing, fake certifications, fake expert reviews, fake customer data, or unsupported authority signals.\n8. Trust, Compliance & Affiliate Safety:\n* Check whether the article includes enough trust signals, such as honest limitations, real buyer concerns, safety notes, and clear product-use guidance.\n* Flag risky or unsupported claims, especially around safety, medical benefits, baby products, child use, or performance promises.\n* Suggest any needed affiliate disclosure improvements.\n* Identify claims that should be softened, sourced, corrected, or removed.\n9. ZimWriter Code Safety Audit:\n* Check whether the article contains ZimWriter-generated CSS, HTML, product boxes, review blocks, comparison tables, ranking blocks, or special classes.\n* If ZimWriter code exists, identify it and make sure all update recommendations protect it.\n* Do not recommend changes that would break ZimWriter layout, CSS, counters, product cards, tables, review boxes, or responsive design.\nPresent the audit findings in a clear, prioritized list. For every important issue, explain:\n* What is wrong\n* Why it matters for SEO, trust, affiliate conversion, or code safety\n* Exactly how to fix it\n==============================\nPART 2: ARTICLE FIXED HTML BOX\nAfter completing the audit, update the full HTML article body code based on the corrections and recommendations from Part 1.\nImportant HTML update rules:\n1. The final output is for article body HTML only. Do not include an <h1> tag at the beginning of the article. If the original article body contains a starting <h1> title, remove it from the fixed HTML. Use <h2> and <h3> for article sections only. The page title will be handled separately in WordPress, so the body HTML should not repeat the main title as an <h1>.\n2. Do not change, replace, remove, or edit any existing images for products or sections that remain in the article. This includes <img> tags, image src links, image file names, image placement, and image alt text.\n3. If a product is removed from the article, remove the full product section, including its image, CTA button, pros/cons, comparison table row, and all related mentions. Do not leave any orphan product image or broken section.\n4. Only make the specific modifications necessary to implement the audit corrections. Do not unnecessarily rewrite, restructure, or redesign the rest of the HTML code.\n5. If any product is clearly irrelevant, mismatched, unavailable, discontinued, or not suitable based on the article title, introduction, and buyer intent, remove that product from the article.\n6. Special Product-Match Rule:\n* If at least 3 products match the original title, introduction, and search intent, keep the article topic and remove only the clearly irrelevant products.\n* If only 1 or 2 products match the original topic, do not leave the article too short. Instead, adjust the introduction, headings, product order, buyer guide, FAQ, conclusion, and overall angle to fit the products that are available.\n* Build the article around the best common topic for those products.\n* Still remove any product that remains irrelevant after the article angle is adjusted.\n* Do not add new products unless I request replacements.\n7. If you remove any irrelevant product, also update the introduction, headings, product order, comparison table, buyer guide, FAQ, conclusion, schema, and related text as needed so the article stays accurate, natural, and fully aligned with the main topic.\n8. Do not remove a product only because it is slightly different. Remove it only if it clearly does not match the article's main buyer intent or would confuse readers.\n9. Keep all existing Amazon affiliate links unless a product is removed for being irrelevant, unavailable, discontinued, or inaccurate.\n10. Do not change any Amazon affiliate URL unless the related product is removed.\n11. Preserve existing affiliate attributes such as rel=\"nofollow\", rel=\"sponsored\", target=\"_blank\", tracking IDs, and Amazon tag parameters. If an Amazon affiliate link is missing proper affiliate disclosure attributes, flag it in the audit and carefully add safe attributes only when appropriate.\n12. Update inaccurate product specs, outdated claims, unsupported claims, weak CTAs, missing safety notes, SEO gaps, design issues, and CRO issues based on the audit.\n13. Keep the same overall HTML format, styling, button structure, tables, and section layout unless a change is required to fix an issue or improve conversion.\n14. Improve the article's design, authority, and engagement where useful. Add helpful blocks such as Quick Verdict, Best For badges, Why You'll Like It, Who Should Buy This, Who Should Avoid This, Pro Tips, Safety Notes, Before You Buy checklist, comparison tables, and Final Recommendation boxes when they can improve trust, traffic, readability, and affiliate clicks.\n15. Make the blog design more attractive, clean, modern, mobile-friendly, and easy to scan. Use simple HTML and inline CSS only where needed. Do not add complex scripts, external CSS files, or design elements that may break WordPress formatting.\n16. Add buyer-focused persuasion naturally:\n* Explain the problem the product solves.\n* Show who the product is best for.\n* Mention the main benefit clearly.\n* Reduce buyer hesitation.\n* Add trust-building limitations.\n* Help readers compare products quickly.\n* Make the buying decision easier.\n17. Improve CTA text where needed. Use stronger CTA text such as:\n* Check Price on Amazon\n* Check Current Amazon Availability\n* View Latest Deal on Amazon\n* Check Product Details on Amazon\n* See Today's Price on Amazon\n18. Orange Button Rule:\n* All normal Amazon CTA buttons must be orange, bold, rounded, mobile-friendly, and clickable-looking.\n* Use attractive orange button styling for product CTA buttons and comparison table CTA buttons when it can be done safely.\n* Use inline CSS directly inside each CTA <a> tag when needed so the button style works in WordPress.\n* Do not use yellow buttons.\n* Do not force orange inline styling if it would break protected ZimWriter button classes or layouts.\n19. ZimWriter Code Protection Rule: If the article contains ZimWriter-generated HTML, CSS, tables, product boxes, review blocks, or classes, do not break, rewrite, remove, rename, or restyle them.\nProtected ZimWriter classes and structures include, but are not limited to:\n* .btie-style-short\n* .btie-style-reviews\n* .btie-style-box\n* .btie-style-box-image\n* .btie-style-box-button\n* .toc-img\n* .toc-det\n* .toc-tag\n* .toc-pro1\n* .toc-pro2\n* .toc-pro3\n* .toc-but\n* .toc-rev\n* .btie-style-reviews-features\n* Any related ZimWriter table, review, product-card, ranking, or comparison structure\nDo not change ZimWriter CSS, class names, grid layout, media queries, counters, product-box structure, table structure, review structure, or responsive styling unless it is absolutely required to remove a deleted product section.\nThe orange button rule must not damage ZimWriter button classes. If a CTA button is controlled by ZimWriter classes such as .toc-but or .btie-style-box-button, preserve the existing ZimWriter structure and class system. Do not force inline styling that could break the ZimWriter layout.\nIf a product is removed, remove only that product's full related ZimWriter block, including its image, CTA, pros/cons, table row, review block, and related mentions. Do not leave broken numbering, orphan CSS, empty list items, or broken comparison rows.\nIf editing text inside a ZimWriter block, only update the visible text, CTA wording, product facts, and buyer-focused copy. Do not alter the ZimWriter code structure.\nZimWriter protection priority order:\n1. Preserve ZimWriter code and layout.\n2. Preserve existing images for products that remain.\n3. Preserve Amazon affiliate URLs.\n4. Apply SEO, CRO, design, and orange button improvements only when they do not break the ZimWriter code.\n20. Keep persuasion honest. Do not invent fake hands-on testing, fake expert credentials, fake customer reviews, fake discounts, fake scarcity, fake certifications, fake awards, or unsupported product benefits.\n21. If schema or JSON-LD is included, update it to match the final article topic, FAQ, product list, product removals, and changed recommendations. Do not leave outdated schema that conflicts with the visible article.\n22. Improve the article so it becomes more accurate, buyer-focused, SEO-friendly, trustworthy, attractive, and conversion-friendly.\n23. The updated HTML output must be shown in a clear HTML code box named exactly:\nArticle Fixed HTML Box\n24. Inside the Article Fixed HTML Box, provide the complete updated HTML body code in one full html code block. Do not skip sections, summarize the code, or use placeholders like \"same as above.\"\n25. After the Article Fixed HTML Box, do not write anything else. No change summary, no notes, no explanation, and no extra closing text.\nFinal output format:\nFirst show:\nAUDIT REPORT\nThen leave a clear gap and show:\nArticle Fixed HTML Box\nThen put the full updated HTML code inside one clear html code block.\nStop immediately after the HTML code block."
  }
];

// 🛡 Safety Gate prompts shipped with the extension (extension/prompts/*.txt).
// loadState APPENDS them once (flag safetyGatePromptsInstalled_v1) — the
// user's own prompts and the selected/default prompt are never changed.
const SAFETY_GATE_FACTCHECK_PROMPT_ID = 'p_sg_factcheck';
const SAFETY_GATE_PROMPTS = [
  { id: 'p_sg_editor', type: 'audit', webSearch: true, name: 'Informational Editor (Safety Gate)', file: 'prompts/informational-editor.txt' },
  { id: SAFETY_GATE_FACTCHECK_PROMPT_ID, type: 'factcheck', webSearch: false, name: 'Fact Check (Safety Gate)', file: 'prompts/fact-check.txt' }
];

// Read a prompt file bundled with the extension. Returns '' on any failure.
async function fetchBundledPromptText(path) {
  try {
    const resp = await fetch(chrome.runtime.getURL(path), { cache: 'no-store' });
    if (!resp || !resp.ok) return '';
    return String((await resp.text()) || '').trim();
  } catch (e) {
    return '';
  }
}

function allAIProviders() {
  return BUILTIN_AIS.concat((state.customAIs || []).map(normalizeAIConfig));
}

function normalizeAIConfig(ai) {
  const mode = ai?.mode || ai?.apiProvider || 'web';
  return {
    id: ai?.id || ('custom_' + Date.now()),
    name: ai?.name || '',
    url: ai?.url || '',
    mode,
    apiProvider: ai?.apiProvider || (mode === 'web' ? '' : mode),
    apiBaseUrl: ai?.apiBaseUrl || ai?.url || '',
    apiModel: ai?.apiModel || ai?.model || '',
    apiKey: ai?.apiKey || ''
  };
}

function aiMode(ai) {
  return normalizeAIConfig(ai).mode || 'web';
}

function aiModeLabel(ai) {
  const mode = aiMode(ai);
  if (mode === 'openai') return 'OpenAI-compatible API';
  if (mode === 'gemini') return 'Gemini API';
  if (mode === 'anthropic') return 'Claude API';
  return 'Web UI tab';
}

function aiDefaultBaseUrl(mode) {
  if (mode === 'openai') return 'https://api.openai.com/v1';
  if (mode === 'gemini') return 'https://generativelanguage.googleapis.com/v1beta';
  if (mode === 'anthropic') return 'https://api.anthropic.com/v1';
  return '';
}

function aiDefaultModel(mode) {
  if (mode === 'openai') return 'gpt-4o-mini';
  if (mode === 'gemini') return 'gemini-2.5-flash';
  if (mode === 'anthropic') return 'claude-sonnet-4-5';
  return '';
}

function isApiAI(ai) {
  return aiMode(ai) !== 'web';
}

function hasAIProvider(id) {
  return allAIProviders().some(a => a.id === id);
}

function hasPrompt(id) {
  return state.prompts.some(p => p.id === id);
}

// ── Prompt kinds (v3.46.0) ──
// 'audit' and 'edit' prompts do the edit itself. 'factcheck' prompts are only
// used by the Safety Gate's 2nd AI round, so they never show in the Run tab's
// Prompt dropdown and can never become the run (default) prompt.
function normalizePromptType(t) {
  return (t === 'edit' || t === 'factcheck') ? t : 'audit';
}
function isRunPrompt(p) {
  return !!p && p.type !== 'factcheck';
}
function runPrompts() {
  return state.prompts.filter(isRunPrompt);
}
function hasRunPrompt(id) {
  return state.prompts.some(p => p.id === id && isRunPrompt(p));
}
function factCheckPrompts() {
  return state.prompts.filter(p => p && p.type === 'factcheck');
}
function hasFactCheckPrompt(id) {
  return !!id && factCheckPrompts().some(p => p.id === id);
}
// Used when no fact-check prompt is chosen: the seeded one, else the first one.
function defaultFactCheckPromptId() {
  if (hasFactCheckPrompt(SAFETY_GATE_FACTCHECK_PROMPT_ID)) return SAFETY_GATE_FACTCHECK_PROMPT_ID;
  return factCheckPrompts()[0]?.id || '';
}

// ════════════════════════════════════════════════════════════════
// Tab switching
// ════════════════════════════════════════════════════════════════
document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    document.getElementById('tab-' + t.dataset.tab).classList.add('active');
  });
});

// ════════════════════════════════════════════════════════════════
// Load state from storage
// ════════════════════════════════════════════════════════════════
async function loadState() {
  // One-time setup: install the single audit prompt + recommended defaults, then
  // reload so the UI shows them. Runs once (flagged); the Reset button re-applies.
  const _setup = await chrome.storage.local.get({ defaultsV5_installed: false });
  if (!_setup.defaultsV5_installed) {
    await chrome.storage.local.set({
      prompts: JSON.parse(JSON.stringify(DEFAULT_PROMPTS)),
      defaultPromptId: DEFAULT_PROMPTS[0].id,
      selectedPromptId: DEFAULT_PROMPTS[0].id,
      aiTimeout: '1800',
      settleTime: 10,
      pasteWait: 'custom',
      pasteWaitCustom: 30,
      maxRetries: '2',
      backgroundMode: 'off',
      extraPrompts: '0',
      completeness: 'balanced',
      retryMode: 'end',
      onMissing: 'skip',
      autoSplit: 'off',
      auditPromptInstalled_v1: true,
      bigArticleDefaults_v1: true,
      defaultsV3_installed: true,
      defaultsV4_installed: true,
      defaultsV5_installed: true,
      promptsV8_installed: true
    });
    location.reload();
    return;
  }
  // One-time: replace ALL prompts with the current default set (these 4),
  // wipe any older prompts, and lock the audit/preserve installers so the
  // old prompts never come back. Runs once per version bump.
  const _pv8 = await chrome.storage.local.get({ promptsV8_installed: false });
  if (!_pv8.promptsV8_installed) {
    await chrome.storage.local.set({
      prompts: JSON.parse(JSON.stringify(DEFAULT_PROMPTS)),
      defaultPromptId: DEFAULT_PROMPTS[0].id,
      selectedPromptId: DEFAULT_PROMPTS[0].id,
      auditPromptInstalled_v1: true,
      preservePromptInstalled_v1: true,
      promptsV8_installed: true
    });
    location.reload();
    return;
  }
  const data = await chrome.storage.local.get({
    wpSites: [],
    wpDefaultIndex: -1,
    customAIs: [],
    prompts: null,
    selectedAI: 'grok',
    defaultAIId: 'grok',
    selectedPromptId: null,
    defaultPromptId: null,
    selectedSiteIndex: 0,
    savedSlugDraft: '',
    // BUG FIX: saved by saveState() but missing here, so it was always []
    // after the panel reloaded (same trap as the six keys below).
    lastRunSlugs: [],
    processedLinks: [],
    archivedAttemptKeys: [],
    delayBetween: 10,
    aiTimeout: '1800',
    aiTimeoutCustom: 5,
    updateWait: '30',
    updateWaitCustom: 45,
    settleTime: 10,
    pasteWait: 'custom',
    pasteWaitCustom: 30,
    extraPrompts: '0',
    retryMode: 'end',
    strictMode: 'loose',
    onMissing: 'skip',
    maxRetries: '2',
    backgroundMode: 'off',
    completeness: 'balanced',
    apiMaxTokens: '16000',
    fallbackAIId: '',
    autoSplit: 'off',
    // BUG FIX (critical): these six keys were saved by saveState() but were
    // MISSING here — chrome.storage.local.get(defaults) only returns listed
    // keys, so Audit Retry / HTML Recovery / auto-session-zip silently reset
    // to defaults every time the panel reloaded.
    auditRetryEnabled: 'off',
    auditRetryCount: '1',
    auditRetryTiming: 'end',
    htmlRecoveryAudit: 'off',
    htmlRecoveryFailed: 'off',
    htmlRecoveryAnyCode: 'off',
    autoSessionZip: 'on',
    limitGuard: 'off',
    limitMode: 'smart',
    limitFallbackHours: '0',
    modelLimitGuard: 'on',
    modelLimitRetryHours: '0',
    limitResumeMode: 'exact',
    geminiFlashGuard: 'on',
    failStopCount: '5',
    failRetryAfter: '60',
    faqConclAuto: 'off',
    parallelCount: '1',
    fastRecoverAfter: '10',
    fastAnyCode: 'off',
    fastChunkSize: '50',
    fastPasteWait: '10',
    fastStartAfter: '0',
    fastPasteRetries: '3',
    fastManual: 'off',
    // 🛡 Safety Gate + Fact check (v3.46.0) — every key MUST be listed here,
    // or it silently resets to its default on every reload.
    gateEnabled: 'on',
    gateLinkCheck: 'on',
    gateNewFaq: 'auto',
    gateSiteDomains: '',
    factCheck: 'on',
    factCheckAiId: '',
    factCheckPromptId: '',
    factCheckOnError: 'keep'
  });

  state.wpSites = (data.wpSites || []).map(site => ({
    name: site.name || '',
    url: site.url || '',
    updateMode: site.updateMode || (site.wpUsername && site.wpAppPassword ? 'rest' : 'editor'),
    wpUsername: site.wpUsername || '',
    wpAppPassword: site.wpAppPassword || ''
  }));
  state.wpDefaultIndex = data.wpDefaultIndex;
  // BUG FIX: after an import (or older versions) sites could exist while the
  // default index was -1/out of range - the Run tab then said "Set a default
  // WordPress site" forever even though sites were listed. Normalize it.
  if (state.wpSites.length > 0 && (!Number.isInteger(state.wpDefaultIndex) || state.wpDefaultIndex < 0 || state.wpDefaultIndex >= state.wpSites.length)) {
    state.wpDefaultIndex = 0;
  }
  if (state.wpSites.length === 0) state.wpDefaultIndex = -1;
  state.customAIs = (data.customAIs || []).map(normalizeAIConfig);
  state.prompts = data.prompts || JSON.parse(JSON.stringify(DEFAULT_PROMPTS));
  // v3.46.0: keep the new 'factcheck' type; a missing webSearch flag = false.
  state.prompts = (state.prompts || []).map(p => ({ ...p, type: normalizePromptType(p.type), webSearch: p.webSearch === true }));
  // One-time: add a ready-made "Preserve Everything" prompt so the browser AI
  // keeps all products/tables/images (just pick it from the prompt dropdown).
  // Existing prompts are untouched; if you delete it, it will not come back.
  {
    const _pres = await chrome.storage.local.get({ preservePromptInstalled_v1: false });
    if (!_pres.preservePromptInstalled_v1) {
      if (!state.prompts.some(p => p && p.id === 'p_preserve')) {
        state.prompts.push({ id: 'p_preserve', type: 'edit', name: '🛡️ Preserve Everything (no gutting)', text: PRESERVE_PROMPT_TEXT });
        await chrome.storage.local.set({ prompts: state.prompts });
      }
      await chrome.storage.local.set({ preservePromptInstalled_v1: true });
    }
  }
  // One-time (v3.46.0): APPEND the two Safety Gate prompts shipped in
  // extension/prompts/. Existing prompts and the selected/default prompt are
  // untouched; if you delete one, it will not come back. If a file cannot be
  // read, the flag is NOT set, so the next panel load tries again.
  {
    const _sgp = await chrome.storage.local.get({ safetyGatePromptsInstalled_v1: false });
    if (!_sgp.safetyGatePromptsInstalled_v1) {
      let allPresent = true;
      let added = false;
      for (const sp of SAFETY_GATE_PROMPTS) {
        if (state.prompts.some(p => p && p.id === sp.id)) continue;
        const text = await fetchBundledPromptText(sp.file);
        if (!text) { allPresent = false; continue; }
        state.prompts.push({ id: sp.id, type: sp.type, webSearch: sp.webSearch, name: sp.name, text });
        added = true;
      }
      if (added) await chrome.storage.local.set({ prompts: state.prompts });
      if (allPresent) await chrome.storage.local.set({ safetyGatePromptsInstalled_v1: true });
    }
  }
  state.defaultAIId = hasAIProvider(data.defaultAIId) ? data.defaultAIId : (hasAIProvider(data.selectedAI) ? data.selectedAI : 'grok');
  state.selectedAI = hasAIProvider(data.selectedAI) ? data.selectedAI : state.defaultAIId;
  // v3.46.0: the run prompt can never be a 'factcheck' prompt.
  state.defaultPromptId = hasRunPrompt(data.defaultPromptId) ? data.defaultPromptId : (hasRunPrompt(data.selectedPromptId) ? data.selectedPromptId : (runPrompts()[0]?.id || null));
  state.selectedPromptId = hasRunPrompt(data.selectedPromptId) ? data.selectedPromptId : state.defaultPromptId;
  state.selectedSiteIndex = data.wpDefaultIndex;
  state.savedSlugDraft = data.savedSlugDraft || '';
  state.lastRunSlugs = Array.isArray(data.lastRunSlugs) ? data.lastRunSlugs : [];
  state.processedLinks = Array.isArray(data.processedLinks) ? data.processedLinks : [];
  state.archivedAttemptKeys = Array.isArray(data.archivedAttemptKeys) ? data.archivedAttemptKeys : [];
  state.delayBetween = data.delayBetween;
  state.aiTimeout = data.aiTimeout;
  state.aiTimeoutCustom = data.aiTimeoutCustom;
  state.updateWait = data.updateWait;
  state.updateWaitCustom = data.updateWaitCustom;
  state.settleTime = data.settleTime;
  state.pasteWait = data.pasteWait || '1';
  state.pasteWaitCustom = data.pasteWaitCustom || 4;
  state.extraPrompts = data.extraPrompts || '0';
  state.retryMode = ['end', 'inline', 'off'].includes(data.retryMode) ? data.retryMode : 'end';
  state.strictMode = 'loose';
  state.onMissing = data.onMissing;
  state.maxRetries = data.maxRetries;
  state.backgroundMode = data.backgroundMode || 'on';
  state.completeness = data.completeness || 'balanced';
  state.apiMaxTokens = data.apiMaxTokens || '16000';
  state.fallbackAIId = data.fallbackAIId || '';
  state.autoSplit = data.autoSplit || 'off';
  state.auditRetryEnabled = (data.auditRetryEnabled === 'on') ? 'on' : 'off';
  state.auditRetryCount = ['1','2','3'].includes(String(data.auditRetryCount)) ? String(data.auditRetryCount) : '1';
  state.auditRetryTiming = (data.auditRetryTiming === 'immediate') ? 'immediate' : 'end';
  state.htmlRecoveryAudit = (data.htmlRecoveryAudit === 'on') ? 'on' : 'off';
  state.htmlRecoveryFailed = (data.htmlRecoveryFailed === 'on') ? 'on' : 'off';
  state.htmlRecoveryAnyCode = (data.htmlRecoveryAnyCode === 'on') ? 'on' : 'off';
  state.autoSessionZip = (data.autoSessionZip === 'off') ? 'off' : 'on';
  state.limitGuard = (data.limitGuard === 'on') ? 'on' : 'off';   // STRICT default: Off — never auto-pause unless the user opted in
  state.limitMode = ['smart', 'pause', 'off'].includes(data.limitMode) ? data.limitMode : 'smart';
  state.limitFallbackHours = String(sanitizeLimitRetryHours(data.limitFallbackHours ?? data.modelLimitRetryHours ?? 0));
  state.modelLimitGuard = (data.modelLimitGuard === 'off') ? 'off' : 'on';   // default ON

  state.modelLimitRetryHours = String(sanitizeLimitRetryHours(data.modelLimitRetryHours ?? 0));

  state.limitResumeMode = (data.limitResumeMode === 'timer') ? 'timer' : 'exact';

  state.geminiFlashGuard = (data.geminiFlashGuard === 'off') ? 'off' : 'on';   // default ON
  state.failStopCount = String(data.failStopCount ?? '5');
  state.failRetryAfter = String(data.failRetryAfter ?? '60');
  state.faqConclAuto = (data.faqConclAuto === 'on') ? 'on' : 'off';
  state.parallelCount = ['1','2','3','4','5'].includes(String(data.parallelCount)) ? String(data.parallelCount) : '1';
  state.fastRecoverAfter = String(sanitizeDelay(data.fastRecoverAfter));
  state.fastAnyCode = (data.fastAnyCode === 'on') ? 'on' : 'off';
  state.fastChunkSize = String(sanitizeChunkSize(data.fastChunkSize));
  state.fastPasteWait = String(sanitizePasteWait(data.fastPasteWait ?? 10));

  state.fastStartAfter = String(sanitizeStartAfter(data.fastStartAfter ?? 0));

  state.fastPasteRetries = String(sanitizePasteRetries(data.fastPasteRetries ?? 3));
  state.fastManual = (data.fastManual === 'on') ? 'on' : 'off';
  // 🛡 Safety Gate + Fact check (v3.46.0) — On by default.
  state.gateEnabled = (data.gateEnabled === 'off') ? 'off' : 'on';
  state.gateLinkCheck = (data.gateLinkCheck === 'off') ? 'off' : 'on';
  state.gateNewFaq = (data.gateNewFaq === 'no') ? 'no' : 'auto';
  state.gateSiteDomains = String(data.gateSiteDomains || '');
  state.factCheck = (data.factCheck === 'off') ? 'off' : 'on';
  state.factCheckAiId = hasAIProvider(data.factCheckAiId) ? data.factCheckAiId : '';
  // Empty or deleted → the seeded "Fact Check (Safety Gate)" prompt (or the first fact-check prompt).
  state.factCheckPromptId = hasFactCheckPrompt(data.factCheckPromptId) ? data.factCheckPromptId : defaultFactCheckPromptId();
  state.factCheckOnError = (data.factCheckOnError === 'save') ? 'save' : 'keep';

  // Apply to UI
  document.getElementById('aiTimeout').value = state.aiTimeout;
  document.getElementById('aiTimeoutCustom').value = state.aiTimeoutCustom;
  document.getElementById('aiTimeoutCustom').style.display = state.aiTimeout === 'custom' ? '' : 'none';
  document.getElementById('updateWait').value = state.updateWait;
  document.getElementById('updateWaitCustom').value = state.updateWaitCustom;
  document.getElementById('updateWaitCustom').style.display = state.updateWait === 'custom' ? '' : 'none';
  document.getElementById('delayBetween').value = state.delayBetween;
  document.getElementById('onMissing').value = state.onMissing;
  document.getElementById('settleTime').value = state.settleTime;
  const pwEl = document.getElementById('pasteWait');
  if (pwEl) pwEl.value = state.pasteWait || '1';
  const pwcEl = document.getElementById('pasteWaitCustom');
  if (pwcEl) {
    pwcEl.value = state.pasteWaitCustom || 4;
    pwcEl.style.display = state.pasteWait === 'custom' ? '' : 'none';
  }
  const epEl = document.getElementById('extraPrompts');
  if (epEl) epEl.value = state.extraPrompts || '0';
  const rmEl = document.getElementById('retryMode');
  if (rmEl) rmEl.value = state.retryMode || 'end';
  const strictModeEl = document.getElementById('strictMode');
  if (strictModeEl) strictModeEl.value = 'loose';
  document.getElementById('slugTextarea').value = state.savedSlugDraft;
  const mrEl = document.getElementById('maxRetries');
  if (mrEl) mrEl.value = state.maxRetries || '1';
  const arEnEl = document.getElementById('auditRetryEnabled');
  if (arEnEl) arEnEl.value = state.auditRetryEnabled || 'off';
  const arCntEl = document.getElementById('auditRetryCount');
  if (arCntEl) arCntEl.value = state.auditRetryCount || '1';
  const arTimEl = document.getElementById('auditRetryTiming');
  if (arTimEl) arTimEl.value = state.auditRetryTiming || 'end';
  const hrAEl = document.getElementById('htmlRecoveryAudit');
  if (hrAEl) hrAEl.value = state.htmlRecoveryAudit || 'off';
  const hrFEl = document.getElementById('htmlRecoveryFailed');
  if (hrFEl) hrFEl.value = state.htmlRecoveryFailed || 'off';
  const aszEl = document.getElementById('autoSessionZip');
  if (aszEl) aszEl.value = state.autoSessionZip || 'on';
  const limitModeEl = document.getElementById('limitMode');
  if (limitModeEl) limitModeEl.value = state.limitMode || 'smart';
  const limitFallbackEl = document.getElementById('limitFallbackHours');
  if (limitFallbackEl) limitFallbackEl.value = String(state.limitFallbackHours ?? '0');
  const failStopEl = document.getElementById('failStopCount');
  if (failStopEl) failStopEl.value = String(state.failStopCount ?? '5');
  const failRetryEl = document.getElementById('failRetryAfter');
  if (failRetryEl) failRetryEl.value = String(state.failRetryAfter ?? '60');
  const fcaEl = document.getElementById('faqConclAuto');
  if (fcaEl) fcaEl.value = state.faqConclAuto || 'off';
  const pcEl = document.getElementById('parallelCount');
  if (pcEl) pcEl.value = state.parallelCount || '1';
  const fraEl = document.getElementById('fastRecoverAfter');
  if (fraEl) fraEl.value = state.fastRecoverAfter || '10';
  const facEl = document.getElementById('fastAnyCode');
  if (facEl) facEl.value = state.fastAnyCode || 'off';
  const fcsEl = document.getElementById('fastChunkSize');
  if (fcsEl) fcsEl.value = state.fastChunkSize || '50';
  const fprEl = document.getElementById('fastPasteRetries');

  if (fprEl) fprEl.value = String(state.fastPasteRetries || '3');

  const fsaEl = document.getElementById('fastStartAfter');


  if (fsaEl) fsaEl.value = String(state.fastStartAfter ?? '0');


  const fpwEl = document.getElementById('fastPasteWait');
  if (fpwEl) fpwEl.value = String(state.fastPasteWait || '10');
  const fmEl = document.getElementById('fastManual');
  if (fmEl) fmEl.checked = state.fastManual === 'on';
  applyFastManualUi();
  deriveAutoRetryFromState();   // show the Auto-retry panel matching current settings
  const bgEl = document.getElementById('backgroundMode');
  if (bgEl) bgEl.value = state.backgroundMode || 'on';
  const compEl = document.getElementById('completeness');
  if (compEl) compEl.value = state.completeness || 'balanced';
  const mtEl = document.getElementById('apiMaxTokens');
  if (mtEl) mtEl.value = state.apiMaxTokens || '16000';
  const asEl = document.getElementById('autoSplit');
  if (asEl) asEl.value = state.autoSplit || 'off';
  // 🛡 Safety Gate (v3.46.0). factCheckAiId / factCheckPromptId are filled by
  // their dropdown renderers (renderAll), because their options change.
  const geEl = document.getElementById('gateEnabled');
  if (geEl) geEl.value = state.gateEnabled || 'on';
  const glcEl = document.getElementById('gateLinkCheck');
  if (glcEl) glcEl.value = state.gateLinkCheck || 'on';
  const gnfEl = document.getElementById('gateNewFaq');
  if (gnfEl) gnfEl.value = state.gateNewFaq || 'auto';
  const gsdEl = document.getElementById('gateSiteDomains');
  if (gsdEl) gsdEl.value = state.gateSiteDomains || '';
  const fckEl = document.getElementById('factCheck');
  if (fckEl) fckEl.value = state.factCheck || 'on';
  const fceEl = document.getElementById('factCheckOnError');
  if (fceEl) fceEl.value = state.factCheckOnError || 'keep';
  applyGateUi();
  updateWpCredentialUi();

  // --- One-time install of the audit prompt as the active system prompt. ---
  // Non-destructive: replaces the old sample (p_info) or adds the prompt, and
  // sets it as the default. Never deletes other sites, AIs, prompts, or settings.
  const auditSeed = await chrome.storage.local.get({ auditPromptInstalled_v1: false });
  if (!auditSeed.auditPromptInstalled_v1) {
    const seedPrompt = JSON.parse(JSON.stringify(DEFAULT_PROMPTS[0]));
    const existingIdx = state.prompts.findIndex(p => p.id === 'p_info');
    if (existingIdx >= 0) state.prompts[existingIdx] = seedPrompt;
    else state.prompts.unshift(seedPrompt);
    // BUG FIX: was hard-coded 'p_info', but the seeded prompt's id is
    // DEFAULT_PROMPTS[0].id — the default then pointed at a missing prompt.
    state.defaultPromptId = seedPrompt.id;
    state.selectedPromptId = seedPrompt.id;
    await chrome.storage.local.set({ auditPromptInstalled_v1: true });
    await saveState();
  }

  // One-time: enable Fix-it continuation by default so truncated or no-code-block
  // replies on big articles are auto-continued / re-requested instead of failing.
  const bigSeed = await chrome.storage.local.get({ bigArticleDefaults_v1: false });
  if (!bigSeed.bigArticleDefaults_v1) {
    if (!state.extraPrompts || state.extraPrompts === '0') state.extraPrompts = '0';
    await chrome.storage.local.set({ bigArticleDefaults_v1: true });
    await saveState();
  }

  renderAll();
}

async function saveState() {
  await chrome.storage.local.set({
    wpSites: state.wpSites,
    wpDefaultIndex: state.wpDefaultIndex,
    customAIs: state.customAIs,
    prompts: state.prompts,
    selectedAI: state.selectedAI,
    defaultAIId: state.defaultAIId,
    selectedPromptId: state.selectedPromptId,
    defaultPromptId: state.defaultPromptId,
    selectedSiteIndex: state.selectedSiteIndex,
    savedSlugDraft: state.savedSlugDraft,
    lastRunSlugs: state.lastRunSlugs,
    processedLinks: state.processedLinks,
    archivedAttemptKeys: state.archivedAttemptKeys,
    delayBetween: state.delayBetween,
    aiTimeout: state.aiTimeout,
    aiTimeoutCustom: state.aiTimeoutCustom,
    updateWait: state.updateWait,
    updateWaitCustom: state.updateWaitCustom,
    settleTime: state.settleTime,
    pasteWait: state.pasteWait,
    pasteWaitCustom: state.pasteWaitCustom,
    extraPrompts: state.extraPrompts,
    retryMode: state.retryMode,
    strictMode: 'loose',
    onMissing: state.onMissing,
    maxRetries: state.maxRetries,
    backgroundMode: state.backgroundMode,
    completeness: state.completeness,
    apiMaxTokens: state.apiMaxTokens,
    fallbackAIId: state.fallbackAIId,
    autoSplit: state.autoSplit,
    auditRetryEnabled: state.auditRetryEnabled,
    auditRetryCount: state.auditRetryCount,
    auditRetryTiming: state.auditRetryTiming,
    htmlRecoveryAudit: state.htmlRecoveryAudit,
    htmlRecoveryFailed: state.htmlRecoveryFailed,
    htmlRecoveryAnyCode: state.htmlRecoveryAnyCode,
    autoSessionZip: state.autoSessionZip,
    limitGuard: state.limitGuard,
    limitMode: state.limitMode,
    limitFallbackHours: state.limitFallbackHours,

    modelLimitGuard: state.modelLimitGuard,


    modelLimitRetryHours: state.modelLimitRetryHours,


    limitResumeMode: state.limitResumeMode,


    geminiFlashGuard: state.geminiFlashGuard,

    failStopCount: state.failStopCount,

    failRetryAfter: state.failRetryAfter,
    faqConclAuto: state.faqConclAuto,
    parallelCount: state.parallelCount,
    fastRecoverAfter: state.fastRecoverAfter,
    fastAnyCode: state.fastAnyCode,
    fastChunkSize: state.fastChunkSize,

    fastPasteWait: state.fastPasteWait,


    fastStartAfter: state.fastStartAfter,


    fastPasteRetries: state.fastPasteRetries,
    fastManual: state.fastManual,
    gateEnabled: state.gateEnabled,
    gateLinkCheck: state.gateLinkCheck,
    gateNewFaq: state.gateNewFaq,
    gateSiteDomains: state.gateSiteDomains,
    factCheck: state.factCheck,
    factCheckAiId: state.factCheckAiId,
    factCheckPromptId: state.factCheckPromptId,
    factCheckOnError: state.factCheckOnError
  });
}

// ════════════════════════════════════════════════════════════════
// Render: dropdowns
// ════════════════════════════════════════════════════════════════
function renderAll() {
  renderSiteDropdown();
  renderAIDropdown();
  renderPromptDropdown();
  renderPromptPreview();
  renderWpList();
  renderAIList();
  renderPromptList();
  renderProcessedLinks();
  renderFallbackDropdown();
  renderFactCheckAiDropdown();
  renderFactCheckPromptDropdown();
}

// Run-tab Configuration: REAL dropdowns — pick the WordPress site, AI service
// and prompt directly on the Run tab. A pick saves instantly and doubles as
// the default (the DEFAULT badge in Settings follows it).
function renderSiteDropdown() {
  const el = document.getElementById('runSiteSelect');
  if (!el) return;
  if (!state.wpSites.length) {
    el.innerHTML = '<option value="-1">— Add a WordPress site in Settings —</option>';
    el.value = '-1';
    state.selectedSiteIndex = -1;
    return;
  }
  if (!Number.isInteger(state.wpDefaultIndex) || state.wpDefaultIndex < 0 || state.wpDefaultIndex >= state.wpSites.length) state.wpDefaultIndex = 0;
  el.innerHTML = state.wpSites.map((s, i) =>
    '<option value="' + i + '">' + escapeHtml(s.name + ' — ' + s.url + ' (' + siteModeLabel(s) + ')') + '</option>').join('');
  el.value = String(state.wpDefaultIndex);
  state.selectedSiteIndex = state.wpDefaultIndex;
  el.onchange = () => {
    state.wpDefaultIndex = parseInt(el.value, 10);
    state.selectedSiteIndex = state.wpDefaultIndex;
    saveState();
    renderWpList();
  };
}

function renderAIDropdown() {
  const el = document.getElementById('runAISelect');
  if (!el) return;
  const ais = allAIProviders();
  if (!ais.length) { el.innerHTML = '<option value="">— Add an AI in Settings —</option>'; state.selectedAI = null; return; }
  if (!hasAIProvider(state.defaultAIId)) state.defaultAIId = ais[0].id;
  el.innerHTML = ais.map(a => {
    const isBuiltIn = !!BUILTIN_AIS.find(b => b.id === a.id);
    return '<option value="' + escapeHtml(a.id) + '">' + escapeHtml(a.name + ' (' + (isBuiltIn ? 'built-in web' : aiModeLabel(a)) + ')') + '</option>';
  }).join('');
  el.value = state.defaultAIId;
  state.selectedAI = state.defaultAIId;
  el.onchange = () => {
    state.defaultAIId = el.value;
    state.selectedAI = el.value;
    saveState();
    renderAIList();
  };
}

function renderPromptDropdown() {
  const el = document.getElementById('runPromptSelect');
  if (!el) return;
  // v3.46.0: fact-check prompts are used only by the Safety Gate — never listed here.
  const list = runPrompts();
  if (!list.length) { el.innerHTML = '<option value="">— Add a prompt in Settings —</option>'; state.selectedPromptId = null; return; }
  if (!hasRunPrompt(state.defaultPromptId)) state.defaultPromptId = list[0].id;
  el.innerHTML = list.map(p =>
    '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.name + '  [' + (p.type === 'edit' ? 'EDIT ONLY' : 'AUDIT + FIX') + (p.webSearch ? ' · WEB SEARCH' : '') + ']') + '</option>').join('');
  el.value = state.defaultPromptId;
  state.selectedPromptId = state.defaultPromptId;
  el.onchange = () => {
    state.defaultPromptId = el.value;
    state.selectedPromptId = el.value;
    saveState();
    renderPromptPreview();
    renderPromptList();
  };
}

// Save button beside the three dropdowns — everything already saves on pick,
// this confirms it and shows exactly what will run.
{ const b = document.getElementById('saveRunConfigBtn'); if (b) b.onclick = () => {
  saveState();
  const site = state.wpSites[state.wpDefaultIndex];
  const ai = allAIProviders().find(a => a.id === state.defaultAIId);
  const prompt = state.prompts.find(p => p.id === state.defaultPromptId);
  // Fix 6: a configuration only "completes" when site + AI + prompt are all set.
  if (!site || !ai || !prompt) {
    state._configSaved = false;
    if (typeof refreshSaveGate === 'function') refreshSaveGate();
    return showMsg('Cannot save configuration: pick a WordPress site, an AI and a prompt first.', 'err');
  }
  state._configSaved = true;            // config half of the work-gate
  if (typeof refreshSaveGate === 'function') refreshSaveGate();
  showMsg('Configuration saved: ' + site.name + '  ·  ' + ai.name + '  ·  ' + prompt.name, 'ok');
}; }

function renderPromptPreview() {
  const p = state.prompts.find(x => x.id === state.defaultPromptId);
  document.getElementById('promptPreview').textContent = p?.text || '—';
}

// ════════════════════════════════════════════════════════════════
// Render: settings lists
// ════════════════════════════════════════════════════════════════
function siteMode(site) {
  return site?.updateMode === 'rest' ? 'rest' : 'editor';
}

function siteModeLabel(site) {
  return siteMode(site) === 'rest' ? 'Direct REST API' : 'Browser editor tab';
}

function siteHasRestCredentials(site) {
  return !!(site?.wpUsername && site?.wpAppPassword);
}

function normalizeWpUrl(url) {
  let clean = String(url || '').trim();
  if (!clean) return '';
  if (!/^https?:\/\//i.test(clean)) clean = 'https://' + clean;
  return clean.replace(/\/+$/, '');
}

function updateWpCredentialUi() {
  const updateMode = document.getElementById('wpUpdateMode')?.value || 'rest';
  const credentialMode = document.getElementById('wpCredentialMode')?.value || 'auto';
  const manual = document.getElementById('wpManualFields');
  const autoBtn = document.getElementById('wpAutoConnect');
  const addBtn = document.getElementById('wpAdd');
  const directRest = updateMode === 'rest';
  if (manual) manual.style.display = directRest && credentialMode === 'manual' ? '' : 'none';
  if (autoBtn) autoBtn.style.display = directRest && credentialMode === 'auto' ? '' : 'none';
  if (addBtn) {
    addBtn.textContent = addBtn.dataset.editing ? 'Save Site' : (directRest && credentialMode === 'manual' ? '+ Add Manually' : '+ Add');
  }
}

function resetWpForm(message) {
  const addButton = document.getElementById('wpAdd');
  document.getElementById('wpName').value = '';
  document.getElementById('wpUrl').value = '';
  document.getElementById('wpUpdateMode').value = 'rest';
  document.getElementById('wpCredentialMode').value = 'auto';
  document.getElementById('wpUser').value = '';
  document.getElementById('wpAppPassword').value = '';
  delete addButton.dataset.editing;
  updateWpCredentialUi();
  if (message) showMsg(message, 'ok');
}

function updateAIFormPlaceholders() {
  const mode = document.getElementById('aiMode')?.value || 'web';
  const url = document.getElementById('aiUrl');
  const model = document.getElementById('aiModel');
  const key = document.getElementById('aiApiKey');
  if (!url || !model || !key) return;
  // API modes are selectable again in the redesigned Settings tab - show the
  // model + key fields only when an API mode is picked.
  model.style.display = mode === 'web' ? 'none' : '';
  key.style.display = mode === 'web' ? 'none' : '';
  if (mode === 'web') {
    url.placeholder = 'https://chat.deepseek.com';
    model.placeholder = 'Model (API only)';
    key.placeholder = 'API key (API only)';
  } else {
    url.placeholder = aiDefaultBaseUrl(mode) || 'https://api.example.com/v1';
    model.placeholder = aiDefaultModel(mode) || 'model name';
    key.placeholder = 'API key';
  }
}

function resetAIForm(message) {
  const addButton = document.getElementById('aiAdd');
  document.getElementById('aiName').value = '';
  document.getElementById('aiMode').value = 'web';
  document.getElementById('aiUrl').value = '';
  document.getElementById('aiModel').value = '';
  document.getElementById('aiApiKey').value = '';
  delete addButton.dataset.editing;
  addButton.textContent = '+ Add';
  updateAIFormPlaceholders();
  if (message) showMsg(message, 'ok');
}

function renderWpList() {
  const el = document.getElementById('wpList');
  el.innerHTML = '';
  setCountChip('wpCount', state.wpSites.length);
  if (state.wpSites.length === 0) {
    el.innerHTML = '<div class="empty">No WordPress sites added.</div>';
    return;
  }
  state.wpSites.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'site-item' + (i === state.wpDefaultIndex ? ' active' : '');
    const modeDetail = siteMode(s) === 'rest'
      ? 'Direct REST API | user: ' + (s.wpUsername || 'missing') + ' | app password: ' + (s.wpAppPassword ? 'saved' : 'missing')
      : 'Browser editor tab mode';
    row.innerHTML =
      '<div class="site-info">' +
        '<div class="site-name">' + escapeHtml(s.name) + '</div>' +
        '<div class="site-url">' + escapeHtml(s.url) + ' | ' + escapeHtml(modeDetail) + '</div>' +
      '</div>';
    if (i === state.wpDefaultIndex) {
      const b = document.createElement('span');
      b.className = 'default-badge';
      b.textContent = 'DEFAULT';
      row.appendChild(b);
    } else {
      const b = document.createElement('button');
      b.className = 'btn-mini';
      b.textContent = 'Set Default';
      b.onclick = () => { state.wpDefaultIndex = i; state.selectedSiteIndex = i; saveState(); renderAll(); };
      row.appendChild(b);
    }
    const edit = document.createElement('button');
    edit.className = 'btn-mini';
    edit.textContent = 'Edit';
    edit.onclick = () => {
      document.getElementById('wpName').value = s.name || '';
      document.getElementById('wpUrl').value = s.url || '';
      document.getElementById('wpUpdateMode').value = siteMode(s);
      document.getElementById('wpCredentialMode').value = siteMode(s) === 'rest' && siteHasRestCredentials(s) ? 'manual' : 'auto';
      document.getElementById('wpUser').value = s.wpUsername || '';
      document.getElementById('wpAppPassword').value = s.wpAppPassword || '';
      document.getElementById('wpAdd').dataset.editing = String(i);
      document.getElementById('wpAdd').textContent = 'Save Site';
      updateWpCredentialUi();
      document.getElementById('wpName').focus();
      document.getElementById('wpName').scrollIntoView({ behavior: 'smooth' });
    };
    row.appendChild(edit);
    if (siteMode(s) === 'rest' && siteHasRestCredentials(s)) {
      const test = document.createElement('button');
      test.className = 'btn-mini';
      test.textContent = 'Test';
      test.title = 'Verify the REST API credentials work';
      test.onclick = () => testWpConnection(s, test);
      row.appendChild(test);
    }
    const del = document.createElement('button');
    del.className = 'btn-mini btn-danger';
    del.textContent = 'Delete';
    del.onclick = () => {
      if (!confirm('Delete "' + s.name + '"?')) return;
      state.wpSites.splice(i, 1);
      if (state.wpDefaultIndex === i) state.wpDefaultIndex = state.wpSites.length > 0 ? 0 : -1;
      else if (state.wpDefaultIndex > i) state.wpDefaultIndex--;
      if (state.selectedSiteIndex === i) state.selectedSiteIndex = state.wpDefaultIndex;
      else if (state.selectedSiteIndex > i) state.selectedSiteIndex--;
      saveState(); renderAll();
    };
    row.appendChild(del);
    el.appendChild(row);
  });
}

function renderAIList() {
  const el = document.getElementById('aiList');
  el.innerHTML = '';
  setCountChip('aiServiceCount', allAIProviders().length);
  allAIProviders().forEach((a) => {
    const customIndex = state.customAIs.findIndex(item => item.id === a.id);
    const isCustom = customIndex >= 0;
    const endpoint = isApiAI(a)
      ? ((a.apiBaseUrl || aiDefaultBaseUrl(aiMode(a))) + ' | model: ' + (a.apiModel || 'missing') + ' | key: ' + (a.apiKey ? 'saved' : 'missing'))
      : a.url;
    const row = document.createElement('div');
    row.className = 'ai-item' + (a.id === state.defaultAIId ? ' active' : '');
    row.innerHTML =
      '<div class="ai-info">' +
        '<div class="ai-name">' + (isCustom ? '✨ ' : '') + escapeHtml(a.name) + '</div>' +
        '<div class="ai-url">' + escapeHtml(endpoint) + ' (' + (isCustom ? aiModeLabel(a) : 'built-in web') + ')</div>' +
      '</div>';
    if (a.id === state.defaultAIId) {
      const badge = document.createElement('span');
      badge.className = 'default-badge';
      badge.textContent = 'DEFAULT';
      row.appendChild(badge);
    } else {
      const useDefault = document.createElement('button');
      useDefault.className = 'btn-mini';
      useDefault.textContent = 'Set Default';
      useDefault.onclick = () => {
        state.defaultAIId = a.id;
        state.selectedAI = a.id;
        saveState();
        renderAll();
      };
      row.appendChild(useDefault);
    }
    if (!isCustom) {
      el.appendChild(row);
      return;
    }
    const edit = document.createElement('button');
    edit.className = 'btn-mini';
    edit.textContent = 'Edit';
    edit.onclick = () => {
      document.getElementById('aiName').value = a.name || '';
      document.getElementById('aiMode').value = aiMode(a);
      document.getElementById('aiUrl').value = isApiAI(a) ? (a.apiBaseUrl || aiDefaultBaseUrl(aiMode(a))) : (a.url || '');
      document.getElementById('aiModel').value = a.apiModel || '';
      document.getElementById('aiApiKey').value = a.apiKey || '';
      document.getElementById('aiAdd').dataset.editing = a.id;
      document.getElementById('aiAdd').textContent = 'Save AI';
      updateAIFormPlaceholders();
      document.getElementById('aiName').focus();
      document.getElementById('aiName').scrollIntoView({ behavior: 'smooth' });
    };
    row.appendChild(edit);
    const del = document.createElement('button');
    del.className = 'btn-mini btn-danger';
    del.textContent = 'Delete';
    del.onclick = () => {
      if (!confirm('Delete "' + a.name + '"?')) return;
      state.customAIs.splice(customIndex, 1);
      if (state.defaultAIId === a.id) state.defaultAIId = 'grok';
      if (state.selectedAI === a.id) state.selectedAI = state.defaultAIId;
      // BUG FIX: deleting the AI that was set as the fallback left a stale
      // fallbackAIId behind - the fallback then silently resolved to nothing.
      if (state.fallbackAIId === a.id) state.fallbackAIId = '';
      saveState(); renderAll();
    };
    row.appendChild(del);
    el.appendChild(row);
  });
}

function renderPromptList() {
  const el = document.getElementById('promptList');
  el.innerHTML = '';
  setCountChip('promptCount', state.prompts.length);
  if (state.prompts.length === 0) {
    el.innerHTML = '<div class="empty">No prompts. Add one above.</div>';
    return;
  }
  state.prompts.forEach((p, i) => {
    const row = document.createElement('div');
    const isFact = p.type === 'factcheck';
    row.className = 'prompt-item' + ((!isFact && p.id === state.defaultPromptId) ? ' active' : '');
    const typeColor = isFact ? '#ffb340' : (p.type === 'edit' ? '#7aa2ff' : '#5fcc6a');
    const typeLabel = isFact ? 'FACT CHECK' : (p.type === 'edit' ? 'EDIT ONLY' : 'AUDIT + FIX');
    row.innerHTML =
      '<div class="prompt-info">' +
        '<div class="prompt-name">' + escapeHtml(p.name) + ' <span style="font-size:10px;font-weight:700;color:' + typeColor + ';">[' + typeLabel + ']</span>' +
          (p.webSearch ? ' <span style="font-size:10px;font-weight:700;color:#7ee787;" title="The AI may use web search with this prompt">[🌐 WEB SEARCH]</span>' : '') + '</div>' +
        '<div class="prompt-preview">' + escapeHtml(p.text.slice(0, 120)) + (p.text.length > 120 ? '…' : '') + '</div>' +
      '</div>';
    if (isFact) {
      // Fact-check prompts are picked for the Safety Gate, never as the run prompt.
      if (p.id === state.factCheckPromptId) {
        const badge = document.createElement('span');
        badge.className = 'default-badge';
        badge.textContent = 'FACT CHECK';
        badge.title = 'Used by the Safety Gate fact check';
        row.appendChild(badge);
      } else {
        const useFact = document.createElement('button');
        useFact.className = 'btn-mini';
        useFact.textContent = 'Use for Fact Check';
        useFact.onclick = () => {
          state.factCheckPromptId = p.id;
          saveState();
          renderAll();
          if (state.batchActive) pushLiveSettings();
        };
        row.appendChild(useFact);
      }
    } else if (p.id === state.defaultPromptId) {
      const badge = document.createElement('span');
      badge.className = 'default-badge';
      badge.textContent = 'DEFAULT';
      row.appendChild(badge);
    } else {
      const useDefault = document.createElement('button');
      useDefault.className = 'btn-mini';
      useDefault.textContent = 'Set Default';
      useDefault.onclick = () => {
        state.defaultPromptId = p.id;
        state.selectedPromptId = p.id;
        saveState();
        renderAll();
      };
      row.appendChild(useDefault);
    }
    const edit = document.createElement('button');
    edit.className = 'btn-mini';
    edit.textContent = 'Edit';
    edit.onclick = () => {
      document.getElementById('promptName').value = p.name;
      document.getElementById('promptText').value = p.text;
      { const ptSel = document.getElementById('promptType'); if (ptSel) ptSel.value = normalizePromptType(p.type); }
      { const wsCb = document.getElementById('promptWebSearch'); if (wsCb) wsCb.checked = p.webSearch === true; }
      document.getElementById('promptAdd').dataset.editing = p.id;
      document.getElementById('promptAdd').textContent = '💾 Save Changes';
      document.getElementById('promptName').focus();
      document.getElementById('promptName').scrollIntoView({ behavior: 'smooth' });
    };
    const del = document.createElement('button');
    del.className = 'btn-mini btn-danger';
    del.textContent = 'Delete';
    del.onclick = () => {
      if (!confirm('Delete "' + p.name + '"?')) return;
      state.prompts.splice(i, 1);
      if (state.selectedPromptId === p.id) state.selectedPromptId = runPrompts()[0]?.id;
      if (state.defaultPromptId === p.id) state.defaultPromptId = runPrompts()[0]?.id || null;
      if (state.factCheckPromptId === p.id) state.factCheckPromptId = defaultFactCheckPromptId();
      saveState(); renderAll();
    };
    row.appendChild(edit);
    row.appendChild(del);
    el.appendChild(row);
  });
}

function escapeHtml(s) {
  // BUG FIX: map-based escape that also covers quotes - the div/innerHTML
  // trick left " and ' unescaped, which could break out of attribute
  // contexts like href="..." when a stored URL contains a quote.
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function resetPromptForm(message) {
  const addButton = document.getElementById('promptAdd');
  document.getElementById('promptName').value = '';
  document.getElementById('promptText').value = '';
  { const ptSel = document.getElementById('promptType'); if (ptSel) ptSel.value = 'audit'; }
  { const wsCb = document.getElementById('promptWebSearch'); if (wsCb) wsCb.checked = false; }
  delete addButton.dataset.editing;
  addButton.textContent = '+ Add Prompt';
  if (message) showMsg(message, 'ok');
}

let wpAutoPollTimer = null;
const WP_AUTO_SUCCESS_URL = 'http://127.0.0.1/auto-post-updater-pro-wp-callback';
const WP_AUTO_REJECT_URL = 'http://127.0.0.1/auto-post-updater-pro-wp-rejected';

async function saveAutoConnectedWpSite(details) {
  const name = (details.name || '').trim() || 'WordPress Site';
  const url = normalizeWpUrl(details.url || details.siteUrl);
  const wpUsername = (details.wpUsername || details.userLogin || '').trim();
  const wpAppPassword = normalizeWpAppPassword(details.wpAppPassword || details.password);
  if (!url || !wpUsername || !wpAppPassword) {
    throw new Error('WordPress did not return a username and Application Password.');
  }
  const site = { name, url, updateMode: 'rest', wpUsername, wpAppPassword };
  const editing = details.editing;
  if (editing != null && editing !== '' && state.wpSites[Number(editing)]) {
    state.wpSites[Number(editing)] = site;
  } else {
    const existing = state.wpSites.findIndex(s => normalizeWpUrl(s.url) === url);
    if (existing >= 0) state.wpSites[existing] = site;
    else state.wpSites.push(site);
  }
  // BUG FIX: the replace-existing path used to leave wpDefaultIndex at -1,
  // so the connected site never became the default on a fresh setup.
  if (state.wpDefaultIndex === -1) state.wpDefaultIndex = 0;
  await chrome.storage.local.remove('wpAutoConnectPending');
  await saveState();
  resetWpForm();
  renderAll();
  const settingsTab = document.querySelector('.tab[data-tab="settings"]');
  if (settingsTab) settingsTab.click();
  showMsg('Auto connected "' + name + '" with WordPress Application Password.', 'ok');
}

function normalizeWpAppPassword(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function b64Utf8(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

// One-click REST credential check — catches a wrong app password or a
// security plugin blocking the REST API before a whole batch fails on it.
async function testWpConnection(site, btn) {
  const url = normalizeWpUrl(site.url);
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '...';
  try {
    const res = await fetch(url + '/wp-json/wp/v2/users/me?context=edit', {
      headers: {
        Accept: 'application/json',
        Authorization: 'Basic ' + b64Utf8(site.wpUsername + ':' + String(site.wpAppPassword || '').replace(/\s+/g, ''))
      },
      credentials: 'omit'
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.id) {
      showMsg('✓ "' + site.name + '" connected as ' + (data.name || data.slug || 'user') + ' — REST API works.', 'ok');
    } else {
      const hint = (res.status === 403 || res.status === 429)
        ? ' This looks like a site firewall/security plugin blocking direct requests — during a batch the extension automatically retries through a browser tab on your site, which usually gets past this.'
        : '';
      showMsg('Test failed (HTTP ' + res.status + '): ' + (data?.message || res.statusText || 'check the URL, username and Application Password.') + hint, 'err');
    }
  } catch (e) {
    showMsg('Test failed: ' + (e?.message || e) + ' — the site may be blocking REST API requests.', 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

async function handleWpAutoConnectCallback() {
  const params = new URLSearchParams(location.search || '');
  if (!params.has('wp_auto_connect')) return;
  const pendingData = await chrome.storage.local.get('wpAutoConnectPending');
  const pending = pendingData.wpAutoConnectPending || {};
  try {
    if (params.get('wp_rejected') === '1' || params.get('success') === 'false') {
      throw new Error('WordPress authorization was rejected.');
    }
    await saveAutoConnectedWpSite({
      name: pending.name,
      url: params.get('site_url') || pending.url || '',
      wpUsername: params.get('user_login') || params.get('username') || '',
      wpAppPassword: params.get('password') || params.get('wp_app_password') || '',
      editing: pending.editing
    });
  } catch (err) {
    showMsg(err.message || 'WordPress auto connect did not complete.', 'err');
  } finally {
    history.replaceState(null, '', location.pathname);
  }
}

async function startWpAutoConnect() {
  const name = document.getElementById('wpName').value.trim();
  const url = normalizeWpUrl(document.getElementById('wpUrl').value);
  if (!name || !url) return showMsg('Enter site name and WordPress URL first.', 'err');
  const editing = document.getElementById('wpAdd').dataset.editing || '';
  const appId = crypto.randomUUID ? crypto.randomUUID() : '00000000-0000-4000-8000-' + Math.random().toString(16).slice(2, 14).padEnd(12, '0');
  const callbackUrl = WP_AUTO_SUCCESS_URL + '?state=' + encodeURIComponent(appId);
  const rejectUrl = WP_AUTO_REJECT_URL + '?state=' + encodeURIComponent(appId);
  const authUrl = url + '/wp-admin/authorize-application.php?' + new URLSearchParams({
    app_name: 'Auto Post Updater Pro',
    app_id: appId,
    success_url: callbackUrl,
    reject_url: rejectUrl
  }).toString();
  const pending = { name, url, editing, appId, startedAt: Date.now() };
  await chrome.storage.local.set({ wpAutoConnectPending: pending });
  chrome.tabs.create({ url: authUrl, active: true }, (tab) => {
    if (chrome.runtime.lastError) {
      showMsg('Could not open WordPress authorization: ' + chrome.runtime.lastError.message, 'err');
      return;
    }
    showMsg('Approve the Application Password in WordPress. The tab may briefly show 127.0.0.1; I will capture it automatically.', 'ok');
    startWpAutoConnectPoll(tab.id, pending);
  });
}

function parseWpAutoConnectResultUrl(tabUrl, pending) {
  let url;
  try { url = new URL(tabUrl || ''); } catch (e) { return null; }
  const success = url.origin + url.pathname === WP_AUTO_SUCCESS_URL;
  const rejected = url.origin + url.pathname === WP_AUTO_REJECT_URL;
  if (!success && !rejected) return null;
  const params = url.searchParams;
  if (rejected || params.get('wp_rejected') === '1' || params.get('success') === 'false') {
    return { rejected: true };
  }
  return {
    siteUrl: params.get('site_url') || pending?.url || '',
    userLogin: params.get('user_login') || params.get('username') || '',
    password: params.get('password') || params.get('wp_app_password') || ''
  };
}

function startWpAutoConnectPoll(tabId, pending) {
  clearInterval(wpAutoPollTimer);
  const started = Date.now();
  wpAutoPollTimer = setInterval(async () => {
    if (Date.now() - started > 5 * 60 * 1000) {
      clearInterval(wpAutoPollTimer);
      showMsg('WordPress auto connect timed out. You can try again or use Manual.', 'err');
      return;
    }
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab?.url) return;
      const redirectResult = parseWpAutoConnectResultUrl(tab.url, pending);
      if (redirectResult?.rejected) {
        clearInterval(wpAutoPollTimer);
        showMsg('WordPress authorization was rejected.', 'err');
        try { await chrome.tabs.remove(tabId); } catch (e) {}
        return;
      }
      if (redirectResult?.password && redirectResult?.userLogin) {
        clearInterval(wpAutoPollTimer);
        await saveAutoConnectedWpSite({
          name: pending.name,
          url: redirectResult.siteUrl || pending.url,
          wpUsername: redirectResult.userLogin,
          wpAppPassword: redirectResult.password,
          editing: pending.editing
        });
        try { await chrome.tabs.remove(tabId); } catch (e) {}
        return;
      }
      const result = (await chrome.scripting.executeScript({
        target: { tabId },
        func: inspectWordPressApplicationPasswordPage
      }))?.[0]?.result;
      if (result?.rejected) {
        clearInterval(wpAutoPollTimer);
        showMsg('WordPress authorization was rejected.', 'err');
        return;
      }
      if (result?.password && result?.userLogin) {
        clearInterval(wpAutoPollTimer);
        await saveAutoConnectedWpSite({
          name: pending.name,
          url: result.siteUrl || pending.url,
          wpUsername: result.userLogin,
          wpAppPassword: result.password,
          editing: pending.editing
        });
        try { await chrome.tabs.remove(tabId); } catch (e) {}
      }
    } catch (e) {
      // Stop polling if the user closed the authorization tab.
      if (/no tab/i.test(String(e?.message || ''))) {
        clearInterval(wpAutoPollTimer);
        showMsg('WordPress authorization tab was closed before finishing. Try again or use Manual.', 'err');
        return;
      }
      // Loading/cross-origin hops can reject injection; keep polling.
    }
  }, 1800);
}

async function inspectWordPressApplicationPasswordPage() {
  const url = new URL(location.href);
  const params = url.searchParams;
  const fromParams = {
    siteUrl: params.get('site_url') || location.origin,
    userLogin: params.get('user_login') || params.get('username') || '',
    password: params.get('password') || params.get('wp_app_password') || ''
  };
  if (fromParams.password && fromParams.userLogin) return fromParams;
  const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ');
  if (/authorization denied|application rejected|request rejected|access denied/i.test(bodyText)) {
    return { rejected: true };
  }
  const values = [...document.querySelectorAll('input, textarea, code, kbd, pre')]
    .map(el => (el.value || el.textContent || '').trim())
    .filter(Boolean);
  values.push(bodyText);
  const passRegex = /\b([A-Za-z0-9]{4}(?:\s+[A-Za-z0-9]{4}){5})\b/;
  let password = '';
  for (const value of values) {
    const match = value.match(passRegex);
    if (match) { password = match[1]; break; }
  }
  let userLogin = [...document.querySelectorAll('input[name*="user" i], input[id*="user" i], input[name*="login" i], input[id*="login" i]')]
    .map(el => (el.value || '').trim())
    .find(Boolean) || '';
  if (!userLogin) {
    try {
      const nonce = window.wpApiSettings?.nonce || document.querySelector('meta[name="wp-rest-nonce"]')?.content || '';
      const headers = nonce ? { 'X-WP-Nonce': nonce } : {};
      const res = await fetch('/wp-json/wp/v2/users/me?context=edit', { credentials: 'same-origin', headers });
      if (res.ok) {
        const data = await res.json();
        userLogin = data.username || data.slug || data.name || '';
      }
    } catch (e) {}
  }
  return { siteUrl: location.origin, userLogin, password };
}

// ════════════════════════════════════════════════════════════════
// Settings: add site / AI / prompt
// ════════════════════════════════════════════════════════════════
document.getElementById('wpUpdateMode').onchange = updateWpCredentialUi;
document.getElementById('wpCredentialMode').onchange = updateWpCredentialUi;

document.getElementById('wpAdd').onclick = () => {
  const name = document.getElementById('wpName').value.trim();
  let url = normalizeWpUrl(document.getElementById('wpUrl').value);
  const updateMode = document.getElementById('wpUpdateMode').value === 'editor' ? 'editor' : 'rest';
  const credentialMode = document.getElementById('wpCredentialMode').value || 'auto';
  const wpUsername = document.getElementById('wpUser').value.trim();
  const wpAppPassword = document.getElementById('wpAppPassword').value.trim();
  if (!name || !url) { return showMsg('Enter both name and URL.', 'err'); }
  if (updateMode === 'rest' && credentialMode === 'auto') {
    return showMsg('Click Auto Connect WordPress, or switch credential setup to Manual.', 'err');
  }
  if (updateMode === 'rest' && (!wpUsername || !wpAppPassword)) {
    return showMsg('Direct REST API mode needs WordPress username and Application Password.', 'err');
  }
  const site = { name, url, updateMode, wpUsername, wpAppPassword };
  const editing = document.getElementById('wpAdd').dataset.editing;
  if (editing != null && editing !== '') {
    const index = Number(editing);
    if (state.wpSites[index]) state.wpSites[index] = site;
  } else {
    state.wpSites.push(site);
    if (state.wpDefaultIndex === -1) state.wpDefaultIndex = 0;
  }
  resetWpForm();
  saveState(); renderAll();
  showMsg('"' + name + '" saved.', 'ok');
};

document.getElementById('wpAutoConnect').onclick = () => startWpAutoConnect();
document.getElementById('wpNew').onclick = () => resetWpForm('Ready to add a new WordPress site.');

document.getElementById('aiAdd').onclick = () => {
  const name = document.getElementById('aiName').value.trim();
  const mode = document.getElementById('aiMode').value || 'web';
  let url = document.getElementById('aiUrl').value.trim();
  const apiModel = document.getElementById('aiModel').value.trim();
  const apiKey = document.getElementById('aiApiKey').value.trim();
  if (!name) { return showMsg('Enter an AI name.', 'err'); }
  if (mode === 'web') {
    if (!url) { return showMsg('Enter the AI web URL.', 'err'); }
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    url = url.replace(/\/+$/, '');
  } else {
    if (!url) url = aiDefaultBaseUrl(mode);
    if (!apiModel) { return showMsg('Enter an API model name.', 'err'); }
    if (!apiKey) { return showMsg('Paste the API key for this AI service.', 'err'); }
    if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
    url = url.replace(/\/+$/, '');
  }
  const editing = document.getElementById('aiAdd').dataset.editing;
  const config = normalizeAIConfig({
    id: editing || ('custom_' + Date.now()),
    name,
    url,
    mode,
    apiProvider: mode === 'web' ? '' : mode,
    apiBaseUrl: mode === 'web' ? '' : url,
    apiModel: mode === 'web' ? '' : apiModel,
    apiKey: mode === 'web' ? '' : apiKey
  });
  if (editing) {
    const idx = state.customAIs.findIndex(a => a.id === editing);
    if (idx >= 0) state.customAIs[idx] = config;
  } else {
    state.customAIs.push(config);
  }
  resetAIForm();
  saveState(); renderAll();
  showMsg('"' + name + '" saved. Available in AI dropdown.', 'ok');
};

document.getElementById('aiNew').onclick = () => resetAIForm('Ready to add a new AI service.');
document.getElementById('aiMode').onchange = updateAIFormPlaceholders;

document.getElementById('promptAdd').onclick = () => {
  const name = document.getElementById('promptName').value.trim();
  const text = document.getElementById('promptText').value.trim();
  if (!name || !text) { return showMsg('Enter both name and text.', 'err'); }
  const editing = document.getElementById('promptAdd').dataset.editing;
  const type = normalizePromptType((document.getElementById('promptType') || {}).value);
  const webSearch = !!(document.getElementById('promptWebSearch') || {}).checked;
  if (editing) {
    const p = state.prompts.find(x => x.id === editing);
    if (p) { p.name = name; p.text = text; p.type = type; p.webSearch = webSearch; }
  } else {
    const prompt = { id: 'p_' + Date.now(), name, text, type, webSearch };
    state.prompts.push(prompt);
    if (type === 'factcheck') {
      if (!hasFactCheckPrompt(state.factCheckPromptId)) state.factCheckPromptId = prompt.id;
    } else {
      if (!hasRunPrompt(state.defaultPromptId)) state.defaultPromptId = prompt.id;
      if (!hasRunPrompt(state.selectedPromptId)) state.selectedPromptId = prompt.id;
    }
  }
  // A prompt edited into / out of the 'factcheck' type must not stay the run
  // prompt / the fact-check prompt (renderPromptDropdown fixes the run prompt).
  if (!hasFactCheckPrompt(state.factCheckPromptId)) state.factCheckPromptId = defaultFactCheckPromptId();
  resetPromptForm();
  saveState(); renderAll();
  showMsg('Prompt saved.', 'ok');
};

document.getElementById('promptNew').onclick = () => {
  resetPromptForm('Ready to add a new prompt.');
  document.getElementById('promptName').focus();
};

// ════════════════════════════════════════════════════════════════
// Run config changes
// ════════════════════════════════════════════════════════════════
async function saveRunSetup(message) {
  state.selectedSiteIndex = state.wpDefaultIndex;
  state.selectedAI = state.defaultAIId;
  state.selectedPromptId = state.defaultPromptId;
  state.savedSlugDraft = document.getElementById('slugTextarea').value;
  await saveState();
  showMsg(message || 'Run setup saved.', 'ok');
}

document.getElementById('delayBetween').onchange = (e) => { state.delayBetween = parseInt(e.target.value); saveState(); };

document.getElementById('aiTimeout').onchange = (e) => {
  state.aiTimeout = e.target.value;
  document.getElementById('aiTimeoutCustom').style.display = e.target.value === 'custom' ? '' : 'none';
  saveState();
};
document.getElementById('aiTimeoutCustom').onchange = (e) => {
  state.aiTimeoutCustom = parseInt(e.target.value) || 5;
  saveState();
};

document.getElementById('updateWait').onchange = (e) => {
  state.updateWait = e.target.value;
  document.getElementById('updateWaitCustom').style.display = e.target.value === 'custom' ? '' : 'none';
  saveState();
};
document.getElementById('updateWaitCustom').onchange = (e) => {
  state.updateWaitCustom = parseInt(e.target.value) || 45;
  saveState();
};

document.getElementById('settleTime').onchange = (e) => { state.settleTime = parseInt(e.target.value); saveState(); };
const _pwSel = document.getElementById('pasteWait');
if (_pwSel) _pwSel.onchange = (e) => {
  state.pasteWait = e.target.value;
  const c = document.getElementById('pasteWaitCustom');
  if (c) c.style.display = e.target.value === 'custom' ? '' : 'none';
  saveState();
};
const _pwcInp = document.getElementById('pasteWaitCustom');
if (_pwcInp) _pwcInp.onchange = (e) => { state.pasteWaitCustom = parseInt(e.target.value) || 4; saveState(); };
const _epSel = document.getElementById('extraPrompts');
if (_epSel) _epSel.onchange = (e) => { state.extraPrompts = e.target.value; saveState(); };
const _rmSel = document.getElementById('retryMode');
if (_rmSel) _rmSel.onchange = (e) => { state.retryMode = e.target.value; saveState(); };
const _strictModeEl = document.getElementById('strictMode');
if (_strictModeEl) _strictModeEl.onchange = () => { state.strictMode = 'loose'; saveState(); };
document.getElementById('onMissing').onchange = (e) => { state.onMissing = e.target.value; saveState(); };
const _mrSel = document.getElementById('maxRetries');
if (_mrSel) _mrSel.onchange = (e) => { state.maxRetries = e.target.value; saveState(); };
const _bgSel = document.getElementById('backgroundMode');
if (_bgSel) _bgSel.onchange = (e) => { state.backgroundMode = e.target.value; saveState(); };
const _compSel = document.getElementById('completeness');
if (_compSel) _compSel.onchange = (e) => { state.completeness = e.target.value; saveState(); };
const _mtSel = document.getElementById('apiMaxTokens');
if (_mtSel) _mtSel.onchange = (e) => { state.apiMaxTokens = e.target.value; saveState(); };
const _asSel = document.getElementById('autoSplit');
if (_asSel) _asSel.onchange = (e) => { state.autoSplit = e.target.value; saveState(); };
const _arEnSel = document.getElementById('auditRetryEnabled');
if (_arEnSel) _arEnSel.onchange = (e) => { state.auditRetryEnabled = e.target.value; saveState(); if (state.batchActive) pushLiveSettings(); };
const _arCntSel = document.getElementById('auditRetryCount');
if (_arCntSel) _arCntSel.onchange = (e) => { state.auditRetryCount = e.target.value; saveState(); if (state.batchActive) pushLiveSettings(); };
const _arTimSel = document.getElementById('auditRetryTiming');
if (_arTimSel) _arTimSel.onchange = (e) => { state.auditRetryTiming = e.target.value; saveState(); if (state.batchActive) pushLiveSettings(); };
const _hrASel = document.getElementById('htmlRecoveryAudit');
if (_hrASel) _hrASel.onchange = (e) => { state.htmlRecoveryAudit = e.target.value; saveState(); if (state.batchActive) pushLiveSettings(); };
const _hrFSel = document.getElementById('htmlRecoveryFailed');
if (_hrFSel) _hrFSel.onchange = (e) => { state.htmlRecoveryFailed = e.target.value; saveState(); if (state.batchActive) pushLiveSettings(); };
const _saveArBtn = document.getElementById('saveAuditRetryBtn');
if (_saveArBtn) _saveArBtn.onclick = () => { saveState(); if (state.batchActive) pushLiveSettings(); showMsg('Audit settings saved.', 'ok'); };
const _saveFrBtn = document.getElementById('saveFailedRetryBtn');
if (_saveFrBtn) _saveFrBtn.onclick = () => { saveState(); if (state.batchActive) pushLiveSettings(); showMsg('Failed-post settings saved.', 'ok'); };
{ const _srsBtn = document.getElementById('saveRunSetupBtn'); if (_srsBtn) _srsBtn.onclick = () => saveRunSetup(); }
// SIMPLIFIED UX: Start is never locked anymore. Every control already saves
// on change, and Start/Test now flush the on-screen values themselves via
// syncStateFromUi() right before running — so the mandatory "Save All
// Settings" step (which re-locked Start on every panel open) was pure
// friction. The save button remains for explicit saves.
function syncStateFromUi() {
  const v = (id) => { const el = document.getElementById(id); return el ? el.value : undefined; };
  const pick = (id, cur) => { const x = v(id); return x === undefined ? cur : x; };
  const num = (id, cur) => { const x = parseInt(v(id), 10); return Number.isFinite(x) ? x : cur; };
  state.delayBetween = num('delayBetween', state.delayBetween);
  state.aiTimeout = pick('aiTimeout', state.aiTimeout);
  state.aiTimeoutCustom = num('aiTimeoutCustom', state.aiTimeoutCustom);
  state.updateWait = pick('updateWait', state.updateWait);
  state.updateWaitCustom = num('updateWaitCustom', state.updateWaitCustom);
  state.settleTime = num('settleTime', state.settleTime);
  state.pasteWait = pick('pasteWait', state.pasteWait);
  state.pasteWaitCustom = num('pasteWaitCustom', state.pasteWaitCustom);
  state.extraPrompts = pick('extraPrompts', state.extraPrompts);
  state.retryMode = pick('retryMode', state.retryMode);
  state.onMissing = pick('onMissing', state.onMissing);
  state.maxRetries = pick('maxRetries', state.maxRetries);
  state.backgroundMode = pick('backgroundMode', state.backgroundMode);
  state.completeness = pick('completeness', state.completeness);
  state.apiMaxTokens = pick('apiMaxTokens', state.apiMaxTokens);
  state.autoSplit = pick('autoSplit', state.autoSplit);
  state.auditRetryEnabled = pick('auditRetryEnabled', state.auditRetryEnabled);
  state.auditRetryCount = pick('auditRetryCount', state.auditRetryCount);
  state.auditRetryTiming = pick('auditRetryTiming', state.auditRetryTiming);
  state.htmlRecoveryAudit = pick('htmlRecoveryAudit', state.htmlRecoveryAudit);
  state.htmlRecoveryFailed = pick('htmlRecoveryFailed', state.htmlRecoveryFailed);
  state.autoSessionZip = pick('autoSessionZip', state.autoSessionZip);
  state.limitGuard = pick('limitGuard', state.limitGuard);
  state.limitMode = ['smart', 'pause', 'off'].includes(pick('limitMode', state.limitMode)) ? pick('limitMode', state.limitMode) : 'smart';
  state.limitFallbackHours = String(sanitizeLimitRetryHours(pick('limitFallbackHours', state.limitFallbackHours)));

  state.modelLimitGuard = pick('modelLimitGuard', state.modelLimitGuard);


  state.modelLimitRetryHours = String(sanitizeLimitRetryHours(pick('modelLimitRetryHours', state.modelLimitRetryHours)));


  state.limitResumeMode = (pick('limitResumeMode', state.limitResumeMode) === 'timer') ? 'timer' : 'exact';


  state.geminiFlashGuard = pick('geminiFlashGuard', state.geminiFlashGuard);

  state.failStopCount = pick('failStopCount', state.failStopCount);

  state.failRetryAfter = pick('failRetryAfter', state.failRetryAfter);
  state.faqConclAuto = pick('faqConclAuto', state.faqConclAuto);
  state.parallelCount = pick('parallelCount', state.parallelCount);
  state.fastRecoverAfter = String(sanitizeDelay(pick('fastRecoverAfter', state.fastRecoverAfter)));
  state.fastAnyCode = pick('fastAnyCode', state.fastAnyCode);
  state.fastChunkSize = String(sanitizeChunkSize(pick('fastChunkSize', state.fastChunkSize)));
  state.fastPasteWait = String(sanitizePasteWait(pick('fastPasteWait', state.fastPasteWait)));

  state.fastStartAfter = String(sanitizeStartAfter(pick('fastStartAfter', state.fastStartAfter)));

  state.fastPasteRetries = String(sanitizePasteRetries(pick('fastPasteRetries', state.fastPasteRetries)));
  { const _fm = document.getElementById('fastManual'); if (_fm) state.fastManual = _fm.checked ? 'on' : 'off'; }
  state.fallbackAIId = pick('fallbackAI', state.fallbackAIId);
  // 🛡 Safety Gate + Fact check (v3.46.0)
  state.gateEnabled = (pick('gateEnabled', state.gateEnabled) === 'off') ? 'off' : 'on';
  state.gateLinkCheck = (pick('gateLinkCheck', state.gateLinkCheck) === 'off') ? 'off' : 'on';
  state.gateNewFaq = (pick('gateNewFaq', state.gateNewFaq) === 'no') ? 'no' : 'auto';
  state.gateSiteDomains = parseGateSiteDomains(pick('gateSiteDomains', state.gateSiteDomains)).join(', ');
  state.factCheck = (pick('factCheck', state.factCheck) === 'off') ? 'off' : 'on';
  state.factCheckAiId = pick('factCheckAiId', state.factCheckAiId) || '';
  state.factCheckPromptId = pick('factCheckPromptId', state.factCheckPromptId) || '';
  state.factCheckOnError = (pick('factCheckOnError', state.factCheckOnError) === 'save') ? 'save' : 'keep';
  const ta = document.getElementById('slugTextarea');
  if (ta) state.savedSlugDraft = ta.value;
}
function _refreshStartLock() {
  const ready = (typeof workReady === 'function') ? workReady() : true;
  const b = document.getElementById('startBtn');
  if (b && !state.batchActive) b.disabled = !ready;
  const pill = document.getElementById('batchPill');
  if (pill && !state.batchActive) {
    if (ready) {
      pill.textContent = 'Ready';
      pill.style.color = 'var(--accent, #34c759)';
    } else {
      pill.textContent = 'Save Configuration + Save All Settings to start';
      pill.style.color = 'var(--warn, #ffb340)';
    }
  }
}
const _saveAllBtn = document.getElementById('saveAllSettingsBtn');
if (_saveAllBtn) _saveAllBtn.onclick = () => {
  syncStateFromUi();
  saveState();
  state._settingsSaved = true;          // Fix 6: settings half of the work-gate
  if (typeof refreshSaveGate === 'function') refreshSaveGate();
  _refreshStartLock();
  if (state.batchActive) pushLiveSettings();
  showMsg('All settings saved.', 'ok');
};
_refreshStartLock();

let saveSlugDraftTimer = null;
let slugCountTimer = null;
document.getElementById('slugTextarea').oninput = (e) => {
  state.savedSlugDraft = e.target.value;
  clearTimeout(saveSlugDraftTimer);
  saveSlugDraftTimer = setTimeout(() => saveState(), 400);
  // Debounced: pasting a large list (common on an RDP/VPS Chrome) fires one big
  // input event — recomputing the counter synchronously there blocks the paste
  // paint and feels laggy. Defer it so the textarea updates instantly.
  clearTimeout(slugCountTimer);
  slugCountTimer = setTimeout(updateSlugCount, 250);
};

// Live "N slugs" counter under the textarea (with duplicate detection).
function updateSlugCount() {
  const el = document.getElementById('slugCount');
  if (!el) return;
  const ta = document.getElementById('slugTextarea');
  const lines = (ta?.value || '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  if (!lines.length) { el.textContent = ''; return; }
  const dupes = lines.length - new Set(lines).size;
  el.textContent = lines.length + ' slug' + (lines.length === 1 ? '' : 's') + ' ready' +
    (dupes > 0 ? ' — ' + dupes + ' duplicate' + (dupes === 1 ? '' : 's') + ' will be skipped' : '');
}

// ════════════════════════════════════════════════════════════════
// File upload
// ════════════════════════════════════════════════════════════════
document.getElementById('loadFileBtn').onclick = () => {
  const file = document.getElementById('slugFile').files[0];
  if (!file) { return showMsg('Pick a file first.', 'err'); }
  const reader = new FileReader();
  reader.onload = (e) => {
    let content = e.target.result;
    // For CSV, take first column
    if (file.name.toLowerCase().endsWith('.csv')) {
      let lines = content.split(/\r?\n/);
      // BUG FIX: a header row like "url"/"slug"/"link" used to be imported as
      // a slug and then fail as "post not found". Skip an obvious header line.
      if (lines.length && /^\s*"?(url|urls|link|links|slug|slugs|post|posts|address)"?\s*(,|$)/i.test(lines[0])) {
        lines = lines.slice(1);
      }
      content = lines.map(line => {
        // Handle CSV quoting roughly — take everything before first unquoted comma
        const m = line.match(/^"([^"]*)"|^([^,]*)/);
        return m ? (m[1] !== undefined ? m[1] : m[2]) : line;
      }).join('\n');
    }
    document.getElementById('slugTextarea').value = content;
    state.savedSlugDraft = content;
    saveState();
    updateSlugCount();
    showMsg('Loaded ' + file.name + ' — ' + content.split('\n').filter(l => l.trim() && !l.trim().startsWith('#')).length + ' slugs.', 'ok');
  };
  reader.readAsText(file);
};

function resolvePasteWaitSec() {
  return state.pasteWait === 'custom'
    ? Math.max(1, Math.min(30, state.pasteWaitCustom || 4))
    : (parseInt(state.pasteWait) || 1);
}

// ════════════════════════════════════════════════════════════════
// Start / Pause / Resume / Stop
// ════════════════════════════════════════════════════════════════
document.getElementById('startBtn').onclick = async () => {
  if (!requireSaved()) return;   // Fix 6: both Save buttons must be done first
  syncStateFromUi();   // auto-save: what you see on screen is exactly what runs
  if (state.wpSites.length === 0) return showMsg('Add a WordPress site in Settings first.', 'err');
  if (state.prompts.length === 0)  return showMsg('Add a prompt in Settings first.', 'err');

  const raw = document.getElementById('slugTextarea').value;
  state.savedSlugDraft = raw;
  await saveState();
  const seenSlugs = new Set();
  const slugs = raw.split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'))
    .filter(l => { if (seenSlugs.has(l)) return false; seenSlugs.add(l); return true; });
  if (slugs.length === 0) return showMsg('No slugs provided. Paste or upload at least one.', 'err');
  state.lastRunSlugs = slugs.slice();   // remembered so the box clears on finish

  const site = state.wpSites[state.wpDefaultIndex];
  if (!site) return showMsg('Set a default WordPress site in Settings.', 'err');
  if (siteMode(site) === 'rest' && !siteHasRestCredentials(site)) {
    return showMsg('Default WordPress site is Direct REST API mode but username/application password is missing.', 'err');
  }

  const aiId = state.defaultAIId;
  const prompt = state.prompts.find(p => p.id === state.defaultPromptId && isRunPrompt(p));
  if (!prompt) return showMsg('Set a default prompt in Settings.', 'err');

  // Resolve AI
  let aiUrl, aiName, aiKind, aiConfig;
  const builtin = BUILTIN_AIS.find(a => a.id === aiId);
  if (builtin) { aiConfig = normalizeAIConfig(builtin); aiUrl = builtin.url; aiName = builtin.name; aiKind = 'builtin'; }
  else {
    const c = state.customAIs.find(a => a.id === aiId);
    if (!c) return showMsg('Set a default AI provider in Settings.', 'err');
    aiConfig = normalizeAIConfig(c);
    aiUrl = aiConfig.url; aiName = aiConfig.name; aiKind = 'custom';
  }
  if (isApiAI(aiConfig) && (!aiConfig.apiKey || !aiConfig.apiModel)) {
    return showMsg('Default AI is API mode but model/API key is missing.', 'err');
  }

  // Resolve AI timeout (seconds)
  let aiTimeoutSec;
  if (state.aiTimeout === 'nolimit') {
    aiTimeoutSec = 86400; // wait until the AI finishes (stops only on long inactivity)
  } else if (state.aiTimeout === 'custom') {
    aiTimeoutSec = Math.max(60, Math.min(7200, (state.aiTimeoutCustom || 5) * 60));
  } else {
    aiTimeoutSec = parseInt(state.aiTimeout) || 180;
  }

  // Resolve UPDATE wait (seconds)
  let updateWaitSec;
  if (state.updateWait === 'custom') {
    updateWaitSec = Math.max(5, Math.min(300, state.updateWaitCustom || 45));
  } else {
    updateWaitSec = parseInt(state.updateWait) || 30;
  }

  // Confirm
  const aiTimeoutDisplay = state.aiTimeout === 'nolimit' ? 'No limit (until the AI finishes)' : (aiTimeoutSec >= 60 ? (aiTimeoutSec/60) + ' min' : aiTimeoutSec + 's');
  const retryCount = parseInt(state.maxRetries || '1', 10);
  const updateModeDisplay = siteMode(site) === 'rest'
    ? 'Direct REST API (no WordPress editor tab)'
    : 'Browser editor tab';
  const aiModeDisplay = isApiAI(aiConfig)
    ? aiModeLabel(aiConfig) + ' (no AI browser tab)'
    : 'Web UI tab' + (state.backgroundMode === 'on' ? ' in worker window' : '');
  if (!confirm(
    'Start batch?\n\n' +
    slugs.length + ' posts on ' + site.name + ' via ' + aiName + '\n\n' +
    'WordPress update mode: ' + updateModeDisplay + '\n' +
    'AI mode: ' + aiModeDisplay + '\n' +
    'Delay between posts: ' + state.delayBetween + 's\n' +
    'AI timeout: ' + aiTimeoutDisplay + '\n' +
    (siteMode(site) === 'rest' ? '' : 'Wait after UPDATE: ' + updateWaitSec + 's\n') +
    'Completeness check: ' + (state.completeness || 'balanced') + '\n' +
    safetyGateSummary() + '\n' +
    'Max retries per post: ' + retryCount + '\n' +
    'Posts at the same time: ' + parseInt(state.parallelCount || '1', 10) + (parseInt(state.parallelCount || '1', 10) > 1 ? ' ⚡' : ' (one by one)') + '\n' +
    'If a post fails: ' + (state.retryMode === 'inline' ? 'retry immediately' : state.retryMode === 'off' ? 'no automatic retry' : 'retry at the END of the batch') + '\n'
  )) return;

  const job = {
    slugs,
    site,
    aiUrl,
    aiName,
    aiKind,
    aiMode: aiMode(aiConfig),
    aiProvider: aiConfig.apiProvider || aiMode(aiConfig),
    aiApiBaseUrl: aiConfig.apiBaseUrl || aiConfig.url || '',
    aiApiModel: aiConfig.apiModel || '',
    aiApiKey: aiConfig.apiKey || '',
    prompt: prompt.text,
    promptType: (prompt.type === 'edit' ? 'edit' : 'audit'),
    delayBetween: state.delayBetween,
    aiTimeout: aiTimeoutSec,
    updateWait: updateWaitSec,
    pasteWait: resolvePasteWaitSec(),
    continueRounds: parseInt(state.extraPrompts || '0', 10),
    retryMode: state.retryMode || 'end',
    settleTime: state.settleTime,
    strictMode: 'loose',
    onMissing: state.onMissing,
    maxRetries: parseInt(state.maxRetries || '1', 10),
    backgroundMode: state.backgroundMode || 'on',
    completeness: state.completeness || 'balanced',
    apiMaxTokens: parseInt(state.apiMaxTokens || '16000', 10),
    fallbackAi: resolveAiFields(state.fallbackAIId),
    autoSplit: state.autoSplit || 'off',
    auditRetry: (state.auditRetryEnabled === 'on'),
    auditRetryCount: parseInt(state.auditRetryCount || '1', 10),
    auditRetryTiming: (state.auditRetryTiming === 'immediate' ? 'immediate' : 'end'),
    htmlRecoveryAudit: (state.htmlRecoveryAudit === 'on'),
    htmlRecoveryFailed: (state.htmlRecoveryFailed === 'on'),
    htmlRecoveryAnyCode: (state.htmlRecoveryAnyCode === 'on'),
    ...limitFlagsFromMode(),
    failStopCount: parseInt(state.failStopCount ?? '5', 10),
    failRetryAfter: parseInt(state.failRetryAfter ?? '60', 10),
    ...safetyGateJobFields(prompt),
    parallel: parseInt(state.parallelCount || '1', 10)
  };

  chrome.runtime.sendMessage({ type: 'BATCH_START', job }, (resp) => {
    if (chrome.runtime.lastError) {
      showMsg('Error: ' + chrome.runtime.lastError.message, 'err');
    } else if (resp?.ok) {
      state._fullBatchActive = true;
      showMsg('Batch started — processing ' + slugs.length + ' posts.', 'ok');
    } else {
      showMsg('Error: ' + (resp?.error || 'unknown'), 'err');
    }
  });
};

// ── NEW: Test First Post — run ONLY the first slug to verify the whole
// setup (site, AI login, prompt, timings) before committing to a big batch. ──
const _testFirstBtn = document.getElementById('testFirstBtn');
if (_testFirstBtn) _testFirstBtn.onclick = async () => {
  if (state.batchActive) return showMsg('A batch is already running. Wait for it to finish or press Stop first.', 'err');
  if (!requireSaved()) return;   // Fix 6
  syncStateFromUi();
  await saveState();
  const first = (document.getElementById('slugTextarea').value || '')
    .split(/\r?\n/).map(l => l.trim()).find(l => l && !l.startsWith('#'));
  if (!first) return showMsg('Paste at least one slug or URL first.', 'err');
  const r = resolveRunConfig();
  if (!r.ok) return showMsg('Cannot test: ' + r.error + '.', 'err');
  if (!confirm('Test run: process ONLY the first post\n\n"' + first + '"\n\nwith the current settings? If it succeeds, start the full batch with confidence.')) return;
  const job = Object.assign({ slugs: [first] }, r.config);
  chrome.runtime.sendMessage({ type: 'BATCH_START', job }, (resp) => {
    if (chrome.runtime.lastError) return showMsg('Error: ' + chrome.runtime.lastError.message, 'err');
    if (resp && resp.ok) {
      state._fullBatchActive = false;
      showMsg('Test run started — processing only "' + first + '".', 'ok');
    } else {
      showMsg('Error: ' + (resp && resp.error ? resp.error : 'unknown'), 'err');
    }
  });
};

document.getElementById('pauseBtn').onclick = () => {
  chrome.runtime.sendMessage({ type: 'BATCH_PAUSE' });
};
document.getElementById('resumeBtn').onclick = () => {
  // No save gate here either — see the note at resumeBtn.disabled.
  pushLiveSettings({ silent: true });
  chrome.runtime.sendMessage({ type: 'BATCH_RESUME' });
};
document.getElementById('stopBtn').onclick = () => {
  if (!confirm('Stop the batch? Already-processed posts stay updated.')) return;
  chrome.runtime.sendMessage({ type: 'BATCH_STOP' });
};

// ════════════════════════════════════════════════════════════════
// Progress display — listens for batch status changes
// ════════════════════════════════════════════════════════════════
let _pollTick = 0;
function pollStatus() {
  // When the panel tab is hidden, poll every 5s instead of every 1s.
  _pollTick++;
  if (document.hidden && _pollTick % 5 !== 0) return;
  chrome.runtime.sendMessage({ type: 'BATCH_STATUS' }, (resp) => {
    if (chrome.runtime.lastError) return;
    if (resp) updateProgressUI(resp);
  });
}

function formatEta(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60);
  if (m < 60) return m + 'm ' + (sec % 60) + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

let _lastLogSig = '';
let _lastFailSig = '';

// Top summary bar: general live counters driven by the background's
// computeRunProgress() (single source of truth — the run's attempt rows).
function renderProgressSummary(s) {
  const el = document.getElementById('progressSummary');
  if (!el) return;
  const p = s && s.progress;
  const chip = (cls, label, value) => '<span class="ps-chip ' + cls + '">' + label + ' <b>' + value + '</b></span>';
  if (!p || !p.total) {
    el.innerHTML = '<span class="ps-chip ps-idle">No batch running</span>';
    return;
  }
  const phaseLabel = p.phase === 'fast' ? '🚀 Fast Submit' : p.phase === 'recovery' ? '⏰ Recovery' : '▶ Batch';
  const suffix = s.running ? '' : ' — last run';
  let html = '<span class="ps-chip ps-phase">' + phaseLabel + suffix + '</span>';
  html += chip('ps-total', 'Total', p.total);
  if (p.phase === 'fast') {
    // Phase 1 sends prompts; posts become Done (final) only at recovery.
    html += chip('ps-sub', 'Submitted', p.submitted);
    html += chip('ps-fail', 'Failed', p.failed);
    html += chip('ps-left', 'Left', Math.max(0, p.total - p.submitted - p.failed));
  } else {
    html += chip('ps-done', 'Done', p.done);
    html += chip('ps-left', 'Left', p.left);
    html += chip('ps-ok', 'Successful', p.success);
    html += chip('ps-audit', 'Audit', p.audit);
    html += chip('ps-fail', 'Failed', p.failed);
  }
  el.innerHTML = html;
}

// AI limit stop → loud alert. The banner stays until dismissed; the popup
// fires ONCE per stop event (tracked by its timestamp) so a 1s poll cannot
// spam it. The desktop notification comes from the background worker.
function renderLimitAlert(s) {
  const bar = document.getElementById('limitAlertBar');
  if (!bar) return;
  const a = s && s.limitAlert;
  if (!a || !a.iso) return;                       // nothing new to show
  if (state._dismissedLimitAlertIso === a.iso) return;

  const title = document.getElementById('limitAlertTitle');
  const text = document.getElementById('limitAlertText');
  const paused = !!(s && s.paused);
  if (title) {
    title.textContent = (paused ? '⏸ PAUSED — ' : '⛔ ') + (a.aiName || 'AI') +
      ' limit reached (' + (a.time || '') + ')';
  }
  if (text) {
    text.textContent = (a.message || 'The AI reported a limit.') +
      (paused ? ' The run is holding on this exact post — press Resume (here or at the top) to carry on from the same place.' : '');
  }
  // Resume straight from the alert, so the way out is where the problem is.
  const resumeHere = document.getElementById('limitAlertResume');
  if (resumeHere) resumeHere.style.display = paused ? '' : 'none';
  bar.style.display = '';

  if (state._alertedLimitIso !== a.iso) {
    state._alertedLimitIso = a.iso;
    // Popup last: the banner is already painted behind it.
    setTimeout(() => {
      try {
        alert((s && s.paused ? '⏸ PAUSED — ' : '⛔ STOPPED — ') + (a.aiName || 'AI') + ' limit reached\n\n' +
              (a.message || '') + '\n\n' +
              'No post was edited by a limited model. The remaining posts are untouched and still listed in "Posts to update".' +
              (s && s.paused ? '\n\nPress Resume to continue from this exact post whenever the limit has cleared.' : ''));
      } catch (e) {}
    }, 60);
  }
}

{ const b = document.getElementById('limitAlertResume'); if (b) b.onclick = () => {
  pushLiveSettings({ silent: true });
  chrome.runtime.sendMessage({ type: 'BATCH_RESUME' });
  const bar = document.getElementById('limitAlertBar');
  if (bar) bar.style.display = 'none';
  state._dismissedLimitAlertIso = state._alertedLimitIso || '';
}; }

{ const b = document.getElementById('limitAlertDismiss'); if (b) b.onclick = () => {
  const bar = document.getElementById('limitAlertBar');
  if (bar) bar.style.display = 'none';
  state._dismissedLimitAlertIso = state._alertedLimitIso || '';
}; }

function updateProgressUI(s) {
  state.batchActive = !!s.running;
  archiveProcessedAttempts(s.attempts || []);
  try { renderProgressSummary(s); } catch (e) {}
  try { renderLimitAlert(s); } catch (e) {}
  const total = s.total || 0;
  const checked = s.checked ?? s.done ?? 0;
  const failed = s.failed ?? s.failures?.length ?? 0;
  const updated = s.updated ?? Math.max(0, checked - failed);
  const pct = total > 0 ? Math.round((checked / total) * 100) : 0;
  const fill = document.getElementById('progressFill');
  fill.style.width = pct + '%';
  fill.className = 'progress-fill' +
    (failed > 0 ? ' error' : (!s.running && total > 0 && checked >= total ? ' success' : ''));
  const etaPart = (s.running && s.etaSeconds > 0) ? ' | ~' + formatEta(s.etaSeconds) + ' left' : '';
  document.getElementById('progressText').textContent = total > 0
    ? updated + ' updated | ' + failed + ' failed | ' + checked + '/' + total + ' (' + pct + '%)' + etaPart
    : '0 / 0';
  document.getElementById('statusLine').textContent = s.statusText || 'Ready to start.';
  document.getElementById('statusLine').className = 'status-line' + (s.statusKind ? ' ' + s.statusKind : '');

  // A batch just finished: auto-download the session ZIP and, if enabled,
  // start the FAQ-Conclusion Missing AI Session. Both trigger only off a FULL
  // batch (never a retry / test / auto batch), so the auto session cannot loop.
  if (state._wasRunning && !s.running) {
    const wasFull = state._fullBatchActive;
    state._fullBatchActive = false;
    // Clear the slugs that finished successfully from the "Posts to update" box.
    try { removeCompletedSlugsFromBox(); } catch (e) {}
    if (wasFull && (state.autoSessionZip !== 'off')) {
      setTimeout(() => { try { downloadSessionZip(true); } catch (e) {} }, 1500);
    }
    if (wasFull && state.faqConclAuto === 'on') {
      setTimeout(() => { try { autoRunFaqConclSession(); } catch (e) {} }, 3000);
    }
  }
  state._wasRunning = !!s.running;

  const running = s.running && !s.paused;
  const gateOk = (typeof workReady === 'function') ? workReady() : true;
  document.getElementById('startBtn').disabled = s.running || !gateOk;   // Fix 6
  document.getElementById('pauseBtn').disabled = !running;
  // Stop is also the way to call off a scheduled (not yet started) run.
  document.getElementById('stopBtn').disabled = !(s.running || state._pendingStart);
  document.getElementById('pauseBtn').style.display = s.paused ? 'none' : '';
  document.getElementById('resumeBtn').style.display = s.paused ? '' : 'none';
  // NEVER gated by the save flags. Resume continues a run that is already
  // going, using the job captured when it started — no configuration is read.
  // Gating it meant a limit pause could not be resumed at all after the panel
  // was reopened, because the save flags start out unset in every new session.
  document.getElementById('resumeBtn').disabled = !s.paused;

  document.getElementById('batchStatusLabel').textContent =
    !s.running && failed > 0 ? 'Finished with errors' :
    !s.running && total > 0 && checked >= total ? 'Finished' :
    !s.running ? 'Idle' :
    s.paused ? 'Paused' :
    s.retryPass ? 'Running — retry pass' :
    'Running';
  { const pill = document.getElementById('batchPill');
    if (pill) {
      if (s.running) {
        pill.textContent = document.getElementById('batchStatusLabel').textContent +
          (total > 0 ? ' \u00b7 ' + checked + '/' + total : '') +
          (s.parallel > 1 ? ' \u00b7 ⚡' + s.parallel + ' at once' : '');
        pill.style.color = '';
      } else {
        _refreshStartLock();
      }
    } }

  // Log — rebuilt only when it actually changed, and autoscrolled only when the
  // user is already at the bottom (so scrolling up to read is no longer yanked
  // back down every second).
  const logBox = document.getElementById('logBox');
  if (s.log && s.log.length > 0) {
    const lastEntry = s.log[s.log.length - 1];
    const logSig = s.log.length + '|' + (s.log[0]?.time || '') + '|' + lastEntry.time + '|' + lastEntry.msg;
    if (logSig !== _lastLogSig) {
      _lastLogSig = logSig;
      const nearBottom = logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 60;
      logBox.innerHTML = s.log.map(e =>
        '<div class="log-entry">' +
        '<span class="log-time">' + e.time + '</span>' +
        '<span class="log-' + (e.kind || 'info') + '">' + escapeHtml(e.msg) + '</span>' +
        '</div>'
      ).join('');
      if (nearBottom) logBox.scrollTop = logBox.scrollHeight;
    }
  }

  // Failure list — also change-detected to avoid pointless re-renders.
  const failures = s.failures || [];
  const failSig = failures.length + '|' + (failures[failures.length - 1]?.time || '') + '|' + (failures[failures.length - 1]?.slug || '');
  if (failSig !== _lastFailSig) {
    _lastFailSig = failSig;
    const failureList = document.getElementById('failureList');
    if (failures.length > 0) {
      failureList.innerHTML = failures.slice().reverse().map(f =>
        '<div class="failure-item">' +
        '<strong>' + escapeHtml(f.slug || 'Unknown slug') + '</strong> ' +
        '<span class="log-time">' + escapeHtml(f.time || '') + '</span>' +
        '<div>' + escapeHtml(f.message || 'Unknown error') + '</div>' +
        (f.note ? '<div class="failure-note">' + escapeHtml(f.note) + '</div>' : '') +
        '</div>'
      ).join('');
    } else {
      failureList.innerHTML = '<div class="empty">No failed posts in this batch.</div>';
    }
  }

  renderRetryReport(s);
  if (typeof refreshSaveGate === 'function') refreshSaveGate();
}

let _lastRetryReportSig = '';
function renderRetryReport(s) {
  const el = document.getElementById('retryReport');
  if (!el) return;
  const attempts = Array.isArray(s.attempts) ? s.attempts : [];
  const lastA = attempts[attempts.length - 1] || {};
  const sig = attempts.length + '|' + (lastA.isoTime || '') + '|' + (lastA.message || '');
  if (sig === _lastRetryReportSig) return;
  _lastRetryReportSig = sig;

  // Group every attempt by post, preserving chronological order.
  const order = [];
  const groups = new Map();
  attempts.forEach((a) => {
    const key = ((a.rawInput || a.slug || '') + '').trim() || (a.slug || '');
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key).push(a);
  });

  const auditItems = [], failItems = [];
  order.forEach((key) => {
    const recs = groups.get(key);
    const slug = (recs.find(r => r.slug) || {}).slug || key;
    const msgs = recs.map(r => String(r.message || ''));
    const hadAuditIssue = msgs.some(m => /AUDIT ISSUES/i.test(m));
    const hadFailure = recs.some(r => (r.result || '') === 'failed');
    const last = recs[recs.length - 1] || {};
    const finalFailed = (last.result || '') === 'failed';
    const finalAuditIssue = /AUDIT ISSUES/i.test(String(last.message || ''));
    const auditRetries = recs.filter(r => /\[audit retry/i.test(String(r.message || ''))).length;
    if (hadAuditIssue) {
      const solved = !finalAuditIssue && !finalFailed;
      auditItems.push({ slug, solved, retries: auditRetries, status:
        solved ? (auditRetries > 0 ? ('Solved after ' + auditRetries + ' retr' + (auditRetries === 1 ? 'y' : 'ies')) : 'Solved')
               : (auditRetries > 0 ? ('Unsolved after ' + auditRetries + ' retr' + (auditRetries === 1 ? 'y' : 'ies')) : 'Unsolved (retry off)') });
    }
    if (hadFailure) {
      const recovered = !finalFailed;
      const failRetries = Math.max(0, recs.length - 1);
      failItems.push({ slug, solved: recovered, retries: failRetries, status:
        recovered ? ('Recovered after ' + failRetries + ' retr' + (failRetries === 1 ? 'y' : 'ies'))
                  : ('Still failing after ' + recs.length + ' attempt' + (recs.length === 1 ? '' : 's')) });
    }
  });

  if (!auditItems.length && !failItems.length) {
    // Fix 8: never claim "nothing yet" when unresolved items are shown elsewhere.
    const pAudit = (typeof latestByStatus === 'function') ? latestByStatus('audit').length : 0;
    const pFailed = (typeof latestByStatus === 'function') ? latestByStatus('failed').length : 0;
    if (pAudit || pFailed) {
      el.innerHTML = '<div class="card-desc">' + pFailed + ' failed and ' + pAudit +
        ' audit-issue post(s) are listed in the Failed Posts and Audit Issues boxes above. ' +
        'Use their per-post retry buttons or the bulk buttons below.</div>';
    } else {
      el.innerHTML = '<div class="empty">No audit issues or failed posts yet.</div>';
    }
    return;
  }

  const G = '#5fcc6a', R = '#ff5566';
  function section(title, items) {
    const total = items.length;
    const solved = items.filter(i => i.solved).length;
    const attemptsUsed = items.reduce((n, i) => n + i.retries, 0);
    let html =
      '<div style="font-weight:700;margin:6px 0 4px;color:#fff;">' + escapeHtml(title) + '</div>' +
      '<div class="card-desc" style="margin-bottom:6px;">' +
        'Total: ' + total + ' &nbsp;|&nbsp; ' +
        '<span style="color:' + G + ';">Solved by retry: ' + solved + '</span> &nbsp;|&nbsp; ' +
        '<span style="color:' + R + ';">Remaining: ' + (total - solved) + '</span> &nbsp;|&nbsp; ' +
        'Retry attempts used: ' + attemptsUsed +
      '</div>';
    html += items.map(i =>
      '<div class="failure-item">' +
        '<strong>' + escapeHtml(i.slug || 'Unknown') + '</strong> ' +
        '<span style="color:' + (i.solved ? G : R) + ';font-weight:700;">' + escapeHtml(i.status) + '</span>' +
      '</div>'
    ).join('');
    return html;
  }

  el.innerHTML = section('Audit issues', auditItems) + '<div style="height:10px;"></div>' + section('Failed posts', failItems);
}

function attemptKey(attempt) {
  return [
    attempt.isoTime || attempt.time || '',
    attempt.index ?? '',
    attempt.rawInput || attempt.slug || '',
    attempt.result || ''
  ].join('|');
}

function archiveProcessedAttempts(attempts) {
  // Re-render only when something actually changed — this used to rebuild the
  // whole processed-links DOM every second, causing flicker and lost clicks.
  if (!Array.isArray(attempts) || attempts.length === 0) return;

  let changed = false;
  attempts.forEach((attempt) => {
    const key = attemptKey(attempt);
    if (state.archivedAttemptKeys.includes(key)) return;

    state.archivedAttemptKeys.push(key);
    state.processedLinks.unshift({
      rawInput: attempt.rawInput || attempt.slug || '',
      slug: attempt.slug || '',
      result: attempt.result || 'checked',
      message: attempt.message || '',
      postUrl: attempt.postUrl || '',
      editorUrl: attempt.editorUrl || '',
      aiProviderUrl: attempt.aiProviderUrl || '',
      aiSessionUrl: attempt.aiSessionUrl || '',
      aiName: attempt.aiName || '',
      time: attempt.time || '',
      isoTime: attempt.isoTime || new Date().toISOString(),
      // 🛡 v3.46.0: why the Safety Gate / Fact check blocked (or noted) this post.
      gate: compactGateInfo(attempt.gate),
      factCheck: compactFactCheckInfo(attempt.factCheck)
    });
    // STRICT rule: a slug leaves the Posts-to-update box ONLY when its post
    // reaches a FINAL state — Successful, Audit Issues, or Failed — because it
    // then lives in the matching result box. Queued / running / submitted /
    // recovering posts stay in the box (Pause and Stop never remove them).
    const finalResult = attempt.result || '';
    if (finalResult === 'updated' || finalResult === 'failed') {
      removeProcessedInputLine(attempt.rawInput || attempt.slug || '');
    }
    // A successful update supersedes earlier FAILED rows for the same post —
    // once a retry succeeds, the old failed report disappears.
    if ((attempt.result || '') === 'updated') {
      const sSlug = (attempt.slug || '').trim();
      const sRaw = (attempt.rawInput || '').trim();
      state.processedLinks = state.processedLinks.filter((p, idx) => {
        if (idx === 0 || p.result === 'updated') return true;
        const sameSlug = sSlug && (p.slug || '').trim() === sSlug;
        const sameRaw = sRaw && (p.rawInput || '').trim() === sRaw;
        return !(sameSlug || sameRaw);
      });
    }
    // (additive) An audit-retry re-process supersedes this post's previous
    // row(s), so a solved issue leaves the Audit Issues box and nothing
    // duplicates. Only fires for attempts the background flags auditRetry.
    if (attempt.auditRetry) {
      const aSlug = (attempt.slug || '').trim();
      const aRaw = (attempt.rawInput || '').trim();
      state.processedLinks = state.processedLinks.filter((p, idx) => {
        if (idx === 0) return true;
        const sameSlug = aSlug && (p.slug || '').trim() === aSlug;
        const sameRaw = aRaw && (p.rawInput || '').trim() === aRaw;
        return !(sameSlug || sameRaw);
      });
    }
    changed = true;
  });

  if (changed) {
    state.processedLinks = state.processedLinks.slice(0, 2000);
    state.archivedAttemptKeys = state.archivedAttemptKeys.slice(-3000);
    saveState();
    renderProcessedLinks();
    updateSlugCount();
  }
}

function removeProcessedInputLine(rawInput) {
  const target = String(rawInput || '').trim();
  if (!target) return;
  const lines = document.getElementById('slugTextarea').value.split(/\r?\n/);
  const norm = (s) => String(s || '').trim().replace(/\/+$/, '');
  const index = lines.findIndex(line => norm(line) === norm(target));
  if (index === -1) return;
  lines.splice(index, 1);
  state.savedSlugDraft = lines.join('\n').replace(/^\n+|\n+$/g, '');
  document.getElementById('slugTextarea').value = state.savedSlugDraft;
  saveState();
  updateSlugCount();
}

// Reduce a URL or bare slug to a comparable slug key (last path segment,
// lower-cased, no query/hash/trailing slash) so matching works whether the box
// holds full URLs and results hold slugs, or vice versa. (Distinct from the
// item-based slugKeyOf() used by the single-source-of-truth grouping.)
function lineSlugKey(s) {
  let t = String(s || '').trim().toLowerCase();
  if (!t) return '';
  t = t.replace(/[?#].*$/, '').replace(/\/+$/, '');
  const parts = t.split('/');
  return parts[parts.length - 1] || t;
}

// Finish-time sweep: when a run ends (finished OR stopped), remove ONLY the
// slugs that reached a FINAL state — Successful, Audit Issues, or Failed (they
// live in the result boxes now). Slugs that were still queued, submitting,
// generating, or waiting for recovery when the user pressed Stop/Pause MUST
// stay in the Posts box, and must still be there after reload/reopen.
function removeCompletedSlugsFromBox() {
  const ta = document.getElementById('slugTextarea');
  if (!ta) return;
  const ran = Array.isArray(state.lastRunSlugs) ? state.lastRunSlugs : [];
  if (!ran.length) return;
  const ranKeys = new Set(ran.map(lineSlugKey).filter(Boolean));
  // Final states only: every processedLinks row is a terminal result
  // ('updated' → Successful/Audit boxes, 'failed' → Failed box).
  const finalized = new Set(
    (state.processedLinks || [])
      .filter(p => p.result === 'updated' || p.result === 'failed')
      .map(p => lineSlugKey(p.rawInput || p.slug))
      .filter(k => k && ranKeys.has(k))
  );
  const kept = ta.value.split(/\r?\n/).filter(line => {
    const t = line.trim();
    if (!t) return false;                  // tidy up blank lines
    if (t.startsWith('#')) return true;    // keep comment lines
    return !finalized.has(lineSlugKey(t));
  });
  const next = kept.join('\n');
  // Keep lastRunSlugs while unfinished posts remain (e.g. Fast Submit phase 1
  // done, recovery still pending) so the next finish-sweep can clear them.
  const unfinishedRemain = kept.some(l => { const t = l.trim(); return t && !t.startsWith('#') && ranKeys.has(lineSlugKey(t)); });
  if (!unfinishedRemain) state.lastRunSlugs = [];
  if (next !== ta.value) {
    ta.value = next;
    state.savedSlugDraft = next;
  }
  saveState();
  updateSlugCount();
}

// ════════════════════════════════════════════════════════════════
// Result boxes — Successful / Audit Issues / Failed.
// Rows are COLLAPSED by default (click the header to expand), so long
// audit reports no longer stretch the page.
// ════════════════════════════════════════════════════════════════
const _openItems = new Set();       // which rows the user expanded
const _auditSelected = new Set();   // marked rows for the bulk AI re-run

function itemKey(item) {
  return (item.isoTime || item.time || '') + '|' + (item.rawInput || item.slug || '');
}

// Pull structured facts out of an audit message: is it flagged, is the FAQ /
// Conclusion missing, and how many separate issues were reported.
function parseAuditInfo(message) {
  const msg = String(message || '');
  const idx = msg.indexOf('AUDIT ISSUES');
  if (idx < 0) return { isAudit: false, missingFaq: false, missingConcl: false, count: 0, issuesText: '' };
  const issuesText = msg.slice(idx).replace(/^AUDIT ISSUES:\s*/i, '').trim();
  const count = issuesText.split(';').map(sx => sx.trim()).filter(Boolean).length;
  return {
    isAudit: true,
    missingFaq: /FAQ from the original is missing/i.test(msg),
    missingConcl: /Conclusion from the original is missing/i.test(msg),
    count,
    issuesText
  };
}

// ── 🛡 Safety Gate / Fact check results (v3.46.0) ──
// Failure messages start with one of these prefixes (EXT-SPEC 2.7), possibly
// after a wrapper such as "Fast submit failed — ". Parsing the TEXT keeps old
// rows and CSV exports working even without the structured gate fields.
function parseGateInfo(message) {
  const msg = String(message || '');
  const m = msg.match(/SAFETY GATE BLOCKED|FACT CHECK BLOCKED|FACT CHECK ERROR/);
  if (!m) return { isGate: false, kind: '', codes: [], text: '' };
  const text = msg.slice(m.index);
  const kind = m[0] === 'SAFETY GATE BLOCKED' ? 'gate' : (m[0] === 'FACT CHECK BLOCKED' ? 'factcheck' : 'factcheck-error');
  let codes = [];
  if (kind === 'gate') {
    // "SAFETY GATE BLOCKED: IMG_COUNT, TABLE_LOSS — <messages>. The post was NOT changed."
    // (With no messages the codes are followed directly by ". The post was …".)
    const head = text.replace(/^SAFETY GATE BLOCKED:?\s*/, '').split(/\s[—–-]\s|\.(?:\s|$)/)[0];
    codes = head.split(/[,;]\s*/).map(c => c.trim()).filter(c => /^[A-Z][A-Z0-9_]+(\(\d+\))?$/.test(c));
  }
  return { isGate: true, kind, codes, text };
}

// Small, safe copies of attempt.gate / attempt.factCheck for processedLinks
// (persisted, up to 2000 rows) — long lists and texts are capped.
function _capStrList(list, maxItems, maxLen) {
  return (Array.isArray(list) ? list : []).slice(0, maxItems).map(x => {
    const t = (x && typeof x === 'object') ? (x.message || x.code || JSON.stringify(x)) : x;
    return String(t == null ? '' : t).slice(0, maxLen);
  });
}
function compactGateInfo(g) {
  if (!g || typeof g !== 'object') return null;
  return {
    codes: _capStrList(g.codes, 20, 60),
    messages: _capStrList(g.messages, 10, 300),
    warnings: _capStrList(g.warnings, 10, 300)
  };
}
function compactFactCheckInfo(f) {
  if (!f || typeof f !== 'object') return null;
  const issues = (Array.isArray(f.issues) ? f.issues : []).slice(0, 20).map(i => ({
    severity: String((i && i.severity) || '').slice(0, 10),
    category: String((i && i.category) || '').slice(0, 60),
    quote: String((i && i.quote) || '').slice(0, 300),
    problem: String((i && i.problem) || '').slice(0, 400),
    fix: String((i && i.fix) || '').slice(0, 400)
  }));
  return {
    verdict: String(f.verdict || '').slice(0, 20),
    issues,
    dropped: Array.isArray(f.dropped) ? f.dropped.length : (Number(f.dropped) || 0),
    aiSessionUrl: String(f.aiSessionUrl || ''),
    // Set by background when the fact-check round itself broke (verdict 'error').
    error: String(f.error || '').slice(0, 300),
    fixRound: f.fixRound === true
  };
}

// Codes to show: the structured ones first, else the ones in the message.
function gateCodesOf(item, info) {
  const g = item && item.gate;
  if (g && Array.isArray(g.codes) && g.codes.length) return g.codes;
  return (info && info.codes) || [];
}

// Badges for a Failed row, e.g. "🛡 Gate: IMG_COUNT" / "🔎 Fact check: 2 issues".
function gateBadgesHtml(item) {
  const info = parseGateInfo(item && item.message);
  const f = item && item.factCheck;
  let html = '';
  const codes = gateCodesOf(item, info);
  if (info.kind === 'gate' || (!info.isGate && codes.length)) {
    const shown = codes.slice(0, 3).join(', ');
    html += '<span class="pi-badge gate" title="' + escapeHtml(codes.join(', ') || 'Safety Gate') + '">🛡 Gate' +
      (shown ? ': ' + escapeHtml(shown) + (codes.length > 3 ? ' +' + (codes.length - 3) : '') : '') + '</span>';
  }
  if (info.kind === 'factcheck') {
    const n = (f && Array.isArray(f.issues)) ? f.issues.length : 0;
    html += '<span class="pi-badge fact">🔎 Fact check' + (n ? ': ' + n + ' issue' + (n === 1 ? '' : 's') : '') + '</span>';
  } else if (info.kind === 'factcheck-error') {
    html += '<span class="pi-badge fact">🔎 Fact check error</span>';
  }
  return html;
}

// Expanded-row details: gate codes/messages/warnings and fact-check issues.
function renderGateDetails(item) {
  const g = item && item.gate;
  const f = item && item.factCheck;
  let html = '';
  if (g && ((g.messages || []).length || (g.warnings || []).length || (g.codes || []).length)) {
    html += '<div style="margin-top:6px;"><b>🛡 Safety Gate</b>' +
      ((g.codes || []).length ? ' — ' + escapeHtml(g.codes.join(', ')) : '') + '</div>';
    (g.messages || []).forEach(m => { html += '<div style="color:#ff8a8a;">• ' + escapeHtml(m) + '</div>'; });
    (g.warnings || []).forEach(w => { html += '<div style="color:#ffc46b;">• (warning) ' + escapeHtml(w) + '</div>'; });
  }
  if (f && (f.verdict || (f.issues || []).length)) {
    html += '<div style="margin-top:6px;"><b>🔎 Fact check</b>' + (f.verdict ? ' — verdict: ' + escapeHtml(f.verdict) : '') +
      (f.dropped ? ' (' + f.dropped + ' issue' + (f.dropped === 1 ? '' : 's') + ' ignored: quote not found in the article)' : '') + '</div>';
    if (f.error) html += '<div style="color:#ffc46b;">• The fact check itself failed: ' + escapeHtml(f.error) + '</div>';
    (f.issues || []).forEach(i => {
      const sev = String(i.severity || '').toLowerCase();
      html += '<div style="color:' + (sev === 'high' ? '#ff8a8a' : '#ffc46b') + ';">• [' + escapeHtml(sev || '?') + '] ' +
        escapeHtml(i.problem || '') + (i.fix ? ' — Fix: ' + escapeHtml(i.fix) : '') +
        (i.quote ? ' — “' + escapeHtml(i.quote) + '”' : '') + '</div>';
    });
  }
  if (!html) return '';
  return '<div class="processed-message" style="margin-top:6px;">' + html + '</div>' +
    (f && f.aiSessionUrl ? renderProcessedLink('Fact check chat', f.aiSessionUrl) : '');
}

// Text for the CSV "Gate reasons" column.
function gateReasonsText(item) {
  const info = parseGateInfo(item && item.message);
  const g = item && item.gate;
  const f = item && item.factCheck;
  const parts = [];
  const codes = gateCodesOf(item, info);
  if (codes.length || (g && (g.messages || []).length)) {
    parts.push('Safety Gate: ' + codes.join(', ') + (g && (g.messages || []).length ? ' — ' + g.messages.join('; ') : ''));
  }
  if (f && (f.issues || []).length) {
    parts.push((item.result === 'updated' ? 'Fact check notes' : 'Fact check') + (f.verdict ? ' (' + f.verdict + ')' : '') + ': ' +
      f.issues.map(i => '[' + (i.severity || '?') + '] ' + (i.problem || '') + (i.quote ? ' "' + i.quote + '"' : '')).join('; '));
  } else if (f && f.error) {
    parts.push('Fact check error: ' + f.error);
  }
  if (!parts.length && info.isGate) parts.push(info.text);
  return parts.join(' | ');
}

// Sort priority: missing FAQ+Conclusion → missing FAQ → missing Conclusion →
// most audit issues → fewer audit issues.
function auditSortRank(a) {
  if (a.missingFaq && a.missingConcl) return 0;
  if (a.missingFaq) return 1;
  if (a.missingConcl) return 2;
  return 3;
}

// One collapsible result row, shared by all three boxes.
function renderResultItem(item, index, opts) {
  opts = opts || {};
  const result = item.result === 'updated' ? 'updated' : 'failed';
  const label = result === 'updated' ? 'Success' : 'Failed';
  const key = itemKey(item);
  const open = _openItems.has(key);
  const audit = parseAuditInfo(item.message);
  let badges = '';
  if (opts.badges && audit.isAudit) {
    if (audit.missingFaq)   badges += '<span class="pi-badge faq">FAQ missing</span>';
    if (audit.missingConcl) badges += '<span class="pi-badge concl">Conclusion missing</span>';
    badges += '<span class="pi-badge count">' + audit.count + ' issue' + (audit.count === 1 ? '' : 's') + '</span>';
  }
  // 🛡 v3.46.0: why the Safety Gate / Fact check blocked a Failed post.
  if (opts.gateBadges && result === 'failed') badges += gateBadgesHtml(item);
  const check = opts.checkbox
    ? '<input type="checkbox" class="audit-mark" data-key="' + escapeHtml(key) + '"' + (_auditSelected.has(key) ? ' checked' : '') + ' title="Mark this post for the bulk AI re-run">'
    : '';
  // Per-row number (1, 2, 3 …) so each box is clearly countable at a glance.
  const numBadge = opts.pos
    ? '<span class="pi-num" style="display:inline-block;min-width:24px;text-align:right;font-weight:700;opacity:.7;margin-right:8px;">' + opts.pos + '.</span>'
    : '';
  const aiSessionHref = recoverableAiSessionHref(item.aiSessionUrl, item.aiProviderUrl);
  return '<div class="processed-item ' + escapeHtml(result) + (open ? ' open' : '') + '" data-key="' + escapeHtml(key) + '">' +
    '<div class="pi-head" title="Click to expand / collapse">' +
      numBadge +
      check +
      '<span class="processed-status">' + label + '</span>' +
      '<span class="pi-slug">' + escapeHtml(item.rawInput || item.slug || 'Unknown link') + '</span>' +
      badges +
      '<span class="pi-time">' + escapeHtml(item.time || '') + '</span>' +
      '<span class="pi-caret">▶</span>' +
    '</div>' +
    '<div class="pi-body">' +
      '<div class="processed-head" style="margin-top:8px;">' +
        '<button class="btn-warn processed-remove" data-processed-retry="' + index + '">↻ Retry new</button>' +
        (aiSessionHref ? '<button class="btn-primary processed-remove" data-recover="' + index + '">↻ Retry AI session</button>' : '') +
        ((result === 'failed' || audit.isAudit) && aiSessionHref ? '<button class="btn-warn processed-remove" data-recover-any="' + index + '">↻ Recover any code</button>' : '') +
        // Fresh Recovery is offered wherever an audit problem (or a failure)
        // means the live article may itself be the damaged source.
        ((result === 'failed' || audit.isAudit) ? '<button class="btn-danger processed-remove" data-fresh-recover="' + index + '">🗄 Original HTML Fresh Recovery</button>' : '') +
        '<button class="btn-danger processed-remove" data-processed-remove="' + index + '">Remove</button>' +
        '<button class="btn-primary processed-remove" data-dl-original="' + index + '">⬇ Original HTML</button>' +
      '</div>' +
      '<div class="processed-meta">' +
        escapeHtml(item.time || '') +
        (item.slug ? ' | slug: ' + escapeHtml(item.slug) : '') +
        (item.aiName ? ' | AI: ' + escapeHtml(item.aiName) : '') +
      '</div>' +
      renderProcessedLink('Post', item.postUrl) +
      renderProcessedLink('Edit', item.editorUrl) +
      renderAiSessionLink(item.aiSessionUrl, item.aiProviderUrl, item.message) +
      (item.message ? '<div class="processed-message">' + renderAuditMessage(item.message) + '</div>' : '') +
      renderGateDetails(item) +
    '</div>' +
  '</div>';
}

// Wire buttons, checkboxes and expand/collapse inside a rendered list.
function wireItemActions(el) {
  el.querySelectorAll('[data-processed-remove]').forEach(b => { b.onclick = () => removeProcessedLink(Number(b.dataset.processedRemove)); });
  el.querySelectorAll('[data-processed-retry]').forEach(b => { b.onclick = () => retryProcessedLink(Number(b.dataset.processedRetry)); });
  el.querySelectorAll('[data-dl-original]').forEach(b => { b.onclick = () => downloadOriginalForIndex(Number(b.dataset.dlOriginal)); });
  el.querySelectorAll('[data-recover]').forEach(b => { b.onclick = () => recoverProcessedLink(Number(b.dataset.recover)); });
  el.querySelectorAll('[data-recover-any]').forEach(b => { b.onclick = () => recoverProcessedLink(Number(b.dataset.recoverAny), true); });
  el.querySelectorAll('[data-fresh-recover]').forEach(b => { b.onclick = () => freshRecoverProcessedLink(Number(b.dataset.freshRecover)); });
  el.querySelectorAll('.pi-head').forEach(h => {
    h.onclick = (ev) => {
      if (ev.target.closest('button, a, input')) return;   // buttons never toggle
      const card = h.parentElement;
      const key = card.dataset.key || '';
      card.classList.toggle('open');
      if (card.classList.contains('open')) _openItems.add(key); else _openItems.delete(key);
    };
  });
  el.querySelectorAll('.audit-mark').forEach(cb => {
    cb.onchange = () => {
      const key = cb.dataset.key || '';
      if (cb.checked) _auditSelected.add(key); else _auditSelected.delete(key);
      updateAuditSelectionUi();
    };
  });
}

function setCountChip(id, n) {
  const el = document.getElementById(id);
  // Always show the number (including 0) so every box header states how many.
  if (el) el.textContent = String(n || 0);
}

// ── Single source of truth for a post's final status (v3.13.0) ──
// processedLinks is newest-first (archiveProcessedAttempts unshifts), so the
// FIRST entry seen for a slug key is its latest state. Classifying from this
// "latest per slug" view guarantees a post appears in exactly ONE result box,
// and a retry moves it (Failed → Audit → Successful) with no duplicates.
function slugKeyOf(item) {
  return (((item && (item.rawInput || item.slug)) || '') + '').trim().toLowerCase();
}
function latestStatusEntries() {
  const seen = new Set();
  const out = [];
  state.processedLinks.forEach((item, index) => {
    const key = slugKeyOf(item) || ('#idx' + index);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ item, index });
  });
  return out;
}
// The one box a post belongs in: 'success' | 'audit' | 'failed' | 'other'.
function classifyStatus(item) {
  if ((item.result || '') === 'failed') return 'failed';
  if ((item.result || '') === 'updated') return parseAuditInfo(item.message).isAudit ? 'audit' : 'success';
  return 'other';   // 'checked'/unknown — never shown in the three status boxes
}
function latestByStatus(kind) {
  return latestStatusEntries().filter(({ item }) => classifyStatus(item) === kind);
}

// ✅ Successful box: updated on WordPress AND audit clean (latest status only).
function renderProcessedLinks() {
  const el = document.getElementById('processedList');
  if (!el) return;
  const entries = latestByStatus('success');
  setCountChip('successCount', entries.length);
  el.innerHTML = entries.length
    ? entries.map(({ item, index }, i) => renderResultItem(item, index, { pos: i + 1 })).join('')
    : '<div class="empty">No successful posts yet.</div>';
  wireItemActions(el);
  renderFailedBox();
  renderAuditIssues();
  renderFaqConclBox();
  updateRetryCenter();
}

// ❌ Failed box: latest status is a complete failure (never updated on WP).
function renderFailedBox() {
  const el = document.getElementById('failedList');
  if (!el) return;
  const entries = latestByStatus('failed');
  setCountChip('failedCount', entries.length);
  el.innerHTML = entries.length
    ? entries.map(({ item, index }, i) => renderResultItem(item, index, { pos: i + 1, gateBadges: true })).join('')
    : '<div class="empty">No failed posts.</div>';
  wireItemActions(el);
}

function safeHref(url) {
  // Only allow http/https links to become clickable anchors. A stored
  // javascript:/data: URL would otherwise execute when clicked.
  const u = String(url || '').trim();
  return /^https?:\/\//i.test(u) ? u : '';
}

// ChatGPT sometimes exposes provisional DOM identifiers such as
// /c/WEB:<uuid>. They are not real address-bar conversation routes and must
// never become clickable recovery links. Accept only the two durable route
// shapes used by ChatGPT, then return one canonical, query-free HTTPS URL.
function canonicalChatGptSessionHref(url) {
  const href = safeHref(url);
  if (!href) return '';
  try {
    const u = new URL(href);
    const host = u.hostname.toLowerCase();
    if (u.protocol !== 'https:') return '';
    if (u.username || u.password || u.port) return '';
    if (host !== 'chatgpt.com' && host !== 'www.chatgpt.com' && host !== 'chat.openai.com') return '';
    if ([...u.searchParams.keys()].some((key) => /^(?:temporary-chat|temporary|incognito)$/i.test(key))) return '';
    let decodedHash = u.hash;
    try { decodedHash = decodeURIComponent(decodedHash); } catch (e) {}
    if (/(?:temporary-chat|temporary|incognito)/i.test(decodedHash)) return '';

    const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
    let match = new RegExp('^/c/(' + uuid + ')/?$', 'i').exec(u.pathname || '/');
    if (match) return 'https://chatgpt.com/c/' + match[1].toLowerCase();

    match = new RegExp('^/g/(g-[a-z0-9][a-z0-9_-]*)/c/(' + uuid + ')/?$', 'i').exec(u.pathname || '/');
    if (match) return 'https://chatgpt.com/g/' + match[1] + '/c/' + match[2].toLowerCase();
    return '';
  } catch (e) {
    return '';
  }
}

// A provider homepage is a safe hyperlink, but it is not a saved conversation.
// Keep retry/recovery controls hidden unless the URL has a durable chat route.
function recoverableAiSessionHref(url, providerHomeUrl) {
  const href = safeHref(url);
  if (!href) return '';
  try {
    const u = new URL(href);
    const host = u.hostname.toLowerCase();
    const homeHref = safeHref(providerHomeUrl);
    const home = homeHref ? new URL(homeHref) : null;
    const inDomain = (value, root) => value === root || value.endsWith('.' + root);
    const family = (value) => {
      if (value === 'chatgpt.com' || value === 'www.chatgpt.com' || value === 'chat.openai.com') return 'chatgpt';
      if (inDomain(value, 'claude.ai')) return 'claude';
      if (value === 'gemini.google.com' || value === 'bard.google.com') return 'gemini';
      if (inDomain(value, 'grok.com') || value === 'grok.x.ai') return 'grok';
      if (inDomain(value, 'deepseek.com')) return 'deepseek';
      if (inDomain(value, 'perplexity.ai')) return 'perplexity';
      return 'generic';
    };
    const providerFamily = family(host);
    // Do not let ChatGPT/OpenAI lookalike hosts fall through to the permissive
    // custom-provider rules when an older row has no provider-home context.
    // Only the three exact hosts classified above may carry ChatGPT links.
    if (providerFamily === 'generic' && (host.includes('chatgpt') || host.includes('openai'))) return '';
    if (home) {
      const homeFamily = family(home.hostname.toLowerCase());
      if (providerFamily !== 'generic' || homeFamily !== 'generic') {
        if (providerFamily !== homeFamily) return '';
      } else if (u.origin !== home.origin) {
        return '';
      }
    }
    const path = (u.pathname || '/').replace(/\/+$/, '') || '/';
    const lowerPath = path.toLowerCase();
    const lowerSearch = u.search.toLowerCase();
    const lowerHash = u.hash.toLowerCase();
    if (/\/(?:login|log-in|signin|sign-in|signup|sign-up|auth)(?:\/|$)/i.test(lowerPath)) return '';
    // Presence of any history-off/private-chat marker makes the route
    // non-durable, regardless of its stated value or whether an SPA placed it
    // in the query string or hash. Decode once so encoded markers cannot pass.
    let transientUrlState = u.search + u.hash;
    try { transientUrlState = decodeURIComponent(transientUrlState); } catch (e) {}
    if (/(?:^|[?&#\/:=])(?:temporary-chat|temporary|incognito)(?=$|[?&#\/:=])/i.test(transientUrlState)) return '';
    if (providerFamily === 'chatgpt') return canonicalChatGptSessionHref(href);
    if (host === 'claude.ai' || host.endsWith('.claude.ai')) return /\/chat\/[^/]{6,}(?:\/|$)/i.test(path) ? href : '';
    // Gemini: /app/<hex-id>, multi-account /u/<n>/app/<hex-id>, and Gem
    // conversations /gem/<gem-id>/<hex-id>. Mirrors parseGeminiConversationUrl
    // in background.js — the id must be a server-assigned hex segment.
    if (host === 'gemini.google.com' || host === 'bard.google.com') {
      const gm = path.match(/^(?:\/u\/\d+)?\/(?:app|gem\/[^/]+)\/([^/]+)$/i);
      return (gm && /^[0-9a-f]{8,}$/i.test(gm[1])) ? href : '';
    }
    if (host === 'grok.com' || host.endsWith('.grok.com') || host === 'grok.x.ai') return /\/(?:c|chat)\/[^/]{6,}(?:\/|$)/i.test(path) ? href : '';
    if (host === 'deepseek.com' || host.endsWith('.deepseek.com')) return /\/(?:a\/)?chat\/(?:s\/)?[^/]{4,}(?:\/|$)/i.test(path) ? href : '';
    if (host === 'perplexity.ai' || host.endsWith('.perplexity.ai')) return /\/(?:search|page)\/[^/]{4,}(?:\/|$)/i.test(path) ? href : '';

    const hasSessionParam = [...u.searchParams.entries()].some(([k, v]) =>
      /^(?:chat|conversation|session|thread)(?:[-_]?id)?$/i.test(k) && String(v || '').trim().length >= 3
    );
    const hasSessionHash = /(?:^|[#!\/])(?:chat|conversation|session|thread)[=:\/][^/?#&]{3,}/i.test(lowerHash) &&
      !/(?:^|[#!\/])(?:chat|conversation|session|thread)[=:\/]new(?:\/|$)/i.test(lowerHash);
    if (home) {
      const homePath = (home.pathname || '/').replace(/\/+$/, '') || '/';
      if (u.origin.toLowerCase() + lowerPath === home.origin.toLowerCase() + homePath.toLowerCase()) {
        const homeHash = home.hash.toLowerCase();
        if (!hasSessionParam && !(hasSessionHash && lowerHash !== homeHash)) return '';
      }
    }
    if (lowerPath === '/') return (hasSessionParam || hasSessionHash) ? href : '';
    if (!hasSessionParam && !hasSessionHash && /^\/(?:app|home|dashboard|workspace|chat)$/i.test(lowerPath)) return '';
    return !/\/(?:new|new-chat|chat\/new)(?:\/|$)/i.test(lowerPath) ? href : '';
  } catch (e) {
    return '';
  }
}

function renderAuditMessage(message) {
  const msg = String(message || '');
  // Audit issues stand out in RED; a clean audit shows GREEN. Everything
  // before the audit part (e.g. "Updated on WordPress \u2014 ") stays normal.
  const idxIssue = msg.indexOf('AUDIT ISSUES');
  if (idxIssue >= 0) {
    return escapeHtml(msg.slice(0, idxIssue)) +
      '<span style="color:#ff5566;font-weight:700;">' + escapeHtml(msg.slice(idxIssue)) + '</span>';
  }
  // 🛡 v3.46.0: Safety Gate / Fact check failures are RED from the prefix on.
  const gateHit = msg.match(/SAFETY GATE BLOCKED|FACT CHECK BLOCKED|FACT CHECK ERROR/);
  if (gateHit) {
    return escapeHtml(msg.slice(0, gateHit.index)) +
      '<span style="color:#ff5566;font-weight:700;">' + escapeHtml(msg.slice(gateHit.index)) + '</span>';
  }
  const idxOk = msg.indexOf('audit OK');
  if (idxOk >= 0) {
    return escapeHtml(msg.slice(0, idxOk)) +
      '<span style="color:#5fcc6a;">' + escapeHtml(msg.slice(idxOk)) + '</span>';
  }
  return escapeHtml(msg);
}

function renderProcessedLink(label, url) {
  if (!url) return '';
  const href = safeHref(url);
  if (!href) {
    return '<div class="processed-link">' +
      '<span>' + escapeHtml(label) + '</span><span>' + escapeHtml(url) + '</span></div>';
  }
  return '<div class="processed-link">' +
    '<span>' + escapeHtml(label) + '</span><a href="' + escapeHtml(href) + '" target="_blank" rel="noreferrer noopener">' +
    escapeHtml(href) + '</a></div>';
}

function renderAiSessionLink(url, providerHomeUrl, message) {
  const href = recoverableAiSessionHref(url, providerHomeUrl);
  if (href) return renderProcessedLink('AI session', href);
  const rejectedAddress = !!safeHref(url);
  const shouldWarn = rejectedAddress || /conversation link|provider home|home\/new-chat|chat link missing|durable .* link/i.test(String(message || ''));
  if (!shouldWarn) return '';
  return '<div class="processed-link">' +
    '<span>AI session</span><span style="color:#ff6978;font-weight:700;">' +
    (rejectedAddress
      ? 'Not captured — invalid or provisional AI address rejected. Use Retry new.'
      : 'Not captured — no durable conversation link was saved. Use Retry new.') +
    '</span></div>';
}

async function removeProcessedLink(index) {
  const item = state.processedLinks[index];
  if (!item) return;
  state.processedLinks.splice(index, 1);
  await saveState();
  renderProcessedLinks();
  showMsg('Processed link removed: ' + (item.slug || item.rawInput || 'row'), 'ok');
}

// Retry just THIS one row, using the current default site / AI / prompt / settings.
function retryProcessedLink(index) {
  const item = state.processedLinks[index];
  if (!item) return;
  const slug = (item.rawInput || item.slug || '').trim();
  if (!slug) return showMsg('No slug on this row to retry.', 'err');
  if (state.batchActive) return showMsg('A batch is already running. Wait for it to finish or press Stop first.', 'err');
  if (!requireSaved()) return;   // Fix 6
  const r = (typeof resolveRunConfig === 'function') ? resolveRunConfig() : { ok: false, error: 'config unavailable' };
  if (!r.ok) return showMsg('Cannot retry: ' + r.error + '.', 'err');
  const job = Object.assign({ slugs: [slug] }, r.config);
  chrome.runtime.sendMessage({ type: 'BATCH_START', job }, (resp) => {
    if (chrome.runtime.lastError) return showMsg('Error: ' + chrome.runtime.lastError.message, 'err');
    if (resp && resp.ok) {
      state._fullBatchActive = false;
      showMsg('Retrying "' + slug + '"...', 'ok');
      const runTab = document.querySelector('.tab[data-tab="run"]');
      if (runTab) runTab.click();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      showMsg('Error: ' + (resp && resp.error ? resp.error : 'unknown'), 'err');
    }
  });
}

// Manual "Retry via AI session": reopen this row's saved AI session link and read
// the code box that was already generated, then save it to the post. One clean
// recovery pass -- no regenerate fallback and no auto-retry cascade.
function recoverProcessedLink(index, recoverAnyCode) {
  const item = state.processedLinks[index];
  if (!item) return;
  const slug = (item.rawInput || item.slug || '').trim();
  const sessionUrl = recoverableAiSessionHref(item.aiSessionUrl, item.aiProviderUrl);
  if (!slug) return showMsg('No slug on this row to recover.', 'err');
  if (!sessionUrl) return showMsg('No recoverable AI conversation link was saved on this row. Use Retry new.', 'err');
  if (state.batchActive) return showMsg('A batch is already running. Wait for it to finish or press Stop first.', 'err');
  if (!requireSaved()) return;   // Fix 6
  const r = (typeof resolveRunConfig === 'function') ? resolveRunConfig() : { ok: false, error: 'config unavailable' };
  if (!r.ok) return showMsg('Cannot recover: ' + r.error + '.', 'err');
  const job = Object.assign({ slugs: [slug] }, r.config, {
    recoverFromUrl: sessionUrl,
    recoverProviderUrl: item.aiProviderUrl || '',
    retryMode: 'off',
    maxRetries: 0,
    fallbackAi: null,
    auditRetry: false,
    htmlRecoveryAudit: false,
    htmlRecoveryFailed: false,
    recoverAnyCode: recoverAnyCode === true
  });
  chrome.runtime.sendMessage({ type: 'BATCH_START', job }, (resp) => {
    if (chrome.runtime.lastError) return showMsg('Error: ' + chrome.runtime.lastError.message, 'err');
    if (resp && resp.ok) {
      state._fullBatchActive = false;
      showMsg((recoverAnyCode ? 'Recovering ANY HTML code for "' : 'Recovering "') + slug + '" from its saved AI session...', 'ok');
      const runTab = document.querySelector('.tab[data-tab="run"]');
      if (runTab) runTab.click();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      showMsg('Error: ' + (resp && resp.error ? resp.error : 'unknown'), 'err');
    }
  });
}

// -- Bulk one-click retries: run every failed / audit-flagged post in ONE batch --
function _bulkStart(job, msg) {
  chrome.runtime.sendMessage({ type: 'BATCH_START', job }, (resp) => {
    if (chrome.runtime.lastError) return showMsg('Error: ' + chrome.runtime.lastError.message, 'err');
    if (resp && resp.ok) {
      state._fullBatchActive = false;
      showMsg(msg, 'ok');
      const runTab = document.querySelector('.tab[data-tab="run"]'); if (runTab) runTab.click();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      showMsg('Error: ' + (resp && resp.error ? resp.error : 'unknown'), 'err');
    }
  });
}
function _slugOfRow(p) { return (p.rawInput || p.slug || '').trim(); }
// Latest-status only (Fix 4/8): a post that was since fixed clean, or that
// re-failed, is counted in exactly one box — no stale duplicates in bulk retry.
function _failedRows() { return latestByStatus('failed').map(e => e.item); }
function _auditRows() { return latestByStatus('audit').map(e => e.item); }

function retryAllNewSession(rows, label) {
  if (state.batchActive) return showMsg('A batch is already running. Wait for it to finish or press Stop first.', 'err');
  if (!requireSaved()) return;   // Fix 6
  const slugs = [...new Set(rows.map(_slugOfRow).filter(Boolean))];
  if (!slugs.length) return showMsg('No ' + label + ' posts to retry.', 'err');
  const r = (typeof resolveRunConfig === 'function') ? resolveRunConfig() : { ok: false, error: 'config unavailable' };
  if (!r.ok) return showMsg('Cannot retry: ' + r.error + '.', 'err');
  _bulkStart(Object.assign({ slugs }, r.config), 'Retrying ' + slugs.length + ' ' + label + ' post(s) in a new session, one by one...');
}
// Intro/FAQ/Conclusion recovery: same saved-session re-read, but the engine
// accepts the article when all three sections are present.
function retryAllSectionRecovery(rows, label) {
  return retryAllAiSession(rows, label, false, true);
}
function retryAllAiSession(rows, label, recoverAnyCode, recoverSections) {
  if (state.batchActive) return showMsg('A batch is already running. Wait for it to finish or press Stop first.', 'err');
  if (!requireSaved()) return;   // Fix 6
  const recoverMap = {}; const recoverProviderMap = {}; const slugs = [];
  rows.forEach(p => {
    const slug = _slugOfRow(p); const url = recoverableAiSessionHref(p.aiSessionUrl, p.aiProviderUrl);
    if (slug && url && !recoverMap[slug]) {
      recoverMap[slug] = url;
      recoverProviderMap[slug] = p.aiProviderUrl || '';
      slugs.push(slug);
    }
  });
  if (!slugs.length) {
    // Distinguish "nothing in the list" from "nothing has a reusable chat link"
    // — otherwise this looks like the button simply does nothing.
    const total = rows.length;
    return showMsg(total
      ? total + ' ' + label + ' post(s) are listed, but none has a saved AI conversation link to re-read (the chat was never created, or the link was not durable). Use the "new session" button instead.'
      : 'There are no ' + label + ' posts to retry.', 'err');
  }
  const r = (typeof resolveRunConfig === 'function') ? resolveRunConfig() : { ok: false, error: 'config unavailable' };
  if (!r.ok) return showMsg('Cannot recover: ' + r.error + '.', 'err');
  const job = Object.assign({ slugs }, r.config, { recoverMap: recoverMap, recoverProviderMap: recoverProviderMap, retryMode: 'off', maxRetries: 0, fallbackAi: null, auditRetry: false, htmlRecoveryAudit: false, htmlRecoveryFailed: false, recoverAnyCode: recoverAnyCode === true, recoverSections: recoverSections === true });
  _bulkStart(job, 'Recovering ' + (recoverAnyCode ? 'ANY HTML code for ' : recoverSections ? 'Intro/FAQ/Conclusion articles for ' : '') + slugs.length + ' ' + label + ' post(s) from their saved AI sessions, one by one...');
}
{ const b = document.getElementById('retryAllFailedNewBtn'); if (b) b.onclick = () => retryAllNewSession(_failedRows(), 'failed'); }
{ const b = document.getElementById('retryAllFailedSessionBtn'); if (b) b.onclick = () => retryAllAiSession(_failedRows(), 'failed'); }
{ const b = document.getElementById('retryAllFailedAnyCodeBtn'); if (b) b.onclick = () => retryAllAiSession(_failedRows(), 'failed', true); }
{ const b = document.getElementById('retryAllFailedSectionsBtn'); if (b) b.onclick = () => retryAllSectionRecovery(_failedRows(), 'failed'); }
{ const b = document.getElementById('retryAllAuditNewBtn'); if (b) b.onclick = () => retryAllNewSession(_auditRows(), 'audit'); }
{ const b = document.getElementById('retryAllAuditSessionBtn'); if (b) b.onclick = () => retryAllAiSession(_auditRows(), 'audit'); }
{ const b = document.getElementById('retryAllAuditAnyCodeBtn'); if (b) b.onclick = () => retryAllAiSession(_auditRows(), 'audit', true); }   // Fix 4

setInterval(pollStatus, 1000);

function csvCell(value) {
  return '"' + String(value == null ? '' : value)
    .replace(/\r?\n/g, ' ')
    .replace(/"/g, '""') + '"';
}

function downloadProcessedExcel() {
  if (!state.processedLinks.length) return showMsg('No processed links to download.', 'err');
  const header = [
    'Status',
    'Review Action',
    'Processed At',
    'WordPress Post Link',
    'WordPress Edit Link',
    'Input Link',
    'Slug',
    'AI Provider',
    'AI Session Link',
    'Message',
    'AI Provider Start Link',
    'Gate reasons'
  ];
  const rows = state.processedLinks.map(item =>
    [
      processedCsvStatus(item),
      processedCsvAction(item),
      processedCsvTime(item),
      item.postUrl,
      item.editorUrl,
      item.rawInput,
      item.slug,
      item.aiName,
      recoverableAiSessionHref(item.aiSessionUrl, item.aiProviderUrl),
      item.message,
      item.aiProviderUrl,
      gateReasonsText(item)
    ].map(csvCell).join(',')
  );
  // Excel opens CSV reliably. The UTF-8 BOM keeps non-ASCII text readable.
  const csv = '\ufeff' + [header.map(csvCell).join(','), ...rows].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'auto-batch-processed-links-' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  showMsg('Processed links CSV downloaded. Open it in Excel to see every row and link.', 'ok');
}

function processedCsvStatus(item) {
  return item.result === 'updated' ? 'SUCCESS - Updated' : 'FAILED - Review Needed';
}

function processedCsvAction(item) {
  if (item.result === 'updated') return 'Updated in WordPress';
  return recoverableAiSessionHref(item.aiSessionUrl, item.aiProviderUrl)
    ? 'Open WordPress edit link and AI session link'
    : 'AI session link missing — retry in a new session';
}

function processedCsvTime(item) {
  return item.isoTime || item.time || '';
}

document.getElementById('downloadProcessedBtn').onclick = downloadProcessedExcel;

// -- Audit Issues box ------------------------------------------------
// A separate box that lists ONLY the processed links whose audit found
// problems (the rows shown in red -- message contains "AUDIT ISSUES"),
// each with its own Excel CSV download. Purely additive: the main
// Processed Links box above is left exactly as it was.
function auditIssueItems() {
  // Latest status only, so a post that was later fixed clean (or re-failed)
  // leaves the Audit box instead of lingering as a stale duplicate.
  return latestByStatus('audit');
}

// 🔴 Audit Issues box — sorted worst-first:
//   missing FAQ + Conclusion → missing FAQ → missing Conclusion →
//   most audit issues → fewest. Each row has a mark checkbox for the
//   bulk "Run Selected Posts in New AI Session" re-run.
function renderAuditIssues() {
  const el = document.getElementById('auditIssuesList');
  if (!el) return;
  const entries = auditIssueItems()
    .map(e => ({ item: e.item, index: e.index, audit: parseAuditInfo(e.item.message) }))
    .sort((x, y) =>
      auditSortRank(x.audit) - auditSortRank(y.audit) ||
      y.audit.count - x.audit.count);
  setCountChip('auditCount', entries.length);
  // Drop selections whose rows no longer exist (retried / removed / cleared).
  const validKeys = new Set(entries.map(e => itemKey(e.item)));
  [..._auditSelected].forEach(k => { if (!validKeys.has(k)) _auditSelected.delete(k); });
  el.innerHTML = entries.length
    ? entries.map(({ item, index }, i) => renderResultItem(item, index, { checkbox: true, badges: true, pos: i + 1 })).join('')
    : '<div class="empty">No audit issues yet.</div>';
  wireItemActions(el);
  updateAuditSelectionUi();
}

// 📝 FAQ / Conclusion missing sub-box — a focused view of the audit issues,
// filtered to posts whose audit flags a missing FAQ and/or Conclusion.
function renderFaqConclBox() {
  const el = document.getElementById('faqConclList');
  if (!el) return;
  const entries = faqConclRows()
    .map(e => ({ item: e.item, index: e.index, audit: parseAuditInfo(e.item.message) }))
    .sort((x, y) =>
      auditSortRank(x.audit) - auditSortRank(y.audit) ||
      y.audit.count - x.audit.count);
  setCountChip('faqCount', entries.length);
  el.innerHTML = entries.length
    ? entries.map(({ item, index }, i) => renderResultItem(item, index, { badges: true, pos: i + 1 })).join('')
    : '<div class="empty">No FAQ/Conclusion-missing posts.</div>';
  wireItemActions(el);
}

// ── Mark & re-run system ─────────────────────────────────────────
function updateAuditSelectionUi() {
  const lbl = document.getElementById('auditSelCount');
  if (lbl) lbl.textContent = _auditSelected.size ? (_auditSelected.size + ' selected') : 'none selected';
  const btn = document.getElementById('runSelectedAuditBtn');
  if (btn) btn.disabled = _auditSelected.size === 0;
}

function selectedAuditRows() {
  return auditIssueItems().filter(({ item }) => _auditSelected.has(itemKey(item)));
}

// Posts whose audit says the FAQ and/or Conclusion is missing.
function faqConclRows() {
  return auditIssueItems().filter(({ item }) => {
    const a = parseAuditInfo(item.message);
    return a.missingFaq || a.missingConcl;
  });
}

// Run a set of audit-flagged posts again in a NEW AI session. Each post's own
// audit issues travel with the job (issueMap), so the AI is told exactly what
// to fix for that specific article.
function runAuditFixBatch(rows, label, opts) {
  opts = opts || {};
  if (state.batchActive) return showMsg('A batch is already running. Wait for it to finish or press Stop first.', 'err');
  if (!requireSaved()) return;   // Fix 6
  const slugs = [];
  const issueMap = {};
  rows.forEach(({ item }) => {
    const slug = (item.rawInput || item.slug || '').trim();
    if (!slug || issueMap[slug] !== undefined) return;
    slugs.push(slug);
    issueMap[slug] = parseAuditInfo(item.message).issuesText || '';
  });
  if (!slugs.length) return showMsg('No ' + label + ' posts to run.', 'err');
  const r = resolveRunConfig();
  if (!r.ok) return showMsg('Cannot run: ' + r.error + '.', 'err');
  if (!opts.noConfirm && !confirm('Run ' + slugs.length + ' ' + label + ' post(s) again in a new AI session?\n\nEach post is re-sent with its own audit issues attached so the AI fixes exactly what was flagged.')) return;
  const job = Object.assign({ slugs }, r.config, { issueMap });
  _bulkStart(job, 'Running ' + slugs.length + ' ' + label + ' post(s) in a new AI session — each with its audit issues attached...');
  _auditSelected.clear();
  updateAuditSelectionUi();
}

// FAQ-Conclusion Missing AI Session (automatic mode). Runs only when the
// toggle is ON, only after a FULL batch finishes, and never off the back of
// a retry/test/auto batch — so it can never loop.
function autoRunFaqConclSession() {
  if (state.faqConclAuto !== 'on') return;
  if (state.batchActive) return;
  const rows = faqConclRows();
  if (!rows.length) return;
  showMsg('FAQ-Conclusion Missing AI Session: auto-running ' + rows.length + ' post(s) with a missing FAQ/Conclusion...', 'ok');
  runAuditFixBatch(rows, 'FAQ/Conclusion-missing', { noConfirm: true });
}

{ const b = document.getElementById('auditSelectAllBtn'); if (b) b.onclick = () => { auditIssueItems().forEach(({ item }) => _auditSelected.add(itemKey(item))); renderAuditIssues(); }; }
{ const b = document.getElementById('auditClearSelBtn'); if (b) b.onclick = () => { _auditSelected.clear(); renderAuditIssues(); }; }
{ const b = document.getElementById('runSelectedAuditBtn'); if (b) b.onclick = () => runAuditFixBatch(selectedAuditRows(), 'selected'); }
// FAQ/Conclusion-missing bulk retries, moved into the Retry Center → Retry All
// At Once section. AI session re-reads saved chats; Recover any code accepts
// partial HTML; New session re-runs with the FAQ/Conclusion issue attached.
// 🗄 Original HTML Fresh Recovery — rebuild from the pre-update backup only.
// The background refuses to start a post whose backup is missing, so one
// unbackupable post can never take the rest of the batch down with it.
function runFreshRecovery(rows, label) {
  if (state.batchActive) return showMsg('A batch is already running. Wait for it to finish or press Stop first.', 'err');
  if (!requireSaved()) return;
  const slugs = [];
  const issueMap = {};
  rows.forEach((entry) => {
    const item = entry && entry.item ? entry.item : entry;      // accept both shapes
    const slug = (item.rawInput || item.slug || '').trim();
    if (!slug || issueMap[slug] !== undefined) return;
    slugs.push(slug);
    issueMap[slug] = parseAuditInfo(item.message).issuesText || '';
  });
  if (!slugs.length) return showMsg('No ' + label + ' posts to rebuild.', 'err');
  const r = (typeof resolveRunConfig === 'function') ? resolveRunConfig() : { ok: false, error: 'config unavailable' };
  if (!r.ok) return showMsg('Cannot start: ' + r.error + '.', 'err');
  if (!confirm('🗄 Original HTML Fresh Recovery for ' + slugs.length + ' ' + label + ' post(s)?\n\n' +
      'Each post is rebuilt from its ORIGINAL pre-update HTML backup in a brand-new AI session — the article currently on WordPress and the last AI reply are both ignored.\n\n' +
      'Posts with no saved backup are skipped with an error; nothing on WordPress changes for them.\n\n' +
      'They are processed one by one; a failure never stops the rest.')) return;
  const job = Object.assign({ slugs }, r.config, {
    issueMap,
    freshFromBackup: true,
    retryMode: 'off',
    maxRetries: 0,
    fallbackAi: null,
    auditRetry: false,
    htmlRecoveryAudit: false,
    htmlRecoveryFailed: false,
    parallel: 1
  });
  _bulkStart(job, '🗄 Rebuilding ' + slugs.length + ' ' + label + ' post(s) from their original HTML backups, one by one...');
}
function freshRecoverProcessedLink(index) {
  const item = state.processedLinks[index];
  if (!item) return showMsg('That row is no longer available.', 'err');
  runFreshRecovery([item], 'selected');
}
{ const b = document.getElementById('retryAllFaqFreshBtn'); if (b) b.onclick = () => runFreshRecovery(faqConclRows(), 'FAQ/Conclusion-missing'); }
{ const b = document.getElementById('faqBoxFreshBtn'); if (b) b.onclick = () => runFreshRecovery(faqConclRows(), 'FAQ/Conclusion-missing'); }

{ const b = document.getElementById('retryAllFaqSessionBtn'); if (b) b.onclick = () => retryAllAiSession(faqConclRows().map(e => e.item), 'FAQ/Conclusion-missing'); }
{ const b = document.getElementById('retryAllFaqAnyCodeBtn'); if (b) b.onclick = () => retryAllAiSession(faqConclRows().map(e => e.item), 'FAQ/Conclusion-missing', true); }
{ const b = document.getElementById('retryAllFaqNewBtn'); if (b) b.onclick = () => runAuditFixBatch(faqConclRows(), 'FAQ/Conclusion-missing'); }
// Same three actions, from inside the FAQ / Conclusion missing sub-box.
{ const b = document.getElementById('faqBoxAiBtn'); if (b) b.onclick = () => retryAllAiSession(faqConclRows().map(e => e.item), 'FAQ/Conclusion-missing'); }
{ const b = document.getElementById('faqBoxAnyBtn'); if (b) b.onclick = () => retryAllAiSession(faqConclRows().map(e => e.item), 'FAQ/Conclusion-missing', true); }
{ const b = document.getElementById('faqBoxNewBtn'); if (b) b.onclick = () => runAuditFixBatch(faqConclRows(), 'FAQ/Conclusion-missing'); }
// ════════════════════════════════════════════════════════════════
// 🤖 Auto-retry (runs by itself) — a simple front-end over the existing,
// tested retry engine. It only WRITES the existing state fields the batch
// already reads (retryMode / auditRetry* / htmlRecovery* / faqConclAuto), so
// there is no new machinery and no new background code. Off by default per
// the current settings (nothing changes unless the user turns it on).
// ════════════════════════════════════════════════════════════════
function reflectLegacyRetryControls() {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = String(val); };
  set('retryMode', state.retryMode);
  set('maxRetries', state.maxRetries);
  set('auditRetryEnabled', state.auditRetryEnabled);
  set('auditRetryTiming', state.auditRetryTiming);
  set('htmlRecoveryAudit', state.htmlRecoveryAudit);
  set('htmlRecoveryFailed', state.htmlRecoveryFailed);
  set('faqConclAuto', state.faqConclAuto);
}
function applyAutoRetryDisabledUi() {
  const off = (state.autoRetryWhen || 'off') === 'off';
  ['autoRetryMethod','autoRetryFailed','autoRetryAudit','autoRetryFaq'].forEach(id => {
    const el = document.getElementById(id); if (!el) return;
    el.disabled = off; el.style.opacity = off ? '0.45' : '';
  });
}
function updateAutoRetrySummary() {
  const el = document.getElementById('autoRetrySummary'); if (!el) return;
  const when = state.autoRetryWhen || 'off';
  if (when === 'off') { el.className = 'status-line'; el.textContent = 'Off — retries run only when you click the buttons below.'; return; }
  const cats = [];
  if (state.autoRetryFailed === 'on') cats.push('failed');
  if (state.autoRetryAudit === 'on') cats.push('audit-issue');
  if (state.autoRetryFaq === 'on') cats.push('FAQ/Conclusion-missing');
  if (!cats.length) { el.className = 'status-line error'; el.textContent = 'Pick at least one type (Failed / Audit / FAQ) to auto-retry.'; return; }
  const whenTxt = when === 'each' ? 'after each article' : 'after the whole batch finishes';
  const methodTxt = state.autoRetryMethod === 'anycode'
    ? 're-reading the saved AI session and accepting any code (even partial)'
    : (state.autoRetryMethod === 'session' ? 're-reading the saved AI session' : 'a new AI session');
  el.className = 'status-line success';
  el.textContent = '✅ ' + cats.join(', ') + ' posts are retried ' + whenTxt + ' using ' + methodTxt + '.';
}
// Panel controls → existing state fields the batch already reads.
function commitAutoRetry() {
  const when = state.autoRetryWhen || 'off';
  const method = state.autoRetryMethod || 'new';
  const failed = state.autoRetryFailed === 'on';
  const audit = state.autoRetryAudit === 'on';
  const faq = state.autoRetryFaq === 'on';
  // "Recover any code" behaves like "re-read saved session" but also accepts
  // shorter/partial HTML (bypasses the completeness gate for that save).
  const sessionRead = (method === 'session' || method === 'anycode');
  if (when === 'off') {
    state.retryMode = 'off';
    state.auditRetryEnabled = 'off';
    state.htmlRecoveryAudit = 'off';
    state.htmlRecoveryFailed = 'off';
    state.htmlRecoveryAnyCode = 'off';
    state.faqConclAuto = 'off';
  } else {
    const timing = when === 'each' ? 'immediate' : 'end';
    state.retryMode = failed ? (when === 'each' ? 'inline' : 'end') : 'off';
    state.htmlRecoveryFailed = (failed && sessionRead) ? 'on' : 'off';
    if (failed && parseInt(state.maxRetries || '0', 10) < 1) state.maxRetries = '1';
    // FAQ/Conclusion posts ARE audit issues, so per-article FAQ folds into the
    // immediate audit retry (which re-sends each with its issues attached).
    const auditOn = audit || (faq && when === 'each');
    state.auditRetryEnabled = auditOn ? 'on' : 'off';
    state.auditRetryTiming = timing;
    state.htmlRecoveryAudit = (auditOn && sessionRead) ? 'on' : 'off';
    if (auditOn && !['1','2','3'].includes(String(state.auditRetryCount))) state.auditRetryCount = '1';
    // Accept partial HTML during the session re-read when method is "any code".
    state.htmlRecoveryAnyCode = (method === 'anycode') ? 'on' : 'off';
    // The dedicated after-batch FAQ/Conclusion new-session run.
    state.faqConclAuto = (faq && when === 'end') ? 'on' : 'off';
  }
  reflectLegacyRetryControls();
  applyAutoRetryDisabledUi();
  updateAutoRetrySummary();
  saveState();
}
// Existing state fields → panel display (so the panel shows the current reality
// on load without changing any behavior).
function deriveAutoRetryFromState() {
  const auditOn = state.auditRetryEnabled === 'on';
  const faqOn = state.faqConclAuto === 'on';
  const failedOn = state.retryMode === 'end' || state.retryMode === 'inline';
  let when = 'off';
  if (auditOn) when = (state.auditRetryTiming === 'immediate') ? 'each' : 'end';
  else if (failedOn) when = (state.retryMode === 'inline') ? 'each' : 'end';
  else if (faqOn) when = 'end';
  state.autoRetryWhen = when;
  state.autoRetryFailed = failedOn ? 'on' : 'off';
  state.autoRetryAudit = auditOn ? 'on' : 'off';
  state.autoRetryFaq = faqOn ? 'on' : 'off';
  state.autoRetryMethod = (state.htmlRecoveryAnyCode === 'on')
    ? 'anycode'
    : ((state.htmlRecoveryAudit === 'on' || state.htmlRecoveryFailed === 'on') ? 'session' : 'new');
  const set = (id, val, checkbox) => { const el = document.getElementById(id); if (!el) return; if (checkbox) el.checked = val === 'on'; else el.value = val; };
  set('autoRetryWhen', state.autoRetryWhen);
  set('autoRetryMethod', state.autoRetryMethod);
  set('autoRetryFailed', state.autoRetryFailed, true);
  set('autoRetryAudit', state.autoRetryAudit, true);
  set('autoRetryFaq', state.autoRetryFaq, true);
  applyAutoRetryDisabledUi();
  updateAutoRetrySummary();
}
{ const el = document.getElementById('autoRetryWhen'); if (el) el.onchange = (e) => { state.autoRetryWhen = e.target.value; commitAutoRetry(); }; }
{ const el = document.getElementById('autoRetryMethod'); if (el) el.onchange = (e) => { state.autoRetryMethod = e.target.value; commitAutoRetry(); }; }
{ const el = document.getElementById('autoRetryFailed'); if (el) el.onchange = (e) => { state.autoRetryFailed = e.target.checked ? 'on' : 'off'; commitAutoRetry(); }; }
{ const el = document.getElementById('autoRetryAudit'); if (el) el.onchange = (e) => { state.autoRetryAudit = e.target.checked ? 'on' : 'off'; commitAutoRetry(); }; }
{ const el = document.getElementById('autoRetryFaq'); if (el) el.onchange = (e) => { state.autoRetryFaq = e.target.checked ? 'on' : 'off'; commitAutoRetry(); }; }

const _faqAutoSel = document.getElementById('faqConclAuto');
if (_faqAutoSel) _faqAutoSel.onchange = (e) => { state.faqConclAuto = e.target.value; saveState(); };
const _pcSel = document.getElementById('parallelCount');
if (_pcSel) _pcSel.onchange = (e) => { state.parallelCount = e.target.value; saveState(); };
const _fraSel = document.getElementById('fastRecoverAfter');
if (_fraSel) {
  const commitDelay = (e) => {
    const n = sanitizeDelay(e.target.value);
    state.fastRecoverAfter = String(n);
    e.target.value = String(n);   // reflect the clamped value
    saveState();
  };
  _fraSel.onchange = commitDelay;
  _fraSel.onblur = commitDelay;
}
const _facSel = document.getElementById('fastAnyCode');
if (_facSel) _facSel.onchange = (e) => { state.fastAnyCode = e.target.value; saveState(); };
const _fcsInp = document.getElementById('fastChunkSize');
if (_fcsInp) {
  const commitChunk = (e) => {
    const n = sanitizeChunkSize(e.target.value);
    state.fastChunkSize = String(n);
    e.target.value = String(n);   // show the clamped value back to the user
    saveState();
  };
  _fcsInp.onchange = commitChunk;
  _fcsInp.onblur = commitChunk;
}
// Fast Submit "Start after" — whole minutes, 0..500, default 0 (start now).
function sanitizeStartAfter(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(500, n);
}
const _fsaInp = document.getElementById('fastStartAfter');
if (_fsaInp) {
  const commitStartAfter = (e) => {
    const raw = String(e.target.value ?? '').trim();
    const n = sanitizeStartAfter(raw);
    if (raw !== '' && (!/^\d+$/.test(raw) || n !== Number(raw))) {
      showMsg('Start after must be a whole number of minutes between 0 and 500 — set to ' + n + '.', 'err');
    }
    state.fastStartAfter = String(n);
    e.target.value = String(n);
    saveState();
  };
  _fsaInp.onchange = commitStartAfter;
  _fsaInp.onblur = commitStartAfter;
}

// Fast Submit "Paste retries" — 1..3 attempts, default 3.
function sanitizePasteRetries(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(3, n));
}
const _fprSel = document.getElementById('fastPasteRetries');
if (_fprSel) _fprSel.onchange = (e) => {
  state.fastPasteRetries = String(sanitizePasteRetries(e.target.value));
  saveState();
  if (state.batchActive) pushLiveSettings({ silent: true });
};

// Fast Submit "Prompt paste wait" — whole seconds, 1..600, default 10.
function sanitizePasteWait(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 10;
  return Math.max(1, Math.min(600, n));
}
const _fpwInp = document.getElementById('fastPasteWait');
if (_fpwInp) {
  const commitPasteWait = (e) => {
    const raw = String(e.target.value ?? '').trim();
    const n = sanitizePasteWait(raw);
    // Anything empty, non-numeric, decimal or out of range falls back to the
    // safe default and is shown back to the user immediately.
    if (raw === '' || !/^\d+$/.test(raw) || n !== Number(raw)) {
      showMsg('Prompt paste wait must be a whole number of seconds between 1 and 600 — reset to ' + n + 's.', 'err');
    }
    state.fastPasteWait = String(n);
    e.target.value = String(n);
    saveState();
    if (state.batchActive) pushLiveSettings({ silent: true });
  };
  _fpwInp.onchange = commitPasteWait;
  _fpwInp.onblur = commitPasteWait;
}
// "Recover myself (manual)": submit all at once, no timer, no per-cycle system.
// When on, the delay and posts-per-cycle inputs are greyed out (ignored).
function applyFastManualUi() {
  const on = state.fastManual === 'on';
  const fra = document.getElementById('fastRecoverAfter');
  const fcs = document.getElementById('fastChunkSize');
  [fra, fcs].forEach(el => {
    if (!el) return;
    el.disabled = on;
    el.style.opacity = on ? '0.45' : '';
  });
}
const _fmChk = document.getElementById('fastManual');
if (_fmChk) _fmChk.onchange = (e) => {
  state.fastManual = e.target.checked ? 'on' : 'off';
  applyFastManualUi();
  saveState();
};

// ════════════════════════════════════════════════════════════════
// 🚀 Fast Submit + ⏰ Timed Recovery
// ════════════════════════════════════════════════════════════════
// Chunk size validation shared by load, sync, and the input handler:
// integer 1–2000, default 50; blank/NaN → 50, zero/negative → 1, >2000 → 2000.
function sanitizeChunkSize(v) {
  let n = parseInt(v, 10);
  if (!Number.isFinite(n)) n = 50;
  if (n < 1) n = 1;
  if (n > 2000) n = 2000;
  return n;
}
// Recovery delay (minutes): integer 1–500, default 10; blank/NaN → 10,
// below range → 1, above range → 500.
function sanitizeDelay(v) {
  let n = parseInt(v, 10);
  if (!Number.isFinite(n)) n = 10;
  if (n < 1) n = 1;
  if (n > 500) n = 500;
  return n;
}
{ const b = document.getElementById('fastSubmitBtn'); if (b) b.onclick = async () => {
  if (state.batchActive) return showMsg('A batch is already running. Wait for it to finish or press Stop first.', 'err');
  if (!requireSaved()) return;   // Fix 6
  // Prompt paste wait must be a valid whole number BEFORE anything starts.
  {
    const el = document.getElementById('fastPasteWait');
    const raw = String(el ? el.value : (state.fastPasteWait ?? '')).trim();
    if (raw === '' || !/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 600) {
      const safe = sanitizePasteWait(raw);
      state.fastPasteWait = String(safe);
      if (el) el.value = String(safe);
      await saveState();
      return showMsg('Prompt paste wait must be a whole number of seconds between 1 and 600. It was reset to the safe default of ' + safe + 's — press Fast-Submit again to start.', 'err');
    }
  }
  syncStateFromUi();
  const raw = document.getElementById('slugTextarea').value;
  state.savedSlugDraft = raw;
  await saveState();
  const seen = new Set();
  const slugs = raw.split(/\r?\n/).map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .filter(l => { if (seen.has(l)) return false; seen.add(l); return true; });
  if (!slugs.length) return showMsg('Paste at least one slug or URL first.', 'err');
  state.lastRunSlugs = slugs.slice();   // remembered so the box clears on finish
  const r = resolveRunConfig();
  if (!r.ok) return showMsg('Cannot start: ' + r.error + '.', 'err');
  if (r.config.aiMode && r.config.aiMode !== 'web') {
    return showMsg('Fast Submit needs a WEB AI provider (ChatGPT / Grok / Claude / Gemini tab). API mode replies instantly — there is no chat to recover later.', 'err');
  }
  const manual = state.fastManual === 'on';
  const mins = manual ? 0 : sanitizeDelay(state.fastRecoverAfter);
  const chunkSize = sanitizeChunkSize(state.fastChunkSize);
  state.fastChunkSize = String(chunkSize);
  // Manual mode: submit ALL posts at once, no timer, no per-cycle system.
  const totalChunks = manual ? 1 : Math.ceil(slugs.length / chunkSize);
  let confirmMsg;
  if (manual) {
    confirmMsg = '🚀 Fast-submit ALL ' + slugs.length + ' post(s) at once?\n\nEach post: open AI → paste prompt + article → SEND → save the chat link → close the tab. No waiting for replies.\n\n🙋 “Recover myself” is ON — no timer and no per-cycle system. When the AI has had time to finish, press “⏰ Recover & Update Now” yourself.\n\nKeep Chrome open the whole time.';
  } else if (totalChunks <= 1) {
    // Single cycle (list ≤ one chunk) — classic Fast Submit wording.
    confirmMsg = '🚀 Fast-submit ' + slugs.length + ' post(s)?\n\nEach post: open AI → paste prompt + article → SEND → save the chat link → close the tab. No waiting for replies.\n\nRecovery: ' + (mins > 0 ? 'starts automatically ' + mins + ' min after the last submission.' : 'manual — press "⏰ Recover & Update Now" later.') + '\n\nKeep Chrome open the whole time.';
  } else {
    const finalSize = slugs.length - (totalChunks - 1) * chunkSize;
    const eachLine = mins > 0
      ? 'Each cycle: submit the group, wait ' + mins + ' min, recover/update the group, then start the next group automatically.'
      : 'Each cycle: submit the group, then wait for you to press "⏰ Recover & Update Now"; the next group starts automatically once that cycle finishes.';
    confirmMsg = '🚀 Fast-submit ' + slugs.length + ' posts in ' + totalChunks + ' cycles?\n\n' +
      'Cycle size: ' + chunkSize + ' posts.\n' +
      eachLine + '\n' +
      'The final cycle will contain ' + finalSize + ' post(s).\n\nKeep Chrome open the whole time.';
  }
  // "Start after N minutes": pressing the button only SCHEDULES the run.
  const startAfter = sanitizeStartAfter(state.fastStartAfter);
  if (startAfter > 0) {
    const at = new Date(Date.now() + startAfter * 60000).toLocaleTimeString();
    confirmMsg += '\n\n⏳ START AFTER: nothing is sent now — this run begins by itself at ' +
      at + ' (in ' + startAfter + ' min). Keep Chrome open; cancel with "✖ Cancel schedule".';
  }
  if (!confirm(confirmMsg)) return;
  const job = Object.assign({ slugs }, r.config, { fastSubmit: true, recoverAfterMin: mins, parallel: 1, fastChunkSize: chunkSize, fastManual: manual, fastPasteWait: sanitizePasteWait(state.fastPasteWait), fastPasteRetries: sanitizePasteRetries(state.fastPasteRetries) });

  if (startAfter > 0) {
    chrome.runtime.sendMessage({ type: 'FAST_SCHEDULE_START', job, minutes: startAfter }, (resp) => {
      if (chrome.runtime.lastError) return showMsg('Error: ' + chrome.runtime.lastError.message, 'err');
      if (resp && resp.ok) {
        state._fullBatchActive = false;
        const at2 = new Date(resp.when).toLocaleTimeString();
        showMsg('⏳ Fast Submit scheduled — ' + slugs.length + ' post(s) will start automatically at ' + at2 +
                ' (in ' + resp.minutes + ' min). Nothing has been sent yet.', 'ok');
        refreshFastQueueStatus();
      } else {
        showMsg('Error: ' + (resp && resp.error ? resp.error : 'unknown'), 'err');
      }
    });
    return;
  }

  chrome.runtime.sendMessage({ type: 'BATCH_START', job }, (resp) => {
    if (chrome.runtime.lastError) return showMsg('Error: ' + chrome.runtime.lastError.message, 'err');
    if (resp && resp.ok) {
      state._fullBatchActive = false;
      showMsg('🚀 Fast submit started — sending ' + slugs.length + ' prompt(s) without waiting.', 'ok');
    } else {
      showMsg('Error: ' + (resp && resp.error ? resp.error : 'unknown'), 'err');
    }
  });
}; }
{ const b = document.getElementById('fastRecoverNowBtn'); if (b) b.onclick = () => {
  if (state.batchActive) return showMsg('A batch is already running. Wait for it to finish or press Stop first.', 'err');
  chrome.runtime.sendMessage({ type: 'FAST_RECOVER_NOW' }, (resp) => {
    if (chrome.runtime.lastError) return showMsg('Error: ' + chrome.runtime.lastError.message, 'err');
    if (resp && resp.ok) showMsg('⏰ Recovery started — opening ' + resp.count + ' saved AI chat(s) one by one.' +
      (resp.invalidCount ? ' ' + resp.invalidCount + ' old homepage-only link(s) were marked failed; use Retry new for those.' : ''), 'ok');
    else showMsg(resp && resp.error ? resp.error : 'No prompts waiting for recovery.', 'err');
  });
}; }
{ const b = document.getElementById('fastCancelBtn'); if (b) b.onclick = () => {
  chrome.runtime.sendMessage({ type: 'FAST_CANCEL_SCHEDULE' }, (resp) => {
    if (!chrome.runtime.lastError) {
      showMsg(resp && resp.cancelledStart
        ? '⏳ Scheduled Fast Submit cancelled — nothing was sent. Any saved queue is kept.'
        : 'Scheduled recovery cancelled — the queue is kept; press "Recover & Update Now" whenever you like.', 'ok');
    }
    refreshFastQueueStatus();
  });
}; }
{ const b = document.getElementById('fastClearBtn'); if (b) b.onclick = () => {
  if (!confirm('Clear the fast-submit queue?\n\nThe saved chat links are removed and those posts will NOT be recovered automatically.')) return;
  chrome.runtime.sendMessage({ type: 'FAST_CLEAR_QUEUE' }, () => {
    if (!chrome.runtime.lastError) showMsg('Fast-submit queue cleared.', 'ok');
    refreshFastQueueStatus();
  });
}; }
function refreshFastQueueStatus() {
  chrome.runtime.sendMessage({ type: 'FAST_QUEUE_STATUS' }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok) return;
    const chip = document.getElementById('fastQueueChip');
    const el = document.getElementById('fastQueueStatus');

    // ── A scheduled "Start after" run wins the status line: nothing has been
    //    sent yet, and the user needs to see when it will begin. ──
    state._pendingStart = !!resp.pendingStartAt;
    if (resp.pendingStartAt) {
      const leftMs = resp.pendingStartAt - Date.now();
      const leftMin = Math.max(0, Math.ceil(leftMs / 60000));
      const at = new Date(resp.pendingStartAt).toLocaleTimeString();
      if (el) {
        el.textContent = '⏳ Fast Submit is scheduled — ' + (resp.pendingStartCount || 0) +
          ' post(s) start automatically at ' + at +
          (leftMs > 0 ? ' (about ' + leftMin + ' min from now)' : ' (starting now)') +
          '. Nothing has been sent yet. Keep Chrome open; press "✖ Cancel schedule" to call it off.';
        el.className = 'status-line success';
      }
      if (chip) chip.textContent = '⏳ ' + leftMin + 'm';
      return;
    }

    // ── Chunked plan present → show current-cycle + overall-plan progress. ──
    if (resp.planStatus) {
      const cyc = 'Cycle ' + resp.currentChunkNumber + '/' + resp.totalChunks;
      const overall = 'Overall progress: ' + resp.completedTotal + '/' + resp.totalPosts + ' completed' +
        (resp.remaining ? ', ' + resp.remaining + ' remaining' : '') +
        (resp.failedTotal ? ' (' + resp.failedTotal + ' failed)' : '') + '.';
      let sentence = '', cls = 'status-line';
      switch (resp.planStatus) {
        case 'submitting':
          sentence = '🚀 ' + cyc + ': submitting ' + (resp.pending || 0) + ' prompt(s)… ' + overall;
          cls = 'status-line success'; break;
        case 'waiting_recovery':
          sentence = '⏳ ' + cyc + ': ' + (resp.pending || 0) + ' prompt(s) submitted and waiting for recovery' +
            (resp.recoverAt ? ' at ' + new Date(resp.recoverAt).toLocaleTimeString() + ' (keep Chrome open)'
                            : ' — press "⏰ Recover & Update Now"') + '. ' + overall;
          cls = 'status-line success'; break;
        case 'recovering':
          sentence = '⏰ ' + cyc + ': recovering and updating this group… ' + overall;
          cls = 'status-line success'; break;
        case 'ready_next':
          sentence = '↻ ' + cyc + ': starting the next cycle… ' + overall;
          cls = 'status-line success'; break;
        case 'paused':
          sentence = '⏸ ' + cyc + ' paused — no next cycle will start automatically. ' + overall +
            (resp.planError ? ' ' + resp.planError : '');
          cls = 'status-line error'; break;
        case 'error':
          sentence = '⚠ Fast Submit plan error. ' + overall + (resp.planError ? ' ' + resp.planError : '');
          cls = 'status-line error'; break;
        case 'completed':
          sentence = '✅ ' + cyc + ' complete. All ' + resp.totalPosts + ' posts have finished their update attempts (' +
            resp.completedTotal + ' updated' + (resp.failedTotal ? ', ' + resp.failedTotal + ' failed' : '') + ').';
          cls = 'status-line success'; break;
        default:
          sentence = cyc + '. ' + overall;
      }
      if (resp.invalid) sentence += ' ⚠ ' + resp.invalid + ' queued item(s) have no recoverable conversation link; Recover will move them to Failed posts for Retry new.';
      if (chip) chip.textContent = (resp.pending > 0) ? String(resp.pending) : (resp.planActive ? '•' : '');
      if (el) { el.className = cls; el.textContent = sentence; }
      return;
    }

    // ── No plan → classic single-cycle behavior. ──
    if (chip) chip.textContent = resp.pending > 0 ? String(resp.pending) : '';
    if (!el) return;
    if (!resp.pending) {
      el.textContent = resp.invalid
        ? '⚠ ' + resp.invalid + ' queued item(s) contain only an AI provider homepage, not a conversation link. Press “Recover & Update Now” to move them to Failed posts, then use Retry new.'
        : 'No prompts waiting.';
      el.className = resp.invalid ? 'status-line error' : 'status-line';
    } else {
      el.className = 'status-line success';
      el.textContent = '🚀 ' + resp.pending + ' prompt(s) submitted and waiting' +
        (resp.recoverAt ? ' — ⏰ recovery starts at ' + new Date(resp.recoverAt).toLocaleTimeString() + ' (keep Chrome open).'
                        : ' — press "⏰ Recover & Update Now" when the AI has finished.') +
        (resp.invalid ? ' ⚠ ' + resp.invalid + ' homepage-only item(s) will be moved to Failed posts for Retry new.' : '');
    }
  });
}
setInterval(refreshFastQueueStatus, 3000);
refreshFastQueueStatus();

function downloadAuditIssuesExcel() {
  const entries = auditIssueItems();
  if (!entries.length) return showMsg('No audit issues to download.', 'err');
  const header = [
    'Status',
    'Review Action',
    'Processed At',
    'WordPress Post Link',
    'WordPress Edit Link',
    'Input Link',
    'Slug',
    'AI Provider',
    'AI Session Link',
    'Message',
    'AI Provider Start Link',
    'Gate reasons'
  ];
  const rows = entries.map(({ item }) =>
    [
      processedCsvStatus(item),
      processedCsvAction(item),
      processedCsvTime(item),
      item.postUrl,
      item.editorUrl,
      item.rawInput,
      item.slug,
      item.aiName,
      recoverableAiSessionHref(item.aiSessionUrl, item.aiProviderUrl),
      item.message,
      item.aiProviderUrl,
      gateReasonsText(item)
    ].map(csvCell).join(',')
  );
  // BUG FIX: this used a raw invisible BOM character in the source (easily
  // stripped by editors). Use the explicit \ufeff escape like the other CSV.
  const csv = '\ufeff' + [header.map(csvCell).join(','), ...rows].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'auto-batch-audit-issues-' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  showMsg('Audit issues CSV downloaded. Open it in Excel to see every flagged row and link.', 'ok');
}

{ const _aiBtn = document.getElementById('downloadAuditIssuesBtn'); if (_aiBtn) _aiBtn.onclick = downloadAuditIssuesExcel; }
document.getElementById('clearProcessedBtn').onclick = async () => {
  if (!state.processedLinks.length) return showMsg('Processed links list is already empty.', 'ok');
  if (!confirm('Clear ALL processed links from this box?')) return;
  state.processedLinks = [];
  state.archivedAttemptKeys = [];
  await saveState();
  chrome.runtime.sendMessage({ type: 'BATCH_CLEAR_ATTEMPTS' });
  renderProcessedLinks();
  showMsg('Processed links cleared.', 'ok');
};

// ════════════════════════════════════════════════════════════════
// Retry Failed Posts — pulls all "failed" processed links back into the
// slug textarea so the user can press Start again without re-typing.
// ════════════════════════════════════════════════════════════════
const _retryBtn = document.getElementById('retryFailedBtn');
if (_retryBtn) _retryBtn.onclick = () => {
  // BUG FIX: was `p.result !== 'updated'`, which also swept up rows with
  // unexpected result values. Only true failures should be reloaded.
  const failed = state.processedLinks.filter(p => (p.result || '') === 'failed');
  if (failed.length === 0) {
    showMsg('No failed posts to retry.', 'err');
    return;
  }
  if (!confirm('Load ' + failed.length + ' failed post(s) into the slug textarea? Existing textarea content will be replaced.')) return;
  const list = failed.map(p => p.rawInput || p.slug).filter(Boolean);
  const seen = new Set();
  const unique = list.filter(l => { if (seen.has(l)) return false; seen.add(l); return true; });
  document.getElementById('slugTextarea').value = unique.join('\n');
  state.savedSlugDraft = unique.join('\n');
  saveState();
  updateSlugCount();
  showMsg('Loaded ' + unique.length + ' failed post(s). Click Start Batch when ready.', 'ok');
  // Switch to Run tab and scroll to top
  const runTab = document.querySelector('.tab[data-tab="run"]');
  if (runTab) runTab.click();
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

// ════════════════════════════════════════════════════════════════
// Backup / Restore
// ════════════════════════════════════════════════════════════════
document.getElementById('exportBtn').onclick = async () => {
  // Flush the current UI into storage first so the backup ALWAYS contains every
  // setting exactly as shown, even if a control's change handler hasn't fired.
  try { const _ta = document.getElementById('slugTextarea'); if (_ta) state.savedSlugDraft = _ta.value; await saveState(); } catch (e) {}
  const all = await chrome.storage.local.get(null);
  const backup = {
    version: 1,
    type: 'auto-batch',
    exportedAt: new Date().toISOString(),
    data: all
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const date = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = 'blogedit-auto-batch-backup-' + date + '.json';
  a.click();
  URL.revokeObjectURL(url);
  document.getElementById('backupMsg').innerHTML =
    '<div class="status-line success">✅ Backup downloaded (' +
    state.wpSites.length + ' sites, ' + state.customAIs.length + ' AIs, ' + state.prompts.length + ' prompts).</div>';
};

document.getElementById('importBtn').onclick = () => document.getElementById('importFile').click();
document.getElementById('importFile').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (ev) => {
    try {
      const backup = JSON.parse(ev.target.result);
      if (!backup.data) throw new Error('Invalid backup format');
      const counts = {
        sites: (backup.data.wpSites || []).length,
        ais: (backup.data.customAIs || []).length,
        prompts: (backup.data.prompts || backup.data.savedPrompts || []).length
      };
      if (!confirm('Restore backup?\n\n' + counts.sites + ' sites, ' + counts.ais + ' AIs, ' + counts.prompts + ' prompts.\n\n⚠️ This will replace current settings. Continue?')) return;

      // If imported from Manual Extension, map savedPrompts → prompts
      const incomingPrompts = backup.data.prompts || backup.data.savedPrompts;
      if (incomingPrompts && !backup.data.prompts) {
        // Convert Manual format (key/label/text) to Auto format (id/name/text)
        backup.data.prompts = incomingPrompts.map(p => ({
          id: p.key || ('p_' + Math.random().toString(36).slice(2)),
          name: p.label || p.name || 'Imported Prompt',
          text: p.text || ''
        }));
        delete backup.data.savedPrompts;
      }

      await chrome.storage.local.clear();
      // Keep the one-time seeding from re-running on the reload below and
      // overwriting the restored retry/recovery/timing settings -- mark all
      // setup flags as already done so the restored values are preserved.
      backup.data.defaultsV5_installed = true;
      backup.data.defaultsV3_installed = true;
      backup.data.defaultsV4_installed = true;
      backup.data.auditPromptInstalled_v1 = true;
      backup.data.bigArticleDefaults_v1 = true;
      backup.data.preservePromptInstalled_v1 = true;
      // BUG FIX: without this flag the promptsV8 installer REPLACED all the
      // restored prompts with the defaults on the reload below.
      backup.data.promptsV8_installed = true;
      // safetyGatePromptsInstalled_v1 is kept as it is in the backup: that
      // installer only APPENDS the two Safety Gate prompts when they are
      // missing (older backups), so it never removes anything.
      await chrome.storage.local.set(backup.data);
      document.getElementById('backupMsg').innerHTML = '<div class="status-line success">✅ Restored! Reloading...</div>';
      setTimeout(() => location.reload(), 1200);
    } catch (err) {
      document.getElementById('backupMsg').innerHTML = '<div class="status-line error">❌ ' + err.message + '</div>';
    }
  };
  reader.readAsText(file);
  e.target.value = '';
};

// ── Maintenance: Reset Settings + Clear Backups ──
const SETTINGS_DEFAULTS = {
  delayBetween: 10, aiTimeout: '1800', aiTimeoutCustom: 5, updateWait: '30', updateWaitCustom: 45,
  settleTime: 10, pasteWait: 'custom', pasteWaitCustom: 30, extraPrompts: '0', retryMode: 'end',
  onMissing: 'skip', maxRetries: '2', backgroundMode: 'off', completeness: 'balanced',
  autoSplit: 'off', fallbackAIId: '',
  auditRetryEnabled: 'off', auditRetryCount: '1', auditRetryTiming: 'end', htmlRecoveryAudit: 'off', htmlRecoveryFailed: 'off', htmlRecoveryAnyCode: 'off', autoSessionZip: 'on', limitGuard: 'off', modelLimitGuard: 'on', modelLimitRetryHours: '0', limitResumeMode: 'exact', limitMode: 'smart', limitFallbackHours: '0', geminiFlashGuard: 'on', failStopCount: '5', failRetryAfter: '60', faqConclAuto: 'off', parallelCount: '1', fastRecoverAfter: '10', fastAnyCode: 'off', fastChunkSize: '50', fastPasteWait: '10', fastPasteRetries: '3', fastStartAfter: '0', fastManual: 'off',
  gateEnabled: 'on', gateLinkCheck: 'on', gateNewFaq: 'auto', gateSiteDomains: '', factCheck: 'on', factCheckAiId: '', factCheckPromptId: '', factCheckOnError: 'keep'
};
const _resetBtn = document.getElementById('resetSettingsBtn');
if (_resetBtn) _resetBtn.onclick = () => {
  if (!confirm('Reset all timing & run options to the recommended defaults?\n\nYour WordPress sites, AI services, and prompts are kept.')) return;
  chrome.storage.local.set(SETTINGS_DEFAULTS, () => {
    const m = document.getElementById('backupMsg');
    if (m) m.innerHTML = '<div class="status-line success">\u2705 Settings reset to defaults. Reloading...</div>';
    setTimeout(() => location.reload(), 900);
  });
};
const _clearBackupBtn = document.getElementById('clearBackupBtn');
if (_clearBackupBtn) _clearBackupBtn.onclick = async () => {
  if (state.batchActive) return showMsg('Stop the running batch before removing everything.', 'err');
  if (!confirm('\u26a0 CLEAR BACKUPS = REMOVE EVERYTHING\n\nThis permanently deletes ALL data stored by this extension:\n\u2022 Every WordPress site (and its saved credentials)\n\u2022 Every AI service you added\n\u2022 Every prompt\n\u2022 All original-HTML backups\n\u2022 All results, audit / failed / retry history and logs\n\u2022 All timing & run settings (reset to defaults)\n\nBuilt-in AIs (Grok / ChatGPT / Claude / Gemini) stay, because they are built in.\n\nTip: press \u201c\u2b07 Export Backup\u201d first if you might want any of this back.\n\nContinue?')) return;
  if (!confirm('Last check \u2014 this CANNOT be undone.\n\nRemove every site, AI, prompt, credential, backup and setting now?')) return;
  const m = document.getElementById('backupMsg');
  if (m) m.innerHTML = '<div class="status-line">Removing everything\u2026</div>';
  await factoryResetAll();
  if (m) m.innerHTML = '<div class="status-line success">\u2705 Everything removed. Reloading a fresh extension\u2026</div>';
  setTimeout(() => location.reload(), 900);
};

// ════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════
let _msgTimer = null;
function showMsg(text, kind) {
  const el = document.getElementById('msg');
  el.textContent = text;
  el.className = 'show ' + (kind || 'ok');
  // Clear any previous hide-timer, otherwise an older message's timeout
  // hides a newer message too early.
  clearTimeout(_msgTimer);
  _msgTimer = setTimeout(() => { el.className = ''; }, 4000);
}

// ════════════════════════════════════════════════════════════════
// Live settings — apply option changes to a running / paused batch
// ════════════════════════════════════════════════════════════════
function resolveAiFields(aiId) {
  if (!aiId) return null;
  const builtin = BUILTIN_AIS.find(a => a.id === aiId);
  let aiConfig, aiUrl, aiName, aiKind;
  if (builtin) { aiConfig = normalizeAIConfig(builtin); aiUrl = builtin.url; aiName = builtin.name; aiKind = 'builtin'; }
  else {
    const c = state.customAIs.find(a => a.id === aiId);
    if (!c) return null;
    aiConfig = normalizeAIConfig(c); aiUrl = aiConfig.url; aiName = aiConfig.name; aiKind = 'custom';
  }
  if (isApiAI(aiConfig) && (!aiConfig.apiKey || !aiConfig.apiModel)) return null;
  return {
    aiUrl, aiName, aiKind,
    aiMode: aiMode(aiConfig),
    aiProvider: aiConfig.apiProvider || aiMode(aiConfig),
    aiApiBaseUrl: aiConfig.apiBaseUrl || aiConfig.url || '',
    aiApiModel: aiConfig.apiModel || '',
    aiApiKey: aiConfig.apiKey || ''
  };
}

function renderFallbackDropdown() {
  const el = document.getElementById('fallbackAI');
  if (!el) return;
  const opts = ['<option value="">None</option>'].concat(
    allAIProviders().map(a => '<option value="' + escapeHtml(a.id) + '">' + escapeHtml(a.name) + (isApiAI(a) ? ' (API)' : ' (web)') + '</option>')
  );
  el.innerHTML = opts.join('');
  el.value = state.fallbackAIId || '';
  el.onchange = (e) => { state.fallbackAIId = e.target.value; saveState(); if (state.batchActive) pushLiveSettings(); };
}

function resolveRunConfig() {
  const site = state.wpSites[state.wpDefaultIndex];
  if (!site) return { ok: false, error: 'no default WordPress site' };
  if (siteMode(site) === 'rest' && !siteHasRestCredentials(site)) return { ok: false, error: 'REST credentials missing' };
  const prompt = state.prompts.find(p => p.id === state.defaultPromptId && isRunPrompt(p));
  if (!prompt) return { ok: false, error: 'no default prompt' };
  let aiUrl, aiName, aiKind, aiConfig;
  const builtin = BUILTIN_AIS.find(a => a.id === state.defaultAIId);
  if (builtin) { aiConfig = normalizeAIConfig(builtin); aiUrl = builtin.url; aiName = builtin.name; aiKind = 'builtin'; }
  else {
    const c = state.customAIs.find(a => a.id === state.defaultAIId);
    if (!c) return { ok: false, error: 'no default AI' };
    aiConfig = normalizeAIConfig(c); aiUrl = aiConfig.url; aiName = aiConfig.name; aiKind = 'custom';
  }
  if (isApiAI(aiConfig) && (!aiConfig.apiKey || !aiConfig.apiModel)) return { ok: false, error: 'API model/key missing' };
  let aiTimeoutSec = state.aiTimeout === 'nolimit'
    ? 86400
    : (state.aiTimeout === 'custom'
        ? Math.max(60, Math.min(7200, (state.aiTimeoutCustom || 5) * 60))
        : (parseInt(state.aiTimeout) || 180));
  let updateWaitSec = state.updateWait === 'custom'
    ? Math.max(5, Math.min(300, state.updateWaitCustom || 45))
    : (parseInt(state.updateWait) || 30);
  return { ok: true, config: {
    site, aiUrl, aiName, aiKind,
    aiMode: aiMode(aiConfig),
    aiProvider: aiConfig.apiProvider || aiMode(aiConfig),
    aiApiBaseUrl: aiConfig.apiBaseUrl || aiConfig.url || '',
    aiApiModel: aiConfig.apiModel || '',
    aiApiKey: aiConfig.apiKey || '',
    prompt: prompt.text,
    promptType: (prompt.type === 'edit' ? 'edit' : 'audit'),
    delayBetween: state.delayBetween,
    aiTimeout: aiTimeoutSec,
    updateWait: updateWaitSec,
    pasteWait: resolvePasteWaitSec(),
    continueRounds: parseInt(state.extraPrompts || '0', 10),
    retryMode: state.retryMode || 'end',
    settleTime: state.settleTime,
    strictMode: 'loose',
    onMissing: state.onMissing,
    maxRetries: parseInt(state.maxRetries || '1', 10),
    backgroundMode: state.backgroundMode || 'on',
    completeness: state.completeness || 'balanced',
    apiMaxTokens: parseInt(state.apiMaxTokens || '16000', 10),
    fallbackAi: resolveAiFields(state.fallbackAIId),
    autoSplit: state.autoSplit || 'off',
    auditRetry: (state.auditRetryEnabled === 'on'),
    auditRetryCount: parseInt(state.auditRetryCount || '1', 10),
    auditRetryTiming: (state.auditRetryTiming === 'immediate' ? 'immediate' : 'end'),
    htmlRecoveryAudit: (state.htmlRecoveryAudit === 'on'),
    htmlRecoveryFailed: (state.htmlRecoveryFailed === 'on'),
    htmlRecoveryAnyCode: (state.htmlRecoveryAnyCode === 'on'),
    ...limitFlagsFromMode(),
    failStopCount: parseInt(state.failStopCount ?? '5', 10),
    failRetryAfter: parseInt(state.failRetryAfter ?? '60', 10),
    ...safetyGateJobFields(prompt),
    // Carried so a live edit reaches a running Fast Submit; ignored by Start Batch.
    fastPasteWait: sanitizePasteWait(state.fastPasteWait),
    fastPasteRetries: sanitizePasteRetries(state.fastPasteRetries),
    parallel: parseInt(state.parallelCount || '1', 10)
  } };
}

function pushLiveSettings(opts) {
  const announce = !(opts && opts.silent);
  if (!state.batchActive) {
    if (announce) showMsg('No running batch to update — press Start Batch.', 'err');
    return;
  }
  const r = resolveRunConfig();
  if (!r.ok) { if (announce) showMsg('Cannot apply settings: ' + r.error + '.', 'err'); return; }
  chrome.runtime.sendMessage({ type: 'BATCH_UPDATE_JOB', config: r.config }, (resp) => {
    if (chrome.runtime.lastError) return;
    if (resp && resp.ok && announce) showMsg('Running batch updated — new settings apply from the next post.', 'ok');
  });
}

// Auto-apply Run-tab option changes to an active batch.
// BUG FIX: auditRetry*/htmlRecovery* already push live settings inside their
// own onchange handlers - listing them here too sent BATCH_UPDATE_JOB twice
// per change during a running batch.
['delayBetween','aiTimeout','aiTimeoutCustom','updateWait','updateWaitCustom','settleTime','pasteWait','pasteWaitCustom','extraPrompts','retryMode','onMissing','maxRetries','backgroundMode','completeness','apiMaxTokens','autoSplit'].forEach((id) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', () => { if (state.batchActive) pushLiveSettings(); });
});

const _applyLiveBtn = document.getElementById('applyLiveBtn');
if (_applyLiveBtn) _applyLiveBtn.onclick = () => { if (!requireSaved()) return; pushLiveSettings(); };   // Fix 6

// ════════════════════════════════════════════════════════════════
// Original HTML backups — saved before each update; download as a ZIP folder
// ════════════════════════════════════════════════════════════════
function _crc32(bytes) {
  if (!_crc32.t) {
    _crc32.t = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); _crc32.t[n] = c >>> 0; }
  }
  let crc = 0 ^ (-1);
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ _crc32.t[(crc ^ bytes[i]) & 0xFF];
  return (crc ^ (-1)) >>> 0;
}
function _buildZip(files) {
  const enc = new TextEncoder();
  const u16 = (n) => [n & 0xff, (n >>> 8) & 0xff];
  const u32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = enc.encode(f.content);
    const crc = _crc32(data);
    const local = [].concat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0));
    chunks.push(new Uint8Array(local), nameBytes, data);
    const cen = [].concat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset));
    central.push({ header: new Uint8Array(cen), name: nameBytes });
    offset += local.length + nameBytes.length + data.length;
  }
  let centralSize = 0;
  for (const c of central) { chunks.push(c.header, c.name); centralSize += c.header.length + c.name.length; }
  chunks.push(new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(centralSize), u32(offset), u16(0))));
  let total = 0; for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let p = 0; for (const c of chunks) { out.set(c, p); p += c.length; }
  return new Blob([out], { type: 'application/zip' });
}
async function refreshOriginalsCount() {
  const el = document.getElementById('originalsCount');
  if (!el) return;
  try {
    // Read the lightweight counter key — previously this deserialized the whole
    // multi-MB backup array every 3 seconds, which could stutter the panel.
    let n = (await chrome.storage.local.get('__originalsBackupCount')).__originalsBackupCount;
    if (typeof n !== 'number') {
      const data = await chrome.storage.local.get('__originalsBackup');
      n = Array.isArray(data.__originalsBackup) ? data.__originalsBackup.length : 0;
    }
    el.textContent = n ? (n + ' original article backup' + (n === 1 ? '' : 's') + ' saved — download anytime.') : 'No originals saved yet.';
  } catch (e) {}
}
async function downloadOriginalForIndex(index) {
  const item = state.processedLinks[index];
  if (!item) return;
  const slug = item.slug || '';
  const data = await chrome.storage.local.get('__originalsBackup');
  const arr = Array.isArray(data.__originalsBackup) ? data.__originalsBackup : [];
  let entry = null;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (slug && (arr[i].slug || '') === slug) { entry = arr[i]; break; }
  }
  if (!entry && item.postUrl) {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].link && arr[i].link === item.postUrl) { entry = arr[i]; break; }
    }
  }
  if (!entry) {
    showMsg('No original-HTML backup found for "' + (slug || 'this post') + '". A backup is saved only after the original is fetched, so "post not found" failures have none.', 'err');
    return;
  }
  const safe = ((slug || 'article').replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80)) || 'article';
  const content = 'Title: ' + (entry.title || slug || '') + '\r\n' +
                  'Link: ' + (entry.link || item.postUrl || '') + '\r\n' +
                  'Saved: ' + (entry.time || '') + '\r\n\r\n' +
                  (entry.html || '');
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safe + '-original.txt';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
  showMsg('Downloaded the original HTML for "' + (slug || 'post') + '".', 'ok');
}

async function downloadOriginalsZip() {
  const data = await chrome.storage.local.get('__originalsBackup');
  const arr = Array.isArray(data.__originalsBackup) ? data.__originalsBackup : [];
  if (!arr.length) return showMsg('No original backups saved yet.', 'err');
  const files = arr.map((it, i) => {
    const safe = (it.slug || ('article-' + (i + 1))).replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80);
    const name = String(i + 1).padStart(3, '0') + '-' + safe + '.txt';
    const content = 'Title: ' + (it.title || it.slug || '') + '\r\n' +
                    'Link: ' + (it.link || '') + '\r\n' +
                    'Saved: ' + (it.time || '') + '\r\n\r\n' +
                    (it.html || '');
    return { name, content };
  });
  const blob = _buildZip(files);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'original-html-backups-' + new Date().toISOString().slice(0, 10) + '.zip';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
  showMsg('Downloaded ' + files.length + ' original backups as a ZIP.', 'ok');
}

// Session-scoped originals: only the most recent batch's articles. Each file
// includes the article link, the AI session link, and the original HTML.
async function downloadSessionZip(auto) {
  const data = await chrome.storage.local.get('__originalsBackup');
  const arr = Array.isArray(data.__originalsBackup) ? data.__originalsBackup : [];
  if (!arr.length) { if (!auto) showMsg('No originals saved yet.', 'err'); return; }
  let latest = 0;
  arr.forEach(e => { const sid = Number(e.sessionId) || 0; if (sid > latest) latest = sid; });
  const sess = latest ? arr.filter(e => (Number(e.sessionId) || 0) === latest) : arr.slice();
  if (!sess.length) { if (!auto) showMsg('No session originals found.', 'err'); return; }
  const files = sess.map((it, i) => {
    const safe = (it.slug || ('article-' + (i + 1))).replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80);
    const name = String(i + 1).padStart(3, '0') + '-' + safe + '.txt';
    const rawAiSession = it.aiSession || '';
    const canonicalAiSession = recoverableAiSessionHref(rawAiSession, it.aiProviderUrl || '');
    const exportedAiSession = canonicalAiSession || (safeHref(rawAiSession)
      ? 'Not captured - invalid or provisional AI address rejected; use Retry new.'
      : '');
    const content = 'Title: ' + (it.title || it.slug || '') + '\r\n' +
                    'Article: ' + (it.link || '') + '\r\n' +
                    'AI session: ' + exportedAiSession + '\r\n' +
                    'Slug: ' + (it.slug || '') + '\r\n' +
                    'Saved: ' + (it.time || '') + '\r\n\r\n' +
                    (it.html || '');
    return { name, content };
  });
  const blob = _buildZip(files);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'session-originals-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.zip';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
  showMsg('Downloaded this session: ' + files.length + ' original article' + (files.length === 1 ? '' : 's') + ' (with article + AI session links) as a ZIP.', 'ok');
}
const _dlSessBtn = document.getElementById('downloadSessionBtn');
if (_dlSessBtn) _dlSessBtn.onclick = () => downloadSessionZip(false);
const _autoSessSel = document.getElementById('autoSessionZip');
if (_autoSessSel) _autoSessSel.onchange = (e) => { state.autoSessionZip = e.target.value; saveState(); };
// Fallback wait in hours: 0 = wait for Resume. Shared by the limit mode below.
function sanitizeLimitRetryHours(v) { const n = Math.round(Number(v)); return (!Number.isFinite(n) || n <= 0) ? 0 : Math.min(48, n); }

// ONE setting drives every limit flag the batch engine reads. Keeping the
// derivation in a single place means the (well-tested) engine never has to
// know that the UI was simplified.
function limitFlagsFromMode() {
  const mode = ['smart', 'pause', 'off'].includes(state.limitMode) ? state.limitMode : 'smart';
  const fallback = sanitizeLimitRetryHours(state.limitFallbackHours);
  if (mode === 'off') {
    return { limitGuard: false, modelLimitGuard: false, geminiFlashGuard: false,
             modelLimitRetryHours: 0, limitResumeMode: 'exact' };
  }
  return {
    limitGuard: true,
    modelLimitGuard: true,
    geminiFlashGuard: true,
    // "Pause only" never schedules a retry; Smart uses the AI's own reset time
    // and falls back to the chosen wait.
    modelLimitRetryHours: mode === 'pause' ? 0 : fallback,
    limitResumeMode: mode === 'pause' ? 'timer' : 'exact'
  };
}

const _limitModeSel = document.getElementById('limitMode');
if (_limitModeSel) _limitModeSel.onchange = (e) => { state.limitMode = e.target.value; saveState(); if (state.batchActive) pushLiveSettings(); };
const _limitFallbackSel = document.getElementById('limitFallbackHours');
if (_limitFallbackSel) _limitFallbackSel.onchange = (e) => { state.limitFallbackHours = String(sanitizeLimitRetryHours(e.target.value)); saveState(); if (state.batchActive) pushLiveSettings(); };
const _failStopSel = document.getElementById('failStopCount');
if (_failStopSel) _failStopSel.onchange = (e) => { state.failStopCount = e.target.value; saveState(); if (state.batchActive) pushLiveSettings(); };
const _failRetrySel = document.getElementById('failRetryAfter');
if (_failRetrySel) _failRetrySel.onchange = (e) => { state.failRetryAfter = e.target.value; saveState(); if (state.batchActive) pushLiveSettings(); };

// ════════════════════════════════════════════════════════════════
// 🛡 Safety Gate + Fact check (v3.46.0) — settings, job fields, UI
// ════════════════════════════════════════════════════════════════
// "Your other domains" text → clean host names for job.gateSiteDomains:
// split on commas / spaces, lower-case, drop scheme, path, port and a leading
// "www." (or "*."). Duplicates and non-host junk are dropped.
function parseGateSiteDomains(text) {
  const out = [];
  String(text || '').split(/[\s,;]+/).forEach((raw) => {
    let h = raw.trim().toLowerCase().replace(/^\*\./, '');
    if (!h) return;
    if (!/^[a-z][a-z0-9+.-]*:\/\//.test(h)) h = 'http://' + h.replace(/^\/+/, '');
    try { h = new URL(h).hostname; } catch (e) { return; }
    h = h.replace(/\.+$/, '').replace(/^www\./, '');
    if (!h || !/^[a-z0-9.-]+$/.test(h) || !/[a-z0-9]/.test(h)) return;
    if (!out.includes(h)) out.push(h);
  });
  return out;
}

// Job fields for the Safety Gate + Fact check (EXT-SPEC 2.1). Used by BOTH
// job builders (Start and resolveRunConfig) so they can never drift apart.
// `prompt` is the selected run prompt (its webSearch flag).
function safetyGateJobFields(prompt) {
  const fcId = hasFactCheckPrompt(state.factCheckPromptId) ? state.factCheckPromptId : defaultFactCheckPromptId();
  const fcPrompt = state.prompts.find(p => p.id === fcId && p.type === 'factcheck');
  return {
    gateEnabled: (state.gateEnabled !== 'off'),
    gateLinkCheck: (state.gateLinkCheck !== 'off'),
    gateNewFaq: (state.gateNewFaq === 'no' ? 'no' : 'auto'),
    gateSiteDomains: parseGateSiteDomains(state.gateSiteDomains),
    factCheck: (state.factCheck !== 'off'),
    // '' = the same AI as the run; otherwise resolved exactly like fallbackAi.
    factCheckAi: (state.factCheckAiId ? (resolveAiFields(state.factCheckAiId) || '') : ''),
    // '' = none chosen → the background uses its built-in prompts/fact-check.txt.
    factCheckPrompt: fcPrompt ? String(fcPrompt.text || '') : '',
    factCheckOnError: (state.factCheckOnError === 'save' ? 'save' : 'keep'),
    promptWebSearch: !!(prompt && prompt.webSearch)
  };
}

// One line for the Start confirm dialog.
function safetyGateSummary() {
  if (state.gateEnabled === 'off') return 'Safety Gate: OFF — AI edits are saved WITHOUT safety checks or fact check';
  let line = 'Safety Gate: ON' + (state.gateLinkCheck === 'off' ? ' (new links not tested)' : ' (new links tested)');
  if (state.factCheck === 'off') return line + ' · Fact check: OFF';
  const fcAi = state.factCheckAiId ? resolveAiFields(state.factCheckAiId) : null;
  line += ' · Fact check: ON with ' + (fcAi ? fcAi.aiName : 'the same AI') +
    (state.factCheckOnError === 'save' ? ' (saves anyway if the check breaks)' : ' (keeps the original if the check breaks)');
  return line;
}

// While the Safety Gate is Off the background skips the fact check too, so
// show a note and dim the fact-check options (they stay editable).
function applyGateUi() {
  const off = state.gateEnabled === 'off';
  const note = document.getElementById('gateOffNote');
  if (note) note.style.display = off ? '' : 'none';
  const fc = document.getElementById('factCheckBlock');
  if (fc) fc.style.opacity = off ? '0.5' : '';
}

function renderFactCheckAiDropdown() {
  const el = document.getElementById('factCheckAiId');
  if (!el) return;
  if (state.factCheckAiId && !hasAIProvider(state.factCheckAiId)) state.factCheckAiId = '';
  const opts = ['<option value="">Same AI as the run</option>'].concat(
    allAIProviders().map(a => '<option value="' + escapeHtml(a.id) + '">' + escapeHtml(a.name) + (isApiAI(a) ? ' (API)' : ' (web)') + '</option>')
  );
  el.innerHTML = opts.join('');
  el.value = state.factCheckAiId || '';
  el.onchange = (e) => { state.factCheckAiId = e.target.value; saveState(); if (state.batchActive) pushLiveSettings(); };
}

// Lists ONLY prompts of type 'factcheck'. Empty choice → the seeded one.
function renderFactCheckPromptDropdown() {
  const el = document.getElementById('factCheckPromptId');
  if (!el) return;
  if (!hasFactCheckPrompt(state.factCheckPromptId)) state.factCheckPromptId = defaultFactCheckPromptId();
  const list = factCheckPrompts();
  el.innerHTML = list.length
    ? list.map(p => '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.name) + '</option>').join('')
    : '<option value="">Built-in fact-check prompt (no fact-check prompt saved yet)</option>';
  el.value = state.factCheckPromptId || '';
  el.onchange = (e) => { state.factCheckPromptId = e.target.value; saveState(); renderPromptList(); if (state.batchActive) pushLiveSettings(); };
}

const _gateEnSel = document.getElementById('gateEnabled');
if (_gateEnSel) _gateEnSel.onchange = (e) => { state.gateEnabled = (e.target.value === 'off') ? 'off' : 'on'; applyGateUi(); saveState(); if (state.batchActive) pushLiveSettings(); };
const _gateLinkSel = document.getElementById('gateLinkCheck');
if (_gateLinkSel) _gateLinkSel.onchange = (e) => { state.gateLinkCheck = (e.target.value === 'off') ? 'off' : 'on'; saveState(); if (state.batchActive) pushLiveSettings(); };
const _gateFaqSel = document.getElementById('gateNewFaq');
if (_gateFaqSel) _gateFaqSel.onchange = (e) => { state.gateNewFaq = (e.target.value === 'no') ? 'no' : 'auto'; saveState(); if (state.batchActive) pushLiveSettings(); };
const _gateDomInp = document.getElementById('gateSiteDomains');
if (_gateDomInp) _gateDomInp.onchange = (e) => {
  state.gateSiteDomains = parseGateSiteDomains(e.target.value).join(', ');
  e.target.value = state.gateSiteDomains;   // show the cleaned list
  saveState();
  if (state.batchActive) pushLiveSettings();
};
const _factSel = document.getElementById('factCheck');
if (_factSel) _factSel.onchange = (e) => { state.factCheck = (e.target.value === 'off') ? 'off' : 'on'; applyGateUi(); saveState(); if (state.batchActive) pushLiveSettings(); };
const _factErrSel = document.getElementById('factCheckOnError');
if (_factErrSel) _factErrSel.onchange = (e) => { state.factCheckOnError = (e.target.value === 'save') ? 'save' : 'keep'; saveState(); if (state.batchActive) pushLiveSettings(); };

const _dlOrigBtn = document.getElementById('downloadOriginalsBtn');
if (_dlOrigBtn) _dlOrigBtn.onclick = downloadOriginalsZip;
const _clrOrigBtn = document.getElementById('clearOriginalsBtn');
if (_clrOrigBtn) _clrOrigBtn.onclick = async () => {
  if (!confirm('Clear ALL saved original HTML backups? Download them first if you might need them.\n\nThis permanently deletes every backup record and cannot be undone. Your sites, prompts, credentials and settings are kept.')) return;
  await clearAllBackupsFully();   // Fix 5: full, awaited clean
  showMsg('All backups cleared.', 'ok');
};
refreshOriginalsCount();
// Event-driven instead of polling the (potentially huge) backup array.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.__originalsBackupCount || changes.__originalsBackup)) refreshOriginalsCount();
});

// ════════════════════════════════════════════════════════════════
// v3.13.0 additions — Fix 3 (nav), Fix 4 (retry center count),
// Fix 5 (full clear backups), Fix 6 (dual-save gate), Fix 7 (clear all)
// ════════════════════════════════════════════════════════════════

// ── Fix 6: dual-save work gate ──
function workReady() { return !!(state._configSaved && state._settingsSaved); }
function requireSaved() {
  if (workReady()) return true;
  // Name the exact button(s) still needed — "save something" was too vague,
  // and changing any setting re-opens this gate mid-session.
  const need = [];
  if (!state._configSaved) need.push('💾 Save Configuration');
  if (!state._settingsSaved) need.push('💾 Save All Settings');
  showMsg('Click ' + need.join(' and ') + ' first, then press this button again.', 'err');
  if (typeof refreshSaveGate === 'function') refreshSaveGate();
  return false;
}
// Only the buttons that START BRAND-NEW WORK are hard-disabled by the save
// gate. The retry / recovery buttons are deliberately NOT in this list: every
// one of them already calls requireSaved() itself, so disabling them as well
// made them silently dead — a click did nothing and showed no reason, which
// looked like the buttons were broken. Left clickable, they either run or
// explain exactly which Save button is missing.
const _GATED_BTN_IDS = ['testFirstBtn','applyLiveBtn','fastSubmitBtn'];
// Retry buttons that must stay clickable so their own guard can speak up.
const _RETRY_BTN_IDS = ['runSelectedAuditBtn',
  'retryAllFailedNewBtn','retryAllFailedSessionBtn','retryAllFailedAnyCodeBtn','retryAllFailedSectionsBtn',
  'retryAllAuditNewBtn','retryAllAuditSessionBtn','retryAllAuditAnyCodeBtn',
  'retryAllFaqSessionBtn','retryAllFaqAnyCodeBtn','retryAllFaqNewBtn','retryAllFaqFreshBtn',
  'faqBoxAiBtn','faqBoxAnyBtn','faqBoxNewBtn','faqBoxFreshBtn'];
function refreshSaveGate() {
  const ready = workReady();
  const gate = document.getElementById('saveGate');
  const gtxt = document.getElementById('saveGateText');
  if (gate) gate.classList.toggle('show', !ready);
  if (gtxt && !ready) {
    const need = [];
    if (!state._configSaved) need.push('Save Configuration');
    if (!state._settingsSaved) need.push('Save All Settings');
    gtxt.textContent = 'Click ' + need.join(' and ') + ' before starting any work (Start, Test, Fast Submit, Apply, retry, resume).';
  }
  _GATED_BTN_IDS.forEach(id => {
    const b = document.getElementById(id);
    if (b) b.disabled = !ready;
  });
  // Retry buttons stay enabled; only their own rules apply.
  _RETRY_BTN_IDS.forEach(id => {
    const b = document.getElementById(id);
    if (!b) return;
    b.disabled = (id === 'runSelectedAuditBtn') ? (_auditSelected.size === 0) : false;
    b.title = ready ? '' : 'Save Configuration and Save All Settings first — click to see what is missing.';
  });
  if (!state.batchActive) _refreshStartLock();
  const ca = document.getElementById('clearAllRunBtn');
  if (ca) ca.disabled = !!state.batchActive;
}
// Mark the correct half dirty when its inputs change.
const _CONFIG_CONTROL_IDS = new Set(['runSiteSelect','runAISelect','runPromptSelect','parallelCount']);
const _SETTINGS_IGNORE_IDS = new Set(['slugTextarea','slugFile','importFile',
  'wpName','wpUrl','wpUpdateMode','wpCredentialMode','wpUser','wpAppPassword',
  'aiName','aiMode','aiUrl','aiModel','aiApiKey','promptName','promptType','promptText','promptWebSearch']);
document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (!t || !t.id) return;
  if (_CONFIG_CONTROL_IDS.has(t.id)) { state._configSaved = false; refreshSaveGate(); return; }
  if (_SETTINGS_IGNORE_IDS.has(t.id)) return;
  if (!t.closest || !t.closest('#tab-run')) return;   // processing options live on the Run tab
  if (!/^(SELECT|INPUT|TEXTAREA)$/.test(t.tagName)) return;
  state._settingsSaved = false; refreshSaveGate();
});

// ── Fix 4: Retry Center count of unresolved (latest) failed + audit items ──
function updateRetryCenter() {
  setCountChip('retryCenterCount', latestByStatus('failed').length + latestByStatus('audit').length);
}

// ── Total wipe: remove ALL stored data (sites, AIs, prompts, credentials,
// settings, backups, results, history, batch/queue state), then write a clean
// fresh state with every first-run re-seed flag set so nothing comes back on
// reload. Built-in AIs (Grok/ChatGPT/Claude/Gemini) remain — they are hardcoded,
// not stored. ──
async function factoryResetAll() {
  try { chrome.runtime.sendMessage({ type: 'BATCH_STOP' }); } catch (e) {}
  try { chrome.runtime.sendMessage({ type: 'FAST_CLEAR_QUEUE' }); } catch (e) {}
  try { chrome.runtime.sendMessage({ type: 'BATCH_CLEAR_ATTEMPTS' }); } catch (e) {}
  await chrome.storage.local.clear();
  const fresh = Object.assign({}, SETTINGS_DEFAULTS, {
    wpSites: [], customAIs: [], prompts: [],
    wpDefaultIndex: -1, defaultPromptId: null, selectedPromptId: null,
    defaultAIId: 'grok', selectedAI: 'grok',
    savedSlugDraft: '', processedLinks: [], archivedAttemptKeys: [],
    // Suppress EVERY first-run re-seed so cleared prompts/sites/settings do not
    // reappear after the reload (this is why a plain clear looked "not working").
    defaultsV5_installed: true, defaultsV3_installed: true, defaultsV4_installed: true,
    promptsV8_installed: true, auditPromptInstalled_v1: true,
    bigArticleDefaults_v1: true, preservePromptInstalled_v1: true,
    safetyGatePromptsInstalled_v1: true
  });
  await chrome.storage.local.set(fresh);
}

// ── Fix 5: permanently clear every ORIGINAL-HTML backup record (awaited) ──
async function clearAllBackupsFully() {
  // This build stores backups in chrome.storage.local (no IndexedDB).
  try { await chrome.storage.local.remove(['__originalsBackup', '__originalsBackupCount']); } catch (e) {}
  // Defensive: also wipe any IndexedDB a future build might use, so deleted
  // backups cannot reappear after a reload or Chrome restart.
  try {
    if (typeof indexedDB !== 'undefined' && indexedDB.databases) {
      const dbs = await indexedDB.databases();
      await Promise.all((dbs || []).filter(d => d && d.name).map(d => new Promise((res) => {
        const req = indexedDB.deleteDatabase(d.name);
        req.onsuccess = req.onerror = req.onblocked = () => res();
      })));
    }
  } catch (e) {}
  try { await refreshOriginalsCount(); } catch (e) {}
}

// ── Fix 7: Clear All — reset this run to a fresh state ──
{ const b = document.getElementById('clearAllRunBtn'); if (b) b.onclick = async () => {
  if (state.batchActive) return showMsg('A batch, recovery or retry is running. Stop it first.', 'err');
  if (!confirm('Clear ALL results and history for a fresh run?\n\nRemoves: successful / audit / failed results, retry & audit history, logs, counters, timestamps, the pasted slug list, and temporary batch/queue state.\n\nKeeps: your WordPress sites, AIs, prompts, credentials and all settings. This cannot be undone.')) return;
  state.processedLinks = [];
  state.archivedAttemptKeys = [];
  state.savedSlugDraft = '';
  _auditSelected.clear();
  _openItems.clear();
  await saveState();
  // Full reset of the BACKGROUND runtime too (log, failures, counters, queues) —
  // and wait for it, so the very next status poll can't repaint the old run.
  await new Promise((res) => { try { chrome.runtime.sendMessage({ type: 'BATCH_RESET' }, () => res()); } catch (e) { res(); } });
  _lastLogSig = ''; _lastFailSig = ''; _lastRetryReportSig = '';
  const ta = document.getElementById('slugTextarea'); if (ta) ta.value = '';
  const lb = document.getElementById('logBox'); if (lb) lb.innerHTML = '<div class="empty">Log entries will appear here when the batch starts.</div>';
  const fl = document.getElementById('failureList'); if (fl) fl.innerHTML = '<div class="empty">No failed posts in this batch.</div>';
  const rr = document.getElementById('retryReport'); if (rr) rr.innerHTML = '<div class="empty">No audit issues or failed posts yet.</div>';
  const pf = document.getElementById('progressFill'); if (pf) { pf.style.width = '0%'; pf.className = 'progress-fill'; }
  const pt = document.getElementById('progressText'); if (pt) pt.textContent = '0 / 0';
  const sl = document.getElementById('statusLine'); if (sl) { sl.textContent = 'Ready to start.'; sl.className = 'status-line'; }
  const bsl = document.getElementById('batchStatusLabel'); if (bsl) bsl.textContent = 'Idle';
  renderProcessedLinks();
  updateSlugCount();
  refreshFastQueueStatus();
  showMsg('Cleared — this is a fresh run. Your sites, prompts and settings are intact.', 'ok');
}; }

// ── "Everything Clear" (top area): one click wipes every result, counter,
// history list and log, leaving settings, sites, prompts and the unfinished
// queue untouched. Blocked while a run is active so nothing is cleared
// underneath a working batch.
{ const b = document.getElementById('emergencyStopBtn'); if (b) b.onclick = () => {
  // No confirmation and no gate: an emergency stop must never be blocked by a
  // dialog, an unsaved-settings gate, or "is a batch running?" state.
  b.disabled = true;
  b.textContent = '🛑 STOPPING…';
  chrome.runtime.sendMessage({ type: 'EMERGENCY_STOP' }, () => {
    b.disabled = false;
    b.textContent = '🛑 EMERGENCY STOP';
    state._pendingStart = false;
    showMsg('🛑 Emergency stop — everything halted. Nothing further will be sent.', 'err');
    refreshFastQueueStatus();
  });
}; }

{ const b = document.getElementById('everythingClearBtn'); if (b) b.onclick = async () => {
  if (state.batchActive) {
    return showMsg('A batch, recovery or retry is running — press Stop first, then use Everything Clear.', 'err');
  }
  if (!confirm('Are you sure you want to clear everything?\n\nClears EVERYTHING from this work: the pasted slugs / URLs in "Posts to update", all counters and summary chips, successful / audit / failed lists, retry centre data, logs and activity, the last run and recovery summary, any scheduled or queued Fast Submit, and every finished-run record in storage.\n\nKeeps only your setup: WordPress sites, AIs, prompts, credentials and settings.\n\nThis cannot be undone.')) return;

  // 1) Panel-side history and counters.
  state.processedLinks = [];
  state.archivedAttemptKeys = [];
  state.lastRunSlugs = [];
  state.savedSlugDraft = '';          // the queue box is part of "everything"
  state._pendingStart = false;
  _auditSelected.clear();
  _openItems.clear();
  { const ta0 = document.getElementById('slugTextarea'); if (ta0) ta0.value = ''; }
  await saveState();

  // 2) Background runtime: log, failures, attempts, counters, fast queue and
  //    the chunked-cycle plan. Awaited so the next poll cannot repaint them.
  await new Promise((res) => { try { chrome.runtime.sendMessage({ type: 'BATCH_RESET' }, () => res()); } catch (e) { res(); } });

  // 3) Any leftover finished-run keys written by older builds.
  try { await chrome.storage.local.remove(['__fastQueue', '__fastCyclePlan', '__runtime', 'lastRunSummary', 'retryHistory']); } catch (e) {}

  // 4) Repaint every result surface as empty.
  _lastLogSig = ''; _lastFailSig = ''; _lastRetryReportSig = '';
  const setHtml = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  setHtml('logBox', '<div class="empty">Log entries will appear here when the batch starts.</div>');
  setHtml('failureList', '<div class="empty">No failed posts in this batch.</div>');
  setHtml('retryReport', '<div class="empty">No audit issues or failed posts yet.</div>');
  setHtml('progressSummary', '<span class="ps-chip ps-idle">No batch running</span>');
  const pf = document.getElementById('progressFill'); if (pf) { pf.style.width = '0%'; pf.className = 'progress-fill'; }
  const pt = document.getElementById('progressText'); if (pt) pt.textContent = '0 / 0';
  const sl = document.getElementById('statusLine'); if (sl) { sl.textContent = 'Ready to start.'; sl.className = 'status-line'; }
  const bsl = document.getElementById('batchStatusLabel'); if (bsl) bsl.textContent = 'Idle';
  renderProcessedLinks();
  updateSlugCount();
  refreshFastQueueStatus();
  showMsg('Everything cleared successfully — the panel is fresh and ready for a new run.', 'ok');
}; }

// ── Fix 3: sticky top shortcut navigation ──
(function initShortcutNav() {
  const bar = document.getElementById('shortcutBar');
  if (!bar) return;
  const links = [...bar.querySelectorAll('a[data-sc]')];
  const setActive = (id) => links.forEach(a => a.classList.toggle('active', a.dataset.sc === id));
  links.forEach(a => {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      const sec = document.getElementById(a.dataset.sc);
      if (!sec) return;
      const runTab = document.querySelector('.tab[data-tab="run"]');
      if (runTab && !runTab.classList.contains('active')) runTab.click();
      if (sec.tagName === 'DETAILS') sec.open = true;
      let p = sec.parentElement;
      while (p) { if (p.tagName === 'DETAILS') p.open = true; p = p.parentElement; }
      setTimeout(() => sec.scrollIntoView({ behavior: 'smooth', block: 'start' }), 40);
      setActive(a.dataset.sc);
    });
  });
  if ('IntersectionObserver' in window) {
    const seen = new Map();
    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => seen.set(e.target.id, e.intersectionRatio));
      let best = null, bestR = 0;
      seen.forEach((r, id) => { if (r > bestR) { bestR = r; best = id; } });
      if (best) setActive(best);
    }, { rootMargin: '-70px 0px -60% 0px', threshold: [0, 0.25, 0.5, 1] });
    links.map(a => a.dataset.sc).forEach(id => { const el = document.getElementById(id); if (el) io.observe(el); });
  }
})();

// Gate starts closed on load: both halves unsaved → work is blocked until the
// user clicks Save Configuration and Save All Settings.
refreshSaveGate();

// ════════════════════════════════════════════════════════════════
// Init
// ════════════════════════════════════════════════════════════════
try {
  const _ver = document.getElementById('verLabel');
  if (_ver) _ver.textContent = 'v' + chrome.runtime.getManifest().version;
} catch (e) {}
updateAIFormPlaceholders();
loadState().then(handleWpAutoConnectCallback).then(updateSlugCount);
