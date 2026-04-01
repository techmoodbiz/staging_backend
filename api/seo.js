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

async function handleAnalytics(req, res, url, { gsc, ad, aa, oauth2Client }) {
  try {
    const GA4_DATASET = process.env.GA4_DATASET_ID;
    const GSC_DATASET = process.env.GSC_DATASET_ID;
    const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;

    if (!GA4_DATASET) return res.status(200).json({ success: false, error: 'Thiếu cấu hình GA4_DATASET_ID trên Vercel.' });
    if (!GSC_DATASET) return res.status(200).json({ success: false, error: 'Thiếu cấu hình GSC_DATASET_ID trên Vercel.' });
    if (!PROJECT_ID) return res.status(200).json({ success: false, error: 'Thiếu cấu hình FIREBASE_PROJECT_ID trên Vercel.' });

    let pageviews = 0;
    let gscResults = { clicks: 0, impressions: 0, avg_position: 0 };

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
            const ga4Resp = await ad.properties.runReport({
                auth: oauth2Client,
                property: `properties/${propertyId}`,
                requestBody: {
                    dateRanges: [{ startDate: '30daysAgo', endDate: 'yesterday' }],
                    dimensions: [{ name: 'pageLocation' }],
                    metrics: [{ name: 'screenPageViews' }],
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

            pageviews = Number(ga4Resp.data.rows?.[0]?.metricValues?.[0]?.value || 0);
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
        const sitesResp = await gsc.sites.list();
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
            const endDate = new Date();
            endDate.setDate(endDate.getDate() - 1); // GSC usually has 1-day lag
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - 30);

            const gscResp = await gsc.searchanalytics.query({
                auth: oauth2Client,
                siteUrl: siteUrl,
                requestBody: {
                    startDate: startDate.toISOString().split('T')[0],
                    endDate: endDate.toISOString().split('T')[0],
                    dimensions: ['page'],
                    dimensionFilterGroups: [{
                        filters: [{
                            dimension: 'page',
                            operator: 'equals',
                            expression: url
                        }]
                    }]
                }
            });

            const row = gscResp.data.rows?.[0];
            if (row) {
                gscResults = {
                    clicks: row.clicks || 0,
                    impressions: row.impressions || 0,
                    avg_position: row.position || 0
                };
            }
        } else {
            console.warn(`[warning] No matching GSC property found for URL: ${url}. Available properties: ${siteEntries.map(s => s.siteUrl).join(', ')}`);
        }
    } catch (e) {
        console.warn(`[warning] GSC API error: ${e.message}`);
        console.log(`Hint: Ensure the service account has 'Viewer' access to the GSC property.`);
    }

    return res.status(200).json({
      success: true,
      data: {
        pageviews,
        clicks: gscResults.clicks || 0,
        impressions: gscResults.impressions || 0,
        avgPosition: gscResults.avg_position ? Number(gscResults.avg_position.toFixed(2)) : 0
      }
    });

  } catch (error) {
    console.error('Lỗi handleAnalytics tổng quát:', error);
    return res.status(500).json({ error: 'Lỗi truy vấn dữ liệu: ' + error.message });
  }
}
