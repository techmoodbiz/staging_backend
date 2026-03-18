import fetch from 'node-fetch';
import admin from 'firebase-admin';

// Initialize Firebase Admin (reuse existing logic from other endpoints like scrape.js)
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

export default async function handler(req, res) {
  // CORS Configuration
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // --- AUTH VERIFICATION ---
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
  }
  const token = authHeader.split('Bearer ')[1];
  try {
    await admin.auth().verifyIdToken(token);
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized: Token verification failed' });
  }
  // -------------------------

  try {
    const { url } = req.body;

    // Validate URL basic
    if (!url || !url.startsWith('http')) {
      return res.status(400).json({ error: 'URL không hợp lệ. Vui lòng nhập URL bắt đầu bằng http:// hoặc https://' });
    }

    const API_LOGIN = process.env.SEO_API_LOGIN;
    const API_PASSWORD = process.env.SEO_API_PASSWORD;

    if (!API_LOGIN || !API_PASSWORD) {
      return res.status(500).json({ error: 'Server thiếu cấu hình DataForSEO credentials.' });
    }

    const basicAuth = Buffer.from(`${API_LOGIN}:${API_PASSWORD}`).toString('base64');
    
    // Call DataForSEO On-Page Instant Pages API
    const postData = [
      {
        url: url,
        enable_javascript: false,
        load_resources: false, 
      }
    ];

    const response = await fetch('https://api.dataforseo.com/v3/on_page/instant_pages', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(postData),
      timeout: 30000 // Ensure we wait long enough 
    });

    if (!response.ok) {
      throw new Error(`DataForSEO API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const resultItem = data?.tasks?.[0]?.result?.[0]?.items?.[0];

    if (!resultItem) {
      return res.status(400).json({ error: 'Không thể phân tích URL này hoặc site chặn bot DataForSEO.' });
    }

    // Format Data
    const formattedResponse = {
      url: url,
      statusCode: resultItem.status_code || null,
      title: resultItem.meta?.title || '',
      metaDescription: resultItem.meta?.description || '',
      h1: resultItem.meta?.htags?.h1?.[0] || '', // First H1
      canonical: resultItem.meta?.canonical || '',
      wordCount: resultItem.meta?.content?.word_count || 0,
      indexability: resultItem.is_indexable ? 'index' : 'noindex', 
      rawProviderResponse: resultItem // optional raw data
    };

    return res.status(200).json({
        success: true,
        data: formattedResponse
    });

  } catch (error) {
    console.error('Lỗi API SEO:', error);
    return res.status(500).json({ error: error.message || 'Lỗi server khi fetch SEO API' });
  }
}
