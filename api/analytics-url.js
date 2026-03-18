import { BigQuery } from '@google-cloud/bigquery';
import admin from 'firebase-admin';

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

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // --- AUTH VERIFICATION ---
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.split('Bearer ')[1];
  try {
    await admin.auth().verifyIdToken(token);
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized: Token verification failed' });
  }

  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    // Environment variables for Dataset IDs
    const GA4_DATASET = process.env.GA4_DATASET_ID; // e.g., analytics_123456789
    const GSC_DATASET = process.env.GSC_DATASET_ID; // e.g., searchconsole

    if (!GA4_DATASET || !GSC_DATASET) {
      return res.status(500).json({ error: 'Backend missing GA4_DATASET_ID or GSC_DATASET_ID configuration.' });
    }

    // --- GA4 Query: Page Views (Last 30 Days) ---
    const ga4Query = `
      SELECT count(*) as pageviews
      FROM \`${process.env.FIREBASE_PROJECT_ID}.${GA4_DATASET}.events_*\`
      WHERE event_name = 'page_view'
      AND (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_location') = @url
      AND _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY))
      AND FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY))
    `;

    // --- GSC Query: Search Performance (Last 30 Days) ---
    const gscQuery = `
      SELECT 
        sum(clicks) as clicks,
        sum(impressions) as impressions,
        avg(position) as avg_position
      FROM \`${process.env.FIREBASE_PROJECT_ID}.${GSC_DATASET}.searchdata_url_impressions\`
      WHERE url = @url
      AND data_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
    `;

    const options = {
      query: ga4Query,
      params: { url: url },
    };

    const gscOptions = {
        query: gscQuery,
        params: { url: url },
    };

    // Run queries in parallel
    const [ga4Task, gscTask] = await Promise.all([
        bigquery.query(options),
        bigquery.query(gscOptions)
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
    console.error('BigQuery Error:', error);
    return res.status(500).json({ error: error.message || 'Error querying BigQuery' });
  }
}
