import admin from "firebase-admin";
import fetch from "node-fetch";

// Initialize Firebase Admin
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
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization");

    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const idToken = authHeader.split("Bearer ")[1];
        let currentUser;
        try {
            currentUser = await auth.verifyIdToken(idToken);
        } catch (error) {
            return res.status(401).json({ error: "Invalid token" });
        }

        const currentUserDoc = await db.collection("users").doc(currentUser.uid).get();
        const currentUserData = currentUserDoc.data();
        if (!currentUserData || !["admin", "brand_owner"].includes(currentUserData.role)) {
            return res.status(403).json({ error: "Permission denied" });
        }

        const { action } = req.body;

        if (action === 'delete') {
            return handleDelete(req, res, currentUser.uid);
        } else {
            // Default to Create
            return handleCreate(req, res, currentUser.uid, currentUserData.role);
        }

    } catch (error) {
        return res.status(500).json({ error: "Server error: " + error.message });
    }
}

async function handleCreate(req, res, currentUserId, currentUserRole) {
    const { name, email, password, role, ownedBrandIds, assignedBrandIds } = req.body;
    if (!name || !email || !password) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    const newUser = await auth.createUser({
        email,
        password,
        displayName: name,
        emailVerified: false 
    });

    await db.collection("users").doc(newUser.uid).set({
        name,
        email,
        role,
        ownedBrandIds: role === "brand_owner" ? ownedBrandIds || [] : [],
        assignedBrandIds: role === "content_creator" ? assignedBrandIds || [] : [],
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        createdBy: currentUserId,
    });

    // Trigger Firebase Email via REST API
    const WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || "AIzaSyAa7s0JC9Z6Jz_cMQCD_oBT0ZUzj50tMVA";
    let emailStatus = "init";
    try {
        const customToken = await auth.createCustomToken(newUser.uid);
        const signInRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${WEB_API_KEY}`, {
            method: 'POST',
            body: JSON.stringify({ token: customToken, returnSecureToken: true }),
            headers: { 'Content-Type': 'application/json' }
        });
        const signInData = await signInRes.json();
        if (signInRes.ok) {
            await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${WEB_API_KEY}`, {
                method: 'POST',
                body: JSON.stringify({ requestType: "VERIFY_EMAIL", idToken: signInData.idToken }),
                headers: { 'Content-Type': 'application/json' }
            });
            emailStatus = "sent_via_firebase_template";
        }
    } catch (e) {
        emailStatus = "failed_firebase_trigger";
    }

    return res.status(200).json({ success: true, message: `User created. Email: ${emailStatus}`, userId: newUser.uid });
}

async function handleDelete(req, res, currentUserId) {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: "Missing userId" });

    try { await auth.deleteUser(userId); } catch (e) {}
    await db.collection("users").doc(userId).delete();

    return res.status(200).json({ success: true, message: "User deleted successfully" });
}
