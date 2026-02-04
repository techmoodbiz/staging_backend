
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
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPad; CPU OS 17_1_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/120.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:109.0) Gecko/20100101 Firefox/120.0'
];

/**
 * Advanced Stealth Fetch with randomized headers and behavior
 */
async function stealthFetch(url, language = 'vi') {
    const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    const isMobile = ua.includes('Mobile');

    // Random delay to avoid patterns (200ms - 800ms)
    await sleep(200 + Math.random() * 600);

    const headers = {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': language === 'vi' ? 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7' : 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        // Common cookies to bypass consent pages
        'Cookie': 'SOCS=CAISHAgBEhJnd3NfMjAyMzA4MzAtMF9SQzIaAnZpIAEaBgiA_LaoBg; CONSENT=YES+cb.20230531-04-p0.en+FX+908',
    };

    if (!isMobile) {
        headers['sec-ch-ua'] = '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"';
        headers['sec-ch-ua-mobile'] = '?0';
        headers['sec-ch-ua-platform'] = '"Windows"';
    }

    return fetch(url, { headers, agent: httpsAgent, timeout: 15000 });
}

/**
 * Stage 1: Search Extraction
 * Tries Google with Stealth Mode, fallbacks to Bing or DuckDuckGo if blocked.
 */
async function getTop5Links(keyword, language = 'vi') {
    const engines = [
        {
            name: 'Google',
            url: `https://www.google.com/search?q=${encodeURIComponent(keyword)}&hl=${language}&gbv=1`,
            selector: '/url?q=',
            titleSelector: 'h3'
        },
        {
            name: 'Bing',
            url: `https://www.bing.com/search?q=${encodeURIComponent(keyword)}&setlang=${language === 'vi' ? 'vi' : 'en'}`,
            selector: 'li.b_algo h2 a',
            directUrl: true
        },
        {
            name: 'DuckDuckGo',
            url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(keyword)}&kl=${language === 'vi' ? 'vn-vi' : 'us-en'}`,
            selector: 'a.result__a',
            directUrl: true
        }
    ];

    for (const engine of engines) {
        try {
            console.log(`[Research] Trying ${engine.name}: ${engine.url}`);
            const response = await stealthFetch(engine.url, language);

            if (!response.ok) {
                console.warn(`[Research] ${engine.name} failed with ${response.status}`);
                continue;
            }

            const html = await response.text();

            // Basic CAPTCHA/Block check
            if (html.includes('google.com/sorry/index') || html.includes('captcha') || html.includes('Sign in') || html.includes('Đăng nhập')) {
                console.warn(`[Research] ${engine.name} detected bot blocking.`);
                continue;
            }

            const { document } = parseHTML(html);
            const links = [];
            const items = document.querySelectorAll(engine.selector.includes('/') ? 'a' : engine.selector);

            console.log(`[Research] Found ${items.length} items on ${engine.name}`);

            for (const item of items) {
                if (links.length >= 5) break;

                let url = item.getAttribute('href');
                let title = '';

                if (engine.name === 'Google') {
                    if (!url || !url.startsWith('/url?q=')) continue;
                    const h3 = item.querySelector('h3');
                    title = (h3 ? h3.textContent : item.textContent)?.trim();

                    try {
                        const urlParams = new URLSearchParams(url.split('?')[1]);
                        url = urlParams.get('q');
                    } catch (e) { continue; }
                } else {
                    title = item.textContent?.trim();
                }

                if (url && title && title.length > 5 && url.startsWith('http') && !url.includes(engine.name.toLowerCase())) {
                    if (!links.some(l => l.url === url)) {
                        links.push({ title: title.split(' › ')[0].trim(), url });
                    }
                }
            }

            if (links.length > 0) {
                console.log(`[Research] Successfully extracted ${links.length} links using ${engine.name}`);
                return links;
            }
        } catch (error) {
            console.error(`[Research] Error with ${engine.name}:`, error.message);
        }
    }

    throw new Error("Tất cả các công cụ tìm kiếm đều bị chặn. Vui lòng thử lại sau 5-10 phút.");
}

/**
 * Stage 2: Content Scraping
 */
async function scrapeUrl(url) {
    try {
        // Reuse stealthFetch for consistency
        const response = await stealthFetch(url);
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
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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

        let links = await getTop5Links(keyword, language);
        console.log(`[Research] Final links list:`, links.map(l => l.url));

        const scrapeResults = await Promise.all(links.map(link => scrapeUrl(link.url)));
        const successfulScrapes = scrapeResults.filter(r => r !== null);

        if (successfulScrapes.length === 0) {
            return res.status(404).json({ error: "Không thể trích xuất nội dung từ các trang web tìm được." });
        }

        const { GoogleGenerativeAI } = await import("@google/generative-ai");
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({
            model: 'gemini-2.0-flash',
            generationConfig: { temperature: 0.2, maxOutputTokens: 8000 }
        });

        const combinedMarkdown = successfulScrapes.map((s, i) => `--- SOURCE ${i + 1}: ${s.title} (${s.url}) ---\n${s.content}`).join('\n\n');

        const prompt = `
Role: Senior Content Researcher & SEO Strategist.
Task: Analyze the top search results for the keyword: "${keyword}".
Context: The user wants to write high-quality content based on this research.

Instructions:
1. Identify the core themes and topics covered across all sources.
2. Extract unique insights, specific data points, or factual "golden nuggets".
3. Reverse-engineer the content structure of these top competitors.
4. Identify "Content Gaps" - what are these websites missing that we can include?
5. List key statistics or authoritative facts mentioned.

Format in professional Markdown.
Language: ${language === 'vi' ? 'Tiếng Việt' : 'English'}.

Data:
"""
${combinedMarkdown.substring(0, 30000)}
"""
`;

        const result = await model.generateContent(prompt);
        const analysis = result.response.text();
        const usage = result.response.usageMetadata || { totalTokenCount: 0 };

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
