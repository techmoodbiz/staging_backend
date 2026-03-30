import "../firebaseForceDeps.js";

let admin = null;
let db = null;

async function initAdmin() {
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
      console.error('Firebase dynamic init error (auditContent):', error);
      throw error;
    }
  }
  return { admin, db };
}
import { performFullAudit } from '../auditUtils.js';

export default async function handler(req, res) {
  // 1. IMMEDIATE CORS & OPTIONS RESPONSE
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // 2. LAZY INIT (Dynamic)
    const { admin, db } = await initAdmin();

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // --- AUTH VERIFICATION ---
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized: Missing or invalid token format' });
    }

    const parts = authHeader.split('Bearer ');
    if (parts.length < 2) {
      return res.status(401).json({ error: 'Unauthorized: Malformed token' });
    }

    const token = parts[1].trim();
    let currentUser;

    try {
      currentUser = await admin.auth().verifyIdToken(token);
    } catch (error) {
      console.error("Token verification failed:", error);
      return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }

    const { text, language, platform, constructedPrompt } = req.body;

    const { result, usage, errors: auditErrors } = await performFullAudit({ text, language, platform, constructedPrompt });
    
    let tokensLogic = usage.tokensLogic;
    let tokensBrand = usage.tokensBrand;
    let tokensLang = usage.tokensLang;

    const finalResult = result;

    if (auditErrors.length > 0) {
      console.warn("Audit Partial Errors:", auditErrors);
      finalResult.identified_issues.push({
        category: 'ai_logic',
        severity: 'Low',
        problematic_text: 'System Warning',
        citation: 'System',
        reason: `Một số module Audit gặp lỗi: ${auditErrors.join(', ')} `,
        suggestion: 'Vui lòng kiểm tra lại cấu hình.'
      });
    }

    // --- TRACK USAGE (ASYNC) ---
    if (currentUser.uid) {
      try {
        const { logTokenUsage } = await import('../tokenLogger.js');
        const promises = [];

        if (tokensLogic > 0) {
          promises.push(logTokenUsage(currentUser.uid, 'AUDIT_LOGIC_LEGAL', tokensLogic, { status: 'success' }));
        }
        if (tokensBrand > 0) {
          promises.push(logTokenUsage(currentUser.uid, 'AUDIT_BRAND_PRODUCT', tokensBrand, { status: 'success' }));
        }
        if (tokensLang > 0) {
          promises.push(logTokenUsage(currentUser.uid, 'AUDIT_LANGUAGE', tokensLang, { status: 'success' }));
        }

        await Promise.all(promises);
      } catch (e) {
        console.error("Failed to track audit usage:", e);
      }
    }

    return res.status(200).json({
      success: true,
      result: finalResult,
      usage: {
        totalTokens: tokensLogic + tokensBrand + tokensLang
      }
    });

  } catch (error) {
    console.error('Audit API Critical Error:', error);
    return res.status(200).json({
      success: true,
      result: {
        summary: 'Lỗi hệ thống khi phân tích.',
        identified_issues: [{ category: 'ai_logic', severity: 'High', problematic_text: 'API Error', citation: 'System', reason: error.message, suggestion: 'Thử lại sau.' }],
      },
    });
  }
}
