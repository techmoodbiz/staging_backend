
import admin from "firebase-admin";

if (!admin.apps.length) {
    try {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
            }),
        });
    } catch (error) {
        console.error("Firebase admin initialization error", error);
    }
}

const db = admin.firestore();
const auth = admin.auth();

export default async function handler(req, res) {
    // Cấu hình CORS đầy đủ nhất
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    // Xử lý Preflight Request (OPTIONS) ngay lập tức
    if (req.method === "OPTIONS") {
        return res.status(200).end();
    }

    if (req.method !== "POST") {
        return res.status(405).json({ error: "Only POST allowed" });
    }

    try {
        // Kiểm tra Token
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({ error: "Unauthorized: Missing Token" });
        }

        const idToken = authHeader.split("Bearer ")[1];
        let currentUser;
        try {
            currentUser = await auth.verifyIdToken(idToken);
        } catch (error) {
            return res.status(401).json({ error: "Unauthorized: Invalid Token" });
        }

        // Kiểm tra Quyền (Admin hoặc Brand Owner)
        const currentUserDoc = await db.collection("users").doc(currentUser.uid).get();
        const currentUserData = currentUserDoc.data();

        if (!currentUserData || !["admin", "brand_owner"].includes(currentUserData.role)) {
            return res.status(403).json({ error: "Permission denied" });
        }

        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: "Missing userId" });

        console.log(`Deleting user: ${userId}, requested by: ${currentUser.uid}`);

        // 1. Xóa user khỏi Authentication (Nếu tồn tại)
        try {
            await auth.deleteUser(userId);
        } catch (e) {
            console.log("User not found in Auth or already deleted:", e.message);
        }

        // 2. Xóa user khỏi Firestore
        await db.collection("users").doc(userId).delete();

        return res.status(200).json({ success: true, message: "User deleted successfully from Auth and Firestore" });

    } catch (error) {
        console.error("Delete user error:", error);
        return res.status(500).json({ error: "Server error: " + error.message });
    }
}
