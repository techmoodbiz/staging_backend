
import admin from 'firebase-admin';
import fetch from 'node-fetch';
import mammoth from 'mammoth';

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            type: 'service_account',
            project_id: process.env.FIREBASE_PROJECT_ID,
            private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
            client_email: process.env.FIREBASE_CLIENT_EMAIL,
        }),
        storageBucket: process.env.GOOGLE_STORAGE_BUCKET,
    });
}

const db = admin.firestore();
const bucket = admin.storage().bucket();

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
            if (currentChunk.length >= minChunkSize) {
                chunks.push(currentChunk);
                currentChunk = "";
            }
            if (cleanPara.length > maxChunkSize) {
                const sentences = cleanPara.match(/[^.!?]+[.!?]+(\s+|$)/g) || [cleanPara];
                let subChunk = "";
                for (const sentence of sentences) {
                    if (subChunk.length + sentence.length <= maxChunkSize) {
                        subChunk += sentence;
                    } else {
                        if (subChunk) chunks.push(subChunk.trim());
                        subChunk = sentence;
                    }
                }
                if (subChunk) currentChunk = subChunk.trim();
            } else {
                currentChunk = cleanPara;
            }
        }
    }
    if (currentChunk) chunks.push(currentChunk);
    return chunks.filter(c => c.length > 20).map((c, index) => ({
        text: c, start: index * 100, end: (index * 100) + c.length
    }));
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

        if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

        const guidelineRef = db.collection('brand_guidelines').doc(guidelineId);
        const guidelineSnap = await guidelineRef.get();
        if (!guidelineSnap.exists) return res.status(404).json({ error: 'Guideline not found' });

        const guideline = guidelineSnap.data();
        const filePath = guideline.storage_path;
        const file = bucket.file(filePath);
        const [fileBuffer] = await file.download();

        let text = '';
        const fileName = (guideline.file_name || '').toLowerCase();

        // --- VISUAL OCR USING GEMINI 2.0 FLASH ---
        const { GoogleGenerativeAI } = await import("@google/generative-ai");
        const genAI = new GoogleGenerativeAI(apiKey);

        if (fileName.endsWith('.pdf')) {
            console.log("Processing PDF with Gemini Vision...");
            const base64Data = fileBuffer.toString('base64');

            // Send direct PDF buffer to Gemini (MIME type application/pdf)
            // Gemini 2.0 Flash is multimodal and can read PDFs natively
            const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

            const response = await model.generateContent([
                {
                    inlineData: {
                        mimeType: 'application/pdf',
                        data: base64Data
                    }
                },
                { text: "Extract ALL text from this document.\nRULES:\n1. Keep structure (Headers, Lists) as Markdown.\n2. Do NOT summarize. I need the full content.\n3. Represents tables as Markdown tables." }
            ]);
            text = response.response.text();

        } else if (fileName.match(/\.(jpg|jpeg|png|webp)$/)) {
            console.log("Processing Image with Gemini Vision...");
            const base64Data = fileBuffer.toString('base64');
            let mimeType = 'image/png';
            if (fileName.endsWith('jpg') || fileName.endsWith('jpeg')) mimeType = 'image/jpeg';
            if (fileName.endsWith('webp')) mimeType = 'image/webp';

            const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

            const response = await model.generateContent([
                {
                    inlineData: {
                        mimeType: mimeType,
                        data: base64Data
                    }
                },
                { text: "Transcribe the text in this image to Markdown." }
            ]);
            text = response.response.text();

        } else if (fileName.endsWith('.docx') || fileName.endsWith('.doc')) {
            // Mammoth is good for Docx text
            const result = await mammoth.extractRawText({ buffer: fileBuffer });
            text = result.value;
        } else {
            text = fileBuffer.toString('utf-8');
        }

        if (!text || text.trim().length === 0) return res.status(400).json({ error: 'Empty file content' });

        // --- EMBEDDING & SAVING ---
        const chunks = semanticChunking(text, 1000, 100);
        const embedUrl = `https://generativelanguage.googleapis.com/v1beta/models/embedding-001:embedContent?key=${apiKey}`;

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

        // --- BATCH WRITE WITH ERROR HANDLING ---
        let batch = db.batch();
        let opCounter = 0;
        const BATCH_SIZE = 400;
        let successCount = 0;
        let failCount = 0;

        for (const chunkData of results) {
            const chunkRef = guidelineRef.collection('chunks').doc();

            // Store chunk even without embedding (allow null for fallback to simple RAG)
            batch.set(chunkRef, {
                text: chunkData.text,
                embedding: chunkData.embedding || null,
                has_embedding: !!chunkData.embedding,
                chunk_index: chunkData.chunk_index,
                is_master_source: !!guideline.is_primary,
                metadata: {
                    source_file: guideline.file_name,
                    char_count: chunkData.text.length,
                    type: "semantic_block",
                    extraction_method: "gemini_vision_v2"
                },
                created_at: admin.firestore.FieldValue.serverTimestamp(),
            });

            if (chunkData.embedding) successCount++;
            else failCount++;

            opCounter++;

            // Commit batch when reaching limit
            if (opCounter >= BATCH_SIZE) {
                try {
                    await batch.commit();
                    console.log(`Committed batch of ${opCounter} chunks`);
                } catch (batchError) {
                    console.error("Batch commit error:", batchError);
                    // Implement retry logic
                    try {
                        console.log("Retrying batch commit...");
                        await batch.commit();
                    } catch (retryError) {
                        throw new Error(`Failed to commit batch after retry: ${retryError.message}`);
                    }
                }
                batch = db.batch();
                opCounter = 0;
            }
        }

        // Final batch commit with error handling
        batch.update(guidelineRef, {
            status: 'approved',
            guideline_text: text.substring(0, 50000),
            chunk_count: results.length,
            chunks_with_embedding: successCount,
            chunks_without_embedding: failCount,
            processing_method: 'gemini_vision_v2',
            updated_at: admin.firestore.FieldValue.serverTimestamp(),
        });

        try {
            await batch.commit();
            console.log(`✅ Final batch committed. Total: ${results.length} chunks (${successCount} with embeddings, ${failCount} without)`);
        } catch (finalError) {
            console.error("Final batch commit error:", finalError);
            throw new Error(`Failed to finalize guideline: ${finalError.message}`);
        }

        res.status(200).json({
            success: true,
            message: `Processed ${results.length} chunks (${successCount} with embeddings)`,
            stats: { total: results.length, withEmbedding: successCount, withoutEmbedding: failCount }
        });

    } catch (e) {
        console.error("Ingest Error:", e);
        res.status(500).json({ error: 'Server error', message: e.message });
    }
}
