
import fetch from "node-fetch";
import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      type: "service_account",
      project_id: process.env.FIREBASE_PROJECT_ID,
      private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
    }),
  });
}

const db = admin.firestore();

function cosineSimilarity(vecA, vecB) {
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

async function getConsolidatedContext(brandId, queryEmbedding = null, topK = 12) {
  try {
    const guidelinesSnap = await db.collection("brand_guidelines")
      .where("brand_id", "==", brandId)
      .where("status", "==", "approved")
      .get();

    if (guidelinesSnap.empty) {
      console.log("No approved guidelines found for brand:", brandId);
      return { text: "", sources: [] };
    }

    let allChunks = [];
    for (const guideDoc of guidelinesSnap.docs) {
      const guideData = guideDoc.data();
      const chunksSnap = await guideDoc.ref.collection("chunks").get();

      chunksSnap.forEach(cDoc => {
        const cData = cDoc.data();
        allChunks.push({
          text: cData.text,
          embedding: cData.embedding,
          isPrimary: !!guideData.is_primary,
          source: guideData.file_name
        });
      });
    }

    if (allChunks.length === 0) return { text: "", sources: [] };

    if (queryEmbedding) {
      console.log("Running cosine similarity on", allChunks.length, "chunks");
      const ranked = allChunks.map(chunk => {
        const similarity = cosineSimilarity(queryEmbedding, chunk.embedding);
        const finalScore = similarity + (chunk.isPrimary ? 0.15 : 0);
        return { ...chunk, finalScore };
      });

      ranked.sort((a, b) => b.finalScore - a.finalScore);
      const topChunks = ranked.slice(0, topK);

      const contextText = topChunks.map(c => `[Nguồn: ${c.source}${c.isPrimary ? ' - MASTER' : ''}] ${c.text}`).join("\n\n---\n\n");
      const uniqueSources = [...new Set(topChunks.map(c => c.source))];

      return { text: contextText, sources: uniqueSources };
    }

    return { text: allChunks.slice(0, 10).map(c => c.text).join("\n\n"), sources: [] };
  } catch (err) {
    console.error("Context retrieval error:", err);
    return { text: "", sources: [] };
  }
}

export default async function handler(req, res) {
  // Config CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

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

  console.log("--- RAG GENERATE REQUEST RECEIVED ---");

  try {
    const { brand, topic, platform, language, userText, systemPrompt, context } = req.body;
    console.log("Request Params:", { brandName: brand?.name, topic, platform, hasContext: !!context, hasSystemPrompt: !!systemPrompt });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

    // Standard dynamic import with correct package
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(apiKey);

    let ragContext = "";
    let sources = [];

    // --- MODE 1: CONTEXT STUFFING ---
    if (context) {
      console.log("Using provided context (Client-side stuffing)");
      ragContext = context;
      sources = ["Client Provided Context"];
    }
    // --- MODE 2: SERVER-SIDE RAG ---
    else {
      console.log("Starting Server-side RAG Retrieval...");
      let queryEmbedding = null;
      try {
        const embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
        const embedRes = await embedModel.embedContent(`${topic} ${platform}`);
        queryEmbedding = embedRes.embedding.values;
      } catch (e) {
        console.warn("Embedding failed, falling back to non-semantic retrieval:", e.message);
      }

      const retrieval = await getConsolidatedContext(brand.id, queryEmbedding);
      ragContext = retrieval.text;
      sources = retrieval.sources;
      console.log("RAG Retrieved:", sources.length, "sources. Context Length:", ragContext.length);
    }

    // --- CONSTRUCT PROMPT ---
    let finalPrompt;
    if (systemPrompt) {
      finalPrompt = `
${systemPrompt}

INPUT CONTEXT / KNOWLEDGE BASE:
${ragContext || "No specific guidelines found."}

REQUEST DETAILS:
Topic: ${topic}
Platform: ${platform}
Language: ${language || "Vietnamese"}
${userText ? `User Note: ${userText}` : ""}
`;
    } else {
      finalPrompt = `
Bạn là chuyên gia Content của ${brand.name}.
Dựa trên bộ Knowledge Base (đã được tổng hợp) dưới đây:
${ragContext || "Không có dữ liệu guideline."}

[YÊU CẦU]
Chủ đề: ${topic}
Kênh: ${platform}
Ngôn ngữ: ${language || "Vietnamese"}
`;
    }

    console.log("Calling Gemini 2.0 Flash...");

    // --- GENERATE CONTENT with correct API ---
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash-exp',
      generationConfig: {
        temperature: 0.7,
        topP: 0.95,
        maxOutputTokens: 8192
      }
    });

    const response = await model.generateContent(finalPrompt);

    const resultText = response.response.text();
    console.log("Gemini Response Received. Length:", resultText?.length);


    res.status(200).json({
      success: true,
      result: resultText || "AI không thể phản hồi.",
      citations: sources
    });

  } catch (e) {
    console.error("CRITICAL GENERATE ERROR:", e);
    res.status(500).json({ success: false, error: e.message });
  }
}
