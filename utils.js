
/**
 * Robust JSON Parser V2
 * Handles Markdown code blocks, comments, and common syntax errors.
 */
export function robustJSONParse(text) {
    if (!text) return null;
    let clean = String(text);
    // Remove markdown code blocks if present
    clean = clean.replace(/```json/gi, '').replace(/```/g, '').trim();

    const firstBrace = clean.indexOf('{');
    const lastBrace = clean.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
        clean = clean.substring(firstBrace, lastBrace + 1);
    } else {
        return null;
    }
    try { return JSON.parse(clean); } catch (e) { }
    // Try cleaning common errors
    clean = clean.replace(/\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1').replace(/([{,]\s*)([a-zA-Z0-9_]+?)\s*:/g, '$1"$2":');
    try { return JSON.parse(clean); } catch (e) { }
    return null;
}

/**
 * Cosine Similarity Calculation
 */
export function cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
    let dotProduct = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Semantic Chunking
 * Splits text into chunks based on paragraphs, respecting max/min sizes.
 */
export function semanticChunking(text, maxChunkSize = 1000, minChunkSize = 100) {
    const cleanText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const rawParagraphs = cleanText.split(/\n\s*\n/);
    const chunks = [];
    let currentChunk = "";

    for (const para of rawParagraphs) {
        const cleanPara = para.trim();
        if (!cleanPara) continue;
        const potentialSize = currentChunk.length + cleanPara.length + 2;
        if (potentialSize <= maxChunkSize) {
            currentChunk += (currentChunk ? "\n\n" : "") + cleanPara;
        } else {
            if (currentChunk.length >= minChunkSize) { chunks.push(currentChunk); currentChunk = ""; }
            if (cleanPara.length > maxChunkSize) {
                const sentences = cleanPara.match(/[^.!?]+[.!?]+(\s+|$)/g) || [cleanPara];
                let subChunk = "";
                for (const sentence of sentences) {
                    if (subChunk.length + sentence.length <= maxChunkSize) subChunk += sentence;
                    else { if (subChunk) chunks.push(subChunk.trim()); subChunk = sentence; }
                }
                if (subChunk) currentChunk = subChunk.trim();
            } else { currentChunk = cleanPara; }
        }
    }
    if (currentChunk) chunks.push(currentChunk);
    return chunks.filter(c => c.length > 20).map((c, index) => ({ text: c, start: index * 100, end: (index * 100) + c.length }));
}
