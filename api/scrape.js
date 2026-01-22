
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
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
  try {
    await admin.auth().verifyIdToken(token);
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized: Token verification failed' });
  }
  const decodedToken = await admin.auth().verifyIdToken(token);
  const uid = decodedToken.uid;
  // -------------------------

  try {
    const { url, cleaningLevel = 'aggressive' } = req.body;
    // cleaningLevel: 'aggressive' (default) - Dùng Gemini để clean kỹ cho brand guidelines
    //                'minimal' - Chỉ xóa noise, giữ nguyên nội dung cho audit

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
      timeout: 20000 // Tăng timeout lên 20s
    });

    if (!response.ok) {
      throw new Error(`Website returned status ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // 2. Extract Metadata (Thông tin quan trọng nhất)
    const metadata = {
      title: $('title').text().trim() || $('meta[property="og:title"]').attr('content') || '',
      description: $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '',
      keywords: $('meta[name="keywords"]').attr('content') || ''
    };

    // 3. Remove Clutter (Xóa rác kỹ hơn)
    const tagsToRemove = [
      'script', 'style', 'noscript', 'iframe', 'svg', 'video', 'audio', 'canvas', 'map', 'object',
      'link', 'meta', // Đã lấy meta ở trên rồi
      '[hidden]', '.hidden',
      // Common noise classes/ids
      '#header', '.header', 'header',
      '#footer', '.footer', 'footer',
      'nav', '.nav', '.navigation', '.menu', '#menu',
      '.sidebar', '#sidebar', 'aside',
      '.ads', '.advertisement', '.ad-banner',
      '.cookie-banner', '#cookie-banner', '.gdpr',
      '.social-share', '.share-buttons',
      '.comments', '#comments', '.comment-section',
      '.related-posts', '.recommended',
      '.popup', '.modal',
      '.login', '.signup', '.auth'
    ];
    $(tagsToRemove.join(', ')).remove();

    // 4. Smart Content Extraction Strategy
    let $content = null;

    // Ưu tiên thẻ ngữ nghĩa chứa nội dung bài viết
    const contentSelectors = [
      'article',
      '[role="main"]',
      '.post-content',
      '.entry-content',
      '#content',
      '.content',
      '.article-body',
      'main'
    ];

    for (const selector of contentSelectors) {
      if ($(selector).length > 0) {
        $content = $(selector).first(); // Lấy phần tử đầu tiên khớp
        break;
      }
    }

    // Fallback: Nếu không tìm thấy main content, dùng body (đã được dọn dẹp)
    if (!$content) {
      $content = $('body');
    }

    // 5. Structure Preservation (Giữ cấu trúc xuống dòng)
    // Thay thế các thẻ block bằng ký tự xuống dòng để text không bị dính chùm
    $content.find('br').replaceWith('\n');
    $content.find('p, div, h1, h2, h3, h4, h5, h6, li, tr').each((i, el) => {
      $(el).after('\n');
    });

    // Lấy text và làm sạch khoảng trắng thừa
    let rawText = $content.text();
    // Thay thế nhiều dòng trống liên tiếp bằng 1 dòng trống
    rawText = rawText.replace(/\n\s*\n/g, '\n\n').trim();

    if (rawText.length < 50) {
      // Fallback: Nếu nội dung quá ngắn, thử lấy lại toàn bộ body text
      rawText = $('body').text().replace(/\n\s*\n/g, '\n\n').trim();
      if (rawText.length < 50) {
        throw new Error("Nội dung trang web quá ngắn hoặc được render bằng JavaScript (SPA).");
      }
    }

    let finalContent = rawText;

    // 6. Gemini Cleaning & Structuring (CHỈ CHO MODE 'aggressive')
    let usageData = { totalTokenCount: 0 };
    if (cleaningLevel === 'aggressive' && process.env.GEMINI_API_KEY) {
      try {
        const { GoogleGenerativeAI } = await import("@google/generative-ai");
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

        const prompt = `
Role: Web Content Extractor.
Task: Reconstruct the main article from the raw scraped text below.

Context Info:
- Title: ${metadata.title}
- Description: ${metadata.description}

Instructions:
1. Ignore navigation menus, footers, copyright, and irrelevant links.
2. Focus on the main body content related to the Title.
3. Preserve the original meaning and structure (headings, paragraphs).
4. Output cleanly formatted text (Markdown is preferred).
5. Remove duplicate content and redundant text.
6. Keep only article/product description, technical details, and relevant information.

Raw Scraped Text:
"""
${rawText.substring(0, 40000)} // Giới hạn token
"""
`;

        const model = genAI.getGenerativeModel({
          model: 'gemini-2.0-flash-exp',
          generationConfig: {
            temperature: 0.3, // Lower for more focused extraction
            topP: 0.8,
            topK: 20,
            maxOutputTokens: 8000
          }
        });

        const result = await model.generateContent(prompt);
        const responseText = result.response.text();

        if (responseText && responseText.length > 50) {
          finalContent = responseText;
          if (result.response.usageMetadata) usageData = result.response.usageMetadata;
          console.log('✅ Gemini cleaning successful');
        }
      } catch (e) {
        console.warn("Gemini cleaning failed, using raw text:", e.message);
        // Fallback: prepend metadata to raw text for context
        finalContent = `Title: ${metadata.title}\nDescription: ${metadata.description}\n\n${rawText}`;
      }
    } else {
      // Nếu không có AI, vẫn ghép metadata vào để kết quả tốt hơn
      finalContent = `Title: ${metadata.title}\nDescription: ${metadata.description}\n\n${rawText}`;
    }

    if (usageData?.totalTokenCount > 0 && uid) {
      try {
        const { logTokenUsage } = await import('../tokenLogger.js');
        await logTokenUsage(uid, 'SCRAPE_WEBSITE', usageData.totalTokenCount, {
          url: url,
          cleaningLevel: cleaningLevel
        });
      } catch (e) { console.error("Log usage failed", e); }
    }

    // --- TRACK USAGE ---
    const tokenCount = usageData?.totalTokenCount || 0;
    if (tokenCount > 0) {
      try {
        // Extract User ID from verified token (need to pass or re-verify? We have auth middleware)
        // We parsed token at start but didn't save uid to variable `currentUser` widely in this scope.
        // We need to decode token properly to get uid.
        // Wait, scrape.js didn't store uid in a variable in the original code?
        // Checking original code: 
        // const token = authHeader.split('Bearer ')[1];
        // await admin.auth().verifyIdToken(token); -> result ignored?
        // We should capture the result.
      } catch (e) { }
    }

    return res.status(200).json({
      success: true,
      text: finalContent,
      metadata: metadata,
      url: url,
      cleaningLevel: cleaningLevel, // Thông báo mode đã dùng
      usage: usageData
    });

  } catch (error) {
    console.error("Scrape Error:", error);
    return res.status(500).json({ error: error.message });
  }
}
