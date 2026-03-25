import fetch from 'node-fetch';
import admin from 'firebase-admin';
import { BigQuery } from '@google-cloud/bigquery';

// Initialize Firebase Admin
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  } catch (error) {
    console.error('Firebase admin init error', error);
  }
}

const bqLocation = process.env.BIGQUERY_LOCATION || 'asia-southeast1';
console.log('BigQuery Location:', bqLocation);

const bigquery = new BigQuery({
  projectId: process.env.FIREBASE_PROJECT_ID,
  location: bqLocation,
  credentials: {
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }
});

export default async function handler(req, res) {
  // CORS Configuration
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
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

  const { url, action } = req.body;
  if (!url && action !== 'diagnostic') return res.status(400).json({ error: 'URL is required' });

  // ROUTING BASED ON ACTION
  if (action === 'analytics') {
    return handleAnalytics(req, res, url);
  } else if (action === 'diagnostic') {
    return handleDiagnostic(req, res);
  } else {
    // Default to technical analysis
    return handleTechnical(req, res, url, userId);
  }
}

async function handleDiagnostic(req, res) {
  const GA4_DATASET = process.env.GA4_DATASET_ID;
  const GSC_DATASET = process.env.GSC_DATASET_ID;
  const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;

  const results = {
    projectId: PROJECT_ID,
    location: bqLocation,
    ga4Dataset: GA4_DATASET,
    gscDataset: GSC_DATASET,
    steps: []
  };

  try {
    const [datasets] = await bigquery.getDatasets();
    results.steps.push({ step: 'Project Access', status: 'success', message: `Found ${datasets.length} datasets: ${datasets.map(d => d.id).join(', ')}` });
  } catch (err) {
    results.steps.push({ step: 'Project Access', status: 'error', message: err.message });
  }

  if (GA4_DATASET) {
    try {
      const [tables] = await bigquery.dataset(GA4_DATASET).getTables();
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
      const [tables] = await bigquery.dataset(GSC_DATASET).getTables();
      results.steps.push({ step: 'GSC Dataset Access', status: 'success', message: `Found tables: ${tables.map(t => t.id).join(', ')}` });
    } catch (err) {
      results.steps.push({ step: 'GSC Dataset Access', status: 'error', message: err.message });
    }
  }

  return res.status(200).json({ success: true, diagnostic: results });
}

async function handleTechnical(req, res, url, userId) {
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

async function handleAnalytics(req, res, url) {
  try {
    const GA4_DATASET = process.env.GA4_DATASET_ID;
    const GSC_DATASET = process.env.GSC_DATASET_ID;
    const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;

    if (!GA4_DATASET) return res.status(200).json({ success: false, error: 'Thiếu cấu hình GA4_DATASET_ID trên Vercel.' });
    if (!GSC_DATASET) return res.status(200).json({ success: false, error: 'Thiếu cấu hình GSC_DATASET_ID trên Vercel.' });
    if (!PROJECT_ID) return res.status(200).json({ success: false, error: 'Thiếu cấu hình FIREBASE_PROJECT_ID trên Vercel.' });

    const ga4Query = `
      SELECT count(*) as pageviews
      FROM \`${PROJECT_ID}.${GA4_DATASET}.events_*\`
      WHERE event_name = 'page_view'
      AND (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_location') = @url
      AND _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY))
      AND FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY))
    `;

    const gscQuery = `
      SELECT sum(clicks) as clicks, sum(impressions) as impressions, avg(position) as avg_position
      FROM \`${PROJECT_ID}.${GSC_DATASET}.searchdata_url_impressions\`
      WHERE url = @url
      AND data_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
    `;

    // Chúng ta dùng try-catch riêng cho từng query để bắt lỗi "Bảng chưa tồn tại"
    let pageviews = 0;
    let gscResults = { clicks: 0, impressions: 0, avg_position: 0 };

    try {
        const [ga4Task] = await bigquery.query({ query: ga4Query, params: { url }, location: bqLocation });
        pageviews = ga4Task[0]?.pageviews || 0;
    } catch (e) {
        console.warn(`[warning] GA4 Dataset/Table might not be ready yet: ${e.message}`);
        console.log(`Hint: Check if GA4 BigQuery export is enabled on Google Analytics. Also verify BIGQUERY_LOCATION (${bqLocation}) and GA4_DATASET_ID (${GA4_DATASET}) on Vercel.`);
    }

    try {
        const [gscTask] = await bigquery.query({ query: gscQuery, params: { url }, location: bqLocation });
        gscResults = gscTask[0] || gscResults;
    } catch (e) {
        console.warn(`[warning] GSC Dataset/Table might not be ready yet: ${e.message}`);
        console.log(`Hint: Check if GSC BigQuery export is enabled and wait 48h. Also verify BIGQUERY_LOCATION (${bqLocation}) and GSC_DATASET_ID (${GSC_DATASET}) on Vercel.`);
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
    return res.status(500).json({ error: 'Lỗi truy vấn BigQuery: ' + error.message });
  }
}
