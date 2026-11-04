// content.js — Injected into PCC's class schedule (findclasses.pasadena.edu)
// Finds instructor names in the class results and injects RMP rating badges.

const PROCESSED_ATTR = "data-rmp-processed";
const INSTRUCTOR_LABEL = "Instructor:";
// Sections with no assigned instructor are listed under this placeholder.
const PLACEHOLDER_NAME = "staff";

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
    // The badge a card was opened from can be unmounted by a filter change, in
    // which case it never fires mouseleave.
    if (_activeBadge && !_activeBadge.isConnected) hideCard();

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.closest(".rmp-badge, .rmp-card")) continue;
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
    if (nameEl) processNameElement(nameEl);
  }
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
  const name = el.textContent.trim().replace(/\s+/g, " ");
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
  if (!name || name.toLowerCase() === PLACEHOLDER_NAME) return;
  attachBadge(el, name);
}

// ── Badge Injection ──────────────────────────────────────────────────────────

function attachBadge(el, name) {
  if (!_contextValid) return;

  const badge = document.createElement("span");
  badge.className = "rmp-badge rmp-loading";
  badge.textContent = "RMP…";
  badge.setAttribute("data-rmp-name", name);
  // Added beside the name rather than inside it, so that hovering or clicking
  // the badge doesn't also trigger the name's tooltip and instructor drawer.
  el.after(badge);

  try {
    chrome.runtime.sendMessage(
      { type: "GET_PROFESSOR_RATING", name },
      (response) => {
        if (chrome.runtime.lastError) {
          const msg = chrome.runtime.lastError.message || "";
          if (msg.includes("Extension context invalidated") || msg.includes("context invalidated")) {
            _contextValid = false;
            if (_observer) _observer.disconnect();
          }
          badge.remove();
          return;
        }
        const data = response?.data;
        renderBadge(badge, data);
      }
    );
  } catch (err) {
    // Extension was reloaded — context is gone
    _contextValid = false;
    if (_observer) _observer.disconnect();
    badge.remove();
  }
}

function renderBadge(badge, data) {
  badge.classList.remove("rmp-loading");

  if (!data || data.numRatings === 0) {
    badge.className = "rmp-badge rmp-not-found";
    badge.textContent = "RMP: N/A";
    badge.title = "No RateMyProfessors data found";
    return;
  }

  const rating = data.avgRating ?? 0;
  badge.className = `rmp-badge ${ratingClass(rating)}`;
  badge.textContent = `★ ${rating.toFixed(1)}`;

  badge.addEventListener("mouseenter", () => showCard(badge, data));
  badge.addEventListener("mouseleave", scheduleHide);
}

function ratingClass(r) {
  if (r >= 4.0) return "rmp-good";
  if (r >= 3.0) return "rmp-ok";
  if (r >= 2.0) return "rmp-poor";
  return "rmp-bad";
}

// ── Hover Card ───────────────────────────────────────────────────────────────

// Only one card exists at a time, built on hover. A fully scrolled schedule has
// thousands of badges, which is far too many to pre-build a card for each.
let _activeCard = null;
let _activeBadge = null;
let _hideTimer = null;

function showCard(badge, data) {
  cancelHide();
  hideCard();

  const card = buildHoverCard(data);
  card.addEventListener("mouseenter", cancelHide);
  card.addEventListener("mouseleave", scheduleHide);
  document.body.appendChild(card);

  _activeCard = card;
  _activeBadge = badge;
  positionAndShow(card, badge);
}

function hideCard() {
  _activeCard?.remove();
  _activeCard = null;
  _activeBadge = null;
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

function positionAndShow(card, badge) {
  card.style.display = "block";
  const rect = badge.getBoundingClientRect();

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
