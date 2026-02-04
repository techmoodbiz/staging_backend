
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
import { loadSkill } from '../skillLoader.js';

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

        const skillContent = await loadSkill('audit-logic-legal');
        const systemInstruction = `
You are **MOODBIZ LOGIC & LEGAL AUDITOR** (Agent Skill).
Base your auditing on the following skill definition:

${skillContent}

### NHIỆM VỤ QUAN TRỌNG NHẤT (MANDATORY):
1. Chỉ được báo cáo lỗi khi tìm thấy sự vi phạm trực tiếp đối với các quy tắc được cung cấp (Module 3: MarkRules hoặc Module 4: LegalRules).
2. TRÍCH DẪN CHÍNH XÁC: Trường "citation" TUYỆT ĐỐI phải khớp 100% với TÊN của quy tắc được cung cấp (ví dụ: "MarkRule: Logic_01").
3. CẤM BỊA ĐẶT: Nếu một vấn đề không vi phạm quy tắc cụ thể nào -> KHÔNG ĐƯỢC BÁO LỖI.

JSON Schema:
{
  "summary": "Tóm tắt ngắn gọn lỗi vi phạm SOP",
  "identified_issues": [
    {
       "category": "ai_logic" | "legal",
       "problematic_text": "đoạn văn vi phạm",
       "citation": "Tên chính xác sau dấu '### MarkRule:' hoặc '### LegalRule:'",
       "reason": "Giải thích chi tiết lỗi dựa trên SOP (Tiếng Việt)",
       "severity": "High" | "Medium" | "Low",
       "suggestion": "Gợi ý sửa đổi phù hợp"
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
        errors.push(`Logic / Legal Error: ${e.message} `);
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

        const skillContent = await loadSkill('audit-brand-product');
        const systemInstruction = `
You are ** MOODBIZ BRAND & PRODUCT AUDITOR ** (Agent Skill).
Base your auditing on the following skill definition:

${skillContent}

JSON Output Only.
          Summary / Reason in Vietnamese.Suggestion in ${language || 'Vietnamese'}.
        `;
        const model = genAI.getGenerativeModel({
          model: 'gemini-2.0-flash',
          systemInstruction: systemInstruction,
          generationConfig: { temperature: 0.1, responseMimeType: 'application/json', responseSchema: auditResponseSchema }
        });

        const response = await model.generateContent(constructedPrompt || text);
        if (response.response.usageMetadata) tokensBrand += response.response.usageMetadata.totalTokenCount || 0;
        result = robustJSONParse(response.response.text());

      } catch (e) {
        console.error("Gemini (Brand/Product) Error:", e.message);
        errors.push(`Brand / Product Error: ${e.message} `);
      }
      return result;
    })();

    // --- 3. LANGUAGE STREAM (Gemini - Linguistic Expert Agent) ---
    const languagePromise = (async () => {
      const targetLang = language || 'Vietnamese';
      let result = { identified_issues: [] };
      try {
        const gmKey = process.env.GEMINI_API_KEY;
        if (!gmKey) throw new Error("Missing Gemini Key");

        const { GoogleGenerativeAI, SchemaType } = await import('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(gmKey);

        const langResponseSchema = {
          type: SchemaType.OBJECT,
          properties: {
            summary: { type: SchemaType.STRING },
            identified_issues: {
              type: SchemaType.ARRAY,
              items: {
                type: SchemaType.OBJECT,
                properties: {
                  category: { type: SchemaType.STRING, description: "always 'language'" },
                  problematic_text: { type: SchemaType.STRING },
                  citation: { type: SchemaType.STRING, description: "Spelling, Grammar, or RedFlag" },
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

        const skillContent = await loadSkill('audit-linguistic-expert');
        const systemInstruction = `
You are ** MOODBIZ LINGUISTIC EXPERT ** (Agent Skill).
Base your auditing on the following skill definition:

${skillContent}

### ADDITIONAL CONTEXT:
        - Target Language: ${targetLang}
        - Strategy: SIÊU BẢO THỦ(Anti - hallucination).Only audit objective errors.

JSON Output Only.Summary / Reason in Vietnamese.Suggestion in the text's original language.
`;
        const model = genAI.getGenerativeModel({
          model: 'gemini-2.0-flash',
          systemInstruction: systemInstruction,
          generationConfig: { temperature: 0.0, responseMimeType: 'application/json', responseSchema: langResponseSchema }
        });

        const response = await model.generateContent(`Text to audit: \n"""\n${text}\n"""`);
        if (response.response.usageMetadata) tokensLang += response.response.usageMetadata.totalTokenCount || 0;
        result = robustJSONParse(response.response.text());

      } catch (e) {
        console.error("Gemini (Language Agent) Error:", e.message);
        errors.push(`Language Agent Error: ${e.message} `);
        result = {
          summary: "Lỗi hệ thống Language Audit.",
          identified_issues: [{ category: "language", severity: "High", problematic_text: "System", citation: "API", reason: e.message, suggestion: "Kiểm tra lại kết nối Gemini." }]
        };
      }
      return result;
    })();

    // --- MERGE RESULTS ---
    const [logicLegalResult, brandProductResult, languageResult] = await Promise.all([logicLegalPromise, brandProductPromise, languagePromise]);

    const summaries = [
      logicLegalResult?.summary,
      brandProductResult?.summary,
      languageResult?.summary
    ].filter(s => s && s.trim().length > 0);

    const finalResult = {
      summary: summaries.join(' | ') || "Hoàn tất kiểm tra.",
      identified_issues: [
        ...(logicLegalResult?.identified_issues || []),
        ...(brandProductResult?.identified_issues || []),
        ...(languageResult?.identified_issues || [])
      ]
    };

    if (errors.length > 0) {
      console.warn("Audit Partial Errors:", errors);
      finalResult.identified_issues.push({
        category: 'ai_logic',
        severity: 'Low',
        problematic_text: 'System Warning',
        citation: 'System',
        reason: `Một số module Audit gặp lỗi: ${errors.join(', ')} `,
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
