# Unattended article editor

> **Using the Chrome extension (Auto Post Updater Pro)?** Read [`extension/SAFETY-GATE.md`](../extension/SAFETY-GATE.md) instead.
> This folder is the standalone / API version: you call the AI API from your own code.
> The extension ships its own copy of the validator (`extension/safety-gate.js`) and of the browser prompts (`extension/prompts/`).

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
| VERIFY list (find each doubtful fact with Ctrl+F) | The prompt says "do no harm": when unsure, keep the original wording or leave the addition out. Changed facts go to META `facts_changed`, unsure ones to `unverified_kept` (logged). The fact audit checks every new or changed claim. Without research (no web page really opened), code also blocks new prices, percentages and years, and any new "Last checked" or "verified" wording. |
| "I'll click each link once before publishing" | `checkLinks` opens every new link. `sanitizeLinks` removes a new link (the words stay) when it is dead, redirects to another site, is internal, is on a forbidden or short-link site, is a deep link without research, or is a deep link that could not be checked. Tracking parts such as `utm_source` are cut from new links. The audit checks that each new page supports its sentence (`link_mismatch`). |
| CHECKS line (images X → X, links, editor) | `validateArticle` compares the edit with the original: `IMG_COUNT`, `IMG_CHANGED`, `LINK_MISSING`, `SHORTCODE_MISSING`, `PLUGIN_BLOCK_CHANGED` and many more (49 error codes, section 9). Any error = keep original. |
| YOUR EXPERIENCE | The prompt forbids invented experience. The audit marks any new "I tried / we tested" as `invented_experience` (high). |
| RANK MATH suggestions | META `seo_titles`, `meta_description` and `focus_keyword`. Your automation can write them into Rank Math (section 5). |
| The report | META JSON + validator report + audit result, saved in your log (section 8). Nobody has to read them. |

## 3. The pipeline, step by step

The numbers in the picture and in the list below are the same steps.

```
 [1] Fetch the post (content.raw) ------ no content.raw ----------------> STOP THE RUN
        |                                 empty content.raw ------------> log "empty", next post
 [2] Fill SETTINGS + article into the editor prompt
        |
 [3] Editor call (web search + page opening) -- error, or stop_reason
        |                                        is not end_turn -------> KEEP ORIGINAL
 [4] processEditorOutput (parse, link check, clean links, all checks)
        |-- META status "skipped" --------------------------------------> SKIP
        |-- any error --------------------------------------------------> KEEP ORIGINAL
        |
 [5] Fact audit call ------------------- error, or stop_reason
        |                                is not end_turn ---------------> KEEP ORIGINAL
 [6] filterAuditIssues -> effectiveVerdict
        |-- pass -------------------------------------------------------> [8]
        |-- reject -----------------------------------------------------> KEEP ORIGINAL
        '-- fix, first try only --> [7] ONE retry: back to [2] on the ORIGINAL,
                                        audit issues in "Extra instructions".
                                        Second time: pass -> [8], anything else -> KEEP ORIGINAL
 [8] Write to WordPress and read it back -- differs --> put the original back, STOP THE RUN
        |
 [9] Log everything and mark the post as processed
```

1. **Fetch.** Read the post raw (section 5). Stop the whole run if the reply has no `content.raw`. Never use `content.rendered`. If `content.raw` is empty, do not call the editor; log `empty` and go to the next post. Otherwise keep an exact, unchanged copy. This is `originalHtml`.
2. **Fill the prompt.** Take `article-editor-prompt.txt`. Write each value after the colon of its SETTINGS line (table below). Put `originalHtml` between `<article_html>` and `</article_html>` at the end.
3. **Editor call.** Send the filled prompt as the user message, with web search and web fetch on (section 4). Use `callClaude` from section 4: it handles streaming and `pause_turn`, and counts searches and opened pages. Below, `edit` is its result. Anything but `edit.stopReason` `end_turn` = keep original.
4. **Validate.** Call `processEditorOutput(originalHtml, edit.finalText, options)`. Below, `result` is its answer. It reads the `<<<ARTICLE_HTML>>>`, `<<<META_JSON>>>` and `<<<END>>>` markers, tests new links, removes bad ones and runs every check. The answer has `action`: `publish`, `keep_original` or `skip`. `siteDomains` is required; pass the research count (below) as `webSearchCount`.
5. **Fact audit.** Only when `action` is `publish`. Take `fact-audit-prompt.txt` and fill its **two** SETTINGS lines: `Today's date (YYYY-MM-DD):` and `Web search available (yes / no; default: no):`. Put `originalHtml` inside `<original_html>` and `result.html` inside `<edited_html>`. `result.html` is the cleaned edit (links already removed or cleaned). Never send the HTML from the editor's reply. Give the audit call web search and web fetch whenever the editor call had them. If your audit model cannot search, run the editor with `Web search available: no` too. Otherwise the audit must flag every researched fact as unverified, and almost every good edit is thrown away. Read the audit reply exactly like the editor reply: use `callClaude` (below, `check` is its result); anything but `check.stopReason` `end_turn` = keep original.
6. **Filter the audit.** Call `audit = filterAuditIssues(result.html, check.finalText, { originalHtml })`. Issues whose quote is not really in the article are dropped. Use `effectiveVerdict`, not `verdict`. A reply that is not valid JSON counts as `reject`.
7. **Decide.** `pass` → go to step 8. `reject` → keep original. `fix` → one retry: run the editor again on the **original** (not on the failed edit), with `audit.retryIssues` in "Extra instructions" (text below). This is a fresh editor call: start all counts from zero and never mix text or counts from the first try. Then steps 3–6 again. Publish only if the second audit is `pass`. Never a third try.
8. **Write and check.** Write `result.html` to WordPress, then read the post again and compare (section 5).
9. **Log and mark** (sections 5 and 8).

### How to fill the SETTINGS block

| SETTINGS line (exact text) | What to write | Validator option / CLI flag |
|---|---|---|
| `Post title (H1, set in WordPress):` | the post title (`title.raw`) | `postTitle` / `--title` |
| `Focus keyword:` | Rank Math focus keyword if you have it, else blank | – |
| `Target reader / country:` | e.g. `UK drivers`, or blank | – |
| `Site domain(s) (comma-separated):` | your own domain(s), e.g. `tubetyre.com` | `siteDomains` / `--site` (required) |
| `Today's date (YYYY-MM-DD):` | today, from your server clock | `today` / `--today` |
| `Web search available (yes / no; default: no):` | `yes` only if you really turned on web search **and** web fetch | `webSearchCount` / `--searches` = the research count (below), not yes/no |
| `Add new FAQ (auto / no; default: auto):` | `auto`, or `no` | `allowNewFaq` / `--faq` |
| `Last checked line (yes / no / auto; default: auto):` | usually `auto` | `lastCheckedLine` / `--last-checked` |
| `Extra instructions:` | blank; the audit issues on the retry | – |

The audit prompt has two SETTINGS lines: `Today's date (YYYY-MM-DD):` and `Web search available (yes / no; default: no):`. Write the same values as for the editor.

### The research count (`webSearchCount` / `--searches`)

The validator only asks: did the editor really open and read at least one web page? `0` means no research. Then it removes every new deep link and blocks new "Last checked" lines, "updated/verified" wording, today's date, and new prices, percentages or years. Search results alone do not count, because the prompt says snippets never verify anything. One rule:

- **Claude with `callClaude`:** pass `edit.pagesOpened` (pages opened without an error), and `edit.openedUrls` as `verifiedUrls`. If searches ran but no page opened, this is `0`, and that is correct.
- **Tool off, or you are not sure a page was opened:** pass `0`.
- **Another provider, tool on, but it does not report opened pages:** leave it out (`null`). The validator then uses META `web_research_used`, which the prompt sets to `true` only when a page was opened and read.
- **Google Vertex AI** has no web fetch, so `pagesOpened` is always `0`. Write `Web search available: no` in both prompts and leave the search tool out: searches alone cannot verify anything, and you would pay for nothing.

### Helper to fill the prompts

A small helper (Node). It uses `split/join`, not `replace()`, because a `$` in prices breaks `replace()`. It stops with an error if a SETTINGS line or tag is not found, so a changed prompt file never goes out half-filled:

```js
function fillPrompt(template, settings, tags) {
  let text = String(template).replace(/\r\n?/g, '\n');           // Windows line endings
  for (const [line, value] of Object.entries(settings)) {
    if (!text.includes('\n' + line + '\n')) throw new Error('SETTINGS line not found: ' + line);
    const v = line.startsWith('Extra instructions') ? String(value || '').trim()
      : String(value || '').replace(/\s+/g, ' ').trim();          // one line only
    text = text.split('\n' + line + '\n').join('\n' + line + (v ? ' ' + v : '') + '\n');
  }
  for (const [tag, html] of Object.entries(tags)) {   // e.g. { article_html: originalHtml }
    const empty = '<' + tag + '>\n</' + tag + '>';
    if (text.split(empty).length !== 2) throw new Error('Tag not found once: ' + tag);
    text = text.split(empty).join('<' + tag + '>\n' + html + '\n</' + tag + '>');
  }
  return text;
}
```

On the retry, write `audit.retryIssues` after `Extra instructions:` (it is the last SETTINGS line, so several lines are fine). The list is already sorted high first. Use at most 10. Issues marked `quoteNotFound` are high issues whose quote was not found exactly; they are kept so the retry still avoids them:

```js
function retryText(retryIssues) {
  const lines = retryIssues.slice(0, 10).map(function (i, n) {
    return (n + 1) + '. [' + i.severity + ', ' + i.category + '] "' + i.quote + '"' +
      (i.quoteNotFound ? ' (quote not found exactly)' : '') + ' - Problem: ' + i.problem + ' - Fix: ' + i.fix;
  });
  return 'A fact audit found these problems in your earlier edit. Edit the original again and avoid all of them.\n' + lines.join('\n');
}
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
- Audit call: the same shape with the filled audit prompt, `max_tokens` 16000 and `max_uses` 10 for each tool. If your log often shows `max_tokens` for the audit, raise it to 32000.
- 20 + 20 tool uses match the prompt's research budget (25–40 searches and page opens).
- Use streaming for a large `max_tokens`, or the HTTP call can time out. Thinking uses part of `max_tokens`, so leave room.
- Prefill is not supported, so you cannot start the reply with the first marker. That is fine: the parser ignores text before `<<<ARTICLE_HTML>>>`.
- Web fetch only opens URLs that are already in the conversation (for example from search results, or links in the article).
- Google Vertex AI: only `{"type": "web_search_20250305", "name": "web_search", "max_uses": 20}` exists, and there is no web fetch. See "The research count" above.

### `callClaude`: one call, with streaming and `pause_turn`

A streamed reply arrives as many small events, not as one JSON message. This helper (Node 18 or newer, no packages) sends the request, rebuilds the message from the events, continues on `pause_turn` (at most 5 times, with the assistant's content added and no "continue" message), and counts the tools. Use it for the editor call and for the audit call.

```js
// Rebuilds one message from the streamed text (Server-Sent Events).
function sseToMessage(sseText) {
  const msg = { role: 'assistant', content: [], stop_reason: null, usage: {} };
  const partialJson = {};
  let finished = false;
  for (const event of String(sseText).replace(/\r\n?/g, '\n').split('\n\n')) {
    const data = event.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n');
    if (!data) continue;
    const ev = JSON.parse(data);                       // a broken event throws: treat it as an API problem
    if (ev.type === 'error') throw new Error('Stream error: ' + JSON.stringify(ev.error));
    if (ev.type === 'message_start') Object.assign(msg, ev.message, { content: [] });
    else if (ev.type === 'content_block_start') msg.content[ev.index] = ev.content_block;
    else if (ev.type === 'content_block_delta') {
      const b = msg.content[ev.index], d = ev.delta;
      if (d.type === 'text_delta') b.text += d.text;
      else if (d.type === 'thinking_delta') b.thinking += d.thinking;
      else if (d.type === 'signature_delta') b.signature = d.signature;
      else if (d.type === 'citations_delta') (b.citations = b.citations || []).push(d.citation);
      else if (d.type === 'input_json_delta') partialJson[ev.index] = (partialJson[ev.index] || '') + d.partial_json;
    } else if (ev.type === 'content_block_stop') {
      if (partialJson[ev.index]) msg.content[ev.index].input = JSON.parse(partialJson[ev.index]);
    } else if (ev.type === 'message_delta') {
      Object.assign(msg, ev.delta);
      Object.assign(msg.usage, ev.usage || {});
    } else if (ev.type === 'message_stop') finished = true;
  }
  if (!finished || !msg.stop_reason) throw new Error('Stream ended early (no message_stop)');
  msg.content = msg.content.filter(Boolean);
  return msg;
}

// One Claude call. Returns { finalText, replyText, stopReason, searches, searchesOk, pagesOpened, openedUrls, rounds, usage }.
async function callClaude(body, apiKey) {
  const messages = body.messages.slice();
  const out = { finalText: '', replyText: '', stopReason: '', searches: 0, searchesOk: 0,
    pagesOpened: 0, openedUrls: [], rounds: 0, usage: [] };
  const allTexts = [];
  let finalTexts = [];
  for (let round = 0; round <= 5; round++) {          // the first request + at most 5 pause_turn continuations
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(Object.assign({}, body, { stream: true, messages: messages }))
    });
    const raw = await res.text();
    if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + raw.slice(0, 300));
    const msg = sseToMessage(raw);
    out.rounds++;
    out.stopReason = msg.stop_reason;
    out.usage.push(msg.usage);
    for (const b of msg.content) {
      if (b.type === 'text') { allTexts.push(b.text); finalTexts.push(b.text); continue; }
      if (b.type !== 'thinking' && b.type !== 'redacted_thinking') finalTexts = [];   // a tool block: earlier text was not the answer
      if (b.type === 'server_tool_use' && b.name === 'web_search') out.searches++;
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) out.searchesOk++;  // an error is an object, not a list
      if (b.type === 'web_fetch_tool_result' && b.content && b.content.type === 'web_fetch_result') {
        out.pagesOpened++;
        if (b.content.url) out.openedUrls.push(b.content.url);
      }
    }
    if (msg.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: msg.content });   // no "continue" message
  }
  out.finalText = finalTexts.join('');
  out.replyText = allTexts.join('');
  return out;
}
```

How to use it: `const call = await callClaude(requestBody, process.env.ANTHROPIC_API_KEY);`. Never put the key in a prompt or a log. If it throws (HTTP error, timeout, broken stream), keep the original and try the post again in a later run.

**Reading the answer.**
- Everything below is per call. The editor call, the audit call and the retry's editor call each have their own `callClaude` result, including that call's own `pause_turn` continuations. Never join text or add counts from two different calls.
- Feed `finalText` to the validator and to the audit filter: the text after the model's last search or page open. Text written between searches is the model talking to itself, not the answer. `replyText` (all text) is only for your log.
- `searches` = `server_tool_use` blocks named `web_search`. Web search is billed per search, so log it. `searchesOk` leaves out searches that returned an error: that is a `web_search_tool_result` whose `content` is an error object (for example `error_code` `max_uses_exceeded`) instead of a list. Tool errors do not raise; the API still returns HTTP 200. `usage.server_tool_use.web_search_requests` also reports searches; whether it counts failed ones is not verified.
- `pagesOpened` / `openedUrls` = page opens that returned a page and not an error. Use them for the research count (section 3).

| `stop_reason` | Meaning | What to do |
|---|---|---|
| `end_turn` | normal finish | go on |
| `pause_turn` | the server paused its tool loop (after 10 rounds) | `callClaude` continues by itself, at most 5 times. Still `pause_turn` after that → keep original. SDK tool runners do not do this for you. |
| `max_tokens` | the reply was cut off | keep original |
| `refusal` | the safety system declined | keep original |
| anything else, HTTP error, timeout | – | keep original; try the post again in a later run |

This applies to the editor call **and** the audit call. A paused or cut-off audit has no valid JSON, so it must never be passed to `filterAuditIssues` as if it were finished.

**Tested how?** `callClaude` was tested against a simulated stream built from the documented event format (thinking, searches, page opens, a failed search, a failed page open, `pause_turn`, citations), not against the live API. Before the first real run, do a dry run on one post and look at the log: `stopReason` `end_turn`, `pagesOpened` above 0, and `openedUrls` filled. If `openedUrls` stays empty while `pagesOpened` is above 0, the URL field has another name in real replies; that only makes the link check stricter. If you use the official SDK instead (its stream helper can return the final message), treat that as untested until you have checked the same things.

**Other providers** (OpenAI, Gemini and others): enable the provider's built-in web search tool, rebuild the whole answer, and use the research count rule in section 3.

## 5. WordPress side

- **Read raw content.** `GET /wp-json/wp/v2/posts/<id>?context=edit` (pages: `/wp-json/wp/v2/pages/<id>?context=edit`), logged in with an Application Password. Use `content.raw` and `title.raw`.
- **Gate.** If the reply is an error or has no `content.raw` string, stop the whole run. This usually means `?context=edit` is missing or the login failed. Never fall back to `content.rendered`: it has the block comments removed and the shortcodes expanded, so an edit of it would break the post. The validator cannot catch that, because it compares with whatever you gave it. If `content.raw` is empty, do not call the editor (see step 1).
- **Write back.** `POST /wp-json/wp/v2/posts/<id>` (pages: `/wp-json/wp/v2/pages/<id>`) with `{"content": "<result.html>"}`. Send only `content` (the Rank Math fields go in a second POST, below). Do not change status, date, slug or title. If `result.changed` is false, there is nothing to write.
- **Someone edited it meanwhile?** Just before writing, read the post again. If `modified_gmt` changed since step 1, do not write; try it in a later run.
- **Check the write.** Right after the POST, read the post again with `?context=edit` and compare `content.raw` with `result.html`, character for character. If they differ, WordPress changed the content while saving. Then POST `{"content": originalHtml}` back, log `write_mismatch` with both texts, and **stop the whole run**. A common cause (not verified in this project): the Application Password belongs to a user who may not post unfiltered HTML, so WordPress removes scripts, iframes or schema on save. Use the Application Password of an Administrator.
- **Revisions = your undo button.** Keep post revisions on (do not set `WP_POST_REVISIONS` to `false` or `0`). Every write makes a revision. To undo: open the post, Revisions, Restore. Also keep the original in your log.
- **Rank Math fields (optional)** are post meta: `rank_math_title`, `rank_math_description`, `rank_math_focus_keyword`. The core REST API only writes meta that is registered for REST. Use a connector/plugin that writes Rank Math fields, or a small snippet (for example with the Code Snippets plugin). Add `'page'` to the list if you edit pages too:

```php
add_action( 'init', function () {
    $keys = array( 'rank_math_title', 'rank_math_description', 'rank_math_focus_keyword', 'ai_edit_date', 'ai_edit_result' );
    foreach ( array( 'post' ) as $type ) {          // array( 'post', 'page' ) if you edit pages
        foreach ( $keys as $key ) {
            register_post_meta( $type, $key, array(
                'type'          => 'string',
                'single'        => true,
                'show_in_rest'  => true,
                'auth_callback' => function ( $allowed, $meta_key, $post_id ) { return current_user_can( 'edit_post', $post_id ); },
            ) );
        }
    }
} );
```

  Safe rules for these fields:
  - Write them only after the content write was checked (step 8), in a second POST: `{"meta": {"rank_math_title": "...", "rank_math_description": "..."}}`.
  - Title = META `seo_titles[0]`. Description = META `meta_description`. Focus keyword = META `focus_keyword`. Never use `seo_titles[1]`.
  - Fill a field only when the read in step 1 showed it and it was empty. If the key is missing from `meta`, your snippet is not working: write nothing.
  - Skip a field that got a `META_LENGTH` warning. The message tells you which one: `SEO title is ...` or `Meta description is ...`.
  - Skip a field that `safeSeoText` below returns as empty. It rejects `<`, `>`, `{`, `}`, `[`, `]`, `TODO`, `TBD`, and any number that is not in the article's visible text. The fact audit does not see these fields, so this is their only check.
  - After the POST, read the meta again. If the values are not there, log `meta_not_saved`. The article itself is fine.

```js
// V = require('./automation/validate-article.js'); visibleText is an internal helper of version 1.2.0
function safeSeoText(text, finalHtml) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || /[<>{}\[\]]|\bTODO\b|\bTBD\b/.test(t)) return '';
  const body = V._internal.visibleText(finalHtml);
  const numbers = t.match(/\d+(?:[.,]\d+)*/g) || [];
  return numbers.every(n => body.includes(n)) ? t : '';
}
```

- **Mark processed posts.** Keep your own list (a sheet or a database: site, post id, date, result). This list is required. Before picking a post, check the list. Right after each post, write its row. If the list cannot be read or written, stop the whole run, or the same posts get edited again and again. Do not write marks into WordPress for `keep_original`, `skip` or `empty` posts: a POST with only meta may also change the post's modified date (not verified). If you also want a mark in WordPress, add `ai_edit_date` and `ai_edit_result` to the Rank Math POST of a published post, and read it back.
- **When to try a post again.** Published posts: not again for 12 months. `keep_original`: once more after 30 days, then leave them. `skip`: never. `empty`: look again after 30 days. `write_mismatch`: never automatically. Why: each re-edit rewrites the text again, so over many runs the article drifts away from what you wrote, and you pay every time.

**Not verified in this project:** these are standard WordPress behaviour, but were not tested here: `title.raw`, the Application Passwords screen (Users → Profile), `modified_gmt`, `WP_POST_REVISIONS`, the Revisions screen, the snippet above (including the `auth_callback`), the Code Snippets plugin, meta writes over REST, and the pages endpoint. Try the whole flow once on a draft post first.

## 6. Using the validator

Run every command from the folder that contains the `automation` folder. Save your own script files in that same folder, so `require('./automation/validate-article.js')` and the file paths work.

**Command line** (Node 18 or newer, no packages needed). Use one folder per post, and start with an empty folder each time (delete it first if it exists), so files from an old run can never be mixed up:

```
node automation/validate-article.js --original work/123/original.html --output work/123/reply.txt --site tubetyre.com --searches 6 --faq auto --title "How to check tyre pressure" --last-checked auto --today 2026-09-27 --write-html work/123/final.html --report work/123/report.json
```

Keep the command on one line. That works in bash and in the Windows command prompt.

| Flag | Meaning |
|---|---|
| `--original` / `--output` | the raw original HTML / the editor's answer text, `finalText` (required) |
| `--site a.com,b.com` | your own domains; new links to them are removed (**required**, exit 1 without it) |
| `--searches N` | the research count from section 3; `0` = no research. Leave out only if unknown (then META `web_research_used` decides) |
| `--faq auto\|no` | same as the "Add new FAQ" setting |
| `--title "..."` | the post title; a title line at the top of the article is then an error (`TITLE_IN_BODY`) |
| `--last-checked yes\|no\|auto` | same as the "Last checked line" setting; with `no`, a new Last checked line is an error |
| `--today YYYY-MM-DD` | today's date; with `--searches 0`, adding today's date is an error |
| `--no-link-check` | **tests only.** New links are not opened, so dead and unchecked deep links stay in. Never use it in a real run |
| `--write-html out.html` | writes the cleaned article, only on publish |
| `--report report.json` | writes the full result, for your log |
| `--help` | shows the usage line |

- Exit codes: **0 publish**, **2 keep_original**, **3 skip**, **1 usage or file error** (for example a missing `--site`, or an output file that is also an input file).
- At the very start of every run, the `--write-html` and `--report` files are deleted, even when the arguments are wrong. So an old `final.html` never survives.
- **Publish only when the exit code is 0 and `final.html` exists.**
- If your tool treats a non-zero exit code as a failed step, set that step to continue on error and decide from the files only: publish only when `final.html` exists and `report.json` has `"action": "publish"`. Anything else = keep original.
- It prints the result as JSON (without the HTML).

**Audit filter.** It has no flag of its own. Run it with `node -e`. The four paths at the end are: the cleaned article, the audit reply, the original, and the output file. It deletes the old output first, writes the filtered audit, prints the verdict, and exits with 0 only on `pass`:

```
node -e "const V=require('./automation/validate-article.js'),fs=require('fs'),a=process.argv.slice(1);try{fs.unlinkSync(a[3])}catch(e){}const r=V.filterAuditIssues(fs.readFileSync(a[0],'utf8'),fs.readFileSync(a[1],'utf8'),{originalHtml:fs.readFileSync(a[2],'utf8')});fs.writeFileSync(a[3],JSON.stringify(r,null,2));console.log(r.effectiveVerdict);process.exitCode=r.effectiveVerdict==='pass'?0:2" work/123/final.html work/123/audit.txt work/123/original.html work/123/audit-result.json
```

Exit 0 = pass. Exit 2 = fix or reject (read `effectiveVerdict` and `retryIssues` in `audit-result.json`). Exit 1 = a file is missing, so keep original.

**JavaScript API.** Exports: `parseEditorOutput`, `findNewLinks`, `checkLinks`, `sanitizeLinks`, `validateArticle`, `filterAuditIssues`, `processEditorOutput`, `runSafetyGate`, `stripEndMarkers`, `runCli`, `ERROR_CODES`, `WARNING_CODES`, `DEFAULT_FORBIDDEN_LINK_DOMAINS`, `REDIRECT_LINK_DOMAINS`, `BOX_TYPES`, `VERSION`.

Steps 2 to 7 for one post. Paste `fillPrompt`, `retryText` (section 3) and `sseToMessage` + `callClaude` (section 4) into the same file. `s` holds your settings. It returns `publish` with the HTML to write, or `keep_original` or `skip`, and fills `log`:

```js
const fs = require('fs');
const V = require('./automation/validate-article.js');
const EDITOR_PROMPT = fs.readFileSync('./automation/article-editor-prompt.txt', 'utf8');
const AUDIT_PROMPT = fs.readFileSync('./automation/fact-audit-prompt.txt', 'utf8');
const webTools = n => [
  { type: 'web_search_20260209', name: 'web_search', max_uses: n },
  { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: n }
];

// s = { title, focusKeyword, reader, sites: ['tubetyre.com'], today: '2026-09-27', faq: 'auto', lastChecked: 'auto' }
async function editOnePost(originalHtml, s, log) {
  const key = process.env.ANTHROPIC_API_KEY;
  let extra = '';
  for (let attempt = 1; attempt <= 2; attempt++) {          // the first try + ONE retry
    const editorPrompt = fillPrompt(EDITOR_PROMPT, {
      'Post title (H1, set in WordPress):': s.title,
      'Focus keyword:': s.focusKeyword,
      'Target reader / country:': s.reader,
      'Site domain(s) (comma-separated):': s.sites.join(', '),
      "Today's date (YYYY-MM-DD):": s.today,
      'Web search available (yes / no; default: no):': 'yes',   // 'no' only if you remove the tools
      'Add new FAQ (auto / no; default: auto):': s.faq,
      'Last checked line (yes / no / auto; default: auto):': s.lastChecked,
      'Extra instructions:': extra
    }, { article_html: originalHtml });
    const edit = await callClaude({ model: 'claude-opus-5', max_tokens: 64000, thinking: { type: 'adaptive' },
      output_config: { effort: 'high' }, tools: webTools(20),
      messages: [{ role: 'user', content: editorPrompt }] }, key);
    log.push({ attempt, step: 'editor', stopReason: edit.stopReason, rounds: edit.rounds, searches: edit.searches,
      searchesOk: edit.searchesOk, pagesOpened: edit.pagesOpened, openedUrls: edit.openedUrls, usage: edit.usage });
    if (edit.stopReason !== 'end_turn') return { action: 'keep_original' };

    const result = await V.processEditorOutput(originalHtml, edit.finalText, {
      siteDomains: s.sites, webSearchCount: edit.pagesOpened, verifiedUrls: edit.openedUrls,
      allowNewFaq: s.faq !== 'no', postTitle: s.title, lastCheckedLine: s.lastChecked, today: s.today
    });
    log.push({ attempt, step: 'validate', action: result.action, meta: result.meta, errors: result.errors,
      warnings: result.warnings, removedLinks: result.removedLinks, changedLinks: result.changedLinks,
      linkResults: result.linkResults, stats: result.stats });
    if (result.action === 'skip' && attempt === 1) return { action: 'skip' };
    if (result.action !== 'publish') return { action: 'keep_original' };

    const auditPrompt = fillPrompt(AUDIT_PROMPT, {
      "Today's date (YYYY-MM-DD):": s.today,
      'Web search available (yes / no; default: no):': 'yes'
    }, { original_html: originalHtml, edited_html: result.html });
    const check = await callClaude({ model: 'claude-opus-5', max_tokens: 16000, thinking: { type: 'adaptive' },
      output_config: { effort: 'high' }, tools: webTools(10),
      messages: [{ role: 'user', content: auditPrompt }] }, key);
    log.push({ attempt, step: 'audit call', stopReason: check.stopReason, rounds: check.rounds,
      searches: check.searches, pagesOpened: check.pagesOpened, usage: check.usage });
    if (check.stopReason !== 'end_turn') return { action: 'keep_original' };

    const audit = V.filterAuditIssues(result.html, check.finalText, { originalHtml: originalHtml });
    log.push({ attempt, step: 'audit', audit: audit });
    if (audit.effectiveVerdict === 'pass') {
      return { action: 'publish', html: result.html, changed: result.changed, meta: result.meta, warnings: result.warnings };
    }
    if (audit.effectiveVerdict !== 'fix') return { action: 'keep_original' };
    extra = retryText(audit.retryIssues);                   // used only on the second try
  }
  return { action: 'keep_original' };
}

// A normal .js file needs this wrapper for "await"; an n8n Code node allows await directly.
(async () => {
  const log = [];
  const out = await editOnePost(originalHtml, settings, log);   // originalHtml = content.raw from step 1
  // save log; if out.action === 'publish' and out.changed, do step 8 (section 5)
})();
```

Options for `processEditorOutput` (and `validateArticle`):

| Option | Default | Meaning |
|---|---|---|
| `siteDomains` | – | your domains. **Required.** If missing, it is guessed from the original's upload links (warning `SITE_DOMAINS_INFERRED`); if that finds nothing, the result is `CONFIG_MISSING` and the original is kept |
| `webSearchCount` | `null` | the research count (section 3); `0` = no research, `null` = unknown (META `web_research_used` decides) |
| `verifiedUrls` | `[]` | pages you know were opened (`edit.openedUrls`). A new deep link that our link check could not reach (401, 403, 429, timeout, no fetch) is kept only when it is on this list |
| `allowNewFaq` | `true` | `false` when "Add new FAQ: no" |
| `postTitle` | `''` | catches a title line at the top (`TITLE_IN_BODY`) |
| `lastCheckedLine` | `'auto'` | `'yes'`, `'no'` or `'auto'`; `'no'` blocks a new Last checked line |
| `today` | `''` | `'YYYY-MM-DD'`; with research count `0`, adding today's date is blocked |
| `checkLinks` | `true` | `false` = do not open new links. **Tests only** (dead and unchecked deep links then stay in) |
| `fetchFn` | global `fetch` | your own fetch function (below) |
| `webSearchAllowed` | – | browser mode, instead of `webSearchCount`: `false` = no research (same as `0`, and it wins over a count), `true` = unknown or some research |
| `endMarker` / `requireEndMarker` | `''` / `false` | e.g. `'APU-END'`: `<!-- APU-END -->` comments are removed before the comparison; with `requireEndMarker: true` an edit without one is `END_MARKER_MISSING` (cut off) |
| `linkTimeoutMs` / `linkConcurrency` | `10000` / `4` | link check timeout and parallel requests |
| `forbiddenLinkDomains` | the default list | replaces the default list; to add sites, use `V.DEFAULT_FORBIDDEN_LINK_DOMAINS.concat(['somecouponsite.com'])`. Short-link and redirect hosts (`REDIRECT_LINK_DOMAINS`) are always removed anyway |
| `minWordRatio` / `maxWordRatio` / `minRetention` | `0.8` / `5` / `0.75` | limits for `CONTENT_LOSS`, `WORD_RATIO_EXTREME` and `CONTENT_RETENTION` |

The result has: `action` (`publish`, `keep_original`, `skip`), `html` (the cleaned edit on publish, else the original), `changed` (false = nothing to write), `candidateHtml`, `meta`, `errors`, `warnings`, `removedLinks` (`{url, reason}`), `changedLinks` (links with tracking parts cut), `linkResults`, `stats` (including `wordRetention`).
`filterAuditIssues` returns the audit with `verdict`, `effectiveVerdict`, `issues` (kept), `dropped` (quote not in the article), `retryIssues`, `blocking` (true unless `effectiveVerdict` is `pass`) and `valid` (false = not JSON).

**Browser extension (`runSafetyGate`).** The Chrome extension (Auto Post Updater Pro) ships this file byte-identical as `extension/safety-gate.js` and loads it with `importScripts`; it then finds everything in one global object, `self.SafetyGate` (`VERSION`, `runSafetyGate`, `stripEndMarkers`, `filterAuditIssues`, `validateArticle`, `sanitizeLinks`, `checkLinks`, `findNewLinks`, `ERROR_CODES`, `WARNING_CODES`). A chat website gives no META, so it calls `runSafetyGate(referenceHtml, aiHtml, options)` on the extracted article: end markers removed, new links found, checked (`checkLinks`, `fetchFn`), cleaned, then `validateArticle`. It never throws and resolves to `{ ok, html, errors, warnings, removedLinks, linkResults, stats, changedLinks, candidateHtml, changed }`. Save `html` only when `ok` is true (it is then the cleaned, marker-free edit); when `ok` is false, `html` is the reference and nothing may be saved. After a copy, `node --test automation/test/` checks that the two files are still identical.

**Link results.**
- `ok` (2xx/3xx) = kept. But it counts as dead when a deep link lands on the site's homepage (a hidden "not found") or on a domain-parking page. It is removed with reason `redirect` when it lands on another site.
- `dead` (404, 410, 5xx, DNS failure, connection refused, certificate error) = removed, and its Sources item is removed too.
- `unknown` (401, 403, 429, timeout, other) = a homepage is kept; a deep link is removed (reason `unverified`) unless it is in `verifiedUrls`.
- No fetch function at all = every deep link not in `verifiedUrls` is removed, homepages stay (warning `LINK_CHECK_UNAVAILABLE`). Every link `unknown` = warning `LINK_CHECK_INCONCLUSIVE` (check the network or firewall).

**Your own fetch function.** Any function that takes `(url, {method, redirect, headers, signal})` and returns (or resolves to) an object with a numeric `status` (or `statusCode`). Also return `url` = the final address after redirects if you can; that is how redirects to the homepage or to another site are found:

```js
async function myFetch(url, init) {
  // init.method is 'HEAD' or 'GET'; init.redirect is 'follow'; init.signal can abort the request
  const res = await yourHttpClient(url, init.method);   // must follow redirects
  return { status: res.statusCode, url: res.finalUrl };
}
// processEditorOutput(originalHtml, text, { ..., fetchFn: myFetch })
```

If a request fails, throw an Error. Give it `code = 'ENOTFOUND'` or `'ECONNREFUSED'` when you know it, so the link counts as dead. An error with `response.status` (like axios) is read as that HTTP status. Other errors count as unknown. The timeout works even if your function ignores `signal`.

**n8n and similar tools.** Paste the whole `validate-article.js` at the top of a Code node, then call the functions below it (`processEditorOutput` is async; Code nodes allow `await`). If the Code node has no `fetch`, pass a `fetchFn`; otherwise every new deep link is removed (safe, but you lose good links). `callClaude` also needs `fetch`. If your Code node does not have it, run your script with Node instead (on self-hosted n8n, for example with an Execute Command node). A tool that cannot run JavaScript at all cannot run this pipeline safely. These n8n details were not tested in this project; try them on one post first.

**Tests:** `node --test automation/test/`. For extra safety after you change the validator: `node automation/test/mutation-check.js --run` (takes a few minutes).

## 7. If an AI agent does the work

For example Claude Code or Cowork with a WordPress MCP connector. The agent must follow the same gates:

1. Read the post in raw (edit) form, with block comments and shortcodes. If the connector only gives rendered HTML, or no raw content, do not edit that post. If that happens for every post, stop.
2. Start with an empty folder `work/<post-id>/` (delete it first if it exists). Save the raw content unchanged to `work/<post-id>/original.html`.
3. Edit it by following `article-editor-prompt.txt` (SETTINGS filled). Save the **whole answer, with the markers**, to `work/<post-id>/reply.txt`. Count the web pages you really opened and read for this post (search results do not count; if unsure, `0`).
4. Run the validator with every flag. `--site` is required:
   `node automation/validate-article.js --original work/<post-id>/original.html --output work/<post-id>/reply.txt --site <your domains> --searches <pages opened> --faq <auto or no> --title "<post title>" --last-checked <auto, yes or no> --today <YYYY-MM-DD> --write-html work/<post-id>/final.html --report work/<post-id>/report.json`
5. Only if the exit code is 0 and `final.html` exists: run the fact audit with `fact-audit-prompt.txt` (two SETTINGS lines), `original.html` and `final.html`. A fresh session or subagent that did not write the edit is best. It needs web access if the editor had it; if it has none, the editor must also run with `Web search available: no`. Save its reply to `work/<post-id>/audit.txt` and run the audit filter from section 6 with the `work/<post-id>/` paths.
6. Only if the filter printed `pass`: update the post with the exact content of `final.html`. Never retype it or "fix" it by hand. Then read the post again; if the raw content differs from `final.html`, restore `original.html` and stop.
7. If the filter printed `fix` (first try only): one retry. Edit `original.html` again in a new folder `work/<post-id>/try2/`, with `retryIssues` from `audit-result.json` in "Extra instructions" (section 3). Then steps 3–6 again with the `try2/` paths and new counts. Any other result: do not touch the post.
8. Save the files as the log and mark the post (section 5).

## 8. Logging

For every post and run, save: site, post id, date, model, and for each call its `stopReason`, `rounds`, `searches`, `searchesOk`, `pagesOpened`, `openedUrls` and `usage`; the META JSON; the validator report (`--report` file or the `processEditorOutput` result); the filtered audit (with `dropped` and `retryIssues`); whether a retry happened; the write check result; the final action; and a copy of the original. A folder per day, a database or a spreadsheet row with the JSON is enough. META `notes` (plugin block suggestions, broken-looking old links, missing affiliate disclosure) are only logged.

Optional, if you ever have 10 minutes:
- **Weekly:** look at the `keep_original` list and count the error codes and stop reasons. One code on many posts means a setup problem, not bad articles. For example:
  - `originalHtml` has no `<!-- wp:` although the site uses the block editor → you are reading rendered content (step 1 is wrong).
  - Many `stop_reason` `max_tokens` → the articles are too long for one answer.
  - `CONFIG_MISSING` or `SITE_DOMAINS_INFERRED` → you are not passing `--site` / `siteDomains`.
  - `LINK_CHECK_UNAVAILABLE` or `LINK_CHECK_INCONCLUSIVE` on most posts → the link check has no working internet, and good deep links are being removed.
  - `LAST_CHECKED_WITHOUT_RESEARCH` or `NEW_NUMBER_WITHOUT_RESEARCH` although web search is on → `pagesOpened` is 0, so page opening (web fetch) is not working.
  - `STRAY_TEXT`, `MARKDOWN` or `PARSE_MISSING_MARKER` often → the model is chatting instead of following the output format.
  - `CONTENT_RETENTION` or `CONTENT_LOSS` often → the model drops parts of long articles.
  - Many dropped high audit issues → the auditor does not copy its quotes exactly.
- **Spot-check:** open 1 in 20 published posts and compare the last two revisions in WordPress.

## 9. Error and warning codes

Any **error** means keep original. **Warnings** are only logged.

| Group | Error codes |
|---|---|
| Reading the answer, setup | `PARSE_MISSING_MARKER` (a marker is missing, or the answer was cut off), `PARSE_META_JSON` (META unreadable or without `status`), `PARSE_EMPTY_HTML` (status `edited` but no HTML), `CONFIG_MISSING` (no site domain), `INTERNAL_ERROR` (the validator crashed), `END_MARKER_MISSING` (browser mode: the required `<!-- APU-END -->` is missing, so the reply was cut off) |
| Images and media | `IMG_COUNT`, `IMG_CHANGED` (an image changed apart from its alt text, or moved under another heading), `MEDIA_COUNT`, `MEDIA_CHANGED` (a video, iframe, source, embed, ad or form tag changed), `ELEMENT_COUNT` (form, button, ad count), `EMBED_URL_MISSING` (a video or post embed URL line changed or gone), `MEDIA_BLOCK_CHANGED` |
| Shortcodes, blocks, scripts | `SHORTCODE_MISSING`, `SHORTCODE_ADDED` (new shortcode or `[bracket]` text), `PLUGIN_BLOCK_CHANGED`, `BLOCK_MARKUP_MISMATCH` (a heading level or list type does not match its block comment), `BLOCK_COMMENTS_IN_CLASSIC`, `BLOCK_UNBALANCED`, `SCRIPT_CHANGED`, `SPECIAL_COMMENT_MISSING` (`<!--more-->`, `<!--nextpage-->`), `MALFORMED_COMMENT`, `JSONLD_INVALID`, `JSONLD_TYPE` |
| Links and ids | `LINK_MISSING`, `LINK_ATTR_CHANGED` (`rel="nofollow"`, `sponsored` or `ugc` dropped), `ID_MISSING`, `NEW_INTERNAL_LINK`, `BAD_NEW_LINK` |
| HTML shape | `FORBIDDEN_TAG` (new h1, style, script, input and similar), `FIRST_ELEMENT_NOT_P`, `TITLE_IN_BODY`, `HEADING_ORDER`, `TAG_UNBALANCED`, `STRAY_TEXT` (chat text such as "Here is the edited article"), `MARKDOWN` (markdown or citation marks), `CODE_FENCE`, `PLACEHOLDER` (`{{`, `[VERIFY`, `TODO:`, `[Your Name]`, `example.com` and similar, also inside schema), `OMISSION_MARKER` ("rest unchanged" notes) |
| Amount of text | `CONTENT_LOSS` (under 80% of the words), `CONTENT_RETENTION` (under 75% of the original's words still there; originals of 100+ words), `WORD_RATIO_EXTREME` (over 5 times longer; very short articles may grow to about 600 words), `DUPLICATE_CONTENT`, `TABLE_LOSS` (fewer `<table>` or `<tr>` than the original) |
| Prompt rules | `BOX_DUPLICATED` (second Quick Answer, Key Takeaways or At a Glance), `SECTION_DUPLICATED` (second FAQ, Sources list or Last checked line), `NEW_FAQ_NOT_ALLOWED`, `LAST_CHECKED_NOT_ALLOWED`, and three that apply only when the research count is 0: `LAST_CHECKED_WITHOUT_RESEARCH` (new Last checked line, "updated/verified" wording, or today's date), `NEW_NUMBER_WITHOUT_RESEARCH` (new price, percentage or year), `NUMBER_MISSING` (a price, percentage or year of the original is gone) |

Warning codes: `AI_PHRASE`, `WORD_RATIO_HIGH`, `BOX_LIMIT`, `FAQ_SCHEMA_MISMATCH`, `META_LENGTH` (`SEO title is ...` or `Meta description is ...`), `META_JSON_INVALID` (META broken but its status readable; research then counts as not used), `NEW_CONCLUSION`, `EMOJI_ADDED`, `LINK_IN_HEADING`, `DUPLICATE_NEW_LINK`, `SOURCES_MISMATCH`, `NEW_HTML_COMMENT`, `LINK_CHECK_UNAVAILABLE`, `LINK_CHECK_INCONCLUSIVE`, `SITE_DOMAINS_INFERRED`, `LIST_LOSS` (over 30% of the list items gone), `CLASSIC_CONVERSION` (a block-editor original came back with no block comments at all; `MEDIA_BLOCK_CHANGED` and `BLOCK_UNBALANCED` are then skipped, `PLUGIN_BLOCK_CHANGED` still applies).

## 10. Cost and safety tips

- Always set `max_uses` for web search and web fetch. Each search is billed on top of the tokens.
- Always set `max_tokens` (64000 for the editor, 16000 for the audit) and at most 5 `pause_turn` continuations.
- One retry per post, at most. Never loop until it passes.
- Process a fixed number of posts per run (start with 5–10), one post at a time per site. Never run two copies of the automation at once.
- Start with a dry run: do everything except the WordPress write, and read the logs.
- Stop the whole run when something looks broken; do not keep paying:
  - 5 posts in a row end as `keep_original`;
  - 3 posts in a row end as `skip` or `empty`;
  - a post has no `content.raw`, or WordPress refuses the login;
  - a write check fails (`write_mismatch`);
  - your list of processed posts cannot be read or written.
- Mark every processed post (section 5). Never edit the same post again and again.
- Keep revisions on, and keep the original in your log.

## 11. Files in this folder

- `article-editor-prompt.txt`: the editor prompt (automation edition of Prompt 2). Fill its 9 SETTINGS lines and `<article_html>`.
- `fact-audit-prompt.txt`: the second-AI fact check. Fill its 2 SETTINGS lines, `<original_html>` and `<edited_html>`.
- `validate-article.js`: all code checks (parse, link check, link cleaning, validate, audit filter). Command line or `require()` or paste. Version 1.2.0. The browser extension uses a byte-identical copy (`extension/safety-gate.js`).
- `test/run-tests.test.js`: tests for every error and warning code (`node --test automation/test/`).
- `test/mutation-check.js`: checks that the tests notice when a safety rule is weakened (`node automation/test/mutation-check.js --run`).
- `test/package.json`: lets `node --test automation/test/` work on Node 22 and newer.
- `test/fixtures/`: sample originals (`original-block.html`, `original-classic.html`) and good editor replies (`edited-good.txt`, `edited-classic-good.txt`).
- `README.md`: this guide.
