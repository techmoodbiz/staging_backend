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

// Agent để bypass lỗi SSL certificate (nếu có)
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

export default async function handler(req, res) {
  // Config CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // --- AUTH VERIFICATION ---
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
  }
  const token = authHeader.split('Bearer ')[1];
  let uid;
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    uid = decodedToken.uid;
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized: Token verification failed' });
  }
  // -------------------------

  try {
    const { url, cleaningLevel = 'aggressive' } = req.body;

    if (!url) return res.status(400).json({ error: 'URL is required' });

    // 1. Fetch HTML với User-Agent giả lập Chrome để tránh bị chặn
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      },
      agent: url.startsWith('https') ? httpsAgent : null,
      timeout: 25000 // Tăng timeout lên 25s
    });

    if (!response.ok) {
      throw new Error(`Website returned status ${response.status}`);
    }

    const html = await response.text();

    // 2. Use linkedom for robust content extraction and auditing
    const { document } = parseHTML(html);
    const doc = document;

    // --- HTML STRUCTURE AUDIT ENGINE ---
    const audit = {
      score: 100,
      categories: {
        url: { score: 100, issues: [] },
        metadata: { score: 100, issues: [] },
        semantic: { score: 100, issues: [] },
        headings: { score: 100, issues: [] },
        links: { score: 100, issues: [] },
        images: { score: 100, issues: [] },
        schema: { score: 100, issues: [] }
      },
      recommendations: []
    };

    // A. URL Audit
    const urlObj = new URL(url);
    if (urlObj.protocol !== 'https:') {
      audit.categories.url.issues.push("URL should use HTTPS for security.");
      audit.categories.url.score -= 40;
    }
    if (url.toLowerCase() !== url) {
      audit.categories.url.issues.push("URL contains uppercase letters; lowercase is preferred for SEO.");
      audit.categories.url.score -= 20;
    }
    if (urlObj.pathname.includes('_')) {
      audit.categories.url.issues.push("URL uses underscores; hyphens are preferred separators.");
      audit.categories.url.score -= 20;
    }
    const depth = urlObj.pathname.split('/').filter(Boolean).length;
    if (depth > 4) {
      audit.categories.url.issues.push(`URL depth is high (${depth}). Shallow structures are better for crawling.`);
      audit.categories.url.score -= 10;
    }

    // B. Metadata Audit
    const metaTitle = doc.querySelector('title')?.textContent || "";
    const metaDesc = doc.querySelector('meta[name="description"]')?.getAttribute('content') || doc.querySelector('meta[property="og:description"]')?.getAttribute('content');
    const metaLang = doc.documentElement.getAttribute('lang');
    const metaViewport = doc.querySelector('meta[name="viewport"]');
    const metaCharset = doc.querySelector('meta[charset]') || doc.querySelector('meta[content*="charset"]');

    if (!metaTitle) {
      audit.categories.metadata.issues.push("Missing <title> tag.");
      audit.categories.metadata.score -= 50;
    } else if (metaTitle.length < 30 || metaTitle.length > 70) {
      audit.categories.metadata.issues.push(`Title length (${metaTitle.length}) is not optimal (recommended: 30-70 chars).`);
      audit.categories.metadata.score -= 10;
    }

    if (!metaDesc) {
      audit.categories.metadata.issues.push("Missing meta description.");
      audit.categories.metadata.score -= 40;
    } else if (metaDesc.length < 120 || metaDesc.length > 160) {
      audit.categories.metadata.issues.push(`Meta description length (${metaDesc.length}) is not optimal (recommended: 120-160 chars).`);
      audit.categories.metadata.score -= 10;
    }

    if (!metaLang) {
      audit.categories.metadata.issues.push("Missing 'lang' attribute on <html> tag.");
      audit.categories.metadata.score -= 20;
    }
    if (!metaViewport) {
      audit.categories.metadata.issues.push("Missing viewport meta tag for responsive design.");
      audit.categories.metadata.score -= 30;
    }
    if (!metaCharset) {
      audit.categories.metadata.issues.push("Missing character encoding (charset) meta tag.");
      audit.categories.metadata.score -= 20;
    }

    // C. Semantic Audit
    const semanticTags = ['header', 'nav', 'main', 'footer', 'article', 'aside'];
    semanticTags.forEach(tag => {
      if (doc.querySelector(tag)) {
        // Found
      } else if (['main', 'header', 'footer'].includes(tag)) {
        audit.categories.semantic.issues.push(`Semantic tag <${tag}> is missing.`);
        audit.categories.semantic.score -= 20;
      }
    });

    // D. Heading Hierarchy Audit
    const headers = Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    const h1s = doc.querySelectorAll('h1');
    if (h1s.length === 0) {
      audit.categories.headings.issues.push("Missing H1 tag.");
      audit.categories.headings.score -= 50;
    } else if (h1s.length > 1) {
      audit.categories.headings.issues.push(`Multiple H1 tags found (${h1s.length}). Only one H1 is recommended per page.`);
      audit.categories.headings.score -= 30;
    }

    let prevLevel = 0;
    headers.forEach(h => {
      const level = parseInt(h.tagName[1]);
      if (level > prevLevel + 1 && prevLevel !== 0) {
        audit.categories.headings.issues.push(`Heading level skipped: ${h.tagName} follows H${prevLevel}.`);
        audit.categories.headings.score -= 20;
      }
      prevLevel = level;
    });

    // E. Link Audit
    const links = Array.from(doc.querySelectorAll('a'));
    const internalLinks = links.filter(a => a.href.startsWith(urlObj.origin) || a.href.startsWith('/'));
    const externalLinks = links.filter(a => !internalLinks.includes(a));
    const emptyAnchors = links.filter(a => !a.textContent.trim() && !a.querySelector('img'));

    if (emptyAnchors.length > 0) {
      audit.categories.links.issues.push(`${emptyAnchors.length} links have empty anchor text.`);
      audit.categories.links.score -= Math.min(30, emptyAnchors.length * 5);
    }
    if (links.length > 300) {
      audit.categories.links.issues.push("Too many links on page (>300). May dilute link equity.");
      audit.categories.links.score -= 10;
    }

    // F. Image Audit
    const images = Array.from(doc.querySelectorAll('img'));
    const missingAlt = images.filter(img => !img.hasAttribute('alt') || !img.alt.trim());
    const notLazy = images.filter(img => img.offsetTop > 1000 && !img.hasAttribute('loading'));

    if (missingAlt.length > 0) {
      audit.categories.images.issues.push(`${missingAlt.length} images are missing alt text.`);
      audit.categories.images.score -= Math.min(50, missingAlt.length * 10);
    }
    if (notLazy.length > 5) {
      audit.categories.images.issues.push("Several below-the-fold images are missing 'loading=\"lazy\"'.");
      audit.categories.images.score -= 10;
    }

    // G. Schema Audit
    const jsonLd = doc.querySelectorAll('script[type="application/ld+json"]');
    if (jsonLd.length === 0) {
      audit.categories.schema.issues.push("No JSON-LD structured data detected.");
      audit.categories.schema.score -= 40;
    }

    // Calculate Final Score (Weighted)
    const weights = {
      url: 0.1,
      metadata: 0.2,
      semantic: 0.15,
      headings: 0.15,
      links: 0.1,
      images: 0.1,
      schema: 0.2
    };

    audit.score = Math.round(
      Object.keys(weights).reduce((acc, cat) => acc + (Math.max(0, audit.categories[cat].score) * weights[cat]), 0)
    );

    // Collect Recommendations
    Object.values(audit.categories).forEach(cat => {
      audit.recommendations.push(...cat.issues);
    });

    // Extract Basic Metadata for Response
    const metadata = {
      title: doc.querySelector('title')?.textContent || '',
      description: doc.querySelector('meta[name="description"]')?.getAttribute('content') || doc.querySelector('meta[property="og:description"]')?.getAttribute('content') || '',
      keywords: doc.querySelector('meta[name="keywords"]')?.getAttribute('content') || '',
      author: doc.querySelector('meta[name="author"]')?.getAttribute('content') || '',
      ogImage: doc.querySelector('meta[property="og:image"]')?.getAttribute('content') || '',
      favicon: doc.querySelector('link[rel="icon"]')?.getAttribute('href') || doc.querySelector('link[rel="shortcut icon"]')?.getAttribute('href') || '',
      lang: metaLang,
      stats: {
        links: links.length,
        internalLinks: internalLinks.length,
        externalLinks: externalLinks.length,
        images: images.length,
        schemaCount: jsonLd.length
      }
    };
    // ------------------------------------

    const reader = new Readability(doc);
    const article = reader.parse();

    if (!article || (!article.textContent && !article.content)) {
      throw new Error("Unable to parse content from the provided URL. The page might be protected or use complex JavaScript rendering.");
    }

    // 3. Convert cleaned HTML to Markdown to preserve headers and structure
    const turndownService = new TurndownService({
      headingStyle: 'atx',
      hr: '---',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced'
    });

    // Remove unwanted elements from the article content if any remain
    // Note: Readability already does a great job here.

    let markdown = turndownService.turndown(article.content);

    // Add Metadata header to markdown if not present in content
    let finalContent = `# ${article.title || metadata.title}\n\n${markdown}`;

    // 4. Gemini Cleaning & Structuring (CHỈ CHO MODE 'aggressive')
    let usageData = { totalTokenCount: 0 };
    if (cleaningLevel === 'aggressive' && process.env.GEMINI_API_KEY) {
      try {
        const { GoogleGenerativeAI } = await import("@google/generative-ai");
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

        const prompt = `
Role: Web Content Auditor & Extractor.
Task: Perfect the Markdown structure of the scraped article for a high-quality audit.

Context Info:
- Original Title: ${metadata.title}
- Description: ${metadata.description}

Instructions:
1. Ensure the Markdown is clean and logically structured.
2. PRESERVE all headers (H1, H2, H3), lists, and important links.
3. Remove any remaining "noise" (e.g., social sharing text, navigation fragments, ads).
4. Do NOT change the meaning or rewrite the facts; only optimize formatting and clarity.
5. If there are tables or lists, ensure they are formatted correctly in Markdown.

Raw Scraped Content (Markdown):
"""
${finalContent.substring(0, 35000)}
"""
`;

        const model = genAI.getGenerativeModel({
          model: 'gemini-2.0-flash',
          generationConfig: {
            temperature: 0.1, // Very low temperature for high fidelity
            maxOutputTokens: 8000
          }
        });

        const result = await model.generateContent(prompt);
        const responseText = result.response.text();

        if (responseText && responseText.length > 50) {
          finalContent = responseText;
          if (result.response.usageMetadata) usageData = result.response.usageMetadata;
          console.log('✅ Gemini structured cleaning successful');
        }
      } catch (e) {
        console.warn("Gemini cleaning failed, using Readability Markdown:", e.message);
      }
    }

    // Log Token Usage
    if (usageData?.totalTokenCount > 0 && uid) {
      try {
        const { logTokenUsage } = await import('../tokenLogger.js');
        await logTokenUsage(uid, 'SCRAPE_WEBSITE', usageData.totalTokenCount, {
          url: url,
          cleaningLevel: cleaningLevel
        });
      } catch (e) {
        console.error("Log usage failed", e);
      }
    }

    return res.status(200).json({
      success: true,
      text: finalContent,
      metadata: metadata,
      audit: audit, // Include the new audit results
      url: url,
      cleaningLevel: cleaningLevel,
      usage: usageData
    });

  } catch (error) {
    console.error("Scrape Error:", error);
    return res.status(500).json({ error: error.message });
  }
}
