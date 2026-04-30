---
name: seo-ai-mode-audit
description: >-
  Full SEO audit cross-referencing Google Search Console with AI Overview / AI Mode coverage.
  Identifies pages being summarized away, competitors cited instead, and exact fixes to ship.
  Works for all 7 website types: content/blog, service/ecommerce, B2B event/exhibition,
  B2B portal/directory, brand/local business, consultancy/lead-gen, and real estate.
  Use when auditing SEO vs AI Mode, checking pages losing clicks to AI Overviews, finding schema gaps,
  comparing keyword rankings vs AI citation patterns, or building an AI-proof content strategy.
  Produces a live dashboard with keyword visibility table, competitor citation map, page audit
  (H1, schema, FAQ), copy-ready schema JSON, rewrite recommendations, and internal link fix plan.
metadata:
  author: moodbiz
  version: '2.1'
  domain: SEO, AI Mode, GSC, B2B, Events, Tourism, Ecommerce, Real Estate, Consultancy, Local Business
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

Trigger phrases: "audit my site vs AI Mode", "which pages are losing to AI Overviews", "who is Google citing instead of me", "add schema to my pages", "AI-proof my content", "SEO vs AI", "Search Console + AI audit", "audit SEO cho website", "kiểm tra AI Overview"

---

## Workflow

### Step 1 — Clarify Inputs + Detect Site Type

Before starting, confirm:
1. **Domain** to audit
2. **Date range** for Search Console data (default: 28 days)
3. **Target query set** — if not provided, derive from site content (see Step 4)

Ask with `ask_user_question` if any of these are missing.

**Then detect site type** by fetching the homepage and sitemap. Use the table below — this determines the Mode for Steps 3, 4, and 6:

| Site Type | Key Signals | Mode |
|-----------|-------------|------|
| **Content/Blog** | 20+ pages, regular publishing, article dates | Standard |
| **Service/Ecommerce** | Product/service pages, VND/USD pricing, cart or booking flow | Standard |
| **Event/Exhibition** | Date-bound (event name + year), registration CTA, < 10 pages | Event |
| **B2B Portal/Directory** | Multiple company listings, category filters, pagination | B2B Portal |
| **Brand/Local Business** | No online cart, requires phone/visit, local address prominent | Local |
| **Consultancy/Lead-Gen** | No pricing shown, CTA = "book consultation" / "register for advice", content is the funnel | Consultancy |
| **Real Estate** | Project listings, floor plans, price/m², developer brand, investor audience | Real Estate |

**Pre-launch edge case:** If homepage shows "coming soon" / "under construction" / staging environment → skip Steps 2–6, jump directly to outputting a **Pre-launch SEO Checklist** (see Notes).

If still unclear after fetching homepage, default to **Standard Mode**.

---

### Step 2 — Pull Search Console Data

Use the Google Search Console connector (`google_search_console__pipedream`).

Call `google_search_console-retrieve-site-performance-data` with:
- Dimensions: `["query"]` first, then `["page"]` in a second parallel call
- Row limit: 50–100
- Date range: as specified
- Try property formats in this order:
  1. `sc-domain:{domain}` (domain property — preferred)
  2. `https://www.{domain}/`
  3. `https://{domain}/`

If all return null: note in the dashboard footer "Search Console property not found under connected account — verify at https://search.google.com/search-console" and **continue with crawled data**. Do not stop.

Save raw query data to `/home/user/workspace/gsc-queries.json`.

---

### Step 3 — Crawl Pages

Use `browser_task` with `use_local_browser: true`.

**Standard Mode** (Content / Service / Ecommerce):
1. Fetch sitemap → extract all URLs
2. Pick top 5–10 pages: homepage + key service/category/product pages
3. For each: H1, meta description (char count), first 300 words, all `<script type="application/ld+json">`, internal links, FAQ presence

**Event Mode** (< 10 pages or single-page promo):
1. Audit ALL pages found
2. Add column: **"Missing Pages to Create"** — suggest by event type (see Step 6D)
3. Flag if homepage is doing the job of 5+ pages (low crawlability)

**B2B Portal Mode**:
1. Prioritize: homepage + 1 category page + 1 listing/detail page + About/Contact
2. Check for ItemList schema on category pages, pagination markup
3. Flag missing Organization schema per listed company

**Local Mode** (Brand/Local Business — no online cart):
1. Fetch homepage + any service pages + contact page
2. Flag missing: physical address in content, phone number visible above fold, Google Business Profile link
3. Check for `LocalBusiness` or subtype schema (e.g. `AutoRepair`, `ClothingStore`, `MedicalBusiness`)

**Consultancy Mode** (Lead-Gen / Agency / Education):
1. Fetch homepage + each service/program page + blog (sample 2–3 articles) + About/Team page
2. Flag: missing consultant/team profiles (E-E-A-T), no case studies or testimonials with schema, blog articles without `Article` schema
3. Check if CTA pages (contact/booking) have a dedicated URL or are modal-only (modal = not indexable)

**Real Estate Mode**:
1. Fetch homepage + 1 project page + 1 floor plan/pricing page + contact
2. Flag: missing project address, price range, developer name in first 200 words
3. Check for `RealEstateAgent` or `Residence`/`Apartment` schema

For all modes, save findings to `/home/user/workspace/page-audit.json`.

**Universal flags (apply to all modes):**
- Missing H1 → Critical
- No schema of any type → Critical
- FAQ content exists but no FAQPage schema → High
- Meta description > 160 chars or < 100 chars → Medium
- Internal links pointing to off-topic pages → Medium
- Single page overloaded with multiple intents → High

---

### Step 4 — Check AI Overview Coverage

Use `browser_task` (local browser) to search Google for 5–8 target queries.

For each query record:
- AI Overview present? (yes/no)
- Domains cited inside the AI Overview
- Target domain position in organic results (if any)

**Query derivation by mode:**

**Standard** (Service/Ecommerce/Content):
- Top 5 by impressions from GSC
- 2–3 "best [product/service]" or "how to [action]" queries
- Primary commercial query: "mua [sản phẩm] ở đâu", "[dịch vụ] tốt nhất tại [thành phố]"

**Event**:
- "[Tên sự kiện] [năm]" — brand + year
- "triển lãm [ngành] [thành phố] [năm]"
- "đăng ký [tên sự kiện]" — registration intent
- "[tên sự kiện] lịch trình / địa điểm / phí"
- English equivalent for international exhibitors

**B2B Portal**:
- "[Danh mục] nhà cung cấp Việt Nam"
- "[Sản phẩm] B2B [ngành]"
- "công ty [ngành] uy tín Việt Nam"

**Local Business**:
- "[Dịch vụ] tại [quận/thành phố]" — local intent
- "[Tên thương hiệu/hãng] [dịch vụ] TPHCM" — brand + location
- "sửa chữa / mua / thuê [X] gần đây" — near-me intent

**Consultancy/Lead-Gen**:
- "[Dịch vụ tư vấn] uy tín" — discovery
- "chi phí [dịch vụ]" — pricing research
- "[vấn đề khách hàng] giải quyết như thế nào" — problem-aware
- "[tên công ty] review / đánh giá" — validation

**Real Estate**:
- "[Tên dự án] bảng giá / pháp lý / tiến độ"
- "mua căn hộ [khu vực] [năm]"
- "chủ đầu tư [tên công ty] dự án"
- "[loại BĐS] [quận/tỉnh] giá bao nhiêu"

Save to `/home/user/workspace/ai-overview-check.json`.

---

### Step 5 — Research Competitors

Use `search_web` to understand why competitors are being cited:
1. Top-cited competitor URLs from Step 4
2. For each: schema presence, FAQ sections, reviews, content specificity
3. Note the **single most important pattern** each competitor uses that the target site lacks

**Mode-specific extra checks:**

- **Event**: Has Event schema with exact dates? Speaker/exhibitor names listed? Dedicated registration page indexed?
- **Local**: Has Google Business Profile embedded or cited? Address + hours visible in first 100 words?
- **Consultancy**: Has case studies with outcomes? Team profiles with credentials? Blog with specific numbers (e.g. "98% visa approval rate")?
- **Real Estate**: Has price-per-m² mentioned? Project legal status stated? Developer track record cited?

---

### Step 6 — Generate Exact Fixes

Generate fixes for the **top 3 priority pages** (or all pages if Event/Local Mode with < 5 pages).

#### A. Schema JSON Blocks (copy-ready)

Select schema by mode and page function:

| Page type | Primary schema | Secondary |
|-----------|---------------|-----------|
| Tour / excursion | `TouristTrip` | `AggregateRating`, `Offer` |
| Product / ecommerce | `Product` | `AggregateRating`, `Offer` |
| Service page (B2B) | `Service` | `Organization`, `Offer` |
| Event homepage | `ExhibitionEvent` | `Organization`, `Offer` |
| Event schedule/detail | `Event` | `ItemList` |
| Local business (general) | `LocalBusiness` | `OpeningHoursSpecification` |
| Auto garage | `AutoRepair` | `LocalBusiness` |
| Tailor / fashion | `ClothingStore` | `LocalBusiness` |
| Hotel / resort | `LodgingBusiness` | `Offer`, `AggregateRating` |
| Healthcare / pharmacy | `MedicalBusiness` | `LocalBusiness` |
| Supplement / health product B2B | `Product` + `Organization` | `Offer` (B2B pricing) |
| Consultancy / agency | `ProfessionalService` | `FAQPage`, `Person` (team) |
| Education consultancy | `EducationalOrganization` | `Course`, `FAQPage` |
| Real estate developer | `RealEstateAgent` | `Residence`/`Apartment`, `Offer` |
| Real estate project page | `Residence` or `Apartment` | `Offer`, `Place` |
| Blog / article | `Article` | `BreadcrumbList` |
| FAQ or guide page | `FAQPage` | `BreadcrumbList` |
| B2B listing / directory entry | `Organization` | `LocalBusiness` |
| All pages | `BreadcrumbList` | — |

Fill in **real values** from page content. No placeholders.

#### B. H1 + Opening Paragraph Rewrites

Format as "Current → Rewrite" pairs. Universal rules:
- H1: primary keyword + differentiator + year
- Opening sentence: answers search intent directly, includes key specifics

**Mode-specific specifics to include in opening:**
- Standard: price range, key feature, location
- Event: exact dates (DD/MM/YYYY), venue name + city, audience type
- Local: address/district, phone, specific service + brand names handled
- Consultancy: years of experience, success metric (e.g. "98% tỉ lệ đậu visa"), who it's for
- Real Estate: project name, location, price range (VND/m²), legal status (sổ hồng / 50 năm...)

#### C. FAQ Blocks

Generate 4–5 Q&A pairs per page. Universal rules:
- Questions match real typed/voice queries
- Answers: 2–4 sentences, first sentence standalone
- Include specific numbers

**Mode-specific FAQ starters:**

*Event:* "Triển lãm [X] diễn ra khi nào?" / "Chi phí tham gia?" / "Ai nên tham dự?" / "Cách đặt lịch giao thương?"

*Local:* "[Dịch vụ] giá bao nhiêu?" / "Có bảo hành không?" / "Địa chỉ ở đâu / giờ làm việc?" / "Có hỗ trợ [thương hiệu X] không?"

*Consultancy:* "Chi phí tư vấn [dịch vụ] là bao nhiêu?" / "Quy trình làm việc như thế nào?" / "Tỷ lệ thành công?" / "Mất bao lâu?"

*Real Estate:* "Dự án [X] pháp lý như thế nào?" / "Giá bán [dự án] bao nhiêu/m²?" / "Tiến độ xây dựng hiện tại?" / "Chủ đầu tư [X] có uy tín không?"

#### D. Internal Link Fix Plan + Missing Pages

**Standard/B2B/Consultancy/Real Estate:** Link table — From → To → Anchor text. Minimum 2 contextual links per priority page.

**Event Mode — Missing Pages to Create (if < 5 pages):**

| Page | Slug | H1 gợi ý | Intent |
|------|------|---------|--------|
| Lịch trình | `/lich-trinh` | "[Sự kiện] [Năm] — Lịch Trình Chi Tiết" | Logistical |
| Đăng ký | `/dang-ky` | "Đăng Ký Tham Dự [Sự kiện] [Năm]" | Conversion |
| Nhà trưng bày | `/nha-trung-bay` | "Danh Sách Nhà Trưng Bày [Sự kiện] [Năm]" | Discovery |
| Khách tham quan | `/khach-tham-quan` | "Thông Tin Khách Tham Quan [Sự kiện]" | Informational |
| Giới thiệu | `/ve-su-kien` | "[Sự kiện] Là Gì? Giới Thiệu Triển Lãm" | E-E-A-T |

**Local Mode — Missing Pages to Create (if service pages missing):**

| Page | Slug | H1 gợi ý | Intent |
|------|------|---------|--------|
| Dịch vụ chính | `/dich-vu/[ten-dv]` | "[Dịch vụ] tại [Địa điểm] — [USP]" | Commercial |
| Bảng giá | `/bang-gia` | "Bảng Giá [Dịch vụ] [Năm] — [Tên công ty]" | Pricing |
| Liên hệ/Địa chỉ | `/lien-he` | "Liên Hệ [Tên công ty] — Địa Chỉ & Giờ Làm Việc" | Local |
| Blog/Tin tức | `/blog` | (first article) | Topical authority |

---

### Step 7 — Build Dashboard

Use `run_subagent` with `subagent_type: "website_building"` to build a single-file HTML dashboard.

**Required sections (all modes):**
1. **Header** — Domain, audit date, site type badge, 3 KPI chips: AI Overviews triggered / Schema coverage / Times cited in AI
2. **Keyword Visibility Table** — Query | Volume | AI Overview | Position | Status | Priority (color-coded)
3. **Competitor Citation Map** — Cards per query: who's cited and why
4. **Page Audit Table** — H1 | Schema | FAQ Schema | Meta | Internal Links | AI-Citeable Score (0–10)
5. **Ship Today Tabs** — SCHEMA (JSON + copy button) | REWRITES (current → new) | LINKS / MISSING PAGES
6. **AI Mode Checklist** — 2-column: requirements vs your status
7. **Impact Estimator** — 3-phase timeline

**Event/Local extra:** Add "Missing Pages" card between Page Audit and Ship Today.

**Design spec:**
- Background: `#0f1117` · Cards: `#1a1d27` · Accent: `#00c4cc`
- Self-contained HTML, no CDN, copy buttons on all code blocks, responsive

Save to `/home/user/workspace/{domain}-seo-dashboard/index.html`, deploy with `deploy_website`.

---

### Step 8 — Deliver Summary

Present to user:
1. Site type detected + mode used
2. 3 red-flag numbers (AI Overviews triggered / schema gaps / times cited)
3. Keyword table — who is winning your queries
4. Top 3 fixes to ship today in priority order
5. *(Event/Local Mode)* Top 2 missing pages to create this week
6. Link to live dashboard
7. Search Console status note

---

## AI Mode Citation Patterns — Reference

### Universal (all site types)

| Signal | Check | Fix |
|--------|-------|-----|
| Direct-answer opening | Para 1 answers query in 1 sentence? | Rewrite to lead with the answer |
| Specific data points | Numbers (price, distance, duration, dates) in first 200 words? | Add exact figures upfront |
| FAQ with schema | FAQPage JSON-LD present? | Add schema around existing FAQ content |
| AggregateRating | Review count + rating in structured data? | Add if site has testimonials/reviews |
| E-E-A-T signals | About page, team profiles, credentials linked from content? | Link content → About/Team |
| Topical cluster | Related pages link to each other contextually? | Fix internal link map |

### Event/Exhibition

| Signal | Check | Fix |
|--------|-------|-----|
| Exact dates | DD/MM/YYYY in H1 and opening? | Add dates upfront |
| Venue specificity | Full venue name + district + city? | Add in opening paragraph |
| Organizer authority | Organization name + track record? | Add Organization schema |
| Exhibitor/visitor count | Concrete numbers stated? | Add to stats block |
| B2B meeting mechanic | Pre-scheduled meeting system explained? | Add as FAQ + feature section |
| Registration deadline | Deadline + price in Offer schema? | Add ExhibitionEvent with Offer |

### Brand/Local Business

| Signal | Check | Fix |
|--------|-------|-----|
| Address in content | Physical address in first 200 words? | Add with LocalBusiness schema |
| Hours of operation | OpeningHoursSpecification schema? | Add to LocalBusiness block |
| Phone above the fold | Phone number visible without scrolling? | Move phone to header/hero |
| Google Business Profile | GBP linked or embed present? | Add GBP link + embed map |
| Service + brand names | Specific brands/models serviced stated? | List in opening paragraph |

### Consultancy/Lead-Gen

| Signal | Check | Fix |
|--------|-------|-----|
| Success metrics | Specific numbers (tỉ lệ thành công, số năm, số khách)? | Add to hero section + schema |
| Consultant profiles | Named team members with credentials? | Add Person schema per consultant |
| Case studies | Client outcomes with specifics? | Add Article/Review schema |
| Dedicated CTA page | Contact/booking page has own indexable URL? | Create /lien-he or /dat-lich |
| Process transparency | Step-by-step process explained? | Add as numbered list + FAQ |

### Real Estate

| Signal | Check | Fix |
|--------|-------|-----|
| Price per m² | Price range stated in opening? | Add to H1 or first paragraph |
| Legal status | Sổ hồng / sổ đỏ / 50 năm stated? | Add to opening + schema |
| Developer credibility | Past projects listed with completion status? | Add Organization schema with track record |
| Location specifics | Exact address + distance to landmarks? | Add to Place schema |
| Progress updates | Construction % or handover date? | Add to Event (handover) schema |

---

## Schema Templates

### ExhibitionEvent
```json
{
  "@context": "https://schema.org",
  "@type": "ExhibitionEvent",
  "name": "[Tên triển lãm + năm]",
  "description": "[2-3 câu: ngành, đối tượng, điểm nổi bật]",
  "startDate": "[YYYY-MM-DD]",
  "endDate": "[YYYY-MM-DD]",
  "eventStatus": "https://schema.org/EventScheduled",
  "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
  "location": {
    "@type": "Place",
    "name": "[Tên địa điểm]",
    "address": {
      "@type": "PostalAddress",
      "streetAddress": "[Địa chỉ]",
      "addressLocality": "[Thành phố]",
      "addressCountry": "VN"
    }
  },
  "organizer": { "@type": "Organization", "name": "[BTC]", "url": "[URL]" },
  "offers": {
    "@type": "Offer",
    "url": "[URL đăng ký]",
    "price": "[Phí]",
    "priceCurrency": "VND",
    "availability": "https://schema.org/InStock",
    "validFrom": "[YYYY-MM-DD]",
    "validThrough": "[YYYY-MM-DD]"
  },
  "audience": { "@type": "Audience", "audienceType": "[Đối tượng]" }
}
```

### LocalBusiness (brand/local business, garage, tailor, showroom)
```json
{
  "@context": "https://schema.org",
  "@type": "[LocalBusiness hoặc subtype: AutoRepair / ClothingStore / MedicalBusiness / ElectronicsStore]",
  "name": "[Tên cửa hàng/doanh nghiệp]",
  "description": "[Mô tả dịch vụ + khu vực phục vụ]",
  "url": "[URL]",
  "telephone": "[SĐT]",
  "address": {
    "@type": "PostalAddress",
    "streetAddress": "[Địa chỉ]",
    "addressLocality": "[Quận/Huyện]",
    "addressRegion": "[Tỉnh/TP]",
    "addressCountry": "VN"
  },
  "geo": {
    "@type": "GeoCoordinates",
    "latitude": "[lat]",
    "longitude": "[lng]"
  },
  "openingHoursSpecification": [
    {
      "@type": "OpeningHoursSpecification",
      "dayOfWeek": ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"],
      "opens": "08:00",
      "closes": "18:00"
    }
  ],
  "aggregateRating": {
    "@type": "AggregateRating",
    "ratingValue": "[rating]",
    "reviewCount": "[count]",
    "bestRating": "5"
  }
}
```

### ProfessionalService (consultancy, agency, legal, marketing)
```json
{
  "@context": "https://schema.org",
  "@type": "ProfessionalService",
  "name": "[Tên công ty tư vấn]",
  "description": "[Dịch vụ + đối tượng phục vụ + điểm khác biệt]",
  "url": "[URL]",
  "telephone": "[SĐT]",
  "areaServed": { "@type": "Country", "name": "Vietnam" },
  "hasOfferCatalog": {
    "@type": "OfferCatalog",
    "name": "Dịch vụ",
    "itemListElement": [
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "[Tên dịch vụ 1]" } },
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "[Tên dịch vụ 2]" } }
    ]
  },
  "aggregateRating": {
    "@type": "AggregateRating",
    "ratingValue": "[rating]",
    "reviewCount": "[count]",
    "bestRating": "5"
  }
}
```

### EducationalOrganization (du học, đào tạo)
```json
{
  "@context": "https://schema.org",
  "@type": "EducationalOrganization",
  "name": "[Tên tổ chức]",
  "description": "[Chuyên ngành + kinh nghiệm + thành tích nổi bật]",
  "url": "[URL]",
  "telephone": "[SĐT]",
  "address": {
    "@type": "PostalAddress",
    "addressLocality": "[Thành phố]",
    "addressCountry": "VN"
  },
  "hasCredential": "[Tên chứng chỉ/giải thưởng nếu có]",
  "alumni": { "@type": "Person", "name": "[Tên học viên tiêu biểu]" }
}
```

### RealEstateAgent + Residence (bất động sản)
```json
{
  "@context": "https://schema.org",
  "@type": "RealEstateAgent",
  "name": "[Tên chủ đầu tư / sàn BĐS]",
  "url": "[URL]",
  "telephone": "[SĐT]",
  "address": {
    "@type": "PostalAddress",
    "addressLocality": "[Thành phố]",
    "addressCountry": "VN"
  }
}
```
```json
{
  "@context": "https://schema.org",
  "@type": "Residence",
  "name": "[Tên dự án]",
  "description": "[Mô tả dự án: vị trí, loại hình, pháp lý, tiến độ]",
  "address": {
    "@type": "PostalAddress",
    "streetAddress": "[Địa chỉ dự án]",
    "addressLocality": "[Quận/Huyện]",
    "addressRegion": "[Tỉnh/TP]",
    "addressCountry": "VN"
  },
  "offers": {
    "@type": "Offer",
    "priceCurrency": "VND",
    "price": "[Giá từ]",
    "availability": "https://schema.org/InStock"
  },
  "numberOfRooms": "[Số phòng ngủ điển hình]",
  "floorSize": { "@type": "QuantitativeValue", "value": "[m²]", "unitCode": "MTK" }
}
```

### TouristTrip (tour/excursion)
```json
{
  "@context": "https://schema.org",
  "@type": "TouristTrip",
  "name": "[Tour Name]",
  "description": "[Port, duration, highlights — 2 sentences]",
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
    "name": "[Company]", "url": "[URL]", "telephone": "[Phone]",
    "address": { "@type": "PostalAddress", "addressLocality": "[City]", "addressCountry": "[CC]" }
  },
  "offers": { "@type": "Offer", "priceCurrency": "USD", "price": "[price]", "availability": "https://schema.org/InStock" },
  "aggregateRating": { "@type": "AggregateRating", "ratingValue": "[rating]", "reviewCount": "[count]", "bestRating": "5" }
}
```

### Product (ecommerce / brand distributor / supplement B2B)
```json
{
  "@context": "https://schema.org",
  "@type": "Product",
  "name": "[Tên sản phẩm]",
  "description": "[Mô tả: công dụng, chất liệu, đối tượng sử dụng]",
  "brand": { "@type": "Brand", "name": "[Tên thương hiệu]" },
  "offers": {
    "@type": "Offer",
    "priceCurrency": "VND",
    "price": "[Giá]",
    "availability": "https://schema.org/InStock",
    "url": "[URL trang sản phẩm]"
  },
  "aggregateRating": {
    "@type": "AggregateRating",
    "ratingValue": "[rating]", "reviewCount": "[count]", "bestRating": "5"
  }
}
```

### LodgingBusiness (hotel, resort, boutique hotel)
```json
{
  "@context": "https://schema.org",
  "@type": "LodgingBusiness",
  "name": "[Tên khách sạn]",
  "description": "[Phong cách, vị trí, USP — 2 câu tiếng Anh nếu target khách quốc tế]",
  "url": "[URL]",
  "telephone": "[Phone]",
  "address": {
    "@type": "PostalAddress",
    "streetAddress": "[Địa chỉ]",
    "addressLocality": "Ho Chi Minh City",
    "addressCountry": "VN"
  },
  "geo": { "@type": "GeoCoordinates", "latitude": "[lat]", "longitude": "[lng]" },
  "starRating": { "@type": "Rating", "ratingValue": "[số sao]" },
  "aggregateRating": { "@type": "AggregateRating", "ratingValue": "[rating]", "reviewCount": "[count]", "bestRating": "10" },
  "amenityFeature": [
    { "@type": "LocationFeatureSpecification", "name": "Free WiFi", "value": true },
    { "@type": "LocationFeatureSpecification", "name": "Restaurant", "value": true }
  ]
}
```

### Organization (chung cho mọi tổ chức)
```json
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "[Tên]", "url": "[URL]", "logo": "[URL logo]",
  "description": "[Mô tả ngắn]", "foundingDate": "[Năm]",
  "address": { "@type": "PostalAddress", "streetAddress": "[Địa chỉ]", "addressLocality": "[TP]", "addressCountry": "VN" },
  "contactPoint": { "@type": "ContactPoint", "contactType": "customer service", "telephone": "[SĐT]", "email": "[Email]" }
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
      "name": "[Câu hỏi — khớp cách người dùng gõ Google]",
      "acceptedAnswer": { "@type": "Answer", "text": "[2-4 câu. Câu đầu standalone.]" }
    }
  ]
}
```

### BreadcrumbList (tất cả pages)
```json
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    {"@type": "ListItem", "position": 1, "name": "Home", "item": "[URL trang chủ]"},
    {"@type": "ListItem", "position": 2, "name": "[Section]", "item": "[URL section]"},
    {"@type": "ListItem", "position": 3, "name": "[Page]", "item": "[URL page]"}
  ]
}
```

---

## Site Type → Mode Quick Reference

| Website | Mode |
|---------|------|
| nhatrangtour.vip | Standard (Service/Ecommerce) |
| fbcasean.vn | Event |
| huynhgiatrading.com | Standard (Service/Ecommerce) |
| changmibedding.com | Standard (Service/Ecommerce) |
| dulichhoanmy.com | Standard (Service/Ecommerce) |
| mitsubishicleansui.vn | Local (Brand/Distributor) |
| electricbee.vn | Local (Brand/Distributor) |
| autophumy.vn | Local (AutoRepair) |
| 3piecestailor.vn | Local (ClothingStore) |
| pharmadi.vn | Local (Brand/Distributor B2B — supplement) |
| set-edu.com | Consultancy/Lead-Gen |
| jnt.asia | Consultancy/Lead-Gen |
| moodbiz.vn | Consultancy/Lead-Gen |
| amanaki.vn | Local (LodgingBusiness) |
| dbhomes.com.vn | Real Estate |

---

## Output Files

| File | Contents |
|------|----------|
| `/home/user/workspace/gsc-queries.json` | Raw GSC query data |
| `/home/user/workspace/page-audit.json` | Per-page H1, schema, FAQ, internal links, missing pages |
| `/home/user/workspace/ai-overview-check.json` | Per-query AI Overview + competitor citations |
| `/home/user/workspace/{domain}-seo-dashboard/index.html` | Live dashboard |

---

## Notes

- **Pre-launch / Coming Soon sites**: If homepage shows a placeholder/staging page → skip audit → output "Pre-launch SEO Checklist": (1) URL structure plan, (2) schema types to implement at launch, (3) 5 priority pages to create, (4) GSC property verification reminder, (5) sitemap.xml to submit on launch day.
- If Search Console returns null for all property formats, continue audit with crawled data and note in dashboard footer.
- Always use `use_local_browser: true` for browser tasks — logged-in Google session needed for AI Overview panels.
- For Vietnamese sites, check both Vietnamese-language queries AND English equivalents (Google often surfaces English AI Overviews for mixed-intent queries, especially for hospitality, real estate, and events targeting international audiences).
- Search volume estimates: use GSC impressions if available; otherwise label "Est." with conservative figures.
- **Event Mode priority**: For < 5 pages, highest-leverage fix is *creating missing pages* before optimizing existing ones.
- **Local Mode priority**: Highest-leverage fix is often Google Business Profile optimization + LocalBusiness schema — not content rewriting.
- **Consultancy Mode priority**: Content quality (case studies, credentials, FAQ) matters more than technical SEO for AI citations in this niche.
- **Real Estate Mode priority**: Legal status + price clarity + developer credibility are the 3 signals AI Mode cites most for BĐS queries in Vietnam.
