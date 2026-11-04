# RateMyProf for PCC

A Chrome extension that injects **RateMyProfessors** ratings and reviews directly into the [Pasadena City College class schedule](https://findclasses.pasadena.edu/) — no tab switching needed.

> 💡 Inspired by [@chuckmilton](https://github.com/chuckmilton) and his work on a similar extension for CSULB. Sibling project to [RateMyProf for GCC](https://github.com/lawrenceDegoma/GCC_RatemyProf_Extension).

---

## Features

- **Inline rating badge** injected next to each professor's name
- **Hover card** showing quality score, difficulty, "would retake" %, and up to 10 recent reviews
- Color-coded ratings (green → yellow → orange → red)
- **Co-instructors covered** — badges also appear in the Instructor Information drawer
- **Automatic on page load** — no button clicks needed
- In-memory caching per session to avoid redundant API calls
- Handles the schedule's **infinite scroll and filters** via MutationObserver

---

## Installation (Developer Mode)

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select this folder
5. Navigate to the [PCC class schedule](https://findclasses.pasadena.edu/)

---

## Project Structure

```
├── manifest.json       # Extension manifest (MV3)
├── background.js       # Service worker: makes RMP GraphQL requests, matches names
├── content.js          # Injected into the schedule: finds names, injects badges
├── styles.css          # Badge + hover card styles
├── icons/
│   ├── logo.svg        # Icon source
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── PRIVACY_POLICY.md
└── README.md
```

---

## How It Works

1. **Content script** runs on `findclasses.pasadena.edu`
2. It finds each section's `Instructor:` label and reads the name beside it, skipping unassigned `Staff` sections
3. A MutationObserver scans new results as the React app renders them (the site loads more sections as you scroll)
4. For each professor found, a message is sent to the **background service worker**
5. The service worker queries the **RateMyProfessors GraphQL API** (`/graphql`) with the professor's name and PCC's school ID (`2649`), falling back to a search across all schools
6. Results are cached in memory and returned to the content script
7. The content script renders a **color-coded badge** and shows a **hover card** with stats and recent reviews

### Name matching

Catalog names and RMP names often differ, so matching is fuzzy (Jaro-Winkler + Levenshtein), but a wrong professor's rating is worse than none:

- First names can match on a prefix (`Jeff` / `Jeffrey`); surnames can't (`Ho` is not `Holden`)
- Surnames need a similarity score of at least 0.85, which allows typos (`Kohpahl` / `Kohpal`)
- Multi-part surnames can match on one part (`Sara Ruiz Hirata` / `Sara Ruiz`)
- Exact names rank ahead of fuzzy ones
- Matches from other schools must be in California with an exact surname, and the hover card names the school

---

## RateMyProfessors Details

- **School ID:** `2649` (Pasadena City College)
- **GraphQL Endpoint:** `https://www.ratemyprofessors.com/graphql`
- The school's Base64 node ID used in queries: `U2Nob29sLTI2NDk=` (`School-2649`)

---

## Troubleshooting

| Issue | Fix |
|---|---|
| Badges not appearing | Open DevTools → Console on the schedule page and check for errors. The extension finds names through the `Instructor:` label, so a site redesign may require updating `content.js`. |
| "RMP: N/A" for a professor | They may not have a profile, have no ratings yet, or their name on the schedule may be too different from RMP's. |
| CORS errors | The background service worker handles requests — make sure `background.js` is loading correctly in `chrome://extensions` |
