import fetch from 'node-fetch';

let admin = null;
let db = null;
let BigQuery = null;
let google = null;

let bq = null;
let gsc = null;
let ad = null;
let aa = null;

async function initClients() {
  if (!admin) {
    try {
      const { default: firebaseAdmin } = await import('firebase-admin');
      admin = firebaseAdmin;
      
      if (!admin.apps.length) {
        admin.initializeApp({
          credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
          }),
        });
      }
      db = admin.firestore();

      const { BigQuery: bqClass } = await import('@google-cloud/bigquery');
      BigQuery = bqClass;

      const { google: g } = await import('googleapis');
      google = g;
    } catch (error) {
      console.error('Safe Load Error (SEO):', error);
      throw error;
    }
  }

  if (!bq) {
    bq = new BigQuery({
      projectId: process.env.FIREBASE_PROJECT_ID,
      location: process.env.BIGQUERY_LOCATION || 'asia-southeast1',
      credentials: {
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }
    });
  }

  if (!gsc || !ad || !aa) {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GSC_CLIENT_ID,
      process.env.GSC_CLIENT_SECRET
    );
    oauth2Client.setCredentials({
      refresh_token: process.env.GSC_REFRESH_TOKEN
    });

    gsc = google.searchconsole({ version: 'v1', auth: oauth2Client });
    ad = google.analyticsdata({ version: 'v1beta', auth: oauth2Client }); 
    aa = google.analyticsadmin({ version: 'v1alpha', auth: oauth2Client });
  }

  // Get the auth client back from the services if needed, but we have it here
  const auth = gsc.context._options.auth;

  return { admin, db, bq, gsc, ad, aa, oauth2Client: auth }; 
}

function normalizeHostSegment(segment) {
  if (!segment || typeof segment !== 'string') return '';
  let s = segment.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '');
  s = s.split('/')[0].split(':')[0];
  if (s.startsWith('www.')) s = s.slice(4);
  return s;
}

function parseRequestUrlHost(url) {
  try {
    const u = new URL(String(url).trim());
    return normalizeHostSegment(u.hostname);
  } catch {
    return null;
  }
}

function hostBelongsToDomain(host, domainValue) {
  const d = normalizeHostSegment(domainValue);
  const h = normalizeHostSegment(host);
  if (!d || !h) return false;
  return h === d || h.endsWith('.' + d);
}

function brandCoversHost(brand, host) {
  const candidates = [];
  if (brand.domain) candidates.push(brand.domain);
  if (brand.primaryDomain) candidates.push(brand.primaryDomain);
  if (Array.isArray(brand.alternateDomains)) {
    for (const ad of brand.alternateDomains) {
      if (ad) candidates.push(ad);
    }
  }
  return candidates.some((c) => hostBelongsToDomain(host, c));
}

function findBrandMatchingHost(brands, host) {
  for (const b of brands) {
    if (brandCoversHost(b, host)) return b;
  }
  return null;
}

async function fetchBrandsByIds(db, brandIds) {
  const unique = [...new Set((brandIds || []).filter(Boolean))];
  const out = [];
  for (let i = 0; i < unique.length; i += 10) {
    const batch = unique.slice(i, i + 10);
    const refs = batch.map((id) => db.collection('brands').doc(id));
    const snaps = await db.getAll(...refs);
    for (const snap of snaps) {
      if (snap.exists) out.push({ id: snap.id, ...snap.data() });
    }
  }
  return out;
}

async function assertUserCanAccessSeoUrl(db, userData, url) {
  const role = userData?.role;
  if (role === 'admin') return { ok: true };

  const host = parseRequestUrlHost(url);
  if (!host) return { ok: false, status: 400, error: 'URL không hợp lệ.' };

  let brandIds = [];
  if (role === 'brand_owner') brandIds = userData.ownedBrandIds || [];
  else if (role === 'content_creator') brandIds = userData.assignedBrandIds || [];
  else return { ok: false, status: 403, error: 'Không có quyền sử dụng SEO Inspector.' };

  if (!brandIds.length) {
    return { ok: false, status: 403, error: 'Tài khoản chưa được gán brand.' };
  }

  const brands = await fetchBrandsByIds(db, brandIds);
  const match = findBrandMatchingHost(brands, host);
  if (!match) {
    return {
      ok: false,
      status: 403,
      error: 'URL không thuộc domain của brand bạn được phép. Hãy cấu hình trường domain trên brand hoặc kiểm tra URL.',
    };
  }

  return { ok: true, brandId: match.id };
}

export default async function handler(req, res) {
  // 1. IMMEDIATE CORS & OPTIONS RESPONSE
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // 2. LAZY INIT CLIENTS (Safe Load)
    const clients = await initClients();
    const { admin, db, bq, gsc, ad, aa, oauth2Client } = clients;

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // --- AUTH VERIFICATION ---
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = authHeader.split('Bearer ')[1];
    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(token);
    } catch (error) {
      return res.status(401).json({ error: 'Unauthorized: Token verification failed' });
    }
    const userId = decodedToken.uid;

    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.data();
    if (!userData) {
      return res.status(403).json({ error: 'Tài khoản không tồn tại trong hệ thống.' });
    }

    const { url, action } = req.body;
    if (!url && action !== 'diagnostic') return res.status(400).json({ error: 'URL is required' });

    // ROUTING BASED ON ACTION - Pass clients explicitly
    if (action === 'analytics') {
      const access = await assertUserCanAccessSeoUrl(db, userData, url);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      return handleAnalytics(req, res, url, { gsc, ad, aa, oauth2Client });
    } else if (action === 'site-insights') {
      const access = await assertUserCanAccessSeoUrl(db, userData, url);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      if (userData.role !== 'admin' && userData.role !== 'brand_owner') {
        return res.status(403).json({ error: 'Chỉ dành cho brand owner hoặc admin.' });
      }
      return handleSiteInsights(req, res, url, { gsc, ad, aa, oauth2Client });
    } else if (action === 'diagnostic') {
      return handleDiagnostic(req, res, { bq });
    } else {
      const access = await assertUserCanAccessSeoUrl(db, userData, url);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      return handleTechnical(req, res, url, userId, { admin });
    }
  } catch (error) {
    console.error('CRITICAL SEO ERROR:', error);
    return res.status(500).json({ error: error.message });
  }
}

async function handleDiagnostic(req, res, { bq }) {
  const GA4_DATASET = process.env.GA4_DATASET_ID;
  const GSC_DATASET = process.env.GSC_DATASET_ID;
  const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;

  const results = {
    projectId: PROJECT_ID,
    location: bq.location,
    ga4Dataset: GA4_DATASET,
    gscDataset: GSC_DATASET,
    steps: []
  };

  try {
    const [datasets] = await bq.getDatasets();
    results.steps.push({ step: 'Project Access', status: 'success', message: `Found ${datasets.length} datasets: ${datasets.map(d => d.id).join(', ')}` });
  } catch (err) {
    results.steps.push({ step: 'Project Access', status: 'error', message: err.message });
  }

  if (GA4_DATASET) {
    try {
      const [tables] = await bq.dataset(GA4_DATASET).getTables();
      const tableIds = tables.map(t => t.id);
      results.steps.push({ step: 'GA4 Dataset Access', status: 'success', message: `Found tables: ${tableIds.join(', ')}` });
      
      const hasEvents = tableIds.some(id => id.startsWith('events_'));
      results.steps.push({ step: 'GA4 Events Check', status: hasEvents ? 'success' : 'warning', message: hasEvents ? 'Found events_* tables.' : 'No events_* tables found.' });
    } catch (err) {
      results.steps.push({ step: 'GA4 Dataset Access', status: 'error', message: err.message });
    }
  }

  if (GSC_DATASET) {
    try {
      const [tables] = await bq.dataset(GSC_DATASET).getTables();
      results.steps.push({ step: 'GSC Dataset Access', status: 'success', message: `Found tables: ${tables.map(t => t.id).join(', ')}` });
    } catch (err) {
      results.steps.push({ step: 'GSC Dataset Access', status: 'error', message: err.message });
    }
  }

  return res.status(200).json({ success: true, diagnostic: results });
}

async function handleTechnical(req, res, url, userId, { admin }) {
  try {
    const API_LOGIN = process.env.SEO_API_LOGIN;
    const API_PASSWORD = process.env.SEO_API_PASSWORD;

    if (!API_LOGIN || !API_PASSWORD) {
      return res.status(500).json({ error: 'Server thiếu cấu hình DataForSEO credentials.' });
    }

    const basicAuth = Buffer.from(`${API_LOGIN}:${API_PASSWORD}`).toString('base64');
    
    const postData = [{ url: url, enable_javascript: false, load_resources: false }];

    const response = await fetch('https://api.dataforseo.com/v3/on_page/instant_pages', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(postData),
      timeout: 30000 
    });

    if (!response.ok) throw new Error(`DataForSEO API error: ${response.status}`);

    const data = await response.json();
    const resultItem = data?.tasks?.[0]?.result?.[0]?.items?.[0];

    if (!resultItem) return res.status(400).json({ error: 'Không thể phân tích URL này.' });

    const formattedResponse = {
      url: url,
      statusCode: resultItem.status_code || null,
      title: resultItem.meta?.title || '',
      metaDescription: resultItem.meta?.description || '',
      h1: resultItem.meta?.htags?.h1?.[0] || '',
      canonical: resultItem.meta?.canonical || '',
      wordCount: resultItem.meta?.content?.word_count || 0,
      indexability: resultItem.is_indexable ? 'index' : 'noindex', 
      rawProviderResponse: resultItem 
    };

    // Save to Firestore
    try {
        const db = admin.firestore();
        await db.collection('seo_inspections').add({
            ...formattedResponse,
            rawProviderResponse: null, // Don't save raw to FS
            userId: userId,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (fsError) {
        console.error('Firestore Log Error:', fsError);
    }

    return res.status(200).json({ success: true, data: formattedResponse });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

function toDateStr(d) {
  return d.toISOString().split('T')[0];
}

function getDateRangesForComparison() {
  const currentEnd = new Date();
  currentEnd.setDate(currentEnd.getDate() - 1);

  const currentStart = new Date(currentEnd);
  currentStart.setDate(currentStart.getDate() - 6);

  const previousEnd = new Date(currentStart);
  previousEnd.setDate(previousEnd.getDate() - 1);

  const previousStart = new Date(previousEnd);
  previousStart.setDate(previousStart.getDate() - 6);

  return {
    current: { start: toDateStr(currentStart), end: toDateStr(currentEnd) },
    previous: { start: toDateStr(previousStart), end: toDateStr(previousEnd) },
  };
}

/** GSC-style: last 28 days (inclusive) vs previous 28 days */
function getDateRanges28dWoW() {
  const end = new Date();
  end.setDate(end.getDate() - 1);

  const curStart = new Date(end);
  curStart.setDate(curStart.getDate() - 27);

  const prevEnd = new Date(curStart);
  prevEnd.setDate(prevEnd.getDate() - 1);

  const prevStart = new Date(prevEnd);
  prevStart.setDate(prevStart.getDate() - 27);

  return {
    current: { start: toDateStr(curStart), end: toDateStr(end) },
    previous: { start: toDateStr(prevStart), end: toDateStr(prevEnd) },
  };
}

function calcDeltaPct(current, previous) {
  const c = Number(current || 0);
  const p = Number(previous || 0);
  if (p === 0) return c === 0 ? 0 : null;
  return Number((((c - p) / p) * 100).toFixed(2));
}

function metricTrend(deltaPct, threshold = 5) {
  if (deltaPct === null) return 'insufficient_data';
  if (deltaPct > threshold) return 'up';
  if (deltaPct < -threshold) return 'down';
  return 'flat';
}

function buildDeltaMap(currentObj, previousObj, keys) {
  const out = {};
  for (const k of keys) {
    out[k] = calcDeltaPct(currentObj[k], previousObj[k]);
  }
  return out;
}

function pushAction(auditActions, priority, key, title, why, action) {
  auditActions.push({ priority, key, title, why, action });
}

function buildAuditInsights(ga4, gsc) {
  const healthFlags = [];
  const auditActions = [];

  const gscClicksDrop = gsc.deltaPct.clicks != null && gsc.deltaPct.clicks < -10;
  const gscImprUp = gsc.deltaPct.impressions != null && gsc.deltaPct.impressions > 10;
  const gscCtrDrop = gsc.deltaPct.ctr != null && gsc.deltaPct.ctr < -10;
  const gscPosDrop = gsc.deltaPct.avgPosition != null && gsc.deltaPct.avgPosition > 8;
  const ga4TrafficDrop = ga4.deltaPct.pageviews != null && ga4.deltaPct.pageviews < -12;
  const ga4SessionUpButEngDown =
    ga4.deltaPct.sessions != null &&
    ga4.deltaPct.sessions > 10 &&
    ga4.deltaPct.engagementSeconds != null &&
    ga4.deltaPct.engagementSeconds < -8;

  if (gscClicksDrop && gscImprUp) {
    healthFlags.push('ctr_gap');
    pushAction(
      auditActions,
      'high',
      'ctr_gap',
      'Impression tăng nhưng click giảm',
      'Nội dung đang được hiển thị nhiều hơn nhưng snippet/title chưa đủ hấp dẫn.',
      'Audit title/meta description, thêm intent keyword ở đầu title, test rich-result eligibility.'
    );
  }

  if (gscPosDrop) {
    healthFlags.push('ranking_decline');
    pushAction(
      auditActions,
      'high',
      'ranking_decline',
      'Vị trí trung bình đang xấu đi',
      'Trang có dấu hiệu tụt hạng trong 7 ngày gần đây.',
      'Kiểm tra cannibalization, cập nhật internal links từ trang trụ cột, rà lại intent mismatch.'
    );
  }

  if (ga4TrafficDrop && gscClicksDrop) {
    healthFlags.push('traffic_drop');
    pushAction(
      auditActions,
      'high',
      'traffic_drop',
      'Traffic giảm đồng thời ở GA4 và GSC',
      'Suy giảm có thể đến từ SERP loss hoặc technical degradation.',
      'Ưu tiên crawlability/indexability, kiểm tra coverage/search console issues và log server.'
    );
  }

  if (ga4SessionUpButEngDown) {
    healthFlags.push('engagement_quality_drop');
    pushAction(
      auditActions,
      'medium',
      'engagement_quality_drop',
      'Session tăng nhưng chất lượng tương tác giảm',
      'Có thể traffic kém phù hợp intent hoặc UX chưa tối ưu.',
      'Audit speed/CWV, above-the-fold, CTA placement và sự khớp nội dung với query chính.'
    );
  }

  if (gscCtrDrop && !healthFlags.includes('ctr_gap')) {
    healthFlags.push('ctr_decline');
    pushAction(
      auditActions,
      'medium',
      'ctr_decline',
      'CTR giảm đáng kể',
      'Snippet cạnh tranh kém trong SERP dù vẫn còn impression.',
      'Viết lại title với lợi ích định lượng, tối ưu meta description theo search intent.'
    );
  }

  if (!auditActions.length) {
    pushAction(
      auditActions,
      'low',
      'stable_monitoring',
      'Xu hướng đang ổn định',
      'Biến động chưa vượt ngưỡng cảnh báo của hệ thống.',
      'Tiếp tục theo dõi tuần tới và thử tối ưu incremental ở title/H1/internal links.'
    );
  }

  return { healthFlags, auditActions };
}

function mapAiSummaryParsed(parsed, fallback) {
  return {
    enabled: true,
    topPriorities: Array.isArray(parsed.topPriorities) ? parsed.topPriorities.slice(0, 3) : fallback.topPriorities,
    expectedImpact: parsed.expectedImpact || fallback.expectedImpact,
    quickWins48h: Array.isArray(parsed.quickWins48h) ? parsed.quickWins48h.slice(0, 5) : fallback.quickWins48h,
  };
}

async function generateAiAuditSummary(url, dateRanges, ga4, gsc, auditActions) {
  const fallback = {
    enabled: false,
    source: 'fallback',
    topPriorities: auditActions.slice(0, 3).map((a) => a.title),
    expectedImpact: auditActions[0]?.priority === 'high'
      ? 'Nếu xử lý ưu tiên cao trước, khả năng cải thiện CTR/traffic trong 1-2 chu kỳ index là khả thi.'
      : 'Giữ nhịp tối ưu đều để cải thiện dần chất lượng traffic và ổn định thứ hạng.',
    quickWins48h: auditActions.slice(0, 3).map((a) => a.action),
  };

  const promptPayload = {
    url,
    compareWindow: `${dateRanges.current.start}..${dateRanges.current.end} vs ${dateRanges.previous.start}..${dateRanges.previous.end}`,
    ga4,
    gsc,
    auditActions,
  };

  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    try {
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(geminiKey);
      const modelName = process.env.SEO_AUDIT_AI_MODEL || 'gemini-1.5-flash';
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
        },
      });

      const prompt = `You are an SEO technical lead. Use only the JSON data below. Return valid JSON with exactly these keys: topPriorities (array of strings, max 3), expectedImpact (string), quickWins48h (array of strings, max 5). Language: concise Vietnamese.

DATA:
${JSON.stringify(promptPayload)}`;

      const result = await model.generateContent(prompt);
      const raw = result?.response?.text?.() || '{}';
      const parsed = JSON.parse(raw);
      return { ...mapAiSummaryParsed(parsed, fallback), source: 'gemini' };
    } catch (e) {
      console.warn('[warning] Gemini AI summary failed:', e.message);
    }
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    try {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey: openaiKey });

      const completion = await client.chat.completions.create({
        model: process.env.SEO_AUDIT_OPENAI_MODEL || 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: 'You are an SEO technical lead. Return compact JSON with keys: topPriorities(string[]), expectedImpact(string), quickWins48h(string[]). Prefer concise Vietnamese.',
          },
          {
            role: 'user',
            content: JSON.stringify(promptPayload),
          },
        ],
        response_format: { type: 'json_object' },
      });

      const raw = completion?.choices?.[0]?.message?.content || '{}';
      const parsed = JSON.parse(raw);
      return { ...mapAiSummaryParsed(parsed, fallback), source: 'openai' };
    } catch (e) {
      console.warn('[warning] OpenAI AI summary failed:', e.message);
    }
  }

  return fallback;
}

function normalizeGscAggregateRow(row) {
  if (!row) return { clicks: 0, impressions: 0, ctr: 0, avgPosition: 0 };
  const clicks = row.clicks || 0;
  const impressions = row.impressions || 0;
  const ctrRaw = row.ctr;
  const ctr = ctrRaw != null && ctrRaw !== ''
    ? Number((Number(ctrRaw) * 100).toFixed(2))
    : impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(2)) : 0;
  return {
    clicks,
    impressions,
    ctr,
    avgPosition: row.position != null ? Number(Number(row.position).toFixed(2)) : 0,
  };
}

async function handleSiteInsights(req, res, url, { gsc: gscService, ad, aa, oauth2Client }) {
  try {
    const dateRanges = getDateRanges28dWoW();
    const gscSite = {
      current: { clicks: 0, impressions: 0, ctr: 0, avgPosition: 0 },
      previous: { clicks: 0, impressions: 0, ctr: 0, avgPosition: 0 },
      deltaPct: {},
    };
    const ga4Site = {
      current: { pageviews: 0, totalUsers: 0, sessions: 0 },
      previous: { pageviews: 0, totalUsers: 0, sessions: 0 },
      deltaPct: {},
    };

    const ga4MetricAt = (ga4Resp, i) => Number(ga4Resp?.data?.rows?.[0]?.metricValues?.[i]?.value || 0);

    try {
      const urlObj = new URL(url);
      const host = urlObj.hostname;
      const summariesResp = await aa.accountSummaries.list({ auth: oauth2Client });
      const summaries = summariesResp.data.accountSummaries || [];
      let propertyId = null;
      for (const account of summaries) {
        for (const prop of (account.propertySummaries || [])) {
          if (prop.displayName.includes(host) || host.includes(prop.displayName.replace('https://', '').replace('http://', ''))) {
            propertyId = prop.property.replace('properties/', '');
            break;
          }
        }
        if (propertyId) break;
      }

      if (propertyId) {
        const runGa4Site = async (startDate, endDate) => {
          const ga4Resp = await ad.properties.runReport({
            auth: oauth2Client,
            property: `properties/${propertyId}`,
            requestBody: {
              dateRanges: [{ startDate, endDate }],
              metrics: [
                { name: 'screenPageViews' },
                { name: 'totalUsers' },
                { name: 'sessions' },
              ],
            },
          });
          return {
            pageviews: ga4MetricAt(ga4Resp, 0),
            totalUsers: ga4MetricAt(ga4Resp, 1),
            sessions: ga4MetricAt(ga4Resp, 2),
          };
        };
        const [c, p] = await Promise.all([
          runGa4Site(dateRanges.current.start, dateRanges.current.end),
          runGa4Site(dateRanges.previous.start, dateRanges.previous.end),
        ]);
        ga4Site.current = c;
        ga4Site.previous = p;
        ga4Site.deltaPct = buildDeltaMap(ga4Site.current, ga4Site.previous, ['pageviews', 'totalUsers', 'sessions']);
      }
    } catch (e) {
      console.warn(`[warning] site-insights GA4: ${e.message}`);
    }

    let topPages = [];
    let trendingUp = [];
    let trendingDown = [];

    try {
      const sitesResp = await gscService.sites.list();
      const siteEntries = sitesResp.data.siteEntry || [];
      let siteUrl = null;
      const sortedSites = siteEntries.sort((a, b) => b.siteUrl.length - a.siteUrl.length);
      for (const s of sortedSites) {
        const cleanS = s.siteUrl.startsWith('sc-domain:') ? s.siteUrl.replace('sc-domain:', '') : s.siteUrl;
        if (url.includes(cleanS)) {
          siteUrl = s.siteUrl;
          break;
        }
      }

      if (!siteUrl) {
        console.warn(`[warning] site-insights: no GSC property for ${url}`);
        return res.status(200).json({
          success: true,
          data: {
            compareWindow: '28d_vs_prev28d',
            dateRanges,
            gscSite,
            ga4Site,
            topPages,
            trendingUp,
            trendingDown,
            gscPropertyFound: false,
          },
        });
      }

      const rowLimit = 250;
      const [aggCurr, aggPrev, pageCurr, pagePrev] = await Promise.all([
        gscService.searchanalytics.query({
          auth: oauth2Client,
          siteUrl,
          requestBody: {
            startDate: dateRanges.current.start,
            endDate: dateRanges.current.end,
          },
        }),
        gscService.searchanalytics.query({
          auth: oauth2Client,
          siteUrl,
          requestBody: {
            startDate: dateRanges.previous.start,
            endDate: dateRanges.previous.end,
          },
        }),
        gscService.searchanalytics.query({
          auth: oauth2Client,
          siteUrl,
          requestBody: {
            startDate: dateRanges.current.start,
            endDate: dateRanges.current.end,
            dimensions: ['page'],
            rowLimit,
          },
        }),
        gscService.searchanalytics.query({
          auth: oauth2Client,
          siteUrl,
          requestBody: {
            startDate: dateRanges.previous.start,
            endDate: dateRanges.previous.end,
            dimensions: ['page'],
            rowLimit,
          },
        }),
      ]);

      gscSite.current = normalizeGscAggregateRow(aggCurr.data.rows?.[0]);
      gscSite.previous = normalizeGscAggregateRow(aggPrev.data.rows?.[0]);
      gscSite.deltaPct = buildDeltaMap(gscSite.current, gscSite.previous, ['clicks', 'impressions', 'ctr', 'avgPosition']);

      const pageRowMetrics = (row) => normalizeGscAggregateRow(row);

      const currMap = new Map();
      for (const row of pageCurr.data.rows || []) {
        const pageKey = row.keys?.[0];
        if (!pageKey) continue;
        currMap.set(pageKey, pageRowMetrics(row));
      }
      const prevMap = new Map();
      for (const row of pagePrev.data.rows || []) {
        const pageKey = row.keys?.[0];
        if (!pageKey) continue;
        prevMap.set(pageKey, pageRowMetrics(row));
      }

      const allUrls = new Set([...currMap.keys(), ...prevMap.keys()]);
      const merged = [];
      for (const pageKey of allUrls) {
        const cur = currMap.get(pageKey) || { clicks: 0, impressions: 0, ctr: 0, avgPosition: 0 };
        const prev = prevMap.get(pageKey) || { clicks: 0, impressions: 0, ctr: 0, avgPosition: 0 };
        const deltaPctClicks = calcDeltaPct(cur.clicks, prev.clicks);
        merged.push({
          page: pageKey,
          clicks: cur.clicks,
          impressions: cur.impressions,
          ctr: cur.ctr,
          avgPosition: cur.avgPosition,
          previousClicks: prev.clicks,
          deltaPctClicks,
        });
      }

      topPages = [...merged]
        .sort((a, b) => b.clicks - a.clicks)
        .slice(0, 20);

      const upCandidates = merged.filter((m) => {
        if (m.clicks === 0 && m.previousClicks === 0) return false;
        if (m.previousClicks === 0 && m.clicks > 0) return true;
        return m.deltaPctClicks != null && m.deltaPctClicks > 0;
      });
      trendingUp = upCandidates
        .sort((a, b) => {
          const score = (x) => {
            if (x.previousClicks === 0 && x.clicks > 0) return 1e12 + x.clicks;
            if (x.deltaPctClicks == null) return -1;
            return x.deltaPctClicks;
          };
          return score(b) - score(a);
        })
        .slice(0, 15);

      const downCandidates = merged.filter((m) => m.previousClicks > 0 && m.clicks < m.previousClicks);
      trendingDown = downCandidates
        .sort((a, b) => {
          const da = a.deltaPctClicks != null ? a.deltaPctClicks : 0;
          const db = b.deltaPctClicks != null ? b.deltaPctClicks : 0;
          return da - db;
        })
        .slice(0, 15);

      return res.status(200).json({
        success: true,
        data: {
          compareWindow: '28d_vs_prev28d',
          dateRanges,
          gscSite,
          ga4Site,
          topPages,
          trendingUp,
          trendingDown,
          gscPropertyFound: true,
          gscSiteUrl: siteUrl,
        },
      });
    } catch (e) {
      console.warn(`[warning] site-insights GSC: ${e.message}`);
      return res.status(200).json({
        success: true,
        data: {
          compareWindow: '28d_vs_prev28d',
          dateRanges,
          gscSite,
          ga4Site,
          topPages,
          trendingUp,
          trendingDown,
          gscPropertyFound: false,
          gscError: e.message,
        },
      });
    }
  } catch (error) {
    console.error('Lỗi handleSiteInsights:', error);
    return res.status(500).json({ error: 'Lỗi site insights: ' + error.message });
  }
}

async function handleAnalytics(req, res, url, { gsc: gscService, ad, aa, oauth2Client }) {
  try {
    const GA4_DATASET = process.env.GA4_DATASET_ID;
    const GSC_DATASET = process.env.GSC_DATASET_ID;
    const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;

    if (!GA4_DATASET) return res.status(200).json({ success: false, error: 'Thiếu cấu hình GA4_DATASET_ID trên Vercel.' });
    if (!GSC_DATASET) return res.status(200).json({ success: false, error: 'Thiếu cấu hình GSC_DATASET_ID trên Vercel.' });
    if (!PROJECT_ID) return res.status(200).json({ success: false, error: 'Thiếu cấu hình FIREBASE_PROJECT_ID trên Vercel.' });

    const dateRanges = getDateRangesForComparison();
    const ga4 = {
      current: { pageviews: 0, totalUsers: 0, sessions: 0, engagementSeconds: 0, eventCount: 0 },
      previous: { pageviews: 0, totalUsers: 0, sessions: 0, engagementSeconds: 0, eventCount: 0 },
      deltaPct: {},
      trend: {},
    };
    const gsc = {
      current: { clicks: 0, impressions: 0, ctr: 0, avgPosition: 0 },
      previous: { clicks: 0, impressions: 0, ctr: 0, avgPosition: 0 },
      deltaPct: {},
      trend: {},
    };
    let topQueries = [];
    let clicksByDevice = [];

    const ga4MetricAt = (ga4Resp, i) => Number(ga4Resp?.data?.rows?.[0]?.metricValues?.[i]?.value || 0);

    // --- GA4 API MIGRATION ---
    try {
        // 1. Find GA4 Property ID matching the host
        const urlObj = new URL(url);
        const host = urlObj.hostname;

        // Note: Listing ALL properties can be slow if there are 1000+. 
        // Real implementation should cache this mapping in Firestore.
        const summariesResp = await aa.accountSummaries.list({ auth: oauth2Client });
        const summaries = summariesResp.data.accountSummaries || [];
        let propertyId = null;

        for (const account of summaries) {
            for (const prop of (account.propertySummaries || [])) {
                if (prop.displayName.includes(host) || host.includes(prop.displayName.replace('https://', '').replace('http://', ''))) {
                    propertyId = prop.property.replace('properties/', '');
                    break;
                }
            }
            if (propertyId) break;
        }

        if (propertyId) {
            const runGa4 = async (startDate, endDate) => {
              const ga4Resp = await ad.properties.runReport({
                auth: oauth2Client,
                property: `properties/${propertyId}`,
                requestBody: {
                    dateRanges: [{ startDate, endDate }],
                    dimensions: [{ name: 'pageLocation' }],
                    metrics: [
                        { name: 'screenPageViews' },
                        { name: 'totalUsers' },
                        { name: 'sessions' },
                        { name: 'userEngagementDuration' },
                        { name: 'eventCount' },
                    ],
                    dimensionFilter: {
                        filter: {
                            fieldName: 'pageLocation',
                            stringFilter: {
                                matchType: 'EXACT',
                                value: url
                            }
                        }
                    }
                }
              });
              return {
                pageviews: ga4MetricAt(ga4Resp, 0),
                totalUsers: ga4MetricAt(ga4Resp, 1),
                sessions: ga4MetricAt(ga4Resp, 2),
                engagementSeconds: Number(ga4MetricAt(ga4Resp, 3).toFixed(1)),
                eventCount: ga4MetricAt(ga4Resp, 4),
              };
            };

            const [ga4Current, ga4Previous] = await Promise.all([
              runGa4(dateRanges.current.start, dateRanges.current.end),
              runGa4(dateRanges.previous.start, dateRanges.previous.end),
            ]);
            ga4.current = ga4Current;
            ga4.previous = ga4Previous;
        } else {
            console.warn(`[warning] No matching GA4 property found for host: ${host}`);
        }
    } catch (e) {
        console.warn(`[warning] GA4 API error: ${e.message}`);
        console.log(`Hint: Ensure GA4 Data API is enabled and account access is granted.`);
    }

    try {
        // --- GSC API MIGRATION ---
        // Instead of BigQuery, we use the Search Console API which supports 1000+ sites naturally
        
        // 1. Find the best matching site property
        const sitesResp = await gscService.sites.list();
        const siteEntries = sitesResp.data.siteEntry || [];
        
        // Find property that matches the URL
        let siteUrl = null;
        const sortedSites = siteEntries.sort((a, b) => b.siteUrl.length - a.siteUrl.length);
        for (const s of sortedSites) {
            const cleanS = s.siteUrl.startsWith('sc-domain:') ? s.siteUrl.replace('sc-domain:', '') : s.siteUrl;
            if (url.includes(cleanS)) {
                siteUrl = s.siteUrl;
                break;
            }
        }

        if (siteUrl) {
            const pageFilter = {
                dimensionFilterGroups: [{
                    filters: [{
                        dimension: 'page',
                        operator: 'equals',
                        expression: url
                    }]
                }]
            };

            const runGscPageWindow = async (startDate, endDate) => gscService.searchanalytics.query({
              auth: oauth2Client,
              siteUrl,
              requestBody: {
                startDate,
                endDate,
                dimensions: ['page'],
                ...pageFilter,
              },
            });

            const [gscCurrentResp, gscPreviousResp, gscQueriesResp, gscDeviceResp] = await Promise.all([
                runGscPageWindow(dateRanges.current.start, dateRanges.current.end),
                runGscPageWindow(dateRanges.previous.start, dateRanges.previous.end),
                gscService.searchanalytics.query({
                    auth: oauth2Client,
                    siteUrl: siteUrl,
                    requestBody: {
                        startDate: dateRanges.current.start,
                        endDate: dateRanges.current.end,
                        dimensions: ['query'],
                        ...pageFilter,
                        rowLimit: 10,
                    }
                }),
                gscService.searchanalytics.query({
                    auth: oauth2Client,
                    siteUrl: siteUrl,
                    requestBody: {
                        startDate: dateRanges.current.start,
                        endDate: dateRanges.current.end,
                        dimensions: ['device'],
                        ...pageFilter,
                        rowLimit: 10,
                    }
                }),
            ]);

            const normalizeGsc = (row) => {
              if (!row) return { clicks: 0, impressions: 0, ctr: 0, avgPosition: 0 };
              const clicks = row.clicks || 0;
              const impressions = row.impressions || 0;
              const ctrRaw = row.ctr;
              const ctr = ctrRaw != null && ctrRaw !== ''
                ? Number((Number(ctrRaw) * 100).toFixed(2))
                : impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(2)) : 0;
              return {
                clicks,
                impressions,
                ctr,
                avgPosition: row.position != null ? Number(Number(row.position).toFixed(2)) : 0,
              };
            };

            gsc.current = normalizeGsc(gscCurrentResp.data.rows?.[0]);
            gsc.previous = normalizeGsc(gscPreviousResp.data.rows?.[0]);

            const qRows = gscQueriesResp.data.rows || [];
            qRows.sort((a, b) => (b.clicks || 0) - (a.clicks || 0));
            topQueries = qRows.slice(0, 8).map((r) => {
                const qc = r.clicks || 0;
                const qi = r.impressions || 0;
                const qCtr = r.ctr != null && r.ctr !== ''
                    ? Number((Number(r.ctr) * 100).toFixed(2))
                    : qi > 0 ? Number(((qc / qi) * 100).toFixed(2)) : 0;
                return {
                    query: r.keys?.[0] || '',
                    clicks: qc,
                    impressions: qi,
                    ctr: qCtr,
                    position: r.position != null ? Number(Number(r.position).toFixed(2)) : 0,
                };
            });

            clicksByDevice = (gscDeviceResp.data.rows || []).map((r) => ({
                device: r.keys?.[0] || 'UNKNOWN',
                clicks: r.clicks || 0,
                impressions: r.impressions || 0,
            }));
        } else {
            console.warn(`[warning] No matching GSC property found for URL: ${url}. Available properties: ${siteEntries.map(s => s.siteUrl).join(', ')}`);
        }
    } catch (e) {
        console.warn(`[warning] GSC API error: ${e.message}`);
        console.log(`Hint: Ensure the service account has 'Viewer' access to the GSC property.`);
    }

    ga4.deltaPct = buildDeltaMap(ga4.current, ga4.previous, ['pageviews', 'totalUsers', 'sessions', 'engagementSeconds', 'eventCount']);
    gsc.deltaPct = buildDeltaMap(gsc.current, gsc.previous, ['clicks', 'impressions', 'ctr', 'avgPosition']);
    ga4.trend = {
      pageviews: metricTrend(ga4.deltaPct.pageviews),
      totalUsers: metricTrend(ga4.deltaPct.totalUsers),
      sessions: metricTrend(ga4.deltaPct.sessions),
      engagementSeconds: metricTrend(ga4.deltaPct.engagementSeconds),
      eventCount: metricTrend(ga4.deltaPct.eventCount),
    };
    gsc.trend = {
      clicks: metricTrend(gsc.deltaPct.clicks),
      impressions: metricTrend(gsc.deltaPct.impressions),
      ctr: metricTrend(gsc.deltaPct.ctr),
      avgPosition: metricTrend(gsc.deltaPct.avgPosition, 8),
    };

    const { healthFlags, auditActions } = buildAuditInsights(ga4, gsc);
    const aiSummary = await generateAiAuditSummary(url, dateRanges, ga4, gsc, auditActions);

    return res.status(200).json({
      success: true,
      data: {
        compareWindow: '7d_vs_prev7d',
        dateRanges,
        ga4,
        gsc,
        topQueries,
        clicksByDevice,
        healthFlags,
        auditActions,
        aiSummary,
        // Backward-compatible fields for existing consumers
        pageviews: ga4.current.pageviews,
        totalUsers: ga4.current.totalUsers,
        sessions: ga4.current.sessions,
        engagementSeconds: ga4.current.engagementSeconds,
        eventCount: ga4.current.eventCount,
        clicks: gsc.current.clicks,
        impressions: gsc.current.impressions,
        avgPosition: gsc.current.avgPosition,
        ctr: gsc.current.ctr,
      }
    });

  } catch (error) {
    console.error('Lỗi handleAnalytics tổng quát:', error);
    return res.status(500).json({ error: 'Lỗi truy vấn dữ liệu: ' + error.message });
  }
}
