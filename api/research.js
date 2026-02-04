
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
 * Tiered Search Extraction
 */
async function getTop5Links(keyword, language = 'vi') {
    console.log(`[Research] Starting tiered search for: "${keyword}"`);

    // --- TIER 1: Jina AI Search ---
    try {
        console.log(`[Research] Tier 1: Trying Jina AI Search...`);
        const jinaUrl = `https://s.jina.ai/${encodeURIComponent(keyword)}`;
        const response = await fetch(jinaUrl, {
            headers: {
                'Accept': 'application/json',
                'X-With-Links-Summary': 'true',
                'X-No-Cache': 'true'
            },
            timeout: 10000
        });

        console.log(`[Research] Jina AI Status: ${response.status}`);

        if (response.ok) {
            const data = await response.json();
            if (data && data.data && data.data.length > 0) {
                const links = data.data.slice(0, 5).map(item => ({
                    title: item.title,
                    url: item.url
                }));
                console.log(`[Research] Jina AI found ${links.length} links.`);
                return links;
            } else {
                console.warn(`[Research] Jina AI returned empty data:`, JSON.stringify(data).substring(0, 200));
            }
        } else {
            const errorText = await response.text();
            console.warn(`[Research] Jina AI Error Response: ${errorText.substring(0, 200)}`);
        }
    } catch (e) {
        console.warn(`[Research] Jina AI Error:`, e.message);
    }

    // --- TIER 2: DuckDuckGo Lite Fallback ---
    try {
        // Using Lite version as it's often more stable for scraping than HTML version
        console.log(`[Research] Tier 2: Falling back to DuckDuckGo Lite...`);
        const ddgUrl = `https://duckduckgo.com/lite/?q=${encodeURIComponent(keyword)}&kl=${language === 'vi' ? 'vn-vi' : 'us-en'}`;
        const response = await fetch(ddgUrl, {
            headers: {
                'User-Agent': USER_AGENTS[0],
                'Accept': 'text/html'
            },
            timeout: 10000
        });

        console.log(`[Research] DDG Lite Status: ${response.status}`);

        if (response.ok) {
            const html = await response.text();
            const { document } = parseHTML(html);

            // In Lite version, results are usually in <a> tags inside <td> or specific classes
            const anchors = Array.from(document.querySelectorAll('a.result-link'));
            console.log(`[Research] DDG Lite found ${anchors.length} potential anchors`);

            const links = [];
            for (const a of anchors) {
                if (links.length >= 5) break;
                let url = a.getAttribute('href');
                if (url && url.startsWith('http')) {
                    links.push({ title: a.textContent.trim(), url });
                }
            }

            if (links.length > 0) return links;

            // Fallback for different DDG selectors
            const allLinks = Array.from(document.querySelectorAll('a'));
            for (const a of allLinks) {
                if (links.length >= 5) break;
                const url = a.getAttribute('href');
                const title = a.textContent?.trim();
                // DDG Lite results often have results indexed by numbers or follow a specific pattern
                if (url && url.startsWith('http') && !url.includes('duckduckgo.com') && title.length > 10) {
                    if (!links.some(l => l.url === url)) {
                        links.push({ title, url });
                    }
                }
            }

            if (links.length > 0) return links;
            console.warn(`[Research] DDG Lite returned no links. Title: "${document.title}"`);
        }
    } catch (e) {
        console.warn(`[Research] DuckDuckGo fallback failed:`, e.message);
    }

    throw new Error("Không tìm thấy kết quả tìm kiếm nào phù hợp.");
}

/**
 * Tiered Content Scraping (Sequential with Delay)
 */
async function scrapeUrlTiered(url) {
    // --- TIER 1: Jina Reader ---
    try {
        console.log(`[Research] Scraping ${url} via Jina Reader...`);
        const jinaReaderUrl = `https://r.jina.ai/${url}`;
        const response = await fetch(jinaReaderUrl, {
            headers: { 'X-Return-Format': 'markdown' },
            timeout: 15000
        });

        if (response.ok) {
            const markdown = await response.text();
            if (markdown && markdown.length > 200) {
                return { content: markdown, url };
            }
        }
    } catch (e) {
        console.warn(`[Research] Jina Reader failed for ${url}:`, e.message);
    }

    // --- TIER 2: Direct Fetch + Readability ---
    try {
        console.log(`[Research] Scraping ${url} via Direct Fetch...`);
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

    // Auth
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const token = authHeader.split('Bearer ')[1];
    let uid;
    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        uid = decodedToken.uid;
    } catch (error) { return res.status(401).json({ error: 'Unauthorized' }); }

    try {
        const { keyword, language = 'vi' } = req.body;
        if (!keyword) return res.status(400).json({ error: 'Keyword is required' });

        const cacheKey = `${keyword}_${language}`.toLowerCase();

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

        // --- STAGE 1: SEARCH ---
        const links = await getTop5Links(keyword, language);

        // --- STAGE 2: SEQUENTIAL SCRAPE ---
        const successfulScrapes = [];
        for (const link of links) {
            const result = await scrapeUrlTiered(link.url);
            if (result) {
                successfulScrapes.push({ ...result, title: link.title });
            }
            // Delay 1.5s between requests to be gentle
            await sleep(1500);
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
Role: Senior Content Researcher.
Task: Analyze research data for: "${keyword}".
Language: ${language === 'vi' ? 'Tiếng Việt' : 'English'}.

Extract:
1. Core themes and key topics.
2. Unique insights and specific data points.
3. Content structure of competitors.
4. Content Gaps (what's missing?).
5. Key statistics.

Format: Professional Markdown.

Data:
"""
${combinedContext.substring(0, 30000)}
"""
`;

        const result = await model.generateContent(prompt);
        const analysis = result.response.text();
        const usage = result.response.usageMetadata || { totalTokenCount: 0 };

        const finalResult = {
            success: true,
            keyword,
            analysis,
            sources: successfulScrapes.map(s => ({ title: s.title, url: s.url })),
            timestamp: Date.now()
        };

        // --- STAGE 4: CACHE & LOG ---
        await db.collection('research_cache').doc(cacheKey).set(finalResult);

        if (usage.totalTokenCount > 0) {
            await db.collection('users').doc(uid).update({
                'usageStats.totalTokens': admin.firestore.FieldValue.increment(usage.totalTokenCount),
                'usageStats.requestCount': admin.firestore.FieldValue.increment(1),
                'usageStats.lastActiveAt': admin.firestore.FieldValue.serverTimestamp()
            });
        }

        return res.status(200).json(finalResult);

    } catch (error) {
        console.error("[Research] Critical Error:", error);
        return res.status(500).json({ error: error.message });
    }
}
