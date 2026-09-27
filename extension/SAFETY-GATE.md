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
- **AI fact check.** After the Safety Gate passes, a **new** chat compares the original and the edit.
  It looks for wrong facts, made-up details, lost information and risky advice.
  If it finds a problem, the AI gets **one** chance to fix it in another new chat.
  The fixed edit goes through the Safety Gate and the fact check again.
  Only an edit that passes is saved.
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
- **Affiliate posts**: keep your own affiliate prompts. Leave "Allow AI web search" **off** for them.
  The Start box then shows two warnings (no end marker, web search off). That is expected.
  It means the strict rules apply: the AI may not add or remove prices, percentages or years,
  may not add "Last checked" or "updated" lines, and new deep links are removed.
  So an affiliate edit that adds specs or prices, removes a price, or adds a "Last updated" line is blocked.
  The original then stays live.
- Optional, for your own prompts: add this sentence to the output part of the prompt:
  "The last line inside the code block must be `<!-- APU-END -->`."
  Then a cut-off reply is caught for those prompts too. The marker is never saved to WordPress.
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

## 5. Why a post failed, and what to do

The live post is always the original. Nothing is broken.
Open the row in **❌ Failed posts** to see the reason.

**General rules**

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
| END_MARKER_MISSING | The reply did not end with `<!-- APU-END -->`. It was cut off, or the AI ignored the format. | Retry new. If it happens a lot with long posts, the reply is too long for one message. Try another model. |
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
| CONTENT_RETENTION | Less than 75% of the original words are still there. The AI rewrote too much. | Retry new. The prompt should edit sentences, not rewrite sections. |
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
| NEW_NUMBER_WITHOUT_RESEARCH | Web search is off, but the AI added a new price, percentage or year. | Retry new. For informational posts, use a prompt with web search allowed. |
| NUMBER_MISSING | Web search is off, but a price, percentage or year of the original is gone. | Retry new. |
| LAST_CHECKED_WITHOUT_RESEARCH | Web search is off, but the AI added a "Last checked" / "updated" line or today's date. | Retry new. |

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

## 6. Known limits

- **Not tested on the live ChatGPT website.** All tests used local copies of ChatGPT-like pages
  and a fake WordPress. Real pages change often. Start with Test First Post and a small batch.
- **More posts in Failed.** The checks are strict on purpose. Old prompts (no end marker, no web search) fail more often.
  Failed posts count toward "stop after N failures in a row".
- **Slower and uses more of your AI limit.** One more chat per post, sometimes two.
- **The link test cannot see pages that block robots** (403, 429, Cloudflare checks).
  A new deep link to such a page is removed (the words stay). Homepages are kept.
  Links of the original are never tested or removed.
- **Links to local or private addresses** (`localhost`, `192.168.x.x`, ...) are never opened. They are removed.
- **A new link to a homepage** (no path) is kept when the site does not answer,
  because the browser does not say why a request failed. A new link to any other page is removed then.
- **Automatic retries do not know the reason.** A new-session retry during the batch uses the same prompt again.
  The **↻ Retry new** button on a Failed row does send the reasons.
- **The fact check is only as good as the AI.** The same AI can miss its own mistakes.
  Without web search it flags every new price, date or spec it cannot check, so more posts are blocked.
- **Only the five known chat sites are read reliably** for the fact-check verdict
  (ChatGPT, Claude, Gemini, Grok, DeepSeek). Other sites use generic rules.
- **Fast Submit:** phase 1 only sends the prompts. The Safety Gate and the fact check run in the recovery phase,
  before anything is saved.
- **Auto-split (experimental):** the Safety Gate checks the joined article.
  A cut-off middle part is caught only by the length and section checks.
- **The completeness check** (Balanced: at least 85% of the length) can still block an edit that removed a lot
  of messy code, such as `<span>` leftovers from Word or Google Docs. The prompt tells the AI to keep them.
- **The editor prompt is long** (about 58,000 characters). With a very long article the reply may not fit.
  Then END_MARKER_MISSING blocks the post (safe, but not updated).
- **The reference original** is the earliest backup of this run (the extension keeps the last 300 backups).
  Without one, the live post is the reference.
- **The code cannot know the truth.** The Safety Gate checks structure. Facts are checked only by the second AI,
  and it can be wrong too. Keep WordPress revisions on, so you can always roll back.
