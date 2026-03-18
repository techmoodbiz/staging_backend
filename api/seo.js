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

const bigquery = new BigQuery({
  projectId: process.env.FIREBASE_PROJECT_ID,
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
  if (!url) return res.status(400).json({ error: 'URL is required' });

  // ROUTING BASED ON ACTION
  if (action === 'analytics') {
    return handleAnalytics(req, res, url);
  } else {
    // Default to technical analysis
    return handleTechnical(req, res, url, userId);
  }
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

    if (!GA4_DATASET || !GSC_DATASET) {
      return res.status(500).json({ error: 'Backend missing GA4_DATASET_ID or GSC_DATASET_ID configuration.' });
    }

    const ga4Query = `
      SELECT count(*) as pageviews
      FROM \`${process.env.FIREBASE_PROJECT_ID}.${GA4_DATASET}.events_*\`
      WHERE event_name = 'page_view'
      AND (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_location') = @url
      AND _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY))
      AND FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY))
    `;

    const gscQuery = `
      SELECT sum(clicks) as clicks, sum(impressions) as impressions, avg(position) as avg_position
      FROM \`${process.env.FIREBASE_PROJECT_ID}.${GSC_DATASET}.searchdata_url_impressions\`
      WHERE url = @url
      AND data_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
    `;

    const [ga4Task, gscTask] = await Promise.all([
        bigquery.query({ query: ga4Query, params: { url } }),
        bigquery.query({ query: gscQuery, params: { url } })
    ]);

    const pageviews = ga4Task[0][0]?.pageviews || 0;
    const gscResults = gscTask[0][0] || { clicks: 0, impressions: 0, avg_position: 0 };

    return res.status(200).json({
      success: true,
      data: {
        pageviews,
        clicks: gscResults.clicks,
        impressions: gscResults.impressions,
        avgPosition: gscResults.avg_position ? Number(gscResults.avg_position.toFixed(2)) : 0
      }
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
