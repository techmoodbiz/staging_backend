
import fetch from 'node-fetch';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import https from 'https';
import "./firebaseForceDeps.js";
import admin from 'firebase-admin';
import crypto from 'node:crypto';

let db = null;

function initAdmin() {
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
    if (!db) db = admin.firestore();
    return { db };
}

// Agent to bypass SSL certificate issues
const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
});

// Helper for random delay
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
];

/**
 * Tiered Content Scraping (Sequential with Delay)
 */
async function scrapeUrlTiered(url) {
    // --- TIER 1: Jina Reader ---
    try {
        const jinaReaderUrl = `https://r.jina.ai/${url}`;
        const headers = { 'X-Return-Format': 'markdown', 'Accept': 'application/json' };
        if (process.env.JINA_API_KEY) headers['Authorization'] = `Bearer ${process.env.JINA_API_KEY}`;

        const response = await fetch(jinaReaderUrl, { headers, timeout: 15000 });
        if (response.ok) {
            const data = await response.json();
            const markdown = data.data?.content || "";
            const tokens = data.data?.usage?.tokens || 0;
            if (markdown && markdown.length > 200) {
                return { content: markdown, url, tokens, provider: 'jina_reader' };
            }
        }
    } catch (e) {
        console.warn(`[Research] Jina Reader failed for ${url}:`, e.message);
    }

    // --- TIER 2: Direct Fetch + Readability ---
    try {
        const response = await fetch(url, {
            headers: { 'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)] },
            agent: httpsAgent,
            timeout: 15000
        });

        if (response.ok) {
            const html = await response.text();
            const { document } = parseHTML(html);
            const reader = new Readability(document);
            const article = reader.parse();

            if (article && article.content) {
                const turndownService = new TurndownService({ headingStyle: 'atx' });
                const markdown = turndownService.turndown(article.content);
                return { title: article.title, content: markdown, url };
            }
        }
    } catch (e) {
        console.warn(`[Research] Direct fetch failed for ${url}:`, e.message);
    }

    return null;
}

export default async function handler(req, res) {
    // 1. IMMEDIATE CORS & OPTIONS RESPONSE
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        // 2. LAZY INIT
        const { db } = await initAdmin();

        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
        const token = authHeader.split('Bearer ')[1];
        let uid;
        try {
            const decodedToken = await admin.auth().verifyIdToken(token);
            uid = decodedToken.uid;
        } catch (error) { return res.status(401).json({ error: 'Unauthorized' }); }
        const { keyword, urls, language = 'vi' } = req.body;

        // URLs are now mandatory
        if (!urls || !Array.isArray(urls) || urls.length === 0) {
            return res.status(400).json({ error: 'Vui lòng cung cấp ít nhất 1 URL để phân tích.' });
        }

        const rawCacheKey = `${keyword || ''}_${language}_${urls.join('_')}`.toLowerCase();
        const cacheKey = crypto.createHash('sha256').update(rawCacheKey).digest('hex');

        // --- STAGE 0: CACHING ---
        const cacheDoc = await db.collection('research_cache').doc(cacheKey).get();
        if (cacheDoc.exists) {
            const data = cacheDoc.data();
            const ageHours = (Date.now() - data.timestamp) / (1000 * 60 * 60);
            if (ageHours < 24) {
                console.log(`[Research] Cache HIT for: ${keyword || urls[0]}`);
                return res.status(200).json({ ...data, cached: true });
            }
        }

        let totalJinaReaderTokens = 0;
        let totalGeminiAnalysisTokens = 0;

        // --- STAGE 1: USE PROVIDED URLs DIRECTLY ---
        const links = urls.slice(0, 5).map(u => ({ title: 'User Provided Source', url: u }));
        console.log(`[Research] Using ${links.length} user-provided URLs.`);

        // --- STAGE 2: SEQUENTIAL SCRAPE ---
        const successfulScrapes = [];
        for (const link of links) {
            console.log(`[Research] Staggered scrape for: ${link.url}`);
            const result = await scrapeUrlTiered(link.url);
            if (result) {
                successfulScrapes.push({ ...result, title: link.title });
                if (result.provider === 'jina_reader') totalJinaReaderTokens += result.tokens;
            }
            await sleep(1500); // 1.5s delay to avoid rate limits
        }

        if (successfulScrapes.length === 0) {
            return res.status(404).json({ error: "Không thể trích xuất nội dung từ các URL đã cung cấp. Vui lòng kiểm tra lại các đường dẫn." });
        }

        // --- STAGE 3: GEMINI ANALYSIS ---
        const { GoogleGenerativeAI } = await import("@google/generative-ai");
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

        const combinedContext = successfulScrapes.map((s, i) => `--- SOURCE ${i + 1}: ${s.title} (${s.url}) ---\n${s.content}`).join('\n\n');

        const topicContext = keyword ? `Topic / Chủ đề phân tích: "${keyword}"` : `Phân tích nội dung từ ${successfulScrapes.length} nguồn được cung cấp.`;

        const prompt = `
Role: Senior Strategy & Research consultant.
Task: Provide a "Premium Research Brief" based on the content scraped from the provided URLs.
${topicContext}
Language: ${language === 'vi' ? 'Tiếng Việt' : 'English'}.

REQUIRED STRUCTURE (Use these exact Markdown patterns):

# 🎯 Executive Summary
[A concise high-level overview of the topic based on the provided sources]

## 💎 Core Themes & Key Topics
- **[Topic Name]**: [Description with data points]
- **[Topic Name]**: [Description with data points]

## 📊 Content Structure Analysis
[Explain how the provided sources are organized. What are their winning headers/styles/approaches?]

## 🚩 Content Gaps (Strategic Opportunity)
> [!IMPORTANT]
> This is your competitive edge. Identify what the provided sources MISSED or could explain better.

## 📈 Key Statistics & Insights
- [List 3-5 specific numbers, percentages, or high-impact facts found]

## 💡 Content Generation Tips
[How should the user approach writing about this topic to stand out?]

Formatting Rules:
1. Use **bold** for emphasis on key terms.
2. Use > [!NOTE] or > [!IMPORTANT] blocks for high-value insights.
3. Keep the tone professional, analytical, and "expensive".

Data for Analysis:
"""
${combinedContext.substring(0, 30000)}
"""
`;

        const result = await model.generateContent(prompt);
        const analysis = result.response.text();
        if (result.response.usageMetadata) totalGeminiAnalysisTokens = result.response.usageMetadata.totalTokenCount || 0;

        const finalResult = {
            success: true,
            keyword: keyword || '',
            analysis,
            sources: successfulScrapes.map(s => ({ title: s.title, url: s.url })),
            timestamp: Date.now(),
            usage: {
                jinaReader: totalJinaReaderTokens,
                geminiAnalysis: totalGeminiAnalysisTokens
            }
        };

        // --- STAGE 4: LOG USAGE (ASYNC) ---
        if (uid) {
            try {
                const { logTokenUsage } = await import('../tokenLogger.js');
                const logPromises = [];
                if (totalJinaReaderTokens > 0) logPromises.push(logTokenUsage(uid, 'RESEARCH_JINA_READER', totalJinaReaderTokens, { keyword }));
                if (totalGeminiAnalysisTokens > 0) logPromises.push(logTokenUsage(uid, 'RESEARCH_ANALYSIS_GEMINI', totalGeminiAnalysisTokens, { keyword }));
                await Promise.all(logPromises);
            } catch (e) {
                console.error("Failed to log research usage:", e);
            }
        }

        // --- STAGE 5: CACHE ---
        await db.collection('research_cache').doc(cacheKey).set(finalResult);

        return res.status(200).json(finalResult);

    } catch (error) {
        console.error("[Research] Error:", error);
        return res.status(500).json({ error: error.message });
    }
}
