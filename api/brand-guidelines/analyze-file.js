
import busboy from 'busboy';
import mammoth from 'mammoth';
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

    const bb = busboy({ headers: req.headers });
    let fileBuffer = null;
    let fileInfo = null;

    bb.on('file', (fieldname, file, info) => {
        if (fieldname !== 'file') { file.resume(); return; }
        fileInfo = info;
        const chunks = [];
        file.on('data', (data) => chunks.push(data));
        file.on('end', () => { fileBuffer = Buffer.concat(chunks); });
    });

    bb.on('finish', async () => {
        if (!fileBuffer) return res.status(400).json({ error: 'No file uploaded' });

        try {
            const apiKey = process.env.GEMINI_API_KEY;
            const mime = fileInfo.mimeType;
            const filename = (fileInfo.filename || '').toLowerCase();
            const { GoogleGenerativeAI } = await import("@google/generative-ai");
            const genAI = new GoogleGenerativeAI(apiKey);

            let textContent = '';
            let prompt = `
Analyze the following document (Brand Guideline or Company Profile) and extract key strategic information.

INSTRUCTIONS:
- Identify the Brand Name, Industry, and Target Audience.
- Determine the Tone of Voice (e.g., Professional, Playful, Authoritative).
- Extract Core Values and USP.
- If explicit "Don'ts" are missing, INFER them based on the style.
- Summarize Visual Style (colors, vibe) if visible or described.
`;

            if (filename.endsWith('.docx') || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
                const result = await mammoth.extractRawText({ buffer: fileBuffer });
                textContent = result.value;
                prompt += `\n\nDOCUMENT CONTENT:\n${textContent.substring(0, 50000)}`;

                const model = genAI.getGenerativeModel({
                    model: 'gemini-2.0-flash-exp',
                    generationConfig: {
                        responseMimeType: "application/json",
                        responseSchema: getResponseSchema()
                    }
                });
                const response = await model.generateContent(prompt);

                return sendResponse(res, response);

            } else {
                const base64Data = fileBuffer.toString('base64');
                let aiMimeType = mime;
                if (filename.endsWith('.pdf')) aiMimeType = 'application/pdf';
                else if (filename.endsWith('.png')) aiMimeType = 'image/png';
                else if (filename.endsWith('.jpg') || filename.endsWith('.jpeg')) aiMimeType = 'image/jpeg';

                const model = genAI.getGenerativeModel({
                    model: 'gemini-2.0-flash-exp',
                    generationConfig: {
                        responseMimeType: "application/json",
                        responseSchema: getResponseSchema()
                    }
                });
                const response = await model.generateContent([
                    { inlineData: { mimeType: aiMimeType, data: base64Data } },
                    { text: prompt }
                ]);

                return sendResponse(res, response);
            }

        } catch (e) {
            console.error("Analyze File Error", e);
            return res.status(500).json({ error: 'Processing error', message: e.message });
        }
    });

    req.pipe(bb);
}

function getResponseSchema() {
    return {
        type: "OBJECT",
        properties: {
            brandName: { type: "STRING" },
            industry: { type: "STRING" },
            targetAudience: { type: "STRING" },
            tone: { type: "STRING" },
            coreValues: { type: "ARRAY", items: { type: "STRING" } },
            keywords: { type: "ARRAY", items: { type: "STRING" } },
            visualStyle: { type: "STRING" },
            dos: { type: "ARRAY", items: { type: "STRING" } },
            donts: { type: "ARRAY", items: { type: "STRING" } },
            summary: { type: "STRING" }
        },
        required: ["brandName", "tone", "dos", "donts", "summary"]
    };
}

function sendResponse(res, aiResponse) {
    try {
        const text = aiResponse.response.text();
        const json = JSON.parse(text);
        return res.status(200).json({ success: true, data: json });
    } catch (e) {
        return res.status(500).json({ error: "Failed to parse AI response", details: e.message });
    }
}
