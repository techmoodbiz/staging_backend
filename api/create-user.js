import admin from "firebase-admin";
import fetch from "node-fetch";
import dotenv from 'dotenv';

dotenv.config();

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

    if (req.method === "OPTIONS") {
        return res.status(200).end();
    }

    if (req.method !== "POST") {
        return res.status(405).json({ error: "Only POST allowed" });
    }

    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const idToken = authHeader.split("Bearer ")[1];

        let currentUser;
        try {
            const decodedToken = await auth.verifyIdToken(idToken);
            currentUser = decodedToken;
        } catch (error) {
            return res.status(401).json({ error: "Invalid token" });
        }

        const currentUserDoc = await db.collection("users").doc(currentUser.uid).get();
        const currentUserData = currentUserDoc.data();

        if (!currentUserData || !["admin", "brand_owner"].includes(currentUserData.role)) {
            return res.status(403).json({ error: "Permission denied" });
        }

        const { name, email, password, role, ownedBrandIds, assignedBrandIds } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ error: "Missing required fields: name, email, password" });
        }

        // 1. Create User in Firebase Auth
        const newUser = await auth.createUser({
            email,
            password,
            displayName: name,
            emailVerified: false 
        });

        // 2. Create User Profile in Firestore
        await db.collection("users").doc(newUser.uid).set({
            name,
            email,
            role,
            ownedBrandIds: role === "brand_owner" ? ownedBrandIds || [] : [],
            assignedBrandIds: role === "content_creator" ? assignedBrandIds || [] : [],
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            createdBy: currentUser.uid,
        });

        // 3. METHOD B: Trigger Firebase Built-in Email Template via REST API
        // Strategy: 
        // 1. Admin (server) creates a Custom Token for the new user.
        // 2. Server exchanges Custom Token for an ID Token (Simulating the new user logging in).
        // 3. Server calls "sendOobCode" (VERIFY_EMAIL) using the new user's ID Token.
        // Result: Firebase sends its native email template. No SMTP needed.

        let emailStatus = "init";
        let debugInfo = "";
        
        // Web API Key is required for the REST API calls. 
        // Use env var or fallback to the known public key from client config.
        const WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || "AIzaSyAa7s0JC9Z6Jz_cMQCD_oBT0ZUzj50tMVA";

        try {
            console.log(`>>> [CreateUser] Starting Firebase Native Email trigger for ${email}`);

            // A. Create Custom Token
            const customToken = await auth.createCustomToken(newUser.uid);

            // B. Exchange for ID Token (Sign in as the new user)
            const signInRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${WEB_API_KEY}`, {
                method: 'POST',
                body: JSON.stringify({ token: customToken, returnSecureToken: true }),
                headers: { 'Content-Type': 'application/json' }
            });
            
            const signInData = await signInRes.json();
            
            if (!signInRes.ok) {
                throw new Error(`SignIn failed: ${signInData.error?.message || 'Unknown error'}`);
            }

            const newUserIdToken = signInData.idToken;

            // C. Trigger Verification Email
            const verifyRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${WEB_API_KEY}`, {
                method: 'POST',
                body: JSON.stringify({ requestType: "VERIFY_EMAIL", idToken: newUserIdToken }),
                headers: { 'Content-Type': 'application/json' }
            });
            
            const verifyData = await verifyRes.json();

            if (!verifyRes.ok) {
                 throw new Error(`SendEmail failed: ${verifyData.error?.message || 'Unknown error'}`);
            }
            
            console.log(">>> [CreateUser] Firebase Email Triggered Successfully.");
            emailStatus = "sent_via_firebase_template";
            debugInfo = "Firebase Native Email Sent";

        } catch (e) {
            console.error(">>> [CreateUser] Failed to trigger Firebase Email:", e);
            emailStatus = "failed_firebase_trigger";
            debugInfo = e.message;
        }

        return res.status(200).json({
            success: true,
            message: `User created. Email: ${emailStatus}`,
            userId: newUser.uid,
            debug: debugInfo
        });
    } catch (error) {
        return res.status(500).json({ error: "Server error: " + error.message });
    }
}