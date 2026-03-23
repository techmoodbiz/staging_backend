
import fetch from 'node-fetch';
import { GoogleGenerativeAI } from "@google/generative-ai";

/**
 * Ported research logic from api/research.js
 */
export async function performResearch({ keyword, urls, language = 'vi' }) {
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
        throw new Error('Vui lòng cung cấp ít nhất 1 URL để phân tích.');
    }

    // Tiered scraping logic simplified for MCP
    const successfulScrapes = [];
    for (const url of urls.slice(0, 3)) {
        try {
            const jinaReaderUrl = `https://r.jina.ai/${url}`;
            const response = await fetch(jinaReaderUrl, { timeout: 10000 });
            if (response.ok) {
                const data = await response.json();
                if (data.data?.content) {
                    successfulScrapes.push({ content: data.data.content, url, title: "Scraped Source" });
                }
            }
        } catch (e) {
            console.warn(`Scrape failed for ${url}:`, e.message);
        }
    }

    if (successfulScrapes.length === 0) {
        throw new Error("Không thể trích xuất nội dung từ các URL.");
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const combinedContext = successfulScrapes.map((s, i) => `SOURCE ${i + 1}: ${s.url}\n${s.content}`).join('\n\n');
    const prompt = `Research Topic: ${keyword || "General Analysis"}. Language: ${language}. Context: ${combinedContext.substring(0, 20000)}`;

    const result = await model.generateContent(prompt);
    return {
        analysis: result.response.text(),
        sources: successfulScrapes.map(s => s.url)
    };
}
