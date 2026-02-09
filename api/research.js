
import fetch from 'node-fetch';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import https from 'https';
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

const db = admin.firestore();

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
 * Official Search Extraction (Google Custom Search API)
 */
async function getTop5Links(keyword, language = 'vi') {
    console.log(`[Research] Starting Official API search for: "${keyword}"`);

    const API_KEY = process.env.GOOGLE_SEARCH_API_KEY;
    const CX = process.env.GOOGLE_SEARCH_CX;

    // --- TIER 0: Google Custom Search API ---
    if (API_KEY && CX) {
        try {
            console.log(`[Research] Tier 0: Using Google Custom Search API...`);
            // gl=vn for more relevant local results in Vietnam
            const geoParam = language === 'vi' ? '&gl=vn' : '&gl=us';
            const googleUrl = `https://www.googleapis.com/customsearch/v1?key=${API_KEY}&cx=${CX}&q=${encodeURIComponent(keyword)}&hl=${language}${geoParam}&num=5`;

            const response = await fetch(googleUrl, { timeout: 10000 });
            const data = await response.json();

            if (response.ok && data.items && data.items.length > 0) {
                const links = data.items.map(item => ({
                    title: item.title,
                    url: item.link
                }));
                console.log(`[Research] Google API found ${links.length} links.`);
                return { links, tokens: 0, provider: 'google' };
            } else if (data.error) {
                console.warn(`[Research] Google API returned error: ${data.error.message}`);
            }
        } catch (e) {
            console.warn(`[Research] Google Custom Search API failed:`, e.message);
        }
    } else {
        console.warn(`[Research] Google Custom Search API credentials missing (GOOGLE_SEARCH_API_KEY or GOOGLE_SEARCH_CX).`);
    }

    // --- TIER 1: Jina AI Search Fallback ---
    try {
        console.log(`[Research] Tier 1: Falling back to Jina AI Search...`);
        const jinaUrl = `https://s.jina.ai/${encodeURIComponent(keyword)}`;
        const jinaKey = process.env.JINA_API_KEY;
        const headers = { 'Accept': 'application/json', 'X-With-Links-Summary': 'true', 'X-No-Cache': 'true' };
        if (jinaKey) headers['Authorization'] = `Bearer ${jinaKey.trim()}`;

        const response = await fetch(jinaUrl, { headers, timeout: 30000 });
        if (response.ok) {
            const data = await response.json();
            if (data && data.data && data.data.length > 0) {
                const links = data.data.slice(0, 5).map(item => ({ title: item.title, url: item.url }));
                // Jina Search returns tokens in usage object
                const tokens = data.usage?.tokens || 10000;
                console.log(`[Research] Jina AI found ${links.length} links. Tokens: ${tokens}`);
                return { links, tokens, provider: 'jina_search' };
            }
        }
    } catch (e) {
        console.warn(`[Research] Jina AI Search failed:`, e.message);
    }

    // --- TIER 2: DuckDuckGo Lite Fallback ---
    try {
        console.log(`[Research] Tier 2: Falling back to DuckDuckGo Lite...`);
        const ddgUrl = `https://duckduckgo.com/lite/?q=${encodeURIComponent(keyword)}&kl=${language === 'vi' ? 'vn-vi' : 'us-en'}`;
        const response = await fetch(ddgUrl, {
            headers: {
                'User-Agent': USER_AGENTS[0],
                'Accept': 'text/html'
            },
            timeout: 15000
        });

        console.log(`[Research] DDG Lite Status: ${response.status}`);

        if (response.ok) {
            const html = await response.text();
            const { document } = parseHTML(html);

            // Try different selectors for DDG Lite
            let anchors = Array.from(document.querySelectorAll('a.result-link'));
            if (anchors.length === 0) {
                // Lite version often has links in tables
                anchors = Array.from(document.querySelectorAll('td a[rel="nofollow"]'));
            }
            if (anchors.length === 0) {
                anchors = Array.from(document.querySelectorAll('a')).filter(a => {
                    const href = a.getAttribute('href');
                    return href && href.startsWith('http') && !href.includes('duckduckgo.com');
                });
            }

            console.log(`[Research] DDG Lite found ${anchors.length} potential links`);

            const links = [];
            for (const a of anchors) {
                if (links.length >= 5) break;
                let url = a.getAttribute('href');
                let title = a.textContent?.trim();

                if (url && url.startsWith('http')) {
                    // Filter out non-content titles if possible
                    if (title && title.length > 5) {
                        links.push({ title, url });
                    }
                }
            }
            if (links.length > 0) return { links, tokens: 0, provider: 'ddg' };
        }
    } catch (e) {
        console.warn(`[Research] DuckDuckGo fallback failed:`, e.message);
    }

    throw new Error("Không tìm thấy kết quả tìm kiếm nào phù hợp qua API hoặc các nguồn dự phòng.");
}

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
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const token = authHeader.split('Bearer ')[1];
    let uid;
    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        uid = decodedToken.uid;
    } catch (error) { return res.status(401).json({ error: 'Unauthorized' }); }

    try {
        const { keyword, urls, language = 'vi' } = req.body;
        if (!keyword) return res.status(400).json({ error: 'Keyword is required' });

        const cacheKey = `${keyword}_${language}_${(urls || []).join('_')}`.toLowerCase();

        // --- STAGE 0: CACHING ---
        const cacheDoc = await db.collection('research_cache').doc(cacheKey).get();
        if (cacheDoc.exists) {
            const data = cacheDoc.data();
            const ageHours = (Date.now() - data.timestamp) / (1000 * 60 * 60);
            if (ageHours < 24) {
                console.log(`[Research] Cache HIT for: ${keyword}`);
                return res.status(200).json({ ...data, cached: true });
            }
        }

        let totalJinaSearchTokens = 0;
        let totalJinaReaderTokens = 0;
        let totalGeminiAnalysisTokens = 0;

        let links = [];
        let provider = 'manual';

        // --- STAGE 1: SEARCH OR MANUAL URLS ---
        if (urls && Array.isArray(urls) && urls.length > 0) {
            console.log(`[Research] Using ${urls.length} manual URLs for: "${keyword}"`);
            links = urls.slice(0, 5).map(u => ({ title: 'User Provided Source', url: u }));
        } else {
            console.log(`[Research] Starting Official API search for: "${keyword}"`);
            const searchResult = await getTop5Links(keyword, language);
            links = searchResult.links;
            provider = searchResult.provider;
            if (provider === 'jina_search') totalJinaSearchTokens += searchResult.tokens;
        }

        // --- STAGE 2: SEQUENTIAL SCRAPE ---
        const successfulScrapes = [];
        for (const link of links) {
            console.log(`[Research] Staggered scrape for: ${link.url}`);
            const result = await scrapeUrlTiered(link.url);
            if (result) {
                successfulScrapes.push({ ...result, title: link.title });
                if (result.provider === 'jina_reader') totalJinaReaderTokens += result.tokens;
            }
            await sleep(1500); // 1.5s delay
        }

        if (successfulScrapes.length === 0) {
            return res.status(404).json({ error: "Không thể trích xuất nội dung từ các nguồn tìm được." });
        }

        // --- STAGE 3: GEMINI ANALYSIS ---
        const { GoogleGenerativeAI } = await import("@google/generative-ai");
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

        const combinedContext = successfulScrapes.map((s, i) => `--- SOURCE ${i + 1}: ${s.title} (${s.url}) ---\n${s.content}`).join('\n\n');

        const prompt = `
Role: Senior Strategy & Research consultant.
Task: Provide a "Premium Research Brief" for: "${keyword}".
Language: ${language === 'vi' ? 'Tiếng Việt' : 'English'}.

REQUIRED STRUCTURE (Use these exact Markdown patterns):

# 🎯 Executive Summary
[A concise high-level overview of the topic]

## 💎 Core Themes & Key Topics
- **[Topic Name]**: [Description with data points]
- **[Topic Name]**: [Description with data points]

## 📊 Competitor Content Structure
[Explain how top results are organized. What are their winning headers/styles?]

## 🚩 Content Gaps (Strategic Opportunity)
> [!IMPORTANT]
> This is your competitive edge. Identify what the top 5 sources MISSED or could explain better.

## 📈 Key Statistics & Insights
- [List 3-5 specific numbers, percentages, or high-impact facts found]

## 💡 Content Generation Tips
[How should the user approach writing about this topic to rank higher?]

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
            keyword,
            analysis,
            sources: successfulScrapes.map(s => ({ title: s.title, url: s.url })),
            timestamp: Date.now(),
            usage: {
                jinaSearch: totalJinaSearchTokens,
                jinaReader: totalJinaReaderTokens,
                geminiAnalysis: totalGeminiAnalysisTokens
            }
        };

        // --- STAGE 4: LOG USAGE (ASYNC) ---
        if (uid) {
            try {
                const { logTokenUsage } = await import('../tokenLogger.js');
                const logPromises = [];
                if (totalJinaSearchTokens > 0) logPromises.push(logTokenUsage(uid, 'RESEARCH_JINA_SEARCH', totalJinaSearchTokens, { keyword }));
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
