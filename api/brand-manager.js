import * as cheerio from "cheerio";
import fetch from "node-fetch";
import busboy from 'busboy';
import mammoth from 'mammoth';

let admin = null;
let db = null;
let bucket = null;

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
                    storageBucket: process.env.GOOGLE_STORAGE_BUCKET,
                });
            }
            db = admin.firestore();
            bucket = admin.storage().bucket();
        } catch (error) {
            console.error('Firebase dynamic init error (brand-manager):', error);
            throw error;
        }
    }
    return { admin, db, bucket };
}

export default async function handler(req, res) {
    // 1. IMMEDIATE CORS & OPTIONS RESPONSE
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization");

    if (req.method === "OPTIONS") return res.status(200).end();

    try {
        // 2. LAZY INIT
        const { db, bucket } = await initAdmin();

        if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

        // --- AUTH VERIFICATION ---
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const token = authHeader.split('Bearer ')[1];
        let decodedUser;
        try {
            decodedUser = await admin.auth().verifyIdToken(token);
        } catch (error) {
            return res.status(401).json({ error: 'Unauthorized: Token verification failed' });
        }
        const uid = decodedUser.uid;
        const action = req.query.action;

        switch (action) {
            case 'analyze-website':
                return handleAnalyzeWebsite(req, res, uid);
            case 'analyze-file':
                return handleAnalyzeFile(req, res, uid);
            case 'approve-and-ingest':
                return handleApproveAndIngest(req, res, uid);
            case 'approve-text-and-ingest':
                return handleApproveTextAndIngest(req, res, uid);
            case 'create-from-file':
                return handleCreateFromFile(req, res, uid);
            default:
                return res.status(400).json({ error: "Invalid action" });
        }
    } catch (error) {
        console.error(`Error in brand-manager:`, error);
        return res.status(500).json({ error: error.message });
    }
}

// --- SUB-HANDLERS ---

async function handleAnalyzeWebsite(req, res, uid) {
    const { websiteUrl } = req.body;
    if (!websiteUrl) return res.status(400).json({ error: "Website URL is required" });

    const response = await fetch(websiteUrl, {
        headers: { "User-Agent": "Mozilla/5.0..." }
    });
    if (!response.ok) return res.status(400).json({ error: `Website blocked bot (${response.status})` });

    const html = await response.text();
    const $ = cheerio.load(html);
    $('script, style, noscript, iframe, svg, nav, footer').remove();

    let mainText = "";
    $("p, h1, h2, h3, h4, li, blockquote").each((i, elem) => {
        const text = $(elem).text().trim().replace(/\s+/g, " ");
        if (text.length > 20) mainText += text + "\n";
    });

    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
        model: 'gemini-2.0-flash',
        generationConfig: { responseMimeType: "application/json", responseSchema: getBrandSchema() }
    });
    const prompt = `Analyze brand from this content:\n${mainText.substring(0, 50000)}`;
    const aiResult = await model.generateContent(prompt);
    const json = JSON.parse(aiResult.response.text());

    if (uid && aiResult.response.usageMetadata?.totalTokenCount > 0) {
        import('../../tokenLogger.js').then(({ logTokenUsage }) => {
            logTokenUsage(uid, 'ANALYZE_WEBSITE', aiResult.response.usageMetadata.totalTokenCount, { url: websiteUrl });
        });
    }
    return res.status(200).json({ success: true, data: json, usage: aiResult.response.usageMetadata });
}

async function handleAnalyzeFile(req, res, uid) {
    const bb = busboy({ headers: req.headers });
    let fileBuffer = null;
    let fileInfo = null;

    bb.on('file', (fieldname, file, info) => {
        if (fieldname !== 'file') { file.resume(); return; }
        fileInfo = info;
        const chunks = [];
        file.on('data', (d) => chunks.push(d));
        file.on('end', () => { fileBuffer = Buffer.concat(chunks); });
    });

    bb.on('finish', async () => {
        if (!fileBuffer) return res.status(400).json({ error: 'No file' });
        const { GoogleGenerativeAI } = await import("@google/generative-ai");
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ 
            model: 'gemini-2.0-flash',
            generationConfig: { responseMimeType: "application/json", responseSchema: getBrandSchema() }
        });

        let prompt = "Extract brand info from document.";
        let response;

        if (fileInfo.filename.toLowerCase().endsWith('.docx')) {
            const result = await mammoth.extractRawText({ buffer: fileBuffer });
            response = await model.generateContent(`${prompt}\n\nCONTENT:\n${result.value.substring(0, 50000)}`);
        } else {
            response = await model.generateContent([
                { inlineData: { mimeType: fileInfo.mimeType, data: fileBuffer.toString('base64') } },
                { text: prompt }
            ]);
        }
        
        const json = JSON.parse(response.response.text());
        return res.status(200).json({ success: true, data: json, usage: response.response.usageMetadata });
    });
    req.pipe(bb);
}

async function handleCreateFromFile(req, res, uid) {
    const bb = busboy({ headers: req.headers });
    const fields = {};
    let fileBuffer = null;
    let fileInfo = null;

    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('file', (name, file, info) => {
        fileInfo = info;
        const chunks = [];
        file.on('data', (d) => chunks.push(d));
        file.on('end', () => { fileBuffer = Buffer.concat(chunks); });
    });

    bb.on('finish', async () => {
        const brandId = fields.brandId;
        const timestamp = Date.now();
        const uploadPath = `brands/${brandId}/guidelines/${timestamp}-${fileInfo.filename}`;
        const uploadFile = bucket.file(uploadPath);
        await uploadFile.save(fileBuffer, { metadata: { contentType: fileInfo.mimeType } });
        const [url] = await uploadFile.getSignedUrl({ action: 'read', expires: '2099-12-31' });

        const guideId = `GUIDE_${brandId}_${timestamp}`;
        await db.collection('brand_guidelines').doc(guideId).set({
            id: guideId, brand_id: brandId, type: fields.type || 'guideline',
            file_name: fileInfo.filename, file_url: url, storage_path: uploadPath,
            status: 'pending', created_at: admin.firestore.FieldValue.serverTimestamp(),
        });
        return res.status(200).json({ success: true, id: guideId, fileUrl: url });
    });
    req.pipe(bb);
}

async function handleApproveAndIngest(req, res, uid) {
    const { guidelineId } = req.body;
    const snap = await db.collection('brand_guidelines').doc(guidelineId).get();
    const guideline = snap.data();
    const [fileBuffer] = await bucket.file(guideline.storage_path).download();

    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    let text = "";
    const fileName = guideline.file_name.toLowerCase();
    if (fileName.match(/\.(pdf|jpg|jpeg|png|webp)$/)) {
        const res = await model.generateContent([{ inlineData: { mimeType: fileName.endsWith('.pdf') ? 'application/pdf' : 'image/png', data: fileBuffer.toString('base64') }}, { text: "Extract all text" }]);
        text = res.response.text();
    } else if (fileName.endsWith('.docx')) {
        text = (await mammoth.extractRawText({ buffer: fileBuffer })).value;
    } else {
        text = fileBuffer.toString('utf-8');
    }

    await performIngest(guidelineId, text, guideline.is_primary, fileName);
    return res.status(200).json({ success: true, message: "Ingested successfully" });
}

async function handleApproveTextAndIngest(req, res, uid) {
    const { guidelineId } = req.body;
    const snap = await db.collection('brand_guidelines').doc(guidelineId).get();
    const guideline = snap.data();
    let text = guideline.guideline_text;

    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const cleanRes = await model.generateContent(`Clean this text:\n${text.substring(0, 50000)}`);
    text = cleanRes.response.text();

    await performIngest(guidelineId, text, guideline.is_primary, guideline.file_name || 'Direct Input');
    return res.status(200).json({ success: true });
}

// --- HELPERS ---

async function performIngest(guidelineId, text, isPrimary, sourceFile) {
    const chunks = semanticChunking(text);
    const guidelineRef = db.collection('brand_guidelines').doc(guidelineId);
    let batch = db.batch();
    let count = 0;

    for (const chunk of chunks) {
        const chunkRef = guidelineRef.collection('chunks').doc();
        batch.set(chunkRef, {
            text: chunk.text,
            is_master_source: !!isPrimary,
            metadata: { source_file: sourceFile },
            created_at: admin.firestore.FieldValue.serverTimestamp()
        });
        count++;
        if (count >= 400) { await batch.commit(); batch = db.batch(); count = 0; }
    }
    batch.update(guidelineRef, { status: 'approved', guideline_text: text, updated_at: admin.firestore.FieldValue.serverTimestamp() });
    await batch.commit();
}

function semanticChunking(text) {
    return text.split(/\n\s*\n/).filter(p => p.trim().length > 20).map(p => ({ text: p.trim() }));
}

function getBrandSchema() {
    return {
        type: "OBJECT",
        properties: {
            brandName: { type: "STRING" },
            industry: { type: "STRING" },
            targetAudience: { type: "STRING" },
            tone: { type: "STRING" },
            coreValues: { type: "ARRAY", items: { type: "STRING" } },
            keywords: { type: "ARRAY", items: { type: "STRING" } },
            dos: { type: "ARRAY", items: { type: "STRING" } },
            donts: { type: "ARRAY", items: { type: "STRING" } },
            summary: { type: "STRING" }
        },
        required: ["brandName", "tone", "dos", "donts", "summary"]
    };
}
