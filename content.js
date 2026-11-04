// content.js — Injected into PCC's class schedule (findclasses.pasadena.edu)
// Adds an RMP score tile to each class section, a ranked instructor summary to
// each course, and rating badges to the instructor drawer.

const PROCESSED_ATTR = "data-rmp-processed";
const INSTRUCTOR_LABEL = "Instructor:";
// Sections with no assigned instructor are listed under this placeholder.
const PLACEHOLDER_NAME = "staff";
// Everything this script adds, so the observer can ignore its own changes.
const OWN_ELEMENTS = ".rmp-badge, .rmp-tile, .rmp-summary, .rmp-card";

// Track the observer so we can disconnect it if the extension context is invalidated.
let _observer = null;
let _contextValid = true;

// The schedule is a React app: results render after the page loads, and more
// sections are added as you scroll, so we observe DOM mutations.
function init() {
  scanForProfessors(document.body);
  observeTableChanges();
}

// ── DOM Observation ──────────────────────────────────────────────────────────

function observeTableChanges() {
  _observer = new MutationObserver((mutations) => {
    if (!_contextValid) {
      _observer.disconnect();
      return;
    }
    // The element a card was opened from can be unmounted by a filter change, in
    // which case it never fires mouseleave.
    if (_activeAnchor && !_activeAnchor.isConnected) hideCard();

    for (const mutation of mutations) {
      const target = mutation.target.nodeType === Node.ELEMENT_NODE
        ? mutation.target
        : mutation.target.parentElement;
      if (target?.closest(OWN_ELEMENTS)) continue;

      // Sections removed by a filter can drop instructors from the summary.
      if (mutation.removedNodes.length && target?.querySelector(":scope > .rmp-summary")) {
        markSummaryDirty(target);
      }
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.closest(OWN_ELEMENTS)) continue;
        scanForProfessors(node);
      }
    }
    scanInstructorDrawer();
  });

  // characterData catches the drawer, which reuses its elements when it's
  // reopened for a different section.
  _observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

// ── Professor Name Detection ─────────────────────────────────────────────────

function scanForProfessors(root) {
  // Each section prints an "Instructor:" label with the name in the next
  // sibling. Anchoring on the label avoids matching other two-word text on the
  // page, like "Full Term" or "Grade Mode". Sections render twice, once for each
  // of the site's mobile and desktop layouts, and both get a badge.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue.trim() !== INSTRUCTOR_LABEL) continue;
    const nameEl = node.parentElement.nextElementSibling;
    if (nameEl) processSection(nameEl);
  }
}

function readName(el) {
  return el.textContent.trim().replace(/\s+/g, " ");
}

function isRealName(name) {
  return !!name && name.toLowerCase() !== PLACEHOLDER_NAME;
}

function processSection(nameEl) {
  const grid = nameEl.closest(".grid");
  const column = grid?.firstElementChild;

  // The tile needs the row's status column. If the layout ever changes, still
  // show the rating beside the name rather than nothing.
  if (!column || column.contains(nameEl)) {
    processNameElement(nameEl);
    return;
  }

  const name = readName(nameEl);
  const existing = column.querySelector(":scope > .rmp-tile");
  if (existing?.getAttribute("data-rmp-name") === name) return;
  existing?.remove();

  const courseList = grid.parentElement?.parentElement;
  if (courseList) markSummaryDirty(courseList);
  if (isRealName(name)) attachTile(column, name);
}

// The instructor drawer is the only place co-instructors are named; the section
// itself just shows "+1 more".
function scanInstructorDrawer() {
  document.querySelectorAll("h4").forEach((heading) => {
    if (!/^(Primary|Additional) Instructor/.test(heading.textContent)) return;
    heading.parentElement.querySelectorAll("p").forEach(processNameElement);
  });
}

function processNameElement(el) {
  const name = readName(el);
  const existing = el.nextElementSibling?.classList.contains("rmp-badge")
    ? el.nextElementSibling
    : null;

  if (existing) {
    if (existing.getAttribute("data-rmp-name") === name) return;
    existing.remove();
  } else if (el.hasAttribute(PROCESSED_ATTR)) {
    return;
  }

  el.setAttribute(PROCESSED_ATTR, "true");
  if (isRealName(name)) attachBadge(el, name);
}

// ── Ratings ──────────────────────────────────────────────────────────────────

// One lookup per instructor, shared by their tiles, chips and drawer badges.
const _ratings = new Map();

function getRating(name) {
  if (!_ratings.has(name)) _ratings.set(name, requestRating(name));
  return _ratings.get(name);
}

function requestRating(name) {
  return new Promise((resolve, reject) => {
    if (!_contextValid) {
      reject(new Error("Extension context invalidated"));
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: "GET_PROFESSOR_RATING", name }, (response) => {
        if (chrome.runtime.lastError) {
          const msg = chrome.runtime.lastError.message || "";
          if (msg.includes("context invalidated")) invalidateContext();
          _ratings.delete(name);
          reject(new Error(msg));
          return;
        }
        const data = response?.data ?? null;
        // Null can mean the lookup failed, so let later requests try again. The
        // background script answers repeats from its own cache.
        if (!data) _ratings.delete(name);
        resolve(data);
      });
    } catch (err) {
      // Extension was reloaded — context is gone
      invalidateContext();
      _ratings.delete(name);
      reject(err);
    }
  });
}

function invalidateContext() {
  _contextValid = false;
  if (_observer) _observer.disconnect();
}

function hasRatings(data) {
  return !!data && data.numRatings > 0;
}

// ── Score Tile ───────────────────────────────────────────────────────────────

function attachTile(column, name) {
  const tile = document.createElement("div");
  tile.className = "rmp-tile rmp-loading";
  tile.setAttribute("data-rmp-name", name);
  tile.innerHTML = `<span class="rmp-tile-score">…</span><span class="rmp-tile-label">RMP</span>`;
  column.appendChild(tile);

  getRating(name).then((data) => renderTile(tile, data), () => tile.remove());
}

function renderTile(tile, data) {
  const score = tile.querySelector(".rmp-tile-score");
  const label = tile.querySelector(".rmp-tile-label");

  if (!hasRatings(data)) {
    tile.className = "rmp-tile rmp-not-found";
    score.textContent = "—";
    label.textContent = "No RMP";
    tile.title = "No RateMyProfessors data found";
    return;
  }

  const rating = data.avgRating ?? 0;
  tile.className = `rmp-tile ${ratingClass(rating)}`;
  score.textContent = rating.toFixed(1);
  label.textContent = "RMP ★";
  tile.insertAdjacentHTML("beforeend", `<span class="rmp-tile-hint">Hover for reviews</span>`);
  attachHoverCard(tile, data);
}

// ── Course Summary ───────────────────────────────────────────────────────────

const _dirtyLists = new Set();
let _summaryTimer = null;
// Newest refresh per course, so a slow earlier one can't overwrite it.
const _summaryTokens = new WeakMap();

function markSummaryDirty(list) {
  _dirtyLists.add(list);
  if (_summaryTimer) return;
  _summaryTimer = setTimeout(() => {
    _summaryTimer = null;
    const lists = [..._dirtyLists];
    _dirtyLists.clear();
    lists.forEach(refreshSummary);
  }, 100);
}

async function refreshSummary(list) {
  const token = {};
  _summaryTokens.set(list, token);

  const tiles = list.querySelectorAll(".rmp-tile");
  const names = [...new Set([...tiles].map((t) => t.getAttribute("data-rmp-name")))];

  let summary = list.querySelector(":scope > .rmp-summary");
  // Nothing to compare with fewer than two instructors.
  if (names.length < 2) {
    summary?.remove();
    return;
  }

  const results = await Promise.all(
    names.map(async (name) => ({ name, data: await getRating(name).catch(() => null) }))
  );
  if (_summaryTokens.get(list) !== token || !list.isConnected) return;

  const score = (data) => (hasRatings(data) ? data.avgRating : -1);
  results.sort(
    (a, b) => score(b.data) - score(a.data) || (b.data?.numRatings ?? 0) - (a.data?.numRatings ?? 0)
  );

  // Rebuilding would close a hover card open on one of the chips, so skip it
  // when more sections scroll in without changing the result.
  const key = results.map(({ name, data }) => `${name}:${score(data)}`).join("|");
  if (summary?.getAttribute("data-rmp-key") === key) return;

  if (!summary) {
    summary = document.createElement("div");
    summary.className = "rmp-summary";
    list.prepend(summary);
  }
  summary.setAttribute("data-rmp-key", key);
  summary.innerHTML = `
    <div class="rmp-summary-title">Instructors for this course · best rated first</div>
    <div class="rmp-summary-chips"></div>
  `;
  const chips = summary.querySelector(".rmp-summary-chips");
  for (const { name, data } of results) chips.appendChild(buildChip(name, data));
}

function buildChip(name, data) {
  const rated = hasRatings(data);
  const chip = document.createElement("span");
  chip.className = "rmp-chip";

  const score = document.createElement("span");
  score.className = `rmp-chip-score ${rated ? ratingClass(data.avgRating) : "rmp-not-found"}`;
  score.textContent = rated ? data.avgRating.toFixed(1) : "N/A";

  chip.append(score, name);
  if (rated) attachHoverCard(chip, data);
  return chip;
}

// ── Drawer Badge ─────────────────────────────────────────────────────────────

function attachBadge(el, name) {
  const badge = document.createElement("span");
  badge.className = "rmp-badge rmp-loading";
  badge.textContent = "RMP…";
  badge.setAttribute("data-rmp-name", name);
  // Added beside the name rather than inside it, so that hovering or clicking
  // the badge doesn't also trigger anything the site attached to the name.
  el.after(badge);

  getRating(name).then((data) => renderBadge(badge, data), () => badge.remove());
}

function renderBadge(badge, data) {
  badge.classList.remove("rmp-loading");

  if (!hasRatings(data)) {
    badge.className = "rmp-badge rmp-not-found";
    badge.textContent = "RMP: N/A";
    badge.title = "No RateMyProfessors data found";
    return;
  }

  const rating = data.avgRating ?? 0;
  badge.className = `rmp-badge ${ratingClass(rating)}`;
  badge.textContent = `★ ${rating.toFixed(1)}`;
  attachHoverCard(badge, data);
}

function ratingClass(r) {
  if (r >= 4.0) return "rmp-good";
  if (r >= 3.0) return "rmp-ok";
  if (r >= 2.0) return "rmp-poor";
  return "rmp-bad";
}

// ── Hover Card ───────────────────────────────────────────────────────────────

// Only one card exists at a time, built on hover. A fully scrolled schedule has
// thousands of tiles, which is far too many to pre-build a card for each.
let _activeCard = null;
let _activeAnchor = null;
let _hideTimer = null;

function attachHoverCard(anchor, data) {
  anchor.addEventListener("mouseenter", () => showCard(anchor, data));
  anchor.addEventListener("mouseleave", scheduleHide);
}

function showCard(anchor, data) {
  cancelHide();
  hideCard();

  const card = buildHoverCard(data);
  card.addEventListener("mouseenter", cancelHide);
  card.addEventListener("mouseleave", scheduleHide);
  document.body.appendChild(card);

  _activeCard = card;
  _activeAnchor = anchor;
  positionAndShow(card, anchor);
}

function hideCard() {
  _activeCard?.remove();
  _activeCard = null;
  _activeAnchor = null;
}

function cancelHide() {
  if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
}

function scheduleHide() {
  cancelHide();
  _hideTimer = setTimeout(hideCard, 120);
}

function buildHoverCard(data) {
  const card = document.createElement("div");
  card.className = "rmp-card";
  card.setAttribute("role", "tooltip");

  const wtaPercent =
    data.wouldTakeAgainPercent >= 0
      ? `${Math.round(data.wouldTakeAgainPercent)}%`
      : "N/A";

  const reviewsHtml = (data.recentReviews || [])
    .filter((r) => r.comment && r.comment.trim())
    .slice(0, 10)
    .map(
      (r) => `
      <div class="rmp-review">
        <div class="rmp-review-meta">
          <span class="rmp-review-quality ${ratingClass(r.qualityRating)}">★ ${r.qualityRating}</span>
          ${r.class ? `<span class="rmp-review-class">${escHtml(r.class)}</span>` : ""}
          <span class="rmp-review-date">${formatDate(r.date)}</span>
        </div>
        <p class="rmp-review-comment">${escHtml(truncate(r.comment, 140))}</p>
      </div>`
    )
    .join("");

  card.innerHTML = `
    <div class="rmp-card-header">
      <div class="rmp-card-name">${escHtml(data.firstName)} ${escHtml(data.lastName)}</div>
      ${data.department ? `<div class="rmp-card-dept">${escHtml(data.department)}</div>` : ""}
      ${data.school && !data.isPCC ? `<div class="rmp-card-dept">Rated at ${escHtml(data.school)}</div>` : ""}
    </div>
    <div class="rmp-card-stats">
      <div class="rmp-stat">
        <div class="rmp-stat-value ${ratingClass(data.avgRating)}">${data.avgRating?.toFixed(1) ?? "—"}</div>
        <div class="rmp-stat-label">Quality</div>
      </div>
      <div class="rmp-stat">
        <div class="rmp-stat-value">${data.avgDifficulty?.toFixed(1) ?? "—"}</div>
        <div class="rmp-stat-label">Difficulty</div>
      </div>
      <div class="rmp-stat">
        <div class="rmp-stat-value">${wtaPercent}</div>
        <div class="rmp-stat-label">Would Retake</div>
      </div>
      <div class="rmp-stat">
        <div class="rmp-stat-value">${data.numRatings}</div>
        <div class="rmp-stat-label">Ratings</div>
      </div>
    </div>
    ${reviewsHtml ? `<div class="rmp-reviews-title">Recent Reviews</div><div class="rmp-reviews-list">${reviewsHtml}</div>` : ""}
    <a class="rmp-card-link" href="${data.profileUrl}" target="_blank" rel="noopener">
      View full profile on RateMyProfessors ↗
    </a>
  `;

  return card;
}

function positionAndShow(card, anchor) {
  card.style.display = "block";
  const rect = anchor.getBoundingClientRect();

  // Use viewport coords to match position: fixed
  let top = rect.bottom + 6;
  let left = rect.left;

  // Prevent card from going off right edge
  const cardWidth = 340;
  if (left + cardWidth > window.innerWidth - 16) {
    left = window.innerWidth - cardWidth - 16;
  }

  // Prevent card from going off bottom edge, without pushing it off the top
  const cardHeight = card.offsetHeight || 300;
  if (top + cardHeight > window.innerHeight - 16) {
    top = Math.max(16, rect.top - cardHeight - 6);
  }

  card.style.top = `${top}px`;
  card.style.left = `${left}px`;
  card.classList.add("rmp-card-visible");
}

// ── Utilities ────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(str, max) {
  if (!str) return "";
  return str.length <= max ? str : str.slice(0, max).trimEnd() + "…";
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
    });
  } catch {
    return dateStr;
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
