
import admin from 'firebase-admin';
import busboy from 'busboy';

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
        const bb = busboy({ headers: req.headers });
        const fields = {};
        let fileBuffer = null;
        let fileInfo = null;

        bb.on('field', (fieldname, val) => { fields[fieldname] = val; });
        bb.on('file', (fieldname, file, info) => {
            if (fieldname !== 'file') { file.resume(); return; }
            fileInfo = { filename: info.filename, mimeType: info.mimeType };
            const chunks = [];
            file.on('data', (data) => chunks.push(data));
            file.on('end', () => { fileBuffer = Buffer.concat(chunks); });
        });

        bb.on('finish', async () => {
            try {
                if (!fileBuffer || !fileInfo) return res.status(400).json({ error: 'No file uploaded' });
                const brandId = fields.brandId;
                if (!brandId) return res.status(400).json({ error: 'brandId is required' });

                const timestamp = Date.now();
                const uploadPath = `brands/${brandId}/guidelines/${timestamp}-${fileInfo.filename}`;
                const uploadFile = bucket.file(uploadPath);

                await uploadFile.save(fileBuffer, { metadata: { contentType: fileInfo.mimeType } });
                const [url] = await uploadFile.getSignedUrl({ action: 'read', expires: '2099-12-31' });

                const guideId = `GUIDE_${brandId}_${timestamp}`;
                await db.collection('brand_guidelines').doc(guideId).set({
                    id: guideId,
                    brand_id: brandId,
                    type: fields.type || 'guideline',
                    file_name: fileInfo.filename,
                    file_url: url,
                    storage_path: uploadPath,
                    status: 'pending',
                    created_at: admin.firestore.FieldValue.serverTimestamp(),
                });

                return res.status(200).json({ success: true, id: guideId, fileUrl: url });
            } catch (err) {
                return res.status(500).json({ error: 'Server error', message: err.message });
            }
        });
        req.pipe(bb);
    } catch (e) {
        return res.status(500).json({ error: 'Server error', message: e.message });
    }
}
