
let admin = null;
let db = null;

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
    } catch (error) {
      console.error('Safe Load Error (Rank Checker):', error);
      throw error;
    }
  }
  return { admin, db };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { admin, db } = await initClients();
    const { action } = req.query;

    // --- AUTH VERIFICATION ---
    // Public actions for Extension
    const PUBLIC_ACTIONS = ['get-next-keyword', 'submit-result', 'get-job-status', 'check-keyword-gsc'];
    
    let userId = null;
    let userData = null;

    if (!PUBLIC_ACTIONS.includes(action)) {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const token = authHeader.split('Bearer ')[1];
      try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        userId = decodedToken.uid;
        const userDoc = await db.collection('users').doc(userId).get();
        userData = userDoc.data();
      } catch (error) {
        return res.status(401).json({ error: 'Unauthorized: Token verification failed' });
      }
    }

    switch (action) {
      case 'get-keywords':
        return handleGetKeywords(req, res, db, userData);
      case 'manage-keywords':
        return handleManageKeywords(req, res, db, userData);
      case 'create-job':
        return handleCreateJob(req, res, db, userData);
      case 'get-rankings':
        return handleGetRankings(req, res, db, userData);
      case 'get-history':
        return handleGetHistory(req, res, db, userData);
      
      // Extension Endpoints
      case 'get-next-keyword':
        return handleGetNextKeyword(req, res, db);
      case 'submit-result':
        return handleSubmitResult(req, res, db);
      case 'get-job-status':
        return handleGetJobStatus(req, res, db);
      // API-based check (không cần extension mở trình duyệt, không bị CAPTCHA)
      case 'check-keyword-api':
        return handleCheckKeywordWithAPI(req, res, db);
      // Google Search Console API — trả thêm clicks/impressions/CTR, không quota hàng ngày
      case 'gsc-rankings':
        return handleGSCRankings(req, res, db, userData);
      case 'gsc-sync-job':
        return handleGSCSyncJob(req, res, db, userData);
      // Check 1 keyword qua GSC (dùng khi CSE không tìm thấy, thay cho browser scraping)
      case 'check-keyword-gsc':
        return handleCheckKeywordGSC(req, res, db);

      default:
        return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (error) {
    console.error('RANK CHECKER ERROR:', error);
    return res.status(500).json({ error: error.message });
  }
}

async function handleGetKeywords(req, res, db, userData) {
  const { brandId } = req.query;
  if (!brandId) return res.status(400).json({ error: 'brandId required' });
  
  // Try both snake_case and camelCase for backward compatibility during migration if needed
  // but for now we use brandId as primary
  // Query using brandId (new)
  let snapshot = await db.collection('rank_keywords')
    .where('brandId', '==', brandId)
    .get();
  
  // If no results, try brand_id (old)
  if (snapshot.empty) {
    snapshot = await db.collection('rank_keywords')
      .where('brand_id', '==', brandId)
      .get();
  }
  
  const keywords = snapshot.docs.map(doc => {
    const data = doc.data();
    return { 
      id: doc.id, 
      keyword: data.keyword,
      brandId: data.brandId || data.brand_id,
      createdAt: data.createdAt || data.created_at
    };
  });

  // Sort in memory instead of Firestore to avoid index requirement
  keywords.sort((a, b) => (a.keyword || '').localeCompare(b.keyword || ''));

  res.json(keywords);
}

async function handleManageKeywords(req, res, db, userData) {
  if (req.method !== 'POST') return res.status(405).end();
  const { action, subAction, brandId, keyword, keywordId, keywords } = req.body;
  const effectiveAction = action || subAction;

  if (effectiveAction === 'add') {
    const docRef = await db.collection('rank_keywords').add({
      brandId: brandId,
      keyword: keyword.trim(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return res.json({ id: docRef.id });
  } 
  
  if (effectiveAction === 'bulk-add') {
    const batch = db.batch();
    const added = [];
    for (const kw of keywords) {
      const ref = db.collection('rank_keywords').doc();
      batch.set(ref, {
        brandId: brandId,
        keyword: kw.trim(),
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      added.push({ id: ref.id, keyword: kw.trim() });
    }
    await batch.commit();
    return res.json({ added: added.length });
  }

  if (effectiveAction === 'delete') {
    await db.collection('rank_keywords').doc(keywordId).delete();
    // Also delete history for this keyword
    const historySnap = await db.collection('rank_history').where('keywordId', '==', keywordId).get();
    const batch = db.batch();
    historySnap.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    return res.json({ success: true });
  }

  res.status(400).json({ error: 'Invalid action' });
}

async function handleCreateJob(req, res, db, userData) {
  if (req.method !== 'POST') return res.status(405).end();
  const { brandId } = req.body;

  const brandSnap = await db.collection('brands').doc(brandId).get();
  if (!brandSnap.exists) return res.status(404).json({ error: 'Brand not found' });
  const brandData = brandSnap.data();
  const domain = brandData.domain || '';

  // ── Hủy tất cả job đang processing của brand này (tránh extension lấy nhầm job cũ) ──
  const staleJobsSnap = await db.collection('rank_jobs')
    .where('brand_id', '==', brandId)
    .where('status', '==', 'processing')
    .get();
  if (!staleJobsSnap.empty) {
    const batch = db.batch();
    staleJobsSnap.docs.forEach(doc => batch.update(doc.ref, { status: 'cancelled' }));
    await batch.commit();
    console.log(`[CreateJob] Cancelled ${staleJobsSnap.size} stale job(s) for brand ${brandId}`);
  }

  // Query using brandId (new)
  let keywordsSnap = await db.collection('rank_keywords')
    .where('brandId', '==', brandId)
    .get();
  
  // If no results, try brand_id (old)
  if (keywordsSnap.empty) {
    keywordsSnap = await db.collection('rank_keywords')
      .where('brand_id', '==', brandId)
      .get();
  }

  if (keywordsSnap.empty) return res.json({ message: 'No keywords', jobId: null });

  const keywords = keywordsSnap.docs.map(doc => ({ id: doc.id, keyword: doc.data().keyword }));
  
  const jobId = `job_${Date.now()}`;
  await db.collection('rank_jobs').doc(jobId).set({
    brand_id: brandId,
    domain: domain,
    total: keywords.length,
    pending_keywords: keywords,
    completed_results: [],
    status: 'processing',
    created_at: admin.firestore.FieldValue.serverTimestamp()
  });

  res.json({ jobId, total: keywords.length, domain });
}

async function handleGetNextKeyword(req, res, db) {
  const { jobId: specificJobId } = req.query;

  // Nếu có jobId cụ thể, lấy job đó trước
  if (specificJobId) {
    const jobDoc = await db.collection('rank_jobs').doc(specificJobId).get();
    if (jobDoc.exists) {
      const jobData = jobDoc.data();
      if (jobData.status === 'processing' && jobData.pending_keywords?.length > 0) {
        const keywordObj = jobData.pending_keywords[0];
        await jobDoc.ref.update({
          pending_keywords: admin.firestore.FieldValue.arrayRemove(keywordObj)
        });
        return res.json({
          jobId: jobDoc.id,
          keywordId: keywordObj.id,
          keyword: keywordObj.keyword,
          domain: jobData.domain,
          brandId: jobData.brand_id,
          remaining: jobData.pending_keywords.length - 1,
          total: jobData.total
        });
      }
      // Job hết pending_keywords → đánh dấu completed
      if (jobData.pending_keywords?.length === 0) {
        await jobDoc.ref.update({ status: 'completed' });
      }
      return res.json(null);
    }
  }

  // Fallback: tìm job processing bất kỳ
  const jobsSnap = await db.collection('rank_jobs')
    .where('status', '==', 'processing')
    .get();

  if (jobsSnap.empty) return res.json(null);

  // Sort in memory by created_at asc
  const jobs = jobsSnap.docs.map(doc => ({ id: doc.id, ref: doc.ref, ...doc.data() }));
  jobs.sort((a, b) => (a.createdAt || a.created_at || 0) - (b.createdAt || b.created_at || 0));

  const jobDoc = jobs[0];
  const jobData = jobDoc;

  if (!jobData.pending_keywords?.length) {
    await jobDoc.ref.update({ status: 'completed' });
    return res.json(null);
  }

  const keywordObj = jobData.pending_keywords[0];
  
  // Remove from pending in the document (simulating pop)
  await jobDoc.ref.update({
    pending_keywords: admin.firestore.FieldValue.arrayRemove(keywordObj)
  });

  res.json({
    jobId: jobDoc.id,
    keywordId: keywordObj.id,
    keyword: keywordObj.keyword,
    domain: jobData.domain,
    brandId: jobData.brand_id,
    remaining: jobData.pending_keywords.length - 1,
    total: jobData.total
  });
}

async function handleSubmitResult(req, res, db) {
  if (req.method !== 'POST') return res.status(405).end();
  const { jobId, keywordId, keyword, position, url, error } = req.body;

  const jobRef = db.collection('rank_jobs').doc(jobId);
  const result = {
    keywordId,
    keyword,
    position: position ?? null,
    url: url || null,
    error: error || null,
    checkedAt: new Date().toISOString()
  };

  await jobRef.update({
    completed_results: admin.firestore.FieldValue.arrayUnion(result)
  });

  // Save to history
  if (keywordId) {
    const jobSnap = await jobRef.get();
    const brandId = jobSnap.data().brandId || jobSnap.data().brand_id;

    await db.collection('rank_history').add({
      keywordId: keywordId,
      brandId: brandId,
      keyword: keyword,
      position: position ?? null,
      url: url || null,
      checkedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  }

  res.json({ ok: true });
}

async function handleGetJobStatus(req, res, db) {
  const { jobId } = req.query;
  
  if (!jobId) {
    // Global status for extension badge
    const processingSnap = await db.collection('rank_jobs').where('status', '==', 'processing').get();
    return res.json({ pendingJobs: processingSnap.size });
  }

  const doc = await db.collection('rank_jobs').doc(jobId).get();
  if (!doc.exists) return res.status(404).json({ error: 'Job not found' });
  
  const data = doc.data();
  res.json({
    jobId: doc.id,
    domain: data.domain,
    total: data.total,
    pending: data.pending_keywords.length,
    completed: data.completed_results.length,
    done: data.status === 'completed' || (data.pending_keywords.length === 0 && data.completed_results.length >= data.total),
    results: data.completed_results
  });
}

async function handleGetRankings(req, res, db, userData) {
  const { brandId } = req.query;
  
  // Get all keywords for the brand
  const keywordsSnap = await db.collection('rank_keywords').where('brandId', '==', brandId).get();
  let keywords = keywordsSnap.docs.map(doc => ({ id: doc.id, keyword: doc.data().keyword }));
  
  if (keywords.length === 0) {
    // Fallback for snake_case
    const fallbackSnap = await db.collection('rank_keywords').where('brand_id', '==', brandId).get();
    keywords = fallbackSnap.docs.map(doc => ({ id: doc.id, keyword: doc.data().keyword }));
  }

  // For each keyword, get the latest history entry
  const results = [];
  for (const kw of keywords) {
    // Get history for this keyword
    let historySnap = await db.collection('rank_history')
      .where('keywordId', '==', kw.id)
      .get();
    
    // Fallback if not found in camelCase
    if (historySnap.empty) {
      historySnap = await db.collection('rank_history')
        .where('keyword_id', '==', kw.id)
        .get();
    }
    
    if (!historySnap.empty) {
      // Sort in memory to find the latest
      const historyDocs = historySnap.docs.map(doc => doc.data());
      historyDocs.sort((a, b) => {
        const timeA = (a.checkedAt || a.checked_at)?.toDate()?.getTime() || 0;
        const timeB = (b.checkedAt || b.checked_at)?.toDate()?.getTime() || 0;
        return timeB - timeA;
      });
      
      const h = historyDocs[0];
      results.push({
        keywordId: kw.id,
        keyword: kw.keyword,
        position: h.position,
        url: h.url,
        checkedAt: (h.checkedAt || h.checked_at)?.toDate()?.toISOString() || null
      });
    } else {
      results.push({
        keywordId: kw.id,
        keyword: kw.keyword,
        position: null,
        url: null,
        checkedAt: null
      });
    }
  }

  res.json(results);
}

async function handleGetHistory(req, res, db, userData) {
  const { keywordId, limit = 30 } = req.query;
  const historySnap = await db.collection('rank_history')
    .where('keyword_id', '==', keywordId)
    .get();
  
  const history = historySnap.docs.map(doc => ({
    id: doc.id,
    ...doc.data(),
    checkedAt: (doc.data().checkedAt || doc.data().checked_at)?.toDate()?.toISOString()
  }));

  // Sort in memory
  history.sort((a, b) => new Date(b.checkedAt).getTime() - new Date(a.checkedAt).getTime());
  
  res.json(history.slice(0, parseInt(limit)));
}

// ─── Google Custom Search API — Không CAPTCHA ─────────────────────────────────
// Thay thế hoàn toàn việc extension mở browser để scrape Google
async function handleCheckKeywordWithAPI(req, res, db) {
  if (req.method !== 'POST') return res.status(405).end();
  
  const { jobId, keywordId, keyword, domain } = req.body;
  const apiKey = process.env.GOOGLE_API_KEY;
  const cx = process.env.GOOGLE_CX;

  if (!apiKey || !cx) {
    return res.status(500).json({ error: 'GOOGLE_API_KEY hoặc GOOGLE_CX chưa được cấu hình trong .env' });
  }
  if (!keyword || !domain) {
    return res.status(400).json({ error: 'keyword và domain là bắt buộc' });
  }

  // Helper: chuẩn hóa domain để so sánh
  const normDomain = (input) => {
    try {
      let s = input.trim();
      if (!s.startsWith('http')) s = 'https://' + s;
      return new URL(s).hostname.replace(/^www\./, '').toLowerCase();
    } catch (_) {
      return input.replace(/^www\./, '').toLowerCase().split('/')[0].trim();
    }
  };

  const allItems = [];
  const MAX_PAGES = 3; // Top 30 — tương ứng 3 API calls × 10 results

  for (let page = 0; page < MAX_PAGES; page++) {
    const start = page * 10 + 1; // 1, 11, 21
    try {
      const params = new URLSearchParams({
        key: apiKey,
        cx: cx,
        q: keyword,
        num: '10',
        start: String(start),
        hl: 'vi',
        gl: 'vn',
      });

      const apiRes = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`);
      const data = await apiRes.json();

      if (data.error) {
        // Quota hết
        if (data.error.code === 429 || data.error.status === 'RESOURCE_EXHAUSTED') {
          console.warn('[RankAPI] Hết quota Google Custom Search API hôm nay (100 queries/day)');
          break;
        }
        console.error('[RankAPI] API error:', data.error.message);
        break;
      }

      const items = data.items || [];
      items.forEach((item, i) => {
        allItems.push({
          position: start + i,
          url: item.link,
          title: item.title,
        });
      });

      // Ít hơn 10 kết quả = không có trang tiếp theo
      if (items.length < 10) break;

    } catch (err) {
      console.error(`[RankAPI] Lỗi page ${page + 1}:`, err.message);
      break;
    }
  }

  // Tìm vị trí của domain mục tiêu (hỗ trợ cả subdomain)
  const targetClean = normDomain(domain);
  let position = null;
  let resultUrl = null;

  for (const item of allItems) {
    const d = normDomain(item.url);
    if (d === targetClean || d.endsWith('.' + targetClean) || targetClean.endsWith('.' + d)) {
      position = item.position;
      resultUrl = item.url;
      break;
    }
  }

  // Debug: log top 5 URLs để kiểm tra CSE có trả đúng kết quả không
  console.log(`[RankAPI] "${keyword}" | target: "${targetClean}" | position: #${position || 'N/A'} | total: ${allItems.length}`);
  if (allItems.length > 0) {
    console.log('[RankAPI] Top 5 URLs returned:');
    allItems.slice(0, 5).forEach((item, i) => {
      const d = normDomain(item.url);
      console.log(`  ${item.position}. ${d} — ${item.url.substring(0, 80)} ${d === targetClean ? '✅ MATCH' : ''}`);
    });
  } else {
    console.warn('[RankAPI] ⚠️ API trả về 0 kết quả — Kiểm tra Google CSE config tại: https://cse.google.com');
    console.warn('[RankAPI] Đảm bảo CSE được cấu hình "Search the entire web"');
  }

  // Chỉ lưu khi tìm thấy vị trí — nếu null thì browser scraping sẽ submit sau
  if (jobId && keywordId && position !== null) {
    const result = {
      keywordId, keyword,
      position,
      url: resultUrl || null,
      checkedAt: new Date().toISOString(),
    };

    const jobRef = db.collection('rank_jobs').doc(jobId);
    await jobRef.update({
      completed_results: admin.firestore.FieldValue.arrayUnion(result)
    });

    await db.collection('rank_history').add({
      keywordId,
      keyword,
      position,
      url: resultUrl || null,
      checkedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  }

  return res.json({
    ok: true,
    keyword,
    domain,
    targetDomainNormalized: targetClean,
    position,
    url: resultUrl,
    totalScanned: allItems.length,
    top5: allItems.slice(0, 5), // Debug: xem API trả về gì
    source: 'google-custom-search-api',
  });
}

// ─── Google Search Console API ────────────────────────────────────────────────
// Trả thêm clicks/impressions/CTR, không bị quota hàng ngày như Custom Search
// Yêu cầu: GOOGLE_SERVICE_ACCOUNT_KEY env var (JSON của service account)
//          Service account phải được thêm vào GSC với quyền "Restricted"

async function getGSCAuthClient() {
  const { google } = await import('googleapis');
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY chưa được cấu hình');
  const credentials = typeof keyJson === 'string' ? JSON.parse(keyJson) : keyJson;
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });
  return { google, auth };
}

// GET /api/rank-checker?action=gsc-rankings&brandId=xxx&days=28
// Lấy thứ hạng từ GSC cho tất cả keywords của brand
async function handleGSCRankings(req, res, db, userData) {
  const { brandId, days = '28' } = req.query;
  if (!brandId) return res.status(400).json({ error: 'brandId required' });

  const brandSnap = await db.collection('brands').doc(brandId).get();
  if (!brandSnap.exists) return res.status(404).json({ error: 'Brand not found' });
  const brandData = brandSnap.data();
  const domain = brandData.domain || '';
  if (!domain) return res.status(400).json({ error: 'Brand chưa có domain' });

  // Chuẩn hoá siteUrl cho GSC (hỗ trợ cả sc-domain: lẫn https://)
  const siteUrl = domain.startsWith('sc-domain:') ? domain : `https://${domain.replace(/^https?:\/\//, '')}`;

  let google, auth;
  try {
    ({ google, auth } = await getGSCAuthClient());
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }

  // Lấy danh sách keywords
  let keywordsSnap = await db.collection('rank_keywords').where('brandId', '==', brandId).get();
  if (keywordsSnap.empty) {
    keywordsSnap = await db.collection('rank_keywords').where('brand_id', '==', brandId).get();
  }
  if (keywordsSnap.empty) return res.json([]);

  const keywords = keywordsSnap.docs.map(doc => ({ id: doc.id, keyword: doc.data().keyword }));

  const searchconsole = google.searchconsole({ version: 'v1', auth });

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - parseInt(days));
  const fmt = d => d.toISOString().split('T')[0];

  const results = [];
  for (const kw of keywords) {
    try {
      const apiRes = await searchconsole.searchanalytics.query({
        siteUrl,
        requestBody: {
          startDate: fmt(startDate),
          endDate: fmt(endDate),
          dimensions: ['query'],
          dimensionFilterGroups: [{
            filters: [{ dimension: 'query', operator: 'equals', expression: kw.keyword }],
          }],
          rowLimit: 1,
        },
      });

      const rows = apiRes.data.rows || [];
      if (rows.length > 0) {
        const row = rows[0];
        results.push({
          keywordId: kw.id,
          keyword: kw.keyword,
          position: Math.round(row.position),
          positionExact: row.position,
          clicks: row.clicks,
          impressions: row.impressions,
          ctr: parseFloat((row.ctr * 100).toFixed(2)),
          found: true,
          period: `${fmt(startDate)} → ${fmt(endDate)}`,
          source: 'gsc',
        });
      } else {
        results.push({ keywordId: kw.id, keyword: kw.keyword, position: null, clicks: 0, impressions: 0, ctr: 0, found: false, source: 'gsc' });
      }

      // Tránh rate limit GSC API
      await new Promise(r => setTimeout(r, 150));
    } catch(err) {
      results.push({ keywordId: kw.id, keyword: kw.keyword, position: null, error: err.message, found: false, source: 'gsc' });
    }
  }

  return res.json(results);
}

// POST /api/rank-checker?action=gsc-sync-job
// Lấy dữ liệu GSC và ghi vào rank_history (giống như extension submit kết quả)
// Body: { brandId }
async function handleGSCSyncJob(req, res, db, userData) {
  if (req.method !== 'POST') return res.status(405).end();
  const { brandId, days = 28 } = req.body;
  if (!brandId) return res.status(400).json({ error: 'brandId required' });

  const brandSnap = await db.collection('brands').doc(brandId).get();
  if (!brandSnap.exists) return res.status(404).json({ error: 'Brand not found' });
  const brandData = brandSnap.data();
  const domain = brandData.domain || '';
  const siteUrl = domain.startsWith('sc-domain:') ? domain : `https://${domain.replace(/^https?:\/\//, '')}`;

  let google, auth;
  try {
    ({ google, auth } = await getGSCAuthClient());
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }

  let keywordsSnap = await db.collection('rank_keywords').where('brandId', '==', brandId).get();
  if (keywordsSnap.empty) {
    keywordsSnap = await db.collection('rank_keywords').where('brand_id', '==', brandId).get();
  }
  if (keywordsSnap.empty) return res.json({ synced: 0 });

  const keywords = keywordsSnap.docs.map(doc => ({ id: doc.id, keyword: doc.data().keyword }));
  const searchconsole = google.searchconsole({ version: 'v1', auth });

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const fmt = d => d.toISOString().split('T')[0];

  let synced = 0;
  const batch = [];

  for (const kw of keywords) {
    try {
      const apiRes = await searchconsole.searchanalytics.query({
        siteUrl,
        requestBody: {
          startDate: fmt(startDate),
          endDate: fmt(endDate),
          dimensions: ['query'],
          dimensionFilterGroups: [{
            filters: [{ dimension: 'query', operator: 'equals', expression: kw.keyword }],
          }],
          rowLimit: 1,
        },
      });

      const rows = apiRes.data.rows || [];
      const row = rows[0] || null;
      batch.push({
        keywordId: kw.id,
        brandId,
        keyword: kw.keyword,
        position: row ? Math.round(row.position) : null,
        positionExact: row ? row.position : null,
        clicks: row ? row.clicks : 0,
        impressions: row ? row.impressions : 0,
        ctr: row ? parseFloat((row.ctr * 100).toFixed(2)) : 0,
        url: null,
        checkedAt: admin.firestore.FieldValue.serverTimestamp(),
        source: 'gsc',
        period: `${fmt(startDate)} → ${fmt(endDate)}`,
      });
      synced++;

      await new Promise(r => setTimeout(r, 150));
    } catch(err) {
      console.error(`[GSC Sync] "${kw.keyword}":`, err.message);
    }
  }

  // Ghi batch vào rank_history
  const writeBatch = db.batch();
  for (const entry of batch) {
    const ref = db.collection('rank_history').doc();
    writeBatch.set(ref, entry);
  }
  await writeBatch.commit();

  console.log(`[GSC Sync] brand=${brandId} | synced=${synced}/${keywords.length}`);
  return res.json({ ok: true, synced, total: keywords.length, period: `${fmt(startDate)} → ${fmt(endDate)}` });
}

// ─── Check 1 keyword qua GSC (thay browser scraping khi CSE không thấy top 30) ─
// POST /api/rank-checker?action=check-keyword-gsc
// Body: { jobId, keywordId, keyword, domain }
async function handleCheckKeywordGSC(req, res, db) {
  if (req.method !== 'POST') return res.status(405).end();
  const { jobId, keywordId, keyword, domain } = req.body;
  if (!keyword || !domain) return res.status(400).json({ error: 'keyword và domain là bắt buộc' });

  // Lấy siteUrl từ brand domain
  const normDomain = (d) => {
    try {
      let s = d.trim();
      if (!s.startsWith('http')) s = 'https://' + s;
      return new URL(s).hostname.replace(/^www\./, '').toLowerCase();
    } catch (_) { return d.replace(/^www\./, '').toLowerCase().split('/')[0].trim(); }
  };
  const cleanDomain = normDomain(domain);
  const siteUrl = `https://${cleanDomain}`;

  let google, auth;
  try {
    ({ google, auth } = await getGSCAuthClient());
  } catch(e) {
    return res.json({ ok: false, position: null, error: e.message });
  }

  const DAYS = 28;
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - DAYS);
  const fmt = d => d.toISOString().split('T')[0];

  try {
    const searchconsole = google.searchconsole({ version: 'v1', auth });
    const apiRes = await searchconsole.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate: fmt(startDate),
        endDate: fmt(endDate),
        dimensions: ['query'],
        dimensionFilterGroups: [{
          filters: [{ dimension: 'query', operator: 'equals', expression: keyword }],
        }],
        rowLimit: 1,
      },
    });

    const rows = apiRes.data.rows || [];
    if (rows.length === 0) {
      console.log(`[GSC KW] "${keyword}" → không có dữ liệu GSC`);
      return res.json({ ok: true, position: null, clicks: 0, impressions: 0, days: DAYS, source: 'gsc' });
    }

    const row = rows[0];
    const position = Math.round(row.position);
    console.log(`[GSC KW] "${keyword}" → #${position} (avg ${row.position.toFixed(1)}) | clicks:${row.clicks} impr:${row.impressions}`);

    // Lưu vào rank_history nếu có jobId
    if (jobId && keywordId) {
      await db.collection('rank_history').add({
        keywordId,
        keyword,
        position,
        positionExact: row.position,
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: parseFloat((row.ctr * 100).toFixed(2)),
        url: null,
        checkedAt: admin.firestore.FieldValue.serverTimestamp(),
        source: 'gsc',
        period: `${fmt(startDate)} → ${fmt(endDate)}`,
      });
    }

    return res.json({
      ok: true,
      position,
      positionExact: row.position,
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: parseFloat((row.ctr * 100).toFixed(2)),
      days: DAYS,
      source: 'gsc',
    });
  } catch(err) {
    console.error(`[GSC KW] "${keyword}" error:`, err.message);
    return res.json({ ok: false, position: null, error: err.message });
  }
}
