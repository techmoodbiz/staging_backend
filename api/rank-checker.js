
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
    const PUBLIC_ACTIONS = ['get-next-keyword', 'submit-result', 'get-job-status'];
    
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
