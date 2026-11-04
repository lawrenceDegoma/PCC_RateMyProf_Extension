// background.js — Service worker handles RMP GraphQL requests to avoid CORS issues

const RMP_GRAPHQL_URL = "https://www.ratemyprofessors.com/graphql";
const RMP_SCHOOL_ID = "U2Nob29sLTI2NDk="; // Base64 of "School-2649" (Pasadena City College)

// A class search can surface hundreds of instructors at once, so cap parallel
// RMP requests instead of firing them all in the same tick.
const MAX_CONCURRENT_REQUESTS = 6;

// Cache: canonicalName → resolved data
const cache = new Map();
// In-flight: canonicalName → Promise (prevents duplicate concurrent fetches)
const inFlight = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_PROFESSOR_RATING") {
    const { firstName, lastName } = normalizeName(message.name);
    const canonicalName = `${firstName} ${lastName}`;

    if (cache.has(canonicalName)) {
      sendResponse({ data: cache.get(canonicalName) });
      return true;
    }
    if (inFlight.has(canonicalName)) {
      inFlight.get(canonicalName).then((data) => sendResponse({ data }), () => sendResponse({ data: null }));
      return true;
    }

    const promise = fetchProfessorRating(canonicalName);
    inFlight.set(canonicalName, promise);
    promise
      .then((data) => {
        cache.set(canonicalName, data);
        inFlight.delete(canonicalName);
        sendResponse({ data });
      })
      .catch((err) => {
        console.error("[RMP] Fetch error for", canonicalName, err);
        inFlight.delete(canonicalName);
        sendResponse({ data: null });
      });
    return true;
  }
});

// ── Fuzzy Name Matching (Jaro-Winkler + Levenshtein) ────────────────────────
// Adapted from github.com/chuckmilton/Rate-My-CSULB-Professors

function jaroWinkler(s1, s2) {
  const maxDist = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;
  let matches = 0;
  let transpositions = 0;
  const matchMap = new Map();
  const matchedS2 = Array(s2.length).fill(false);

  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - maxDist);
    const end = Math.min(i + maxDist + 1, s2.length);
    for (let j = start; j < end; j++) {
      if (matchedS2[j]) continue;
      if (s1[i] === s2[j]) {
        matches++;
        matchedS2[j] = true;
        matchMap.set(i, j);
        break;
      }
    }
  }

  if (!matches) return 0;

  for (let i of matchMap.keys()) {
    if (s1[i] !== s2[matchMap.get(i)]) transpositions++;
  }

  const jaro =
    (matches / s1.length + matches / s2.length + (matches - transpositions / 2) / matches) / 3;

  let prefix = 0;
  for (let i = 0; i < Math.min(s1.length, s2.length, 4); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }

  return jaro + prefix * 0.1 * (1 - jaro);
}

function levenshtein(a, b) {
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      matrix[i][j] =
        a[i - 1] === b[j - 1]
          ? matrix[i - 1][j - 1]
          : Math.min(matrix[i - 1][j], matrix[i][j - 1], matrix[i - 1][j - 1]) + 1;
  return matrix[a.length][b.length];
}

function areNamesSimilar(n1, n2) {
  if (!n1 || !n2) return false;
  // Single initial match
  if (n1.length === 1 || n2.length === 1)
    return n1.charAt(0) === n2.charAt(0);
  const jaro = jaroWinkler(n1, n2);
  const lev = 1 - levenshtein(n1, n2) / Math.max(n1.length, n2.length);
  const score = 0.7 * jaro + 0.3 * lev;
  // Use 0.85 threshold — tight enough to reject different people with similar
  // surnames (e.g. "Silberling" vs "Sterling", "Cheung" vs "Chang") but forgiving
  // enough for catalog typos and transliteration variants ("Kohpahl" vs "Kohpal").
  const threshold = Math.min(n1.length, n2.length) < 4 ? 0.92 : 0.85;
  return score >= threshold;
}

// First names also match on a prefix, for short forms like "Jeff" and "Jeffrey".
// Surnames must not: "Holden" isn't "Ho", and "Lampley" isn't "Lam".
function areFirstNamesSimilar(n1, n2) {
  if (!n1 || !n2) return false;
  return n1.startsWith(n2) || n2.startsWith(n1) || areNamesSimilar(n1, n2);
}

// ── Name Utilities ────────────────────────────────────────────────────────────

function cleanNamePart(part) {
  return part
    .replace(/(To be Announced|TBA)/gi, "")
    .replace(/,?\s+(Jr|Sr|II|III|IV)\.?$/i, "")  // remove suffixes: "Frank Oceguera III" → "Frank Oceguera"
    .replace(/\b[A-Z]\./g, "")                  // remove initial+period: "A." → ""
    .replace(/\s+\b[A-Z]\b(?=\s|$)/g, "")       // remove bare single-letter initials: "John A Smith" → "John Smith"
    .replace(/-/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// Normalize raw catalog name into { firstName, lastName }.
// Handles "LAST, FIRST", "Last, First", "First Last", ALL-CAPS, and doubled names.
function normalizeName(name) {
  let n = name.trim().replace(/\s+/g, " ");

  // Title-case if fully uppercase
  if (n === n.toUpperCase()) {
    n = n.replace(/\b\w+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  }

  // Deduplicate "Tony Biehl Tony Biehl" → "Tony Biehl"
  const half = Math.ceil(n.length / 2);
  const firstHalf = n.slice(0, half).trim();
  const secondHalf = n.slice(half).trim();
  if (firstHalf && secondHalf && secondHalf.startsWith(firstHalf)) {
    n = firstHalf;
  }

  if (n.includes(",")) {
    const [last, first] = n.split(",").map((s) => s.trim());
    return { firstName: first, lastName: last };
  }
  const parts = n.split(/\s+/);
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") || parts[0] };
}

// Generate every plausible first/last split, including swapped order.
// Mirrors the approach from chuckmilton/Rate-My-CSULB-Professors.
function generateNameCombinations(fullName) {
  const parts = fullName.trim().toLowerCase().split(/\s+/);
  const combos = [];

  for (let i = 0; i <= parts.length; i++) {
    combos.push({
      firstName: parts.slice(0, i).join(" "),
      lastName: parts.slice(i).join(" "),
    });
  }

  // Skip-middle-name variant
  if (parts.length > 2) {
    combos.push({ firstName: parts[0], lastName: parts[parts.length - 1] });
  }

  // Swapped order for "Last First" inputs
  if (parts.length === 2) {
    combos.push({ firstName: parts[1], lastName: parts[0] });
  }

  return combos;
}

// ── RMP API ───────────────────────────────────────────────────────────────────

const RMP_QUERY = `
  query TeacherSearchQuery($text: String!, $schoolID: ID!) {
    newSearch {
      teachers(query: { text: $text, schoolID: $schoolID }) {
        edges {
          node {
            id
            legacyId
            firstName
            lastName
            avgRating
            avgDifficulty
            wouldTakeAgainPercent
            numRatings
            department
            school {
              name
              city
              state
            }
            ratings(first: 10) {
              edges {
                node {
                  comment
                  qualityRating
                  difficultyRatingRounded
                  date
                  class
                  thumbsUpTotal
                  thumbsDownTotal
                }
              }
            }
          }
        }
      }
    }
  }
`;

// Same query but without schoolID scoping — for professors not linked to PCC
const RMP_QUERY_UNSCOPED = `
  query TeacherSearchUnscopedQuery($text: String!) {
    newSearch {
      teachers(query: { text: $text }) {
        edges {
          node {
            id
            legacyId
            firstName
            lastName
            avgRating
            avgDifficulty
            wouldTakeAgainPercent
            numRatings
            department
            school {
              name
              city
              state
            }
            ratings(first: 10) {
              edges {
                node {
                  comment
                  qualityRating
                  difficultyRatingRounded
                  date
                  class
                  thumbsUpTotal
                  thumbsDownTotal
                }
              }
            }
          }
        }
      }
    }
  }
`;

let activeRequests = 0;
const waitingRequests = [];

async function withRequestSlot(fn) {
  if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
    await new Promise((resolve) => waitingRequests.push(resolve));
  } else {
    activeRequests++;
  }
  try {
    return await fn();
  } finally {
    // Hand this slot straight to the next waiter, or free it.
    const next = waitingRequests.shift();
    if (next) next();
    else activeRequests--;
  }
}

async function rmpSearch(text, scopeToSchool = true) {
  const query = scopeToSchool ? RMP_QUERY : RMP_QUERY_UNSCOPED;
  const variables = scopeToSchool ? { text, schoolID: RMP_SCHOOL_ID } : { text };

  const response = await withRequestSlot(() =>
    fetch(RMP_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Basic dGVzdDp0ZXN0",
        "Referer": "https://www.ratemyprofessors.com/",
        "Origin": "https://www.ratemyprofessors.com",
      },
      body: JSON.stringify({ query, variables }),
    })
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json = await response.json();
  if (json.errors) console.error("[RMP] GraphQL errors:", JSON.stringify(json.errors));
  return json?.data?.newSearch?.teachers?.edges ?? [];
}

async function fetchProfessorRating(fullName) {
  const cleanedName = cleanNamePart(fullName);
  const { firstName, lastName } = normalizeName(cleanedName);
  const nameCombinations = generateNameCombinations(cleanedName);

  // Try every search term in order; move to next if results come back but no name matches.
  // Scoped (PCC-only) terms first, then unscoped fallbacks.
  // Deduplication ensures we never fire the same (term, scoped) pair twice.
  const allTerms = [
    { term: cleanedName, scoped: true  },
    { term: lastName,    scoped: true  },
    { term: firstName,   scoped: true  },
    { term: lastName,    scoped: false },
    { term: cleanedName, scoped: false },
    { term: firstName,   scoped: false },
  ].filter((item, i, arr) =>
    item.term &&
    arr.findIndex((x) => x.term === item.term && x.scoped === item.scoped) === i
  );

  let lastError = null;

  for (const { term, scoped } of allTerms) {
    const label = scoped ? "scoped" : "unscoped";
    console.log(`[RMP] Searching (${label}): "${term}"`);

    let edges;
    try {
      edges = await rmpSearch(term, scoped);
    } catch (err) {
      console.error(`[RMP] API error for "${term}":`, err);
      lastError = err;
      continue;
    }

    if (!edges || edges.length === 0) {
      console.warn(`[RMP] No results for ${label} "${term}"`);
      continue;
    }

    console.log(`[RMP] ${edges.length} candidate(s) via ${label} "${term}":`);
    edges.forEach(({ node }) =>
      console.log(`  ${node.firstName} ${node.lastName} | dept: ${node.department} | school: ${node.school?.name} | ratings: ${node.numRatings}`)
    );

    const match = pickBestMatch(edges, nameCombinations);
    if (match) {
      console.log(`[RMP] Matched: ${match.firstName} ${match.lastName} | dept: ${match.department} | rating: ${match.avgRating}`);
      return {
        firstName: match.firstName,
        lastName: match.lastName,
        avgRating: match.avgRating,
        avgDifficulty: match.avgDifficulty,
        wouldTakeAgainPercent: match.wouldTakeAgainPercent,
        numRatings: match.numRatings,
        department: match.department,
        school: match.school?.name,
        isPCC: isPCCSchool(match.school),
        recentReviews: (match.ratings?.edges || []).map((e) => e.node),
        profileUrl: `https://www.ratemyprofessors.com/professor/${match.legacyId}`,
      };
    }

    console.warn(`[RMP] No name match among candidates for ${label} "${term}", trying next...`);
  }

  // A failed request isn't proof the professor has no profile; throw so the
  // result isn't cached as "not found" for the rest of the session.
  if (lastError) throw lastError;

  console.warn(`[RMP] Exhausted all search attempts for "${cleanedName}"`);
  return null;
}

// Extract name matching into a standalone function so the search loop can call it
// at each step and continue to the next term if nothing matches.
function isPCCSchool(school) {
  return (school?.name || "").toLowerCase().includes("pasadena city college");
}

function pickBestMatch(edges, nameCombinations) {
  const candidates = [];

  for (const { node } of edges) {
    const profFirst = cleanNamePart(node.firstName).toLowerCase();
    const profLast = cleanNamePart(node.lastName).toLowerCase();
    const profLastParts = profLast.split(" ");
    const isPCC = isPCCSchool(node.school);

    // Adjuncts often teach at several local colleges, but the same name in another
    // state, or a merely similar name at another school, is usually someone else.
    if (!isPCC && node.school?.state !== "CA") continue;

    const isExact = nameCombinations.some(
      ({ firstName, lastName }) => firstName === profFirst && lastName === profLast
    );

    for (const { firstName: qFirst, lastName: qLast } of nameCombinations) {
      if (!qFirst || !qLast) continue;

      if (!isPCC && profLast !== qLast) continue;

      const firstMatch =
        qFirst.length === 1
          ? profFirst.startsWith(qFirst)
          : areFirstNamesSimilar(profFirst, qFirst) ||
            (profFirst.length === 1 && qFirst.startsWith(profFirst));

      // Either side may list only some of a multi-part surname:
      // "Silvia Cervantes Cortes" can be "Silvia Cervantes" on RMP.
      const lastMatch =
        areNamesSimilar(profLast, qLast) ||
        areNamesSimilar(profLast.replace(/ /g, ""), qLast.replace(/ /g, "")) ||
        profLastParts.some((part) => areNamesSimilar(part, qLast)) ||
        qLast.split(" ").some((part) => areNamesSimilar(part, profLast));

      const prefixMatch =
        profLast === qLast && qFirst.length > 0 && profFirst.startsWith(qFirst);

      if ((firstMatch && lastMatch) || prefixMatch) {
        candidates.push({ node, isPCC, isExact });
        break;
      }
    }
  }

  if (candidates.length === 0) return null;

  // PCC professors first, then exact names, then by rating count
  candidates.sort((a, b) => {
    if (a.isPCC !== b.isPCC) return a.isPCC ? -1 : 1;
    if (a.isExact !== b.isExact) return a.isExact ? -1 : 1;
    return (b.node.numRatings || 0) - (a.node.numRatings || 0);
  });

  return candidates[0].node;
}
