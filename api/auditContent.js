
import admin from 'firebase-admin';

// Initialize Firebase Admin if needed
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
import { robustJSONParse } from '../utils.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // --- AUTH VERIFICATION ---
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token format' });
  }

  const parts = authHeader.split('Bearer ');
  if (parts.length < 2) {
    return res.status(401).json({ error: 'Unauthorized: Malformed token' });
  }

  const token = parts[1].trim();
  let currentUser;

  try {
    currentUser = await admin.auth().verifyIdToken(token);
  } catch (error) {
    console.error("Token verification failed:", error);
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }

  try {
    const { constructedPrompt, text, language } = req.body;
    const errors = [];
    let totalTokensUsed = 0;

    // --- 1. LOGIC STREAM (DeepSeek with Gemini Fallback) ---
    const logicPromise = (async () => {
      let logicResult = null;
      let usedModel = "DeepSeek";

      // 1.1 TRY DEEPSEEK
      try {
        const dkKey = process.env.DEEPSEEK_API_KEY;
        if (!dkKey) throw new Error("Missing DeepSeek Key");

        const { OpenAI } = await import('openai');
        const openai = new OpenAI({ baseURL: 'https://api.deepseek.com', apiKey: dkKey });
        const targetLang = language || 'Vietnamese';

        const systemInstruction = `
You are MOODBIZ LOGIC AUDITOR (DeepSeek-V3).
Check for LOGIC, BRAND, and PRODUCT accuracy. Do NOT check spelling.

**CORE DIRECTIVE:**
1. Check 'ai_logic': Hallucination? Logic flaw?
2. Check 'brand': Wrong tone? Forbidden words?
3. Check 'product': Wrong specs?
4. Check 'legal': Advertising Law violations?

**STRICT CITATION:** Cite exact "Rule Label" or "Implicit Label" from whitelist.
**OUTPUT:** Strictly valid JSON.

JSON Schema:
{
  "summary": "Analysis in Vietnamese",
  "identified_issues": [
    {
       "category": "ai_logic" | "brand" | "product" | "legal",
       "problematic_text": "...",
       "citation": "Exact Rule Label",
       "reason": "Explanation in Vietnamese",
       "severity": "High" | "Medium" | "Low",
       "suggestion": "Rewritten sentence in ${targetLang}"
    }
  ]
}
`;
        const response = await openai.chat.completions.create({
          messages: [{ role: "system", content: systemInstruction }, { role: "user", content: constructedPrompt || text }],
          model: "deepseek-chat",
          temperature: 0.1,
          response_format: { type: "json_object" },
          max_tokens: 4096
        });

        if (response.usage) {
          totalTokensUsed += response.usage.total_tokens || 0;
        }

        logicResult = robustJSONParse(response.choices[0].message.content);

      } catch (dkError) {
        console.warn(`⚠️ DeepSeek Failed (${dkError.message}). Fallback to GEMINI.`);
        usedModel = "Gemini";

        // 1.2 FALLBACK TO GEMINI
        try {
          const gmKey = process.env.GEMINI_API_KEY;
          if (!gmKey) throw new Error("Missing Gemini Key too!");

          const { GoogleGenerativeAI, SchemaType } = await import('@google/generative-ai');
          const genAI = new GoogleGenerativeAI(gmKey);

          const auditResponseSchema = {
            type: SchemaType.OBJECT,
            properties: {
              summary: { type: SchemaType.STRING },
              identified_issues: {
                type: SchemaType.ARRAY,
                items: {
                  type: SchemaType.OBJECT,
                  properties: {
                    category: { type: SchemaType.STRING, description: "ai_logic, brand, product, or legal" },
                    problematic_text: { type: SchemaType.STRING },
                    citation: { type: SchemaType.STRING },
                    reason: { type: SchemaType.STRING },
                    severity: { type: SchemaType.STRING },
                    suggestion: { type: SchemaType.STRING }
                  },
                  required: ["category", "problematic_text", "reason", "suggestion", "citation", "severity"]
                }
              }
            },
            required: ["summary", "identified_issues"]
          };

          const systemInstruction = `
You are MOODBIZ LOGIC AUDITOR (Gemini Fallback).
Check LOGIC, BRAND, PRODUCT, LEGAL. Do NOT check spelling.
OUTPUT: JSON.
- Summary/Reason: Must be in Vietnamese.
- Suggestion: Must be in ${language || 'Vietnamese'}.
`;
          const model = genAI.getGenerativeModel({
            model: 'gemini-2.0-flash-exp',
            systemInstruction: systemInstruction,
            generationConfig: { temperature: 0.1, responseMimeType: 'application/json', responseSchema: auditResponseSchema }
          });

          const result = await model.generateContent(constructedPrompt || text);

          if (result.response.usageMetadata) {
            totalTokensUsed += result.response.usageMetadata.totalTokenCount || 0;
          }

          logicResult = robustJSONParse(result.response.text());

        } catch (gmError) {
          console.error("❌ Both DeepSeek AND Gemini Failed:", gmError);
          errors.push(`Logic Audit Failed: ${gmError.message}`);
          return { summary: "Lỗi hệ thống Logic Audit.", identified_issues: [] };
        }
      }

      return logicResult;
    })();

    // --- 2. HUGGING FACE STREAM (Language) ---
    const hfPromise = (async () => {
      try {
        const hfToken = process.env.HF_ACCESS_TOKEN;

        // FIX: Use OpenAI client to connect to new Hugging Face Router URL
        // Old URL (api-inference.huggingface.co) is deprecated/unstable for large models via hf-inference
        const { OpenAI } = await import('openai');

        const hf = new OpenAI({
          baseURL: "https://router.huggingface.co/hf-inference/v1",
          apiKey: hfToken || "hf_public" // Fallback mostly for public models, but usually requires key
        });

        // Qwen2.5-72B-Instruct is excellent for this.
        const modelName = "Qwen/Qwen2.5-Coder-32B-Instruct";
        const targetLang = language || 'Vietnamese';

        const systemInstruction = `
You are MOODBIZ LANGUAGE AUDITOR.
Your ONLY job is to check for SPELLING, GRAMMAR, and STYLISTICS in ${targetLang}.
Do NOT check for brand rules or logic.

**TASK:**
Review the text below. Identify spelling mistakes, grammar errors, or awkward phrasing (Not Native ${targetLang}).
Return JSON format.

**JSON SCHEMA:**
{
  "summary": "Brief comment on language quality (in Vietnamese)",
  "identified_issues": [
    {
       "category": "language",
       "problematic_text": "text segment",
       "citation": "Spelling/Grammar",
       "reason": "Why is it wrong? (in Vietnamese)",
       "severity": "Low/Medium/High",
       "suggestion": "Corrected text (in ${targetLang})"
    }
  ]
}
`;

        const userPrompt = `Text to check:\n"""\n${text}\n"""\n\nReturn strictly valid JSON.`;

        const response = await hf.chat.completions.create({
          model: modelName,
          messages: [
            { role: "system", content: systemInstruction },
            { role: "user", content: userPrompt }
          ],
          max_tokens: 4096,
          temperature: 0.1
        });

        const content = response.choices[0].message.content;
        // Clean markdown code blocks if present
        const jsonStr = content.replace(/```json\n?|\n?```/g, '').trim();
        return robustJSONParse(jsonStr);

      } catch (e) {
        console.error("Hugging Face Error:", e);
        errors.push("HF Error: " + e.message);
        return { summary: "Lỗi Language Audit (HF).", identified_issues: [] };
      }
    })();

    // --- MERGE RESULTS ---
    const [logicResult, hfResult] = await Promise.all([logicPromise, hfPromise]);

    const finalResult = {
      summary: (logicResult?.summary || "") + (hfResult?.identified_issues?.length ? ` | Note ngữ pháp: ${hfResult.summary}` : ""),
      identified_issues: [
        ...(logicResult?.identified_issues || []),
        ...(hfResult?.identified_issues || [])
      ]
    };

    if (errors.length > 0) {
      console.warn("Audit Partial Errors:", errors);
      finalResult.identified_issues.push({
        category: 'ai_logic',
        severity: 'Low',
        problematic_text: 'System Warning',
        citation: 'System',
        reason: `Một số module Audit gặp lỗi: ${errors.join(', ')}`,
        suggestion: 'Vui lòng kiểm tra lại cấu hình.'
      });
    }

    // --- TRACK USAGE (ASYNC) ---
    if (totalTokensUsed > 0 && currentUser.uid) {
      try {
        await db.collection('users').doc(currentUser.uid).set({
          usageStats: {
            totalTokens: admin.firestore.FieldValue.increment(totalTokensUsed),
            requestCount: admin.firestore.FieldValue.increment(1),
            lastActiveAt: admin.firestore.FieldValue.serverTimestamp()
          }
        }, { merge: true });
      } catch (e) {
        console.error("Failed to track audit usage:", e);
      }
    }

    return res.status(200).json({ success: true, result: finalResult });

  } catch (error) {
    console.error('Audit API Critical Error:', error);
    return res.status(200).json({
      success: true,
      result: {
        summary: 'Lỗi hệ thống khi phân tích.',
        identified_issues: [{ category: 'ai_logic', severity: 'High', problematic_text: 'API Error', citation: 'System', reason: error.message, suggestion: 'Thử lại sau.' }],
      },
    });
  }
}
