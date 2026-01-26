
import admin from 'firebase-admin';
import fetch from 'node-fetch';

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
    // Split token tracking
    let tokensLogic = 0;
    let tokensBrand = 0;
    let tokensLang = 0;
    // let totalTokensUsed = 0; // Removed aggregate counter

    // --- 1. LOGIC & LEGAL STREAM (DeepSeek) ---
    const logicLegalPromise = (async () => {
      let result = { identified_issues: [] };
      try {
        const dkKey = process.env.DEEPSEEK_API_KEY;
        if (!dkKey) throw new Error("Missing DeepSeek Key");

        const { OpenAI } = await import('openai');
        const openai = new OpenAI({ baseURL: 'https://api.deepseek.com', apiKey: dkKey });

        const systemInstruction = `
You are MOODBIZ LOGIC & LEGAL AUDITOR (DeepSeek-V3).
Your job is to specific check:
1. **AI LOGIC**: Hallucinations, logical fallacies, data contradictions.
2. **LEGAL**: Vietnamese Advertising Law compliance.

Do NOT check Brand, Product, or Spelling.

JSON Schema:
{
  "summary": "Logic/Legal Analysis in Vietnamese",
  "identified_issues": [
    {
       "category": "ai_logic" | "legal",
       "problematic_text": "...",
       "citation": "Law Article or Logic Rule",
       "reason": "Explanation in Vietnamese",
       "severity": "High" | "Medium" | "Low",
       "suggestion": "Fix suggestion in ${language || 'Vietnamese'}"
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

        if (response.usage) tokensLogic += response.usage.total_tokens || 0;
        result = robustJSONParse(response.choices[0].message.content);

      } catch (e) {
        console.error("DeepSeek (Logic/Legal) Error:", e.message);
        errors.push(`Logic/Legal Error: ${e.message}`);
        // Fallback or just return empty for this block? 
        // Request implied DeepSeek is dedicated. We can fallback to Gemini if needed but user strictly separated.
        // Let's add a robust fallback just in case or leave consistent with request?
        // User said: "Logic & Legal BY DeepSeek". If it fails, maybe fail or fallback.
        // I will return empty to avoid blocking others.
      }
      return result;
    })();

    // --- 2. BRAND & PRODUCT STREAM (Gemini) ---
    const brandProductPromise = (async () => {
      let result = { identified_issues: [] };
      try {
        const gmKey = process.env.GEMINI_API_KEY;
        if (!gmKey) throw new Error("Missing Gemini Key");

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
                  category: { type: SchemaType.STRING, description: "brand or product" },
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
You are MOODBIZ BRAND & PRODUCT AUDITOR (Gemini).
Your job is to specific check:
1. **BRAND**: Tone of voice, forbidden words, visual style match.
2. **PRODUCT**: Specification accuracy, feature claims.

Do NOT check Logic, Legal, or Spelling.

JSON Output Only.
Summary/Reason in Vietnamese. Suggestion in ${language || 'Vietnamese'}.
`;
        const model = genAI.getGenerativeModel({
          model: 'gemini-2.0-flash-exp',
          systemInstruction: systemInstruction,
          generationConfig: { temperature: 0.1, responseMimeType: 'application/json', responseSchema: auditResponseSchema }
        });

        const response = await model.generateContent(constructedPrompt || text);
        if (response.response.usageMetadata) tokensBrand += response.response.usageMetadata.totalTokenCount || 0;
        result = robustJSONParse(response.response.text());

      } catch (e) {
        console.error("Gemini (Brand/Product) Error:", e.message);
        errors.push(`Brand/Product Error: ${e.message}`);
      }
      return result;
    })();

    // --- 3. LANGUAGE STREAM (Hugging Face / Qwen) ---
    const hfPromise = (async () => {
      const targetLang = language || 'Vietnamese';
      const systemInstruction = `
Bạn là **MOODBIZ LANGUAGE AUDITOR**.

Nhiệm vụ:
- Chỉ kiểm tra chính tả, ngữ pháp, phong cách diễn đạt trong ${targetLang}.
- Không đánh giá brand, legal, logic, sản phẩm.

Yêu cầu output: JSON với cấu trúc:
{
  "summary": "Đánh giá ngắn gọn (tiếng Việt)",
  "identified_issues": [
    {
      "category": "language",
      "problematic_text": "...",
      "citation": "Spelling/Grammar",
      "reason": "Giải thích lỗi (tiếng Việt)",
      "severity": "Low | Medium | High",
      "suggestion": "Câu sửa theo ${targetLang}"
    }
  ]
}
Chỉ trả về JSON hợp lệ, không thêm giải thích ngoài.
`;

      const userPrompt = `Text to check:\n"""\n${text}\n"""\n\nReturn strictly valid JSON.`;

      try {
        const hfToken = process.env.HF_ACCESS_TOKEN;
        const modelName = "Qwen/Qwen2.5-Coder-32B-Instruct";

        // DÙNG LẠI HfInference ĐÚNG CÁCH
        const { HfInference } = await import("@huggingface/inference");

        // Không truyền endpointUrl vào đây
        const hf = new HfInference(hfToken);

        const response = await hf.chatCompletion({
          model: modelName,
          messages: [
            { role: "system", content: systemInstruction },
            { role: "user", content: userPrompt }
          ],
          max_tokens: 4096,
          temperature: 0.1,
          response_format: { type: "json_object" }
        });

        const content = response.choices[0].message.content;
        const jsonStr = content.replace(/```json\n?|\n?```/g, "").trim();

        let tokenCount = 0;
        if (response.usage) {
          tokenCount = response.usage.total_tokens || 0;
        }

        // Add token count to the result so we can access it outside
        const parsed = robustJSONParse(jsonStr);
        parsed._tokenUsage = tokenCount;

        // Explicitly update the outer scope variable if accessible, or return it.
        // Since this is an IIFE / async block, we should return it in the object 
        // OR update the `tokensLang` variable if it was in scope.
        // But `tokensLang` is in the outer scope. We can't easily assign to it from inside this Promise if it's not capturing the variable by reference/closure correctly or if we want to be cleaner.
        // Actually, `tokensLang` *is* in scope (lines 58). So we can just assign to it.
        if (tokenCount > 0) tokensLang += tokenCount;

        return parsed;
      } catch (e) {
        let status = e.response?.status;
        let statusText = e.response?.statusText || "";
        let bodyText = "";

        if (e.response) {
          try {
            bodyText = await e.response.text();
          } catch (_) {
            bodyText = "[Không đọc được body từ HF]";
          }
        }

        console.error(
          `HF Language Error: status=${status || "Unknown"} ${statusText}`.trim()
        );
        console.error(`HF Language Error body: ${bodyText}`);

        errors.push(`Language Error (HF ${status || "Unknown"}): ${e.message}`);

        return {
          summary: "Lỗi hệ thống Language Audit (HF).",
          identified_issues: [
            {
              category: "language",
              severity: "High",
              problematic_text: "System Check",
              citation: "API",
              reason: `Kết nối HF thất bại (HTTP ${status || "Unknown"}): ${bodyText || e.message
                }`,
              suggestion:
                "Kiểm tra lại modelName, Inference Providers và quota HF.",
            },
          ],
        };
      }
    })();

    // --- MERGE RESULTS ---
    const [logicLegalResult, brandProductResult, hfResult] = await Promise.all([logicLegalPromise, brandProductPromise, hfPromise]);

    const summaries = [
      logicLegalResult?.summary,
      brandProductResult?.summary,
      hfResult?.summary
    ].filter(s => s && s.trim().length > 0);

    const finalResult = {
      summary: summaries.join(' | ') || "Hoàn tất kiểm tra.",
      identified_issues: [
        ...(logicLegalResult?.identified_issues || []),
        ...(brandProductResult?.identified_issues || []),
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
    if (currentUser.uid) {
      try {
        const { logTokenUsage } = await import('../tokenLogger.js');
        const promises = [];

        if (tokensLogic > 0) {
          promises.push(logTokenUsage(currentUser.uid, 'AUDIT_LOGIC_LEGAL', tokensLogic, { status: 'success' }));
        }
        if (tokensBrand > 0) {
          promises.push(logTokenUsage(currentUser.uid, 'AUDIT_BRAND_PRODUCT', tokensBrand, { status: 'success' }));
        }
        if (tokensLang > 0) {
          promises.push(logTokenUsage(currentUser.uid, 'AUDIT_LANGUAGE', tokensLang, { status: 'success' }));
        }

        await Promise.all(promises);
      } catch (e) {
        console.error("Failed to track audit usage:", e);
      }
    }

    return res.status(200).json({
      success: true,
      result: finalResult,
      usage: {
        totalTokens: tokensLogic + tokensBrand + tokensLang
      }
    });

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
