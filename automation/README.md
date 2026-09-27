# Unattended article editor

This folder lets an AI improve your WordPress articles when **nobody checks them by hand**.
Every check a person used to do is now done by the prompt, by code, or by a second AI.
If any step fails, the original article stays live. Nothing is lost.

## 1. The problem

Prompt 2 ends with a report for a person: a VERIFY list, "I'll click each link", an image count line and YOUR EXPERIENCE.
In an automation nobody reads that report, so mistakes would go live.
So the checks move into three places: a stricter prompt, code (`validate-article.js`) and a second AI (the fact audit).
One golden rule for every step: **if something fails or is unsure, keep the original article.**

## 2. What replaced each human step

| Human step in Prompt 2 | What does it now |
|---|---|
| VERIFY list (find each doubtful fact with Ctrl+F) | The prompt says "do no harm": when unsure, keep the original wording or leave the addition out. Changed facts go to META `facts_changed`, unsure ones to `unverified_kept` (logged). The fact audit checks every new or changed claim. |
| "I'll click each link once before publishing" | `checkLinks` opens every new link. `sanitizeLinks` removes a new link (the words stay) when it is dead, internal, on a forbidden site, or a deep link without research. The audit checks that each new page supports its sentence (`link_mismatch`). |
| CHECKS line (images X → X, links, editor) | `validateArticle` compares the edit with the original: `IMG_COUNT`, `IMG_CHANGED`, `LINK_MISSING`, `SHORTCODE_MISSING`, `PLUGIN_BLOCK_CHANGED` and about 30 more. Any error = keep original. |
| YOUR EXPERIENCE | The prompt forbids invented experience. The best spot for your own photo or tip only goes into META `notes` (logged). The audit marks any new "I tried / we tested" as `invented_experience` (high). |
| RANK MATH suggestions | META `seo_titles`, `meta_description` and `focus_keyword`. Your automation can write them into Rank Math (section 5). |
| The report | META JSON + validator report + audit result, saved in your log (section 8). Nobody has to read them. |

## 3. The pipeline, step by step

```
 WordPress post (content.raw)
        |
 [1] fill SETTINGS + article into the prompt
        |
 [2] editor call, web search on ---- API problem ----------------> KEEP ORIGINAL
        |
 [3] parse the markers ------------- META status "skipped" ------> SKIP
        |
 [4] link check + sanitize
        |
 [5] validate ---------------------- any error ------------------> KEEP ORIGINAL
        |
 [6] fact audit (second AI call)
        |
 [7] filterAuditIssues
        |-- pass ----------------------------------------------------> PUBLISH
        |-- reject --------------------------------------------------> KEEP ORIGINAL
        '-- fix (first try only) --> ONE retry: back to [2] on the ORIGINAL,
                                     issues in "Extra instructions".
                                     Second time: pass -> PUBLISH, else KEEP ORIGINAL
        |
 [8] log everything and mark the post as processed
```

Steps 3, 4 and 5 are one function call: `processEditorOutput`.

1. **Fetch.** Read the post raw (section 5). Keep an exact, unchanged copy. This is `originalHtml`.
2. **Fill the prompt.** Take `article-editor-prompt.txt`. Write each value after the colon of its SETTINGS line (table below). Put `originalHtml` between `<article_html>` and `</article_html>` at the end.
3. **Editor call.** Send the filled prompt as the user message, with web search on (section 4). Check `stop_reason`. Join the text of all text blocks. Count the searches.
4. **Validate.** Call `processEditorOutput(originalHtml, replyText, options)`. It reads the `<<<ARTICLE_HTML>>>`, `<<<META_JSON>>>` and `<<<END>>>` markers, tests new links, unwraps bad ones and runs every check. The answer has `action`: `publish`, `keep_original` or `skip`.
5. **Fact audit.** Only when `action` is `publish`. Take `fact-audit-prompt.txt`. Fill its three SETTINGS lines. Put `originalHtml` inside `<original_html>` and `result.html` (the cleaned edit) inside `<edited_html>`. Send it with web search on.
6. **Filter the audit.** Call `filterAuditIssues(result.html, auditReplyText, { originalHtml })`. Issues whose quote is not really in the article are dropped. Use `effectiveVerdict`, not `verdict`. A reply that is not valid JSON counts as `reject`.
7. **Decide.** `pass` → write `result.html` to WordPress. `reject` → keep original. `fix` → one retry: run the editor again on the **original** (not on the failed edit), with the kept issues in "Extra instructions". Then steps 3–6 again. Publish only if the second audit is `pass`. Never a third try.
8. **Log and mark** (sections 5 and 8).

### How to fill the SETTINGS block

| SETTINGS line (exact text) | What to write | Validator option / CLI flag |
|---|---|---|
| `Post title (H1, set in WordPress):` | the post title (`title.raw`) | `postTitle` (JS only) |
| `Focus keyword:` | Rank Math focus keyword if you have it, else blank | – |
| `Target reader / country:` | e.g. `UK drivers`, or blank | – |
| `Site domain(s) (comma-separated):` | your own domain(s), e.g. `tubetyre.com` | `siteDomains` / `--site` |
| `Today's date (YYYY-MM-DD):` | today, from your server clock | – |
| `Web search available (yes / no; default: no):` | `yes` only if you really turned the tool on | `webSearchCount` / `--searches` |
| `Add new FAQ (auto / no; default: auto):` | `auto`, or `no` | `allowNewFaq` / `--faq` |
| `Last checked line (yes / no / auto; default: auto):` | usually `auto` | – |
| `Extra instructions:` | blank; the audit issues on the retry | – |

The audit prompt has three lines: `Today's date (YYYY-MM-DD):`, `Web search available (yes / no; default: no):` and `Site language (default: the original article's language):`.

A small helper (Node). It uses `split/join`, not `replace()`, because a `$` in prices breaks `replace()`:

```js
function fillPrompt(template, settings, tags) {
  let text = template;
  for (const [line, value] of Object.entries(settings)) {
    if (!text.includes('\n' + line + '\n')) throw new Error('SETTINGS line not found: ' + line);
    text = text.split('\n' + line + '\n').join('\n' + line + ' ' + value + '\n');
  }
  for (const [tag, html] of Object.entries(tags)) {   // e.g. { article_html: originalHtml }
    const empty = '<' + tag + '>\n</' + tag + '>';
    if (text.split(empty).length !== 2) throw new Error('Tag not found once: ' + tag);
    text = text.split(empty).join('<' + tag + '>\n' + html + '\n</' + tag + '>');
  }
  return text;
}
```

On the retry, write the kept issues after `Extra instructions:` (it is the last line, so several lines are fine), high issues first, at most 10:

```
Extra instructions: A fact audit found these problems in your earlier edit. Edit the original again and avoid all of them.
1. [high, new_claim_unverified] "exact quote from the audit" - Problem: ... - Fix: ...
```

## 4. Settings for the Claude API

Editor call (request body):

```json
{
  "model": "claude-opus-5",
  "max_tokens": 64000,
  "stream": true,
  "thinking": { "type": "adaptive" },
  "output_config": { "effort": "high" },
  "tools": [
    { "type": "web_search_20260209", "name": "web_search", "max_uses": 20 },
    { "type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 20 }
  ],
  "messages": [ { "role": "user", "content": "<the filled editor prompt>" } ]
}
```

- `claude-sonnet-5` is the cheaper option.
- Audit call: the same shape with the filled audit prompt, `max_tokens` 16000 and `max_uses` 10 for each tool.
- Use streaming for a large `max_tokens`, or the HTTP call can time out. Thinking uses part of `max_tokens`, so leave room.
- Prefill is not supported, so you cannot start the reply with the first marker. That is fine: the parser ignores text before `<<<ARTICLE_HTML>>>`.
- Web fetch only opens URLs that are already in the conversation (for example from search results).
- Google Vertex AI: only `{"type": "web_search_20250305", "name": "web_search", "max_uses": 20}` exists, and there is no web fetch. Leave the fetch tool out.

**Reading the answer.**
- Reply text = the text of all `text` blocks, in order, from all responses of this article (continuations too), joined with nothing between them.
- Search count = the number of `server_tool_use` blocks with name `web_search` in all those responses (`usage.server_tool_use.web_search_requests` reports it too). Pass it as `webSearchCount` / `--searches`.
- Tool errors do not raise. The API still returns HTTP 200, with a `web_search_tool_result` whose content is an error object (for example `error_code` `max_uses_exceeded`). To be strict, do not count searches that returned an error.

| `stop_reason` | Meaning | What to do |
|---|---|---|
| `end_turn` | normal finish | go on to validation |
| `pause_turn` | the server paused its tool loop (after 10 rounds) | send the same request again with the assistant's content added at the end of `messages`. Do NOT add a "continue" message. At most 5 times; still pausing → keep original. SDK tool runners do not do this for you. |
| `max_tokens` | the reply was cut off | keep original |
| `refusal` | the safety system declined | keep original |
| anything else, HTTP error, timeout | – | keep original; try the post again in a later run |

**Other providers** (OpenAI, Gemini and others): enable the provider's built-in web search tool. If the provider reports how many searches ran, pass that number. If you cannot count, leave `webSearchCount` out (`null`); then the validator is strict only when META says `"web_research_used": false`. If there is no web search, write `Web search available: no` and pass `--searches 0`. Then new links can only be bare homepages, and a new "Last checked" line is blocked.

## 5. WordPress side

- **Read raw content.** `GET /wp-json/wp/v2/posts/<id>?context=edit`, logged in with an Application Password (Users → Profile → Application Passwords). Use `content.raw` and `title.raw`.
- **Never use `content.rendered`.** It has the block comments removed and the shortcodes expanded. Never give it to the editor and never write it back. The validator cannot catch this, because it compares with whatever you gave it.
- **Write back.** `POST /wp-json/wp/v2/posts/<id>` with `{"content": "<result.html>"}`. Send only `content`; do not change status, date or slug. If `result.changed` is false, there is nothing to write.
- **Someone edited it meanwhile?** Just before writing, read the post again. If `modified_gmt` changed since step 1, do not write; try it in a later run.
- **Revisions = your undo button.** Keep post revisions on (do not set `WP_POST_REVISIONS` to `false` or `0`). Every write makes a revision. To undo: open the post, Revisions, Restore. Also keep the original in your log.
- **Rank Math fields** are post meta: `rank_math_title`, `rank_math_description`, `rank_math_focus_keyword`. The core REST API only writes meta that is registered for REST. Use a connector/plugin that writes Rank Math fields, or a small snippet (for example with the Code Snippets plugin):

```php
add_action( 'init', function () {
    $keys = array( 'rank_math_title', 'rank_math_description', 'rank_math_focus_keyword', 'ai_edit_date', 'ai_edit_result' );
    foreach ( $keys as $key ) {
        register_post_meta( 'post', $key, array(
            'type'          => 'string',
            'single'        => true,
            'show_in_rest'  => true,
            'auth_callback' => function ( $allowed, $meta_key, $post_id ) { return current_user_can( 'edit_post', $post_id ); },
        ) );
    }
} );
```

  Then send `{"meta": {"rank_math_title": "...", "rank_math_description": "..."}}` in the same POST. Safe rules: write them only when the article was published; fill a field only when it is empty; skip a field that got a `META_LENGTH` warning.
- **Mark processed posts.** After every run, save `ai_edit_date` (e.g. `2026-09-26`) and `ai_edit_result` (`publish`, `keep_original` or `skip`), as custom fields or in your own list (sheet or database: site, post id, date, result). Before picking a post, check the mark. Suggested: edited posts not again for 12 months; `keep_original` posts once more after 30 days, then leave them; skipped posts never. Why: each re-edit rewrites the text again, so over many runs the article drifts away from what you wrote, and you pay every time.

## 6. Using the validator

**Command line** (Node 18 or newer, no packages needed):

```
node automation/validate-article.js --original original.html --output reply.txt \
  --site tubetyre.com --searches 14 --faq auto \
  --write-html final.html --report report.json
```

| Flag | Meaning |
|---|---|
| `--original` / `--output` | the raw original HTML / the editor's whole reply (required) |
| `--site a.com,b.com` | your own domains (new links to them are removed) |
| `--searches N` | web searches really done; `0` = no research. Leave out if unknown |
| `--faq auto\|no` | same as the "Add new FAQ" setting |
| `--no-link-check` | do not open new links (use when there is no internet) |
| `--write-html out.html` | writes the cleaned article, only on publish (an old file is deleted otherwise) |
| `--report report.json` | writes the full result, for your log |

It prints the result as JSON. Exit codes: **0 publish**, **2 keep_original**, **3 skip**, **1 usage or file error**. Publish only on 0.
The audit filter has no flag. Run it with `node -e` (writes the filtered audit, prints the verdict, exit 0 only on pass):

```
node -e "const V=require('./automation/validate-article.js'),fs=require('fs');const r=V.filterAuditIssues(fs.readFileSync('final.html','utf8'),fs.readFileSync('audit.txt','utf8'),{originalHtml:fs.readFileSync('original.html','utf8')});fs.writeFileSync('audit-result.json',JSON.stringify(r,null,2));console.log(r.effectiveVerdict);process.exitCode=r.effectiveVerdict==='pass'?0:2"
```

**JavaScript API.** Exports: `parseEditorOutput`, `findNewLinks`, `checkLinks`, `sanitizeLinks`, `validateArticle`, `filterAuditIssues`, `processEditorOutput`, `DEFAULT_FORBIDDEN_LINK_DOMAINS`, `ERROR_CODES`, `WARNING_CODES`.

```js
const V = require('./validate-article.js');
const result = await V.processEditorOutput(originalHtml, replyText, {
  siteDomains: ['tubetyre.com'],
  webSearchCount: 14,        // null = unknown, 0 = no research
  allowNewFaq: true,         // false when "Add new FAQ: no"
  postTitle: postTitle,      // optional: catches a title line at the top (TITLE_IN_BODY)
  checkLinks: true,          // false = do not open new links
  fetchFn: undefined,        // your own fetch function (see below)
  linkTimeoutMs: 10000,
  linkConcurrency: 4
  // also: forbiddenLinkDomains (replaces the default list), minWordRatio (0.8), maxWordRatio (5)
});
// result: action ('publish' | 'keep_original' | 'skip'), html (cleaned edit, or the original),
// changed, meta, errors, warnings, removedLinks, linkResults, stats

if (result.action === 'publish') {
  const audit = V.filterAuditIssues(result.html, auditReplyText, { originalHtml });
  // audit.effectiveVerdict: 'pass' -> publish, 'fix' -> one retry, 'reject' -> keep original
  // audit.issues = kept issues, audit.dropped = issues with a quote that is not in the article
}
```

To add sites to the forbidden list, extend it: `V.DEFAULT_FORBIDDEN_LINK_DOMAINS.concat(['somecouponsite.com'])`.

**Link results.** `ok` (2xx/3xx) = kept. `dead` (404, 410, 5xx, DNS failure, connection refused, certificate error) = unwrapped, and its Sources item is removed. `unknown` (401, 403, 429, timeout, other) = kept.

**Your own fetch function.** Any function that takes `(url, {method, redirect, signal})` and returns (or resolves to) an object with a numeric `status`:

```js
async function myFetch(url, init) {
  // init.method is 'HEAD' or 'GET'; init.redirect is 'follow'; init.signal can abort the request
  const res = await yourHttpClient(url, init.method);   // must follow redirects
  return { status: res.statusCode };
}
// processEditorOutput(originalHtml, replyText, { ..., fetchFn: myFetch })
```

If a request fails, throw an Error. Give it `code = 'ENOTFOUND'` or `'ECONNREFUSED'` when you know it, so the link counts as dead. Other errors count as unknown (link kept). The timeout works even if your function ignores `signal`.

**n8n and similar tools.** Paste the whole file at the top of a Code node, then call the functions below it (`processEditorOutput` is async, so use `await`). If the Code node has no `fetch`, pass a `fetchFn`, or set `checkLinks: false` (internal, forbidden and no-research links are still removed; dead links are not found). On self-hosted n8n you can also write the two files and run the command line with an Execute Command node. Some tools treat a non-zero exit code as a failed step; if yours does, add `; echo "exit_code=$?"` to the command and read the number from the output.

**Tests:** `node --test automation/test/`

## 7. If an AI agent does the work

For example Claude Code or Cowork with a WordPress MCP connector. The agent must follow the same gates:

1. Read the post in raw (edit) form, with block comments and shortcodes. If the connector only gives rendered HTML, do not edit that post.
2. Save it unchanged to a file, e.g. `work/<post-id>/original.html`.
3. Edit it by following `article-editor-prompt.txt` (SETTINGS filled). Save the **whole reply, with the markers**, to `work/<post-id>/reply.txt`.
4. Run the validator command line with `--write-html work/<post-id>/final.html --report work/<post-id>/report.json` and the real number of searches (if unsure, `--searches 0`).
5. Only if the exit code is 0: run the fact audit with `fact-audit-prompt.txt`, `original.html` and `final.html`. A fresh session or subagent that did not write the edit is best. Save its reply to `audit.txt` and run the `node -e` audit filter from section 6.
6. Only if that is `pass`: update the post with the exact content of `final.html`. Never retype it or "fix" it by hand. Then read the post again; if the raw content differs from `final.html`, restore `original.html`.
7. Any other result: do not touch the post. Save the files as the log. One retry at most.

## 8. Logging

For every post and run, save: site, post id, date, model, `stop_reason`, search count, the META JSON, the validator report (`--report` file or the `processEditorOutput` result), the filtered audit (with `dropped`), whether a retry happened, the final action, and a copy of the original. A folder per day, a database or a spreadsheet row with the JSON is enough. META `notes` (plugin block suggestions, broken-looking old links, missing affiliate disclosure) are only logged.

Optional, if you ever have 10 minutes:
- **Weekly:** look at the `keep_original` list and count the error codes. One code on many posts means a setup problem, not bad articles. Examples: `IMG_CHANGED` everywhere → maybe you sent rendered content; `PARSE_MISSING_MARKER` with `max_tokens` → the articles are too long; `LAST_CHECKED_WITHOUT_RESEARCH` → web search is not really on. Also look at many dropped high audit issues.
- **Spot-check:** open 1 in 20 published posts and compare the last two revisions in WordPress.

## 9. Cost and safety tips

- Always set `max_uses` for web search and web fetch. Each search is billed on top of the tokens.
- Always set `max_tokens` (64000 for the editor, 16000 for the audit) and at most 5 `pause_turn` continuations.
- One retry per post, at most. Never loop until it passes.
- Process a fixed number of posts per run (start with 5–10), one post at a time per site. Never run two copies of the automation at once.
- Start with a dry run: do everything except the WordPress write, and read the logs.
- Stop the whole run when, for example, 5 posts in a row end as `keep_original`. Something is broken; do not keep paying.
- Mark every processed post (section 5). Never edit the same post again and again.
- Keep revisions on, and keep the original in your log.

## 10. Files in this folder

- `article-editor-prompt.txt`: the editor prompt (automation edition of Prompt 2). Fill SETTINGS and `<article_html>`.
- `fact-audit-prompt.txt`: the second-AI fact check. Fill SETTINGS, `<original_html>` and `<edited_html>`.
- `validate-article.js`: all code checks (parse, link check, sanitize, validate, audit filter). Command line or `require()` or paste.
- `test/run-tests.test.js`: tests for every error and warning code (`node --test automation/test/`).
- `test/package.json`: lets `node --test automation/test/` work on Node 22 and newer.
- `test/fixtures/`: sample originals (`original-block.html`, `original-classic.html`) and good editor replies (`edited-good.txt`, `edited-classic-good.txt`).
- `README.md`: this guide.
