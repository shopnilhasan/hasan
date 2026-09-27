# Auto Post Updater Pro v3.46.0 — Safety Gate

Nobody reads your posts before they go live.
So from v3.46.0 the extension checks every AI edit **before** it saves anything.
If a check fails, the post is **not changed**. The original stays live.
The row goes to **❌ Failed posts** with the reason.

## 1. What is new in v3.46.0

- **Safety Gate.** Code compares the AI edit with the original article.
  It blocks the edit when images, tables, links, shortcodes, blocks or a big part of the text are lost,
  when the reply was cut off, or when chat text, Markdown or placeholders got into the article.
- **Link test.** Every new link the AI added is opened once.
  A dead link is removed. Its words stay in the text.
- **Two rule sets.** Prompts written for the Safety Gate get every check.
  Your older prompts get the structure checks. Their price and date checks are dropped
  only while the AI fact check is on and keeps the original when it breaks (see section 4.1).
- **Retries say why.** When the batch retries a blocked post by itself,
  the new chat is told why the last edit was rejected (see section 5).
- **AI fact check.** After the Safety Gate passes, a **new** chat compares the original and the edit.
  It looks for wrong facts, made-up details, lost information and risky advice.
  If it finds a problem, the AI gets **one** chance to fix it in another new chat.
  The fixed edit goes through the Safety Gate and the fact check again.
  Only an edit that passes is saved.
  For an older prompt (no end marker) the fact check also gets that prompt, so the removals it names
  (for example "remove specific price claims") are not reported as problems (section 3, "Affiliate posts").
- **Web search per prompt.** Each prompt has a new tick box: "🌐 Allow AI web search with this prompt".
- **New prompt type** "Fact check (2nd AI round)".
- **Two ready prompts** are added once when you open the panel:
  "Informational Editor (Safety Gate)" and "Fact Check (Safety Gate)".
  Your own prompts and your default prompt are not changed.
- **Prompt placeholders.** The extension fills these in when a prompt has them:
  `[[TODAY]]`, `[[SITE_DOMAIN]]`, `[[WEB_SEARCH]]`, `[[NEW_FAQ]]`, `[[POST_TITLE]]`.
  A prompt without them is sent exactly as before.
- **Clear reasons.** Failed rows show badges such as "🛡 Gate: IMG_COUNT" or "🔎 Fact check".
  Click a row to see every reason and a link to the fact-check chat.
  The CSV export has a new column "Gate reasons".
- **Bug fixes** (also with the Safety Gate off):
  - A post that starts or ends with a shortcode (`[toc]`, `[related_posts]`) is no longer cut.
  - The words "fixed article" inside a sentence no longer cut the article.
    (With the Safety Gate on, such an article is also no longer refused.)
  - The log box kept stopping (a panel error). Fixed.
  - A post no longer hangs when Chrome asks for clipboard permission.
  - Parallel runs no longer lose original-HTML backups.
  - ChatGPT agent mode is switched off like deep research.
  - An AI usage limit in a parallel run now pauses the batch.

With the Safety Gate **off**, the extension works like v3.45.0, plus the bug fixes above.

## 2. Install or update

**Update (keeps everything).** Your sites, AIs, prompts, settings and history stay.

1. Optional but wise: open the panel, tab **💾 Backup**, click **⬇ Export Backup**.
2. Stop any running batch.
3. Unzip the new version. Copy all its files **into the same folder** Chrome loads now.
   Replace the old files.
4. Open `chrome://extensions`. On "Auto Post Updater Pro" click the reload icon (↻).
   It should now say version 3.46.0.
5. Open the panel. The two new prompts appear once.

Important: Chrome ties your data to the folder.
If you use **Load unpacked** on a **different** folder, Chrome sees a new extension with no settings.
Then use **⬆ Import Backup**. Do not click **Remove** on the old one before you have a backup.

**New install.** Unzip. Open `chrome://extensions`. Switch on **Developer mode**.
Click **Load unpacked** and pick the folder that holds `manifest.json`.

## 3. Recommended setup for ChatGPT

**Run tab → 🛡 Safety Gate**

| Setting | Choose |
|---|---|
| Safety Gate | On |
| Test new links | On |
| New FAQ section | Auto (or No if you never want a new FAQ) |
| Your other domains | Your other sites, if the posts link to them. Your WordPress site is always included. |
| Fact check | On |
| AI for the fact check | Same AI as the run |
| Fact-check prompt | Fact Check (Safety Gate) |
| If the fact check itself breaks | Keep the original — do not save (safest) |

**Which prompt**

- **Informational posts** (how-to, guides, explainers): run the prompt **"Informational Editor (Safety Gate)"**.
  Web search is already allowed for it (you see "WEB SEARCH" next to its name). Keep it that way.
  It was written for the Safety Gate: it ends its reply with `<!-- APU-END -->`,
  so a cut-off reply is always caught.
- **Affiliate posts**: keep your own affiliate prompts (for example the built-in "Single Amazon Product").
  They have no end marker, so the Safety Gate checks them with its **structure rules** (section 4.1).
  The Start box shows a note about this. That is expected.
  With the fact check **On** and "Keep the original" when it breaks (the recommended setup above),
  removing a price, adding a "Last updated" line or adding a new link to a live page is **not** blocked by code;
  the fact check reads those changes.
  The fact check also gets your affiliate prompt (and any PRIORITY FIX note sent with it), in a block called
  "EDITING INSTRUCTIONS THE EDITOR FOLLOWED". These changes are then accepted:
  - removing a kind of content the prompt names (the Amazon prompt says "Remove specific price claims",
    so removed prices are fine);
  - a "Last updated" line with today's date (or this month and year);
  - moving, merging or renaming sections, as long as their information stays.

  The fact check still blocks, after its one fix round:
  - lost facts, figures, steps, warnings or examples that the prompt does not name. General permissions such as
    "rewrite freely", "shorten", "remove outdated or unnecessary information" or "rewrite claims you can't verify"
    never excuse a loss, and neither does a PRIORITY FIX note;
  - a new or changed price, spec, rating or other fact it cannot confirm, even when the prompt asked for it
    (when web search is off for the prompt, the fact check has no web search either and can confirm almost none);
  - wording that says facts were checked (such as "Reviewed for accuracy" or "Fact-checked") that it cannot confirm.
    The built-in Amazon prompt adds "Reviewed for accuracy", so with web search off its edits often get a fix round,
    and end as FACT CHECK BLOCKED when the fix round keeps that wording;
  - contradictions inside the edit (also in boxes the prompt asked for), dropped or weakened warnings,
    lost images, links, products or tables, and invented "I tested" claims.

  Prompts longer than 30,000 characters are shortened in the middle for the fact check (start and end kept).
  The block is sent only when the fact-check prompt describes it (its text names
  "EDITING INSTRUCTIONS THE EDITOR FOLLOWED", as `prompts/fact-check.txt` does).
  If you installed an earlier 3.46.0 build, your "Fact Check (Safety Gate)" prompt has an older text that does not.
  When you open the panel, a copy you never edited is replaced with the new text by itself.
  A copy you edited, or your own fact-check prompt, is kept: then your affiliate prompt is **not** sent with the
  fact check, removed prices are usually reported, and the Start box and the log say so.
  Paste the text of `prompts/fact-check.txt` into that prompt to change this.
  With the fact check **Off**, or set to "Save the edit anyway", nothing else would stop a made-up price,
  so the code keeps its price and date rules: such an edit is then **blocked** (when web search is off for the prompt).
  Lost images, tables, links, shortcodes, blocks or text are always blocked.
- Optional, for your own prompts: add this sentence to the output part of the prompt:
  "The last line inside the code block must be `<!-- APU-END -->`."
  Then a cut-off reply is caught for those prompts too. The marker is never saved to WordPress.
  But the prompt then counts as a Safety Gate prompt and gets **all** rules (section 4.1),
  including the no-research rules when web search is off. Only do this for prompts that follow those rules.
  If many posts then fail with END_MARKER_MISSING, remove the sentence again.

**In ChatGPT**

- Log in in the same Chrome profile.
- Use a model that can search the web (for the informational prompt).
- The extension switches off Deep research and Agent mode by itself. Normal web search stays on
  when the prompt allows it.
- Optional: switch off ChatGPT memory, so old chats do not mix into the fact check.

**First run**

1. Click **🧪 Test First Post**. Read the log. Lines with 🛡 are the Safety Gate. Lines with 🔎 are the fact check.
2. Then run a small batch (5 posts). Look at the Failed box before you run more.

## 4. What happens to each post

1. The AI edits the post in a chat (as before).
2. The **Safety Gate** compares the edit with the original.
   The original is the version from before this run changed anything.
3. New links are tested. Bad ones are removed. The words stay.
4. The **fact check** runs in a new chat. It answers pass, fix or reject.
5. "fix": one fix round. The AI edits the **original** again, in a new chat, with the problems listed.
   Then steps 2–4 again.
6. Only when everything passes is the post saved to WordPress.

Each post now takes longer: one more chat, sometimes two.
The fact check uses the same "AI response timeout" as the edit.

### 4.1 Which rules apply (per prompt)

The extension looks at the run prompt. A prompt that contains `APU-END` (it asks for the `<!-- APU-END -->` end marker)
is a **Safety Gate prompt**, like "Informational Editor (Safety Gate)". Every other prompt is an **older prompt**.
The log says which rule set was used, on a line with "🛡 Gate rules".

| | Safety Gate prompt | Older prompt (no end marker) |
|---|---|---|
| Images, media, tables, links, shortcodes, blocks, scripts | checked | checked |
| Chat text, Markdown, placeholders, "rest unchanged" notes | checked | checked |
| Lost text (CONTENT_LOSS: at least 80% of the words) | checked | checked |
| Rewritten text (CONTENT_RETENTION) | at least 75% of the original words kept | at least 60% kept (older "audit + fix" prompts rewrite more) |
| New links | tested; dead, private, internal or forbidden links removed | the same |
| Cut-off reply (END_MARKER_MISSING) | checked: the marker must be the **last line** of the reply. A marker at the top or in the middle counts as missing | not possible (no marker); the older completeness check catches most cut-offs |
| No-research rules, when web search is **off** for the prompt: no new or removed prices, percentages or years, no new "Last checked" / "updated" line or today's date, new deep links removed | checked | **not checked** while the fact check is On and keeps the original when it breaks; **checked** when the fact check is Off or set to "Save the edit anyway" |
| Older completeness check | its length part (85%) can be skipped, see below; its other parts stay | as before |

**Why.** Older affiliate prompts change prices and dates on purpose (for example the Amazon prompt removes prices
and adds a "Last updated" line). With the strict no-research rules almost every such post would fail.
So the code leaves these changes to the AI fact check, but only while that fact check keeps the original when it breaks.
The fact check gets the prompt and accepts the removals it names (section 3, "Affiliate posts").
Without such a fact check nothing else would catch a made-up price, so the code keeps checking.
The log line "🛡 Gate rules" says "structure rules" or "structure rules + research rules".

**The rules follow the prompt that wrote the reply.** "↻ Retry AI session", "↻ Recover any code", the automatic
HTML recovery and the Fast Submit recovery read an old chat. That chat is judged by the prompt it was sent with,
not by the prompt you have selected now. A recovered reply that contains `<!-- APU-END -->` is always judged
as a Safety Gate reply. "Recover any code" never skips the end-marker rule for such a reply.

**Completeness and the end marker.** The older completeness check wants at least 85% of the original length.
Cleaning up messy code (such as `<span style="...">` leftovers from Word or Google Docs) can make a complete edit shorter.
So, with the Safety Gate on and a Safety Gate prompt, a reply is not refused for its **length alone** when all of these are true:

- the reply **ends** with `<!-- APU-END -->` (its last line);
- at least 85% of the original's **readable text** is still there (tags, comments and schema do not count, so removed clutter does not matter, lost paragraphs do);
- the original's **last section** is still there. The last section is the original's last H2/H3 heading or
  FAQ question (for example "Conclusion", or the last question of an FAQ), with the text under it.
  It counts as there when one of these is true:
  - its heading or question is still a heading (or an FAQ accordion question) of the reply, with text under it;
  - it is a concluding section ("Conclusion", "Final Thoughts", "The Bottom Line" ...) and the reply's last section
    (a Sources list aside) has a new concluding heading, with text under it ("Conclusion" renamed "Final Thoughts");
  - its own wording is still near the end of the reply: at least three runs of six words that appear nowhere
    earlier in the original (the heading was reworded, the text kept). Words in a Key Takeaways, Quick Answer
    or At a Glance box do not count.

  One shared word is not enough. Entities such as `&nbsp;` (common in Word / Google Docs text) count as plain text.

Otherwise the reply is refused as before, and the reason says why, for example
"not waived for the <!-- APU-END --> end marker: the last section ("Conclusion") of the original is missing".
A reply that stops before the original's last section and then writes the end marker is refused this way.
All other completeness checks always stay. The Safety Gate also counts the words (CONTENT_LOSS, CONTENT_RETENTION).
The log says "accepted because it ends with the <!-- APU-END --> end marker" when the length part was skipped.

## 5. Why a post failed, and what to do

The live post is always the original. Nothing is broken.
Open the row in **❌ Failed posts** to see the reason.

**General rules**

- **Automatic retries tell the AI why.** When "If a post fails" retries a post by itself
  ("retry right away", "retry at the END of the batch", parallel runs, or the fallback AI) after SAFETY GATE BLOCKED or FACT CHECK BLOCKED,
  the new chat gets a short **PRIORITY FIX** note at the end of the prompt, for example:
  "Your previous edit of this exact article was REJECTED by the automatic Safety Gate ... IMG_COUNT — Image count changed:
  original 2, edited 1. Keep every image of the original exactly as it is ...".
  Each retry gets the reasons of the **last** Safety Gate or fact-check block (at most about 3,000 characters).
  A failure in between that has no reasons of its own (a timeout, no code box, FACT CHECK ERROR) keeps that note
  ("↻ The retry keeps the previous PRIORITY FIX note"); before any block there is no note.
  When the fact check's fix round is blocked by the Safety Gate, the note lists the gate reasons **and** the fact-check problems.
  Fast Submit (phase 1) never adds a note. A post's note is forgotten once the post is saved or its last retry is done.
  The log shows "↻ The retry tells the AI why the previous edit was rejected".
  If the AI copies the note into the article, the edit is blocked with PROMPT_ECHO: a sentence of the note,
  a gate code name such as NUMBER_MISSING, or the words "PRIORITY FIX", in the text or in an image's alt text.
- A real AI mistake: click **↻ Retry new** on the row. It starts a new chat and tells the AI what went wrong.
- **↻ Retry AI session** and **↻ Recover any code** read the **same** reply again.
  They are only useful after you changed a setting (for example you allowed web search).
- Many posts fail with the **same** reason: change the setup (see the table).
- Some posts cannot be improved safely. Then the original simply stays live. That is fine.

### 5.1 SAFETY GATE BLOCKED

The message looks like: `SAFETY GATE BLOCKED: IMG_COUNT, LINK_MISSING — ... The post was NOT changed.`

**The reply**

| Code | What it means | What to do |
|---|---|---|
| END_MARKER_MISSING | The reply did not end with `<!-- APU-END -->`: the marker is missing, or it is somewhere else than the last line. The reply was cut off, or the AI ignored the format. | Retry new. If it happens a lot with long posts, the reply is too long for one message. Try another model. |
| PROMPT_ECHO | The AI copied its PRIORITY FIX note (the reasons of an earlier rejection) into the article: a sentence of the note, a code name such as NUMBER_MISSING, or the words "PRIORITY FIX" (in the text, or in alt / title text). | Retry new. |
| PARSE_EMPTY_HTML | No article HTML was found. | Retry new. |
| STRAY_TEXT | Chat text got into the article ("Here is the edited article", "Hope this helps"). | Retry new. |
| MARKDOWN | Markdown (`**bold**`, `## heading`) or ChatGPT citation marks (like `citeturn0search3`) in the article. | Retry new. |
| CODE_FENCE | Code fences (```) in the article. | Retry new. |
| PLACEHOLDER | Placeholders such as `{{...}}`, `[VERIFY]`, `TODO:`, `[Your Name]`, `example.com`. | Retry new. |
| OMISSION_MARKER | Notes like "rest unchanged" instead of the real text. | Retry new. |

**Images and media**

| Code | What it means | What to do |
|---|---|---|
| IMG_COUNT | An image was removed or added. | Retry new. |
| IMG_CHANGED | An image changed (address or attributes), or moved to another section. New alt text is fine. | Retry new. |
| MEDIA_COUNT, MEDIA_CHANGED | A video, iframe, embed, ad or form changed or is gone. | Retry new. |
| ELEMENT_COUNT | The number of forms, buttons or ads changed. | Retry new. |
| EMBED_URL_MISSING | A video or post embed link line changed or is gone. | Retry new. |
| MEDIA_BLOCK_CHANGED | An image or video block (block editor) changed. | Retry new. |

**Tables and text**

| Code | What it means | What to do |
|---|---|---|
| TABLE_LOSS | Fewer tables or table rows than the original. Protects product and price tables. | Retry new. |
| CONTENT_LOSS | Less than 80% of the words are left. | Retry new. |
| CONTENT_RETENTION | Less than 75% of the original words are still there (60% with an older prompt, section 4.1). The AI rewrote too much. | Retry new. The prompt should edit sentences, not rewrite sections. |
| WORD_RATIO_EXTREME | The edit is more than 5 times longer. | Retry new. |
| DUPLICATE_CONTENT | The same text appears twice. | Retry new. |

**Links**

| Code | What it means | What to do |
|---|---|---|
| LINK_MISSING | A link of the original is gone or its address changed. Protects affiliate links. | Retry new. |
| LINK_ATTR_CHANGED | `rel="nofollow"`, `sponsored` or `ugc` was removed from a link. | Retry new. |
| ID_MISSING | An `id` (a jump target, for example for a table of contents) is gone. | Retry new. |
| NEW_INTERNAL_LINK | The AI added a link to your own site. It cannot know which of your pages exist. | Retry new. |
| BAD_NEW_LINK | A new link is not allowed (short link, bad address, link around an image). | Retry new. |

**Shortcodes, blocks and code**

| Code | What it means | What to do |
|---|---|---|
| SHORTCODE_MISSING, SHORTCODE_ADDED | A shortcode (`[toc]`, `[product id=...]`) is gone, changed or new. | Retry new. |
| PLUGIN_BLOCK_CHANGED | A plugin block (product box, table of contents, ...) changed. | Retry new. |
| BLOCK_MARKUP_MISMATCH, BLOCK_UNBALANCED, BLOCK_COMMENTS_IN_CLASSIC, MALFORMED_COMMENT | The block editor comments (`<!-- wp:... -->`) are broken, or were added to a classic post. | Retry new. |
| SPECIAL_COMMENT_MISSING | `<!--more-->` or `<!--nextpage-->` is gone. | Retry new. |
| SCRIPT_CHANGED | A script of the original changed. | Retry new. |
| JSONLD_INVALID, JSONLD_TYPE | The schema (FAQ JSON-LD) is broken or of the wrong type. | Retry new. |

**HTML shape**

| Code | What it means | What to do |
|---|---|---|
| FORBIDDEN_TAG | A new `<h1>`, `<style>`, `<script>`, form field or similar tag. | Retry new. |
| FIRST_ELEMENT_NOT_P | The article must start with an intro paragraph. | Retry new. |
| TITLE_IN_BODY | The article starts with the post title again (WordPress already shows it). | Retry new. |
| HEADING_ORDER | Headings jump levels (h2 → h4), or the first heading is not h2. | Retry new. |
| TAG_UNBALANCED | Tags are not closed properly. | Retry new. |

**Prompt rules**

| Code | What it means | What to do |
|---|---|---|
| BOX_DUPLICATED | A second Quick Answer, Key Takeaways or At a Glance box. | Retry new. |
| SECTION_DUPLICATED | A second FAQ, Sources list or Last checked line. | Retry new. |
| NEW_FAQ_NOT_ALLOWED | A new FAQ was added, but "New FAQ section" is "No". | Retry new, or set it to Auto. |
| LAST_CHECKED_NOT_ALLOWED | A "Last checked" line was added, but the prompt says no. | Retry new. |
| NEW_NUMBER_WITHOUT_RESEARCH | Web search is off for the prompt, but the AI added a new price, percentage or year. | Retry new. For informational posts, use a prompt with web search allowed. |
| NUMBER_MISSING | Web search is off for the prompt, but a price, percentage or year of the original is gone. | Retry new. |
| LAST_CHECKED_WITHOUT_RESEARCH | Web search is off for the prompt, but the AI added a "Last checked" / "updated" line or today's date. | Retry new. |

For older prompts these three codes appear only when the fact check is Off or set to "Save the edit anyway" (section 4.1).
If your affiliate prompt removes prices or adds a "Last updated" line on purpose, switch the fact check On
with "Keep the original": these three codes stop, and the fact check, which also gets your prompt, accepts the
removals the prompt names and a "Last updated" line with today's date (section 3, "Affiliate posts").

**Rare technical codes**

| Code | What it means | What to do |
|---|---|---|
| GATE_NOT_LOADED | The file `safety-gate.js` did not load. Every post fails. | The folder is incomplete. Copy all files again and click reload (↻) in `chrome://extensions`. |
| INTERNAL_ERROR, GATE_FAILED | The Safety Gate crashed or gave no answer. | Retry. If it repeats, keep the log. |
| CONFIG_MISSING | No site domain is known. | Check the WordPress site address in your site settings. |

Warnings (for example `LIST_LOSS`, `CLASSIC_CONVERSION`, `AI_PHRASE`, `LINK_CHECK_INCONCLUSIVE`) never block a post.
They are only written to the log.

### 5.2 FACT CHECK BLOCKED

The message looks like: `FACT CHECK BLOCKED: verdict "reject", 2 issue(s) — ... The post was NOT changed.`

The second AI found a serious problem, and the one fix round did not solve it (or its verdict was "reject").
Open the row to see each issue. Click "Fact check chat" to read the whole answer.

| Issue type | What it means |
|---|---|
| new_claim_unverified | A new or changed fact could not be confirmed. |
| fact_wrong | A fact in the edit is wrong. |
| fact_changed_wrongly | The original was right; the edit changed it into something wrong. |
| invented_experience | New "I tried" / "we tested" claims that the original does not make. |
| contradiction | Two parts of the edit disagree (for example the table and the text). |
| info_lost | A useful fact, step or warning of the original is gone. |
| risky_advice | New or weaker advice on health, money, legal or safety topics. |
| link_mismatch | A new link does not support its sentence. |
| voice_or_language_changed | Different language, spelling style, or "I" became "we". |
| off_topic | New content about another topic, country or product. |

What to do:

- The issue is real: **↻ Retry new**.
- Many `new_claim_unverified` issues: the AIs could not check the new facts.
  For informational posts, use a prompt with web search allowed. Then both chats can open pages.
- You think the fact checker is wrong: leave the post. The original is live and safe.

### 5.3 FACT CHECK ERROR

The message looks like: `FACT CHECK ERROR: the fact-check AI never replied (...). The post was NOT changed.`

The fact check itself broke. For example: the chat never answered, it timed out,
its answer had no readable result, the chat box was not ready, or the fact-check prompt was missing.

What to do:

- Check that you are logged in to the AI and have no usage limit.
- Click "Fact check chat" on the row to see what happened.
- **↻ Retry new**.
- It happens often: raise "AI response timeout" (section 4 Timing & waits).
  Use ChatGPT, Claude, Gemini, Grok or DeepSeek for the fact check. Other chat sites are read less reliably.

If you choose "Save the edit anyway" for "If the fact check itself breaks",
such a post is saved after the Safety Gate passed. Its row in Successful shows "🔎 Fact check skipped (error)".

### 5.4 Other reasons

Messages without these three prefixes come from the older checks, the same as in v3.45.0:
for example a cut-off reply ("sections look missing", "only 74% of the source length"),
no code block, or report text in the reply. Retry new.
(With a Safety Gate prompt, "only …% of the source length" no longer blocks a reply that ends with the end marker
and only lost messy code, section 4.1. A reply that lost text, or stopped before the original's last section,
is still blocked, even when it ends with the marker.)

## 6. Known limits

- **Not tested on the live ChatGPT website.** All tests used local copies of ChatGPT-like pages
  and a fake WordPress. Real pages change often. Start with Test First Post and a small batch.
- **More posts in Failed.** The checks are strict on purpose. Failed posts count toward "stop after N failures in a row".
- **Older prompts get fewer checks.** Without the end marker, and while the fact check is On with "Keep the original",
  the code does not check prices, dates or "Last updated" lines; the fact check reads them (section 4.1).
  A cut-off reply is then caught only by the older completeness checks.
- **Slower and uses more of your AI limit.** One more chat per post, sometimes two.
- **The link test cannot see pages that block robots** (403, 429, Cloudflare checks).
  A new deep link to such a page is removed (the words stay). Homepages are kept.
  Links of the original are never tested or removed.
- **Links to local or private addresses** (`localhost`, `192.168.x.x`, ...) are never opened. They are removed.
- **A new link to a homepage** (no path) is kept when the site does not answer,
  because the browser does not say why a request failed. A new link to any other page is removed then.
- **Automatic retries tell the AI why, but they may fail again.** The AI can repeat the same mistake.
  Each retry is still checked in full. The reasons are carried from the main pass to the end-of-batch retry pass.
- **The fact check is only as good as the AI.** The same AI can miss its own mistakes.
  Without web search it flags every new price, date or spec it cannot check, so more posts are blocked.
- **Only the five known chat sites are read reliably** for the fact-check verdict
  (ChatGPT, Claude, Gemini, Grok, DeepSeek). Other sites use generic rules.
- **Fast Submit:** phase 1 only sends the prompts. The Safety Gate and the fact check run in the recovery phase,
  before anything is saved.
- **Auto-split (experimental):** the Safety Gate checks the joined article.
  A cut-off middle part is caught only by the length and section checks.
- **The completeness check** (Balanced: at least 85% of the length) can still block an edit that removed a lot
  of messy code, such as `<span>` leftovers from Word or Google Docs, when the prompt is an older prompt,
  the reply does not end with the end marker, or the original's last section was rewritten completely
  (both its heading or question AND its wording, for example the last FAQ question and its answer both reworded).
  That is on purpose: the code cannot tell such a rewrite from a reply that stopped early. Retry new.
  A reply that stops in the middle of the last section (heading and at least a quarter of its text there)
  and ends with the marker is not caught by this test; the Safety Gate's lost-words check (CONTENT_LOSS) still applies.
  The re-joined article of Auto-split keeps the full length check.
- **The post-save audit** (report only, unchanged since v3.45.0) still lists a renamed "Conclusion"
  (for example "Final Thoughts") as a missing section. The post is saved; its row is shown under Audit Issues,
  and with an audit retry (or HTML recovery for audit issues) turned on, the post is read or edited once more.
- **PROMPT_ECHO does not read HTML comments.** A note copied into a `<!-- comment -->` is not shown on the page
  and is not blocked.
- **Older affiliate prompts with the fact check On:** the code leaves prices and "Last updated" lines to the fact
  check. The fact check gets the prompt and accepts the removals it names, but it still blocks other lost facts
  and new facts it cannot confirm (section 3). The tests use a fake fact check that follows these rules; whether
  the real ChatGPT follows them was not tested.
- **A reply read back from an older chat** ("↻ Retry AI session", "↻ Recover any code", HTML recovery):
  the prompt that chat got is not stored, so its fact check gets the prompt selected now,
  or no editing instructions when a Safety Gate prompt is selected now.
- **The editor prompt is long** (about 58,000 characters). With a very long article the reply may not fit.
  Then END_MARKER_MISSING blocks the post (safe, but not updated).
- **The reference original** is the earliest backup of this run (the extension keeps the last 300 backups).
  Without one, the live post is the reference.
- **The code cannot know the truth.** The Safety Gate checks structure. Facts are checked only by the second AI,
  and it can be wrong too. Keep WordPress revisions on, so you can always roll back.
