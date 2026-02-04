
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

/**
 * Stage 1: Search Extraction
 * Queries Google and returns top 5 organic links.
 */
async function getTop5GoogleLinks(keyword, language = 'vi') {
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(keyword)}&hl=${language}`;

    const response = await fetch(searchUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': language === 'vi' ? 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7' : 'en-US,en;q=0.9',
        },
        agent: httpsAgent,
        timeout: 10000
    });

    if (!response.ok) throw new Error(`Google Search failed with status ${response.status}`);

    const html = await response.text();
    const { document } = parseHTML(html);

    const links = [];
    // Standard Google result selector (usually inside 'g' class or h3 parent)
    const results = document.querySelectorAll('div.g');

    for (const result of results) {
        if (links.length >= 5) break;

        const a = result.querySelector('a');
        const h3 = result.querySelector('h3');
        const url = a?.getAttribute('href');
        const title = h3?.textContent;

        if (url && url.startsWith('http') && !url.includes('google.com') && title) {
            links.push({ title, url });
        }
    }

    // Fallback if div.g selector fails (Google changes it often)
    if (links.length === 0) {
        const allLinks = document.querySelectorAll('a');
        for (const a of allLinks) {
            if (links.length >= 5) break;
            const href = a.getAttribute('href');
            const h3 = a.querySelector('h3');
            if (href && href.startsWith('http') && !href.includes('google.com') && h3) {
                links.push({ title: h3.textContent, url: href });
            }
        }
    }

    return links;
}

/**
 * Stage 2: Content Scraping
 * Scrapes a single URL and returns Markdown.
 */
async function scrapeUrl(url) {
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
            agent: url.startsWith('https') ? httpsAgent : null,
            timeout: 15000
        });

        if (!response.ok) return null;

        const html = await response.text();
        const { document } = parseHTML(html);

        const reader = new Readability(document);
        const article = reader.parse();

        if (!article || !article.content) return null;

        const turndownService = new TurndownService({
            headingStyle: 'atx',
            hr: '---',
            bulletListMarker: '-',
            codeBlockStyle: 'fenced'
        });

        const markdown = turndownService.turndown(article.content);
        return {
            title: article.title,
            content: markdown,
            url: url
        };
    } catch (error) {
        console.warn(`Failed to scrape ${url}:`, error.message);
        return null;
    }
}

export default async function handler(req, res) {
    // Config CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // Auth Verification
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.split('Bearer ')[1];
    let uid;
    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        uid = decodedToken.uid;
    } catch (error) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const { keyword, language = 'vi' } = req.body;
        if (!keyword) return res.status(400).json({ error: 'Keyword is required' });

        console.log(`[Research] Starting search for: "${keyword}" (${language})`);

        // 1. Get Top 5 Links
        let links = [];
        try {
            links = await getTop5GoogleLinks(keyword, language);
        } catch (e) {
            console.error("Search failed:", e);
            return res.status(500).json({ error: "Failed to fetch search results" });
        }

        if (links.length === 0) {
            return res.status(404).json({ error: "No relevant search results found" });
        }

        console.log(`[Research] Found ${links.length} links. Starting parallel scrape...`);

        // 2. Parallel Scrape
        const scrapeResults = await Promise.all(links.map(link => scrapeUrl(link.url)));
        const successfulScrapes = scrapeResults.filter(r => r !== null);

        if (successfulScrapes.length === 0) {
            return res.status(404).json({ error: "Unable to extract content from any search results" });
        }

        console.log(`[Research] Successfully scraped ${successfulScrapes.length} sites. Analyzing with Gemini...`);

        // 3. Gemini Synthesis
        const { GoogleGenerativeAI } = await import("@google/generative-ai");
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({
            model: 'gemini-2.0-flash',
            generationConfig: { temperature: 0.2, maxOutputTokens: 8000 }
        });

        const combinedMarkdown = successfulScrapes.map((s, i) => `--- SOURCE ${i + 1}: ${s.title} (${s.url}) ---\n${s.content}`).join('\n\n');

        const prompt = `
Role: Senior Content Researcher & SEO Strategist.
Task: Analyze the top 5 search results for the keyword: "${keyword}".

Context: The user wants to write high-quality content based on this research.

Instructions:
1. Identify the core themes and topics covered across all sources.
2. Extract unique insights, specific data points, or "golden nuggets" of information from each.
3. Reverse-engineer the content structure of these top competitors (what sections they have).
4. Identify "Content Gaps" - what are these websites missing that we can include to be better?
5. List key statistics or authoritative facts mentioned.

Format the response in professional Markdown with clear headings and bullet points.
Language: ${language === 'vi' ? 'Tiếng Việt' : 'English'}.

Raw Scraped Data:
"""
${combinedMarkdown.substring(0, 30000)}
"""
`;

        const result = await model.generateContent(prompt);
        const analysis = result.response.text();
        const usage = result.response.usageMetadata || { totalTokenCount: 0 };

        // 4. Log Usage
        if (usage.totalTokenCount > 0) {
            try {
                await db.collection('users').doc(uid).update({
                    'usageStats.totalTokens': admin.firestore.FieldValue.increment(usage.totalTokenCount),
                    'usageStats.requestCount': admin.firestore.FieldValue.increment(1),
                    'usageStats.lastActiveAt': admin.firestore.FieldValue.serverTimestamp()
                });
            } catch (e) {
                console.warn("Usage logging failed", e.message);
            }
        }

        return res.status(200).json({
            success: true,
            keyword,
            analysis,
            sources: successfulScrapes.map(s => ({ title: s.title, url: s.url })),
            usage
        });

    } catch (error) {
        console.error("[Research] Error:", error);
        return res.status(500).json({ error: error.message });
    }
}
