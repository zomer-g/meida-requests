# Accessibility audit: WCAG 2.1 AA (IS 5568)

- **Phase 2 (after fixes): 2026-10-29.** Branch `claude/a11y-privacy-fb5841`, on top of `master` `6d9a1e9` (boards-roles + access log).
- **Result:** **meets WCAG 2.1 AA on every screen tested** (see "Phase 2" below). All 21 phase-1 findings are fixed, except F20, which was not a failure. The limits are listed under "What is still not verified".
- Phase 1 (before fixes) found 1 critical, 6 serious, 6 moderate and 8 minor problems. That audit is kept below for reference.

## Phase 2: fixes and re-test

### What changed

| # | Fix | Where |
|---|---|---|
| F1 | Lookups are an ARIA 1.2 combobox: `role=combobox`, `aria-expanded`, `aria-controls`, `aria-activedescendant`, options with ids and `aria-selected`. ArrowUp/ArrowDown move, Enter picks, Escape closes. The result count ("20 תוצאות" / "לא נמצאו תוצאות") is announced. After a pick, focus moves to the clear button. After clearing, it returns to the input. | `lookupInput` in `app.js` |
| F2 | The lookup input has `id="f_<field>"`, so its `<label for>` works. A chosen value is a `role=group` named by the label. | `lookupInput` |
| F3 | Every required control has `aria-required="true"`. The `*` is `aria-hidden`. Each form starts with "שדות המסומנים ב-* הם שדות חובה". | `fieldControl`, `reqNote`, admin forms |
| F4 | Error summary (`role=alert`, focused) with links to the fields. Each field gets `aria-invalid` and an `aria-describedby` message under it, and a collapsed section with an error opens. Server 400 answers ("שדות חובה: …", "<field>: …") are mapped to the same fields. Applies to: new request, request edit, activity composer, add user, groups. | `showErrors`, `serverErrors` |
| F5 | On navigation, focus moves to the new `h1`. After a save or another action, the screen is redrawn and focus returns to the same control (by id or `data-key`), or to the `h1`. Paging keeps focus on the pager button. | `route`, `settle`, `redraw` |
| F6 | `--muted #5c6680` (5.25:1 on the page, 5.17:1 on light blue). Links `#1b5fb8` (5.71:1). Red text `#c8203f` (5.62:1). Closed pill `#4f5a73` (5.94:1). | `styles.css` |
| F7 | Users table: role, group and Salesforce-user selects no longer save on `change`. Each row has its own "שמירה" button, enabled only when the row has changed. | `renderAdmin` |
| F8 | `aria-live` removed from `<main>`. Two hidden live regions: `#sr-status` (polite) and `#sr-alert` (assertive). Lists and logs announce "N בקשות, עמוד X" / "אין רשומות". | `index.html`, `announce` |
| F9 | The toast is visual only, with a close button. Messages are announced through the live regions. Errors stay until closed. Other messages hide after 6s. | `toast` |
| F10 | `document.title` = "<h1> · ניהול בקשות מידע · התנועה לחופש המידע" on every screen. | `settle` |
| F11 | Input, select and button borders `#8a94a6` (3.06:1). Focus is a 2px `#1b5fb8` outline on fields and a 3px one on everything else (`:focus-visible`). Invalid fields get a red 2px border. | `styles.css` |
| F12 | "דילוג לתוכן" skip link as the first element. It focuses `<main tabindex=-1>` without changing the route hash. | `index.html`, `app.js` |
| F13 | Checkbox groups are `<fieldset>` + `<legend>`. | `fieldControl` |
| F14 | The last column header is "פעולות" (visually hidden). Tables have visually hidden `<caption>`s and `scope=col`. | users, list, logs, import preview |
| F15 | `aria-current="page"` on the active main-nav link and board tab. The active main-nav link is also underlined. | `setActiveNav`, `renderList` |
| F16 | The Salesforce contact error is shown as text in the row, not only in a `title`. | `renderAdmin` |
| F17 | The top bar is inside `<header>`. | `index.html` |
| F18 | Before a sign-in redirect (expired session), typed text in the screen's textareas is kept in `sessionStorage` and put back after returning, with a message. | `saveDrafts`, `restoreDrafts`, `activity.js` |
| F19 | The section arrows use CSS alt text (`content: "▾" / ""`), so they are not read aloud. | `styles.css` |
| F20 | Not changed: hidden columns on small screens are shown on the request page. | – |
| F21 | `[hidden] { display: none !important; }`. The nav no longer shows on the no-access screen (verified: `display: none`). | `styles.css` |
| new | Links inside running text are underlined (axe `link-in-text-block` on the log pages after the colour change). Wide tables keep their hidden captions inside the scroll box, which fixed a horizontal scroll at 320px on the users page. | `styles.css` |

### Re-test results

- **axe-core 4.10, WCAG 2.0/2.1 A + AA + best practice: 0 violations** on all 12 screens: all boards, one board, request page (collapsed and with all sections open), new request, users + CSV import, groups, edit log, access log, no-access, `/privacy`, `/accessibility`.
- **Reflow at 320px: no horizontal page scroll** on all 12 screens. Every screen has a skip link and exactly one `h1`.
- **Text spacing (1.4.12):** no clipped controls on the list, the request page or the users page.
- **Keyboard and ARIA (scripted, `verify.mjs`):**
  - Tab 1 is the skip link. Enter focuses `main` and leaves the hash `#/`.
  - A board switch moves focus to the new `h1` and changes the title. "50+ בקשות, עמוד 1" is announced. Next page keeps focus on "הבא".
  - All 3 lookups have `role=combobox` with `aria-required`. Typing opens 20 options. ArrowDown ×2 sets `aria-activedescendant` to option 2 (`aria-selected=true`). Enter picks it and focuses the clear button. Clearing focuses the input.
  - Submitting the new-request form empty shows a focused summary with 7 errors, 7 `aria-invalid` fields each described by its message, and a summary link that focuses the field.
  - The empty activity post, the add-user form and the group form each show the summary and mark the field.
  - Titles are correct on all screens. The nav is hidden on the no-access screen.
  - **No write request reached the API during the test.**
- **Contrast (computed):** muted 5.25 / 5.73 / 5.17 (page / white / light blue), links 5.71 / 6.22 / 5.61, red text 5.62 on white and 4.77 on the error box, closed pill 5.94, field borders 3.06, focus ring 6.22.

### What is still not verified

- **Real screen readers** (NVDA, JAWS, VoiceOver) and **real phones**. Only the ARIA was checked, by script.
- **Student and employee views** live. Adding a portal user creates a Salesforce Contact, so it was not done locally. They use the same screens (list without board tabs, request, new request), so the same fixes apply.
- **Users table rows** (row save button, contact error text). The local store has no users besides the env admin. Checked in code only.
- **Edit log, request history and import preview with real entries.** Checked in code only.
- **Uploaded files** (PDFs, images from public bodies) are not checked and may not be accessible.
- **Google sign-in** pages are run by xhostd and Google, not by this app.

---

# Phase 1 (before fixes), kept for reference

- **Date:** 2026-10-29
- **Code audited:** branch `claude/a11y-privacy-fb5841`, based on `claude/boards-roles-53e42e` at `898c4e0`
- **Result:** did not meet AA. 1 critical, 6 serious, 6 moderate and 8 minor findings.

## How it was tested (phase 1)

- The app ran locally against the real Salesforce org, read-only (no form was submitted, nothing was written to Salesforce), with the in-memory store instead of Postgres:
  - as an admin (`ADMIN_EMAILS` = `DEV_USER_EMAIL`), which shows every screen and every board;
  - as a signed-in user with no portal access, for the no-access screen.
- **Automated:** axe-core 4.10 (`@axe-core/playwright`, tags `wcag2a wcag2aa wcag21a wcag21aa best-practice`) in Chrome, on each screen at 1280px, plus a 320px pass for reflow (horizontal scroll), `lang`/`dir`, title, `h1` and landmarks. Screens: all boards, one board, request page (collapsed, and with every section opened), new request, admin users + CSV import, admin groups, admin log, no-access, `/privacy`, `/accessibility`.
- **Keyboard (scripted in Playwright):** tab order on the list, focus after a board switch, typing into a lookup and choosing with ArrowDown + Enter, focus styles of inputs/selects/links.
- **Text spacing (1.4.12):** injected the WCAG spacing overrides on the list and admin pages and checked for clipped controls and horizontal scroll.
- **Contrast:** axe, plus computed ratios for every colour pair in `public/styles.css`, including the states axe does not render (pills, disabled, error toast, focus ring, borders).
- **Code review** of `public/app.js`, `public/activity.js`, `public/index.html` and `public/styles.css` for what the scripts cannot reach.

**Not covered in phase 1** (to do in phase 2 or by hand):
- student and employee views (they need a portal user row, and adding one creates a Salesforce Contact). By code they are the admin views minus the board tabs and admin pages;
- the admin log and request history with entries, the CSV import preview table, and posting to the activity feed (each needs data or a Salesforce write). Reviewed in code only;
- a real screen reader (NVDA/JAWS/VoiceOver) and real mobile devices;
- browser zoom at 200%. 320px reflow (= 400% of 1280px) was tested instead and passes.

## Passes

| Criterion | What was checked |
|---|---|
| 3.1.1 Language of page | `<html lang="he" dir="rtl">`. Emails and URLs are marked `dir="ltr"`. |
| 1.4.10 Reflow | No horizontal page scroll at 320px on any screen. Wide tables scroll inside their own box. |
| 1.4.12 Text spacing | No clipped controls and no horizontal scroll with the spacing overrides. |
| 1.4.4 Resize text | Layout uses rem/flex/grid and wraps (see reflow). |
| 1.1.1 Non-text content | Logo has alt text. The "×" clear button in lookups has an `aria-label`. No other informative images. |
| 1.4.1 Use of colour | Status pills always carry a text label. Import rows have a status word as well as colour. Old/new values in the change list are separated by "←" as well as by strike-through. |
| 1.3.1 Headings | One `h1` per screen, `h2` per card/section. |
| 1.3.1 Tables | Data tables use `<table>`, `<thead>`, `<th>` (except F14). |
| 2.1.1 Keyboard (everything except lookups) | Links, buttons, native selects/inputs/date pickers, `<details>` sections and the file input work with the keyboard. List rows can be opened from the link in the name column. |
| 2.4.7 Focus visible (minimal) | Links and buttons get the browser focus ring. Inputs change border colour (see F11 for why this is weak). |
| 2.5.3 Label in name | Accessible names match the visible labels. |
| 3.2.1 On focus | Nothing changes context on focus. |
| 4.1.1 / 4.1.2 Native controls | Native form controls, with labels associated by `for`/`id` (except lookups, F2). |

## Findings

Severity: **Critical**: blocks a task for keyboard or screen-reader users. **Serious**: an AA failure with a real impact. **Moderate**: an AA failure with a workaround, or partial. **Minor**: borderline or best practice.

| # | Criterion | Where | Severity | Problem | Fix |
|---|---|---|---|---|---|
| F1 | 2.1.1 Keyboard, 4.1.2 Name/role/value | Lookups (requested body, initiator, handler) on the new request and request pages (`lookupInput` in `app.js`) | **Critical** | Options are picked only with `mousedown`. ArrowDown + Enter does nothing, so keyboard users **cannot fill these required fields**. No `role="combobox"`, `aria-expanded`, `aria-controls` or `aria-activedescendant`. "No results" is not announced. | Use the ARIA 1.2 combobox pattern: `role=combobox` on the input, `aria-autocomplete=list`, `aria-expanded`, `aria-controls` → listbox id, options with ids and `aria-selected`, Up/Down/Home/End/Enter/Escape handling, and a live region with the result count or "no results". Return focus to the "chosen" chip's clear button after selection. |
| F2 | 1.3.1, 3.3.2 Labels | Lookups | Serious | `<label for="f_…">` points at an id that does not exist (the input has no id). The name comes only from `aria-label`, so clicking the label does nothing. | Give the lookup input `id="f_<name>"`. |
| F3 | 3.3.2, 1.3.1, 4.1.2 | All forms: new request, request, admin users, CSV import, groups | Serious | Required fields are marked only by a red `*`, which is `aria-hidden` on request forms. Controls have no `required`/`aria-required`. No note explains what `*` means. | Add `aria-required="true"` (or `required`) to the control, and add "שדות המסומנים ב-* הם שדות חובה" at the top of each form. |
| F4 | 3.3.1 Error identification, 3.3.3 Error suggestion | All forms, activity composer | Serious | Validation errors arrive only as a toast that vanishes after 4 seconds. The bad field is not marked (`aria-invalid`), not linked to the message (`aria-describedby`), and does not get focus. | Show errors in a persistent error summary (`role="alert"`) with links to the fields. Set `aria-invalid` and an `aria-describedby` message on each field, and move focus to the summary. |
| F5 | 2.4.3 Focus order | Every route change, after saving a request, after admin actions, after picking a lookup option | Serious | The view is replaced and focus falls to `<body>` (verified after a board switch). Keyboard and screen-reader users lose their place. | After `route()`, focus the new `h1` (`tabindex="-1"`). After a re-render, restore focus to the control that triggered it, or to the toast/summary. After a lookup pick, focus the clear button. |
| F6 | 1.4.3 Contrast (minimum) | `.muted` text on the page background, e.g. page intros, pager, "טוען…", record meta line (4.21:1); `.muted` on `--blue-light` (4.14:1); "← חזרה לרשימה" and other links on the page background (`#2274da` on `#f5f5f5`, 4.21:1); closed pill (3.95:1); "הסרה" danger button (3.61:1); required `*` (3.61:1); `tr.bad` muted text (4.33:1) | Serious | Below 4.5:1 for normal text. axe flags 1–6 nodes per screen. | `--muted: #5c6680` (5.25:1 on `#f5f5f5`, 5.31:1 on `--blue-light`). Links on grey `#1b5fb8` (5.71:1). Danger/`*`: `#c8203f` (5.62:1). Closed pill text `#4f5a73`. |
| F7 | 3.2.2 On input | Admin users table: role and group selects | Serious | Each `change` saves at once and re-renders the page. With the keyboard, ArrowDown on a closed select fires `change` for every option, which saves every intermediate role/group and drops focus (F5). | Add an explicit "שמירה" button per row, or save only on Enter/blur. |
| F8 | 4.1.3 Status messages | `<main aria-live="polite">` in `index.html` | Moderate | The whole view is a live region, so every render reads the whole screen (or, with some readers, nothing useful). List search results ("לא נמצאו בקשות", page N) are not announced in a targeted way. | Remove `aria-live` from `main`. Add a visually hidden `role="status"` region and write short messages to it ("נמצאו 25 בקשות", "טוען…"). |
| F9 | 4.1.3, 2.2.1 | Toast (`#toast`) | Moderate | The toast's text is set while it is `hidden`, and then it is shown, which some screen readers do not announce. Errors use `role=status` instead of `alert`. Errors disappear after 4s. | Keep the live region in the DOM, unhidden and empty. Use a separate `role="alert"` region for errors. Keep error toasts until they are dismissed (close button) or until the next action. |
| F10 | 2.4.2 Page titled | All routes | Moderate | `document.title` is the same on every screen. | Set it per route: "<h1 of the screen> · ניהול בקשות מידע". |
| F11 | 1.4.11 Non-text contrast, 2.4.7 | Inputs, selects, textareas, default buttons, board tabs | Moderate | Borders `#dbdbdb` on white are 1.38:1, so field boundaries are not perceivable. The focus outline `#edf4fc` is 1.11:1 (invisible). Focus is shown only by the border turning blue. | Borders `#8a94a6` (3.06:1). Focus: `outline: 2px solid var(--blue); outline-offset: 1px` on inputs, buttons, tabs and links (`:focus-visible`). |
| F12 | 2.4.1 Bypass blocks | All screens | Moderate | No "skip to content" link. Header/nav/main landmarks exist, which partly meets the criterion. | Add `<a class="skip-link" href="#view">דילוג לתוכן</a>` as the first element. Give `main` `tabindex="-1"`. (Done on `/privacy` and `/accessibility`.) |
| F13 | 1.3.1 Info and relationships | Multi-select picklists (`.multi`) | Moderate | The group of checkboxes has a `<label for>` pointing at a `div`, so the group has no name. (No multi-picklist is on the current layout. Found in code.) | `<fieldset><legend>` or `role="group"` + `aria-labelledby`. |
| F14 | 1.3.1 | Admin users table, last column | Minor | Empty `<th>` (axe `empty-table-header`). | Visually hidden text "פעולות". |
| F15 | 1.3.1, 1.4.1 | Main nav and board tabs | Minor | The current page/board is shown visually only. The main nav changes colour only (navy → blue). | `aria-current="page"` on the active link. Add an underline/border to the active main-nav item. |
| F16 | 1.3.1, 2.1.1 | Users table pills (`title` = Salesforce Contact id / contact error) | Minor | The contact error is only in a `title` tooltip, which keyboard and touch users cannot reach. | Show the error as text (e.g. under the pill or in a `<details>`). |
| F17 | best practice (axe `region`) | `.topbar` (user name, logout) | Minor | Content is outside every landmark. | Move the top bar into `<header>`, or give it `role="region"` with an `aria-label`. |
| F18 | 2.2.1 Timing adjustable (to verify) | Request edit form, activity composer | Minor | When the sign-in token expires, the next request gets a 401 and the page navigates to login, so the typed text is lost. Expiry time not verified. | Keep a draft in `sessionStorage` before redirecting, or open login in a new tab and retry. |
| F19 | 1.3.1 | Section headers (`details > summary::after` "▾"/"◂") | Minor | The arrow characters are generated content that some screen readers read aloud. | `content: "▾" / ""` (alt text for generated content), or an `aria-hidden` span. |
| F20 | 1.4.10 (note) | List tables at ≤720px | Minor | `hide-sm` hides the body, handler, owner and date columns. The information is still on the request page, so this is not a failure. | Optional: show those fields as a second line in the name cell on small screens. |
| F21 | 1.3.1, 2.4.3 | No-access screen (header nav) | Minor | `.nav { display: flex }` overrides the `hidden` attribute, so "הבקשות" and "+ בקשה חדשה" are shown and focusable to a user who has no access. Both links lead back to the same no-access screen. | `[hidden] { display: none !important; }` in `styles.css`. |

## Colour pairs measured

| Pair | Ratio | Needed |
|---|---|---|
| `--text` `#3b4763` on white | 9.26 | 4.5 ✓ |
| `--muted` `#6b7590` on white | 4.59 | 4.5 ✓ |
| `--muted` on page `#f5f5f5` | 4.21 | 4.5 ✗ |
| `--muted` on `--blue-light` | 4.14 | 4.5 ✗ |
| `--muted` on closed pill `#eceef2` | 3.95 | 4.5 ✗ |
| link `#2274da` on white | 4.59 | 4.5 ✓ |
| link `#2274da` on `#f5f5f5` | 4.21 | 4.5 ✗ |
| white on primary button `#2274da` | 4.59 | 4.5 ✓ |
| navy on `--blue-light` (th, pills) | 14.27 | 4.5 ✓ |
| refused pill `#b4213f` on `#fde7ec` | 5.52 | 4.5 ✓ |
| received pill `#1f7a52` on `#e3f6ee` | 4.71 | 4.5 ✓ |
| danger `#f14668` on white (button, `*`) | 3.61 | 4.5 ✗ |
| top bar `#c9d3e6` on navy | 10.50 | 4.5 ✓ |
| error toast white on `#b4213f` | 6.50 | 4.5 ✓ |
| active tab white on navy | 15.81 | 4.5 ✓ |
| input border `#dbdbdb` on white | 1.38 | 3 ✗ |
| focus outline `#edf4fc` on white | 1.11 | 3 ✗ |
| focus border `#2274da` on white | 4.59 | 3 ✓ |

## The new public pages

`/privacy` and `/accessibility` are static pages (`public/privacy.html`, `public/accessibility.html`, styles in `public/pages.css`). They have a skip link, header/main/footer landmarks, one `h1`, their own titles, underlined links, colours of 4.5:1 or more and a 3px focus ring. axe reported no violations on them (see phase-1 run). The footer with both links is on every page, including the no-access screen.
