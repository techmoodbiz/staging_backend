
import admin from 'firebase-admin';

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            type: 'service_account',
            project_id: process.env.FIREBASE_PROJECT_ID,
            private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
            client_email: process.env.FIREBASE_CLIENT_EMAIL,
        }),
    });
}

const db = admin.firestore();

function semanticChunking(text, maxChunkSize = 1000, minChunkSize = 100) {
    const cleanText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const rawParagraphs = cleanText.split(/\n\s*\n/);
    const chunks = [];
    let currentChunk = "";

    for (const para of rawParagraphs) {
        const cleanPara = para.trim();
        if (!cleanPara) continue;
        const potentialSize = currentChunk.length + cleanPara.length + 2;
        if (potentialSize <= maxChunkSize) {
            currentChunk += (currentChunk ? "\n\n" : "") + cleanPara;
        } else {
            if (currentChunk.length >= minChunkSize) { chunks.push(currentChunk); currentChunk = ""; }
            if (cleanPara.length > maxChunkSize) {
                const sentences = cleanPara.match(/[^.!?]+[.!?]+(\s+|$)/g) || [cleanPara];
                let subChunk = "";
                for (const sentence of sentences) {
                    if (subChunk.length + sentence.length <= maxChunkSize) subChunk += sentence;
                    else { if (subChunk) chunks.push(subChunk.trim()); subChunk = sentence; }
                }
                if (subChunk) currentChunk = subChunk.trim();
            } else { currentChunk = cleanPara; }
        }
    }
    if (currentChunk) chunks.push(currentChunk);
    return chunks.filter(c => c.length > 20).map((c, index) => ({ text: c, start: index * 100, end: (index * 100) + c.length }));
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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
        const { guidelineId } = req.body;
        const apiKey = process.env.GEMINI_API_KEY;
        const guidelineRef = db.collection('brand_guidelines').doc(guidelineId);
        const guidelineSnap = await guidelineRef.get();
        if (!guidelineSnap.exists) return res.status(404).json({ error: 'Guideline not found' });

        const guideline = guidelineSnap.data();
        let originalText = guideline.guideline_text;
        if (!originalText) return res.status(400).json({ error: 'No text content' });

        // --- INTELLIGENT CLEANING WITH GEMINI 3.0 ---
        let processedText = originalText;
        if (originalText.length > 300) {
            console.log("Cleaning text with Gemini 3.0...");
            try {
                const { GoogleGenerativeAI } = await import("@google/generative-ai");
                const genAI = new GoogleGenerativeAI(apiKey);
                const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
                const cleanResponse = await model.generateContent(`
You are a Data Curator for a RAG System.
Your task: CLEAN the following raw text.
1. Remove "UI Noise" (Navigation menus, Footers, "Read more", "Accept Cookies", Advertisement placeholders).
2. Fix broken line breaks.
3. Keep the core informational content intact.
4. Output Markdown.

RAW TEXT:
"""
${originalText.substring(0, 50000)}
"""
`);

                const responseText = cleanResponse.response.text();
                if (responseText && responseText.length > 50) {
                    processedText = responseText;
                }
            } catch (e) {
                console.error("Cleaning failed", e);
                // Fallback to original text if AI fails
            }
        }

        const chunks = semanticChunking(processedText, 1000, 100);
        const embedUrl = `https://generativelanguage.googleapis.com/v1beta/models/embedding-001:embedContent?key=${apiKey}`;

        // Use global fetch (Node 18+)
        const embeddingPromises = chunks.map(async (chunk, idx) => {
            try {
                const response = await fetch(embedUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: { parts: [{ text: chunk.text }] } })
                });
                const data = await response.json();
                return { ...chunk, embedding: data.embedding?.values || null, chunk_index: idx };
            } catch (err) { return { ...chunk, embedding: null, chunk_index: idx }; }
        });

        const results = await Promise.all(embeddingPromises);
        let batch = db.batch();
        let opCounter = 0;
        const BATCH_SIZE = 400;

        for (const chunkData of results) {
            if (!chunkData.embedding) continue;
            const chunkRef = guidelineRef.collection('chunks').doc();
            batch.set(chunkRef, {
                text: chunkData.text,
                embedding: chunkData.embedding,
                chunk_index: chunkData.chunk_index,
                is_master_source: !!guideline.is_primary,
                metadata: { source_file: guideline.file_name || 'Direct Input', char_count: chunkData.text.length, type: "semantic_block", ingest_mode: "gemini_clean_v3" },
                created_at: admin.firestore.FieldValue.serverTimestamp(),
            });
            opCounter++;
            if (opCounter >= BATCH_SIZE) { await batch.commit(); batch = db.batch(); opCounter = 0; }
        }

        batch.update(guidelineRef, {
            status: 'approved',
            guideline_text: processedText,
            chunk_count: results.length,
            processing_method: 'gemini_clean_v3',
            updated_at: admin.firestore.FieldValue.serverTimestamp(),
        });

        await batch.commit();
        res.status(200).json({ success: true, message: `Processed ${chunks.length} chunks` });

    } catch (e) {
        console.error("Text Ingest Error:", e);
        res.status(500).json({ error: 'Server error', message: e.message });
    }
}
