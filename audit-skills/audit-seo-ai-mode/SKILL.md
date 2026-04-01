---
name: seo-ai-mode-audit
description: Full SEO audit that cross-references Google Search Console data with AI Overview / AI Mode coverage to identify pages being summarized away, competitors being cited instead, and exact fixes to ship. Use when the user asks to audit a website's SEO vs AI Mode, check which pages are losing clicks to AI Overviews, find schema gaps, compare keyword rankings vs AI citation patterns, or build an AI-proof content strategy. Produces a live interactive dashboard with keyword visibility table, competitor citation map, page-level audit (H1, schema, FAQ), copy-ready schema JSON, rewrite recommendations, and internal link fix plan.
metadata:
  author: moodbiz
  version: '1.0'
  domain: SEO, AI Mode, Google Search Console, Content Strategy
---

# SEO vs AI Mode Audit Skill

## When to Use This Skill

Load this skill when the user asks to:

- Audit a website against Google AI Mode or AI Overviews
- Pull Search Console data and compare it to AI citation patterns
- Find out which pages are "being summarized away" by Google AI
- Identify which competitors are being cited in AI Overviews instead
- Generate schema markup, content rewrites, and internal link fixes
- Build a live SEO dashboard showing AI Mode exposure
- Protect organic rankings from AI Overview click cannibalization

Trigger phrases: "audit my site vs AI Mode", "which pages are losing to AI Overviews", "who is Google citing instead of me", "add schema to my pages", "AI-proof my content", "SEO vs AI", "Search Console + AI audit"

---

## Workflow

### Step 1 — Clarify Inputs

Before starting, confirm:
1. **Domain** to audit (e.g. `nhatrangtour.vip`)
2. **Date range** for Search Console data (default: 28 days)
3. **Target query set** — if not provided, derive from site content

Ask with `ask_user_question` if any of these are missing.

---

### Step 2 — Pull Search Console Data

Use the Google Search Console connector (`google_search_console__pipedream`).

Call `google_search_console-retrieve-site-performance-data` with:
- Dimensions: `["query"]` first, then `["page"]` in a second call
- Row limit: 50–100
- Date range: as specified
- Try property formats in this order:
  1. `sc-domain:{domain}` (domain property — preferred)
  2. `https://www.{domain}/`
  3. `https://{domain}/`

If all return null, note in the dashboard: "Search Console property not found under connected account" and proceed with site data only. **Do not stop the audit** — continue with crawled data.

Save raw query data to `/home/user/workspace/gsc-queries.json`.

---

### Step 3 — Crawl Top Pages

Use `browser_task` with `use_local_browser: true` to:
1. Fetch `https://{domain}/sitemap.xml` → extract all URLs
2. Pick the **top 5–10 pages** by relevance (homepage + key service/category pages)
3. For each page extract:
   - H1 tag
   - Meta description (length in chars)
   - First 300 words of body
   - All `<script type="application/ld+json">` blocks
   - Internal links present
   - Whether an FAQ section exists (text + schema)

Save findings to `/home/user/workspace/page-audit.json`.

**Key signals to flag:**
- Missing H1 → Critical
- No schema of any type → Critical
- FAQ content exists but no FAQPage schema → High
- Meta description > 160 chars or < 100 chars → Medium
- Internal links pointing to unrelated topics (not topical cluster) → Medium

---

### Step 4 — Check AI Overview Coverage

Use `browser_task` (local browser) to search Google for the **top 5–8 target queries**.

For each query record:
- AI Overview present? (yes/no)
- Which domains are cited inside the AI Overview
- What position does the target domain hold in organic results (if any)

**Queries to derive** (if not provided by user):
- Pull top 5 queries by impressions from Search Console
- Add 2–3 broad "things to do" / "best [destination/service]" queries based on the site's niche
- Add the site's primary commercial query (e.g. "shore excursions from [port]")

Save to `/home/user/workspace/ai-overview-check.json`.

---

### Step 5 — Research Competitors

Use `search_web` to understand why competitors are being cited:

1. Fetch top-cited competitor URLs from Step 4
2. Check: do they have schema? FAQ sections? Reviews embedded? Port/location-specific content?
3. Note the **single most important pattern** each competitor uses that the target site lacks

---

### Step 6 — Generate Exact Fixes

Based on Steps 3–5, generate the following for the **top 3 priority pages**:

#### A. Schema JSON Blocks (copy-ready)

For each page, generate the most impactful schema type:
- Tour/service pages → `TouristTrip` or `Product` + `AggregateRating` + `Offer`
- Informational pages with FAQ → `FAQPage`
- All pages → `BreadcrumbList`

Fill in real values (name, description, price, rating count, address) from page content. Do not use placeholders.

#### B. H1 + Opening Paragraph Rewrites

Format as "Current → Rewrite" pairs.

Rewrite rules:
- H1 must include: primary keyword + differentiator + year (e.g. "2026")
- Opening paragraph must: answer the search intent in the **first sentence**, include key specifics (price, transfer time, duration, port name, etc.)
- Mirror the pattern of the AI-cited competitor — if they lead with "Ships dock at X port, Y minutes from city", do the same

#### C. FAQ Blocks

Generate 4–5 Q&A pairs per page in "Inverted Pyramid" format (direct answer first, then detail).

FAQ rules for AI Mode optimization:
- Questions must match real voice/typed queries
- Answers must be 2–4 sentences (short enough for AI to cite verbatim)
- First sentence of each answer must be a complete standalone statement
- Include specific numbers, distances, prices, durations

#### D. Internal Link Fix Plan

Identify the **topical cluster** (3–5 pages on the same theme) and create a link table:
- From page → To page → Anchor text
- Minimum: each priority page must link to the other 2 priority pages contextually
- Flag links currently going to off-topic pages that should be replaced

---

### Step 7 — Build Dashboard

Use `run_subagent` with `subagent_type: "website_building"` to build a single-file HTML dashboard.

**Required dashboard sections:**
1. **Header** — Domain name, audit date, 3 KPI chips: AI Overviews triggered / Schema coverage / Times cited in AI
2. **Keyword Visibility Table** — Query | Volume | AI Overview | Site Position | Status | Priority (color-coded rows)
3. **Competitor Citation Map** — Cards per query showing who's cited and why they win
4. **Page Audit Table** — H1 | Schema | FAQ Schema | Meta | Internal Links | AI-Citeable Score (0–10)
5. **Ship Today Tabs** — 3 tabs: SCHEMA (JSON code blocks with copy button) | REWRITES (current vs new) | INTERNAL LINKS (table)
6. **AI Mode Checklist** — 2-column layout: requirements checklist vs your status
7. **Impact Estimator** — 3-phase timeline: Week 1-2 | Week 2-4 | Month 2

**Design spec:**
- Background: `#0f1117`, Cards: `#1a1d27`, Accent: `#00c4cc`
- Self-contained HTML, no external CDN
- Copy buttons on all code blocks
- Responsive, dark theme

Save to `/home/user/workspace/{domain}-seo-dashboard/index.html`.

Then deploy with `deploy_website`.

---

### Step 8 — Deliver Summary

After deploying, present to user:
1. **3 red-flag numbers** (AI Overviews triggered / schema gaps / times cited = 0)
2. **Keyword table** — who is winning your queries
3. **Top 3 fixes to ship today** in priority order
4. Link to live dashboard
5. Note Search Console status (connected / property not found / data gap)

---

## AI Mode Citation Patterns — Reference

These are the signals Google AI Mode rewards. Use them to evaluate pages and write fixes:

| Signal | What to check | Fix |
|--------|---------------|-----|
| Direct-answer opening | Does para 1 answer the query in 1 sentence? | Rewrite to lead with the answer |
| Specific data points | Price, distance, duration, dates in content? | Add exact numbers to first 200 words |
| FAQ with schema | FAQPage JSON-LD present? | Add schema to existing FAQ content |
| TouristTrip / Product schema | Structured data for tours/services? | Generate and add schema block |
| AggregateRating schema | Review count + rating in structured data? | Add if site has reviews |
| Port/location specificity | Exact port name + transfer time stated? | Add in first sentence of page |
| E-E-A-T signals | About page, author bio, credentials linked? | Link from content pages to About |
| Topical cluster depth | Do related pages link to each other? | Fix internal link map |

---

## Schema Templates

### TouristTrip (for tour/excursion pages)
```json
{
  "@context": "https://schema.org",
  "@type": "TouristTrip",
  "name": "[Tour Name]",
  "description": "[2-sentence description including port, duration, highlights]",
  "touristType": ["[audience]"],
  "itinerary": {
    "@type": "ItemList",
    "itemListElement": [
      {"@type": "ListItem", "position": 1, "name": "[Stop 1]"},
      {"@type": "ListItem", "position": 2, "name": "[Stop 2]"}
    ]
  },
  "provider": {
    "@type": "TravelAgency",
    "name": "[Company Name]",
    "url": "[URL]",
    "telephone": "[Phone]",
    "address": {
      "@type": "PostalAddress",
      "addressLocality": "[City]",
      "addressCountry": "[Country Code]"
    }
  },
  "offers": {
    "@type": "Offer",
    "priceCurrency": "USD",
    "price": "[price]",
    "availability": "https://schema.org/InStock"
  },
  "aggregateRating": {
    "@type": "AggregateRating",
    "ratingValue": "[rating]",
    "reviewCount": "[count]",
    "bestRating": "5"
  }
}
```

### FAQPage
```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "[Question text]",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "[2-4 sentence direct answer. First sentence must be standalone.]"
      }
    }
  ]
}
```

### BreadcrumbList (add to all pages)
```json
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    {"@type": "ListItem", "position": 1, "name": "Home", "item": "[homepage URL]"},
    {"@type": "ListItem", "position": 2, "name": "[Section]", "item": "[section URL]"},
    {"@type": "ListItem", "position": 3, "name": "[Page]", "item": "[page URL]"}
  ]
}
```

---

## Output Files

| File | Contents |
|------|----------|
| `/home/user/workspace/gsc-queries.json` | Raw Search Console query data |
| `/home/user/workspace/page-audit.json` | Per-page H1, schema, FAQ, internal link findings |
| `/home/user/workspace/ai-overview-check.json` | Per-query AI Overview presence + competitor citations |
| `/home/user/workspace/{domain}-seo-dashboard/index.html` | Live dashboard |

---

## Notes

- If Search Console returns null for all property formats, continue the audit using crawled data and note the gap in the dashboard footer. Suggest the user verify the property in [Google Search Console](https://search.google.com/search-console).
- Always use `use_local_browser: true` for browser tasks — the user's logged-in Google session is needed to see AI Overview panels accurately.
- For non-English sites (e.g. Vietnamese), AI Overview patterns may differ — check both the local-language query and the English equivalent.
- Search volume estimates: use keyword research data if available; otherwise note as "Est." and use conservative figures from Search Console impressions.
