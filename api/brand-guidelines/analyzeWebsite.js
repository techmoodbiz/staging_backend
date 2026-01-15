
import * as cheerio from "cheerio";
import fetch from "node-fetch";
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
    // CORS Header Setting
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization");

    if (req.method === "OPTIONS") {
        return res.status(200).end();
    }

    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

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
        const { websiteUrl } = req.body;

        if (!websiteUrl) {
            return res.status(400).json({ error: "Website URL is required" });
        }

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            console.error("Missing GEMINI_API_KEY environment variable");
            return res.status(500).json({ error: "Server API Key configuration missing" });
        }

        // 1. Scrape Website Content
        const response = await fetch(websiteUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
            },
        });

        if (!response.ok) {
            return res.status(400).json({
                error: `Website chặn bot (status ${response.status}). Vui lòng copy text thủ công.`,
            });
        }

        const html = await response.text();
        const $ = cheerio.load(html);

        // Remove noise
        $('script, style, noscript, iframe, svg, nav, footer, [role="alert"]').remove();

        const extractedData = {
            title: $("title").text() || "",
            metaDescription: $('meta[name="description"]').attr("content") || "",
            mainText: "",
            headings: [],
        };

        // Extract structured text
        $("body").find("p, h1, h2, h3, h4, li, blockquote, article").each((i, elem) => {
            const text = $(elem).text().trim().replace(/\s+/g, " ");
            if (text.length > 20) {
                extractedData.mainText += text + "\n";
            }
        });

        $("h1, h2, h3").each((i, elem) => {
            const text = $(elem).text().trim();
            if (text) extractedData.headings.push(text);
        });

        // 2. Analyze with Gemini
        const contentContext = `
TITLE: ${extractedData.title}
DESCRIPTION: ${extractedData.metaDescription}
HEADINGS: ${extractedData.headings.join(" | ")}
CONTENT SAMPLE:
${extractedData.mainText.substring(0, 80000)} 
        `;

        // FIX IMPORT
        const { GoogleGenerativeAI } = await import("@google/generative-ai");
        const genAI = new GoogleGenerativeAI(apiKey);

        const prompt = `
You are a Senior Brand Strategist. Analyze the provided website content to reverse-engineer the "Brand DNA".

TASK:
Infer the Brand Guideline based on the writing style, vocabulary, and stated values.

CRITICAL INSTRUCTIONS:
1. **Tone of Voice**: Be specific (e.g., "Empathetic but Authoritative", "Witty and Gen-Z").
2. **Implied Rules**: If they don't use slang, the "Don't" is "Slang". If they use emojis, the "Do" is "Emojis".
3. **USP**: Extract the unique value proposition from the headings.

INPUT CONTEXT:
${contentContext}
`;

        const model = genAI.getGenerativeModel({
            model: 'gemini-2.0-flash-exp',
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        brandName: { type: "STRING" },
                        industry: { type: "STRING" },
                        targetAudience: { type: "STRING" },
                        tone: { type: "STRING" },
                        coreValues: { type: "ARRAY", items: { type: "STRING" } },
                        keywords: { type: "ARRAY", items: { type: "STRING" }, description: "USP/Selling Points" },
                        visualStyle: { type: "STRING" },
                        dos: { type: "ARRAY", items: { type: "STRING" } },
                        donts: { type: "ARRAY", items: { type: "STRING" } },
                        summary: { type: "STRING" }
                    },
                    required: ["brandName", "tone", "dos", "donts", "summary"]
                }
            }
        });
        const aiResult = await model.generateContent(prompt);

        const brandGuideline = JSON.parse(aiResult.response.text());

        return res.status(200).json({ success: true, data: brandGuideline });

    } catch (error) {
        console.error("Analyze Brand Error:", error);
        return res.status(500).json({
            error: "Failed to analyze brand",
            details: error.message,
        });
    }
}
