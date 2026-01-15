
import admin from 'firebase-admin';
import { HfInference } from '@huggingface/inference';

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

  try {
    await admin.auth().verifyIdToken(token);
  } catch (error) {
    console.error("Token verification failed:", error);
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }

  try {
    const { constructedPrompt, text, language } = req.body;
    const errors = [];

    // --- 1. GEMINI STREAM (Logic, Brand, Product) ---
    const geminiPromise = (async () => {
      try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) throw new Error('Missing Gemini API Key');

        const { GoogleGenerativeAI, SchemaType } = await import('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(apiKey);

        const auditResponseSchema = {
          type: SchemaType.OBJECT,
          properties: {
            summary: { type: SchemaType.STRING },
            identified_issues: {
              type: SchemaType.ARRAY,
              items: {
                type: SchemaType.OBJECT,
                properties: {
                  category: { type: SchemaType.STRING, description: "One of: ai_logic, brand, product" }, // Removed 'language'
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
You are MOODBIZ LOGIC AUDITOR.
Your specific job is to check for LOGIC, BRAND CONSISTENCY, and PRODUCT ACCURACY.
Do NOT check for spelling or grammar (another AI does that).

**CORE DIRECTIVE:**
1. Check 'ai_logic': Does the content make sense? Is it hallucinating?
2. Check 'brand': Does it violate brand tone or forbidden words?
3. Check 'product': Is the product info accurate based on provided context?

**STRICT CITATION RULE:**
You MUST cite specific "Rule Labels" from the User Prompt whitelist.
If a sentence is logically sound and fits the brand, it is CORRECT.

**OUTPUT:**
Return JSON. Explanations in the target language (${language || 'Vietnamese'}).
`;

        const model = genAI.getGenerativeModel({
          model: 'gemini-2.0-flash-exp',
          systemInstruction: systemInstruction,
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
            responseSchema: auditResponseSchema
          },
        });

        const finalPrompt = constructedPrompt || `Audit this text:\n"""\n${text}\n"""`;
        const result = await model.generateContent(finalPrompt);
        return robustJSONParse(result.response.text());

      } catch (e) {
        console.error("Gemini Error:", e);
        errors.push("Gemini Error: " + e.message);
        return { summary: "Lỗi Logic Audit.", identified_issues: [] };
      }
    })();

    // --- 2. HUGGING FACE STREAM (Language) ---
    const hfPromise = (async () => {
      try {
        const hfToken = process.env.HF_ACCESS_TOKEN;
        // If no token, we attempt without it (free tier), checking for rate limits or logic in test script

        const hf = new HfInference(hfToken);

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
  "summary": "Brief comment on language quality (in ${targetLang})",
  "identified_issues": [
    {
       "category": "language",
       "problematic_text": "text segment",
       "citation": "Spelling/Grammar",
       "reason": "Why is it wrong? (in ${targetLang})",
       "severity": "Low/Medium/High",
       "suggestion": "Corrected text"
    }
  ]
}
`;

        const userPrompt = `Text to check:\n"""\n${text}\n"""\n\nReturn strictly valid JSON.`;

        const response = await hf.chatCompletion({
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
        return { summary: "Lỗi Language Audit.", identified_issues: [] };
      }
    })();

    // --- MERGE RESULTS ---
    const [geminiResult, hfResult] = await Promise.all([geminiPromise, hfPromise]);

    const finalResult = {
      summary: (geminiResult?.summary || "") + (hfResult?.identified_issues?.length ? ` | Note ngữ pháp: ${hfResult.summary}` : ""),
      identified_issues: [
        ...(geminiResult?.identified_issues || []),
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
