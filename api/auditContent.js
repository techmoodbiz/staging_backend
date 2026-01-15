
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

    // --- 1. DEEPSEEK STREAM (Logic, Brand, Product) ---
    const deepseekPromise = (async () => {
      try {
        const apiKey = process.env.DEEPSEEK_API_KEY;
        // Fallback to Gemini if DeepSeek key is missing (Hybrid safety)
        if (!apiKey) {
          console.warn("⚠️ DeepSeek Key missing. Falling back to Gemini.");
          // ... (Optional: Keep Gemini fallback logic here or just throw to failover)
          throw new Error('Missing DeepSeek API Key');
        }

        const { OpenAI } = await import('openai');
        const openai = new OpenAI({
          baseURL: 'https://api.deepseek.com',
          apiKey: apiKey
        });

        const targetLang = language || 'Vietnamese';

        const systemInstruction = `
You are MOODBIZ LOGIC AUDITOR (Powered by DeepSeek-V3).
Your job is to check for LOGIC, BRAND CONSISTENCY, and PRODUCT ACCURACY.
Do NOT check for spelling or grammar.

**CORE DIRECTIVE:**
1. Check 'ai_logic': Does the content make sense? Is it hallucinating?
2. Check 'brand': Does it behave according to brand persona?
3. Check 'product': Is technical info accurate?

**STRICT CITATION RULE:**
You MUST cite specific "Rule Labels" from the User Prompt whitelist.
If a sentence is logically sound and fits the brand, it is CORRECT.

**OUTPUT FORMAT:**
Return strictly valid JSON only. No markdown. No reasoning text outside JSON.
Explanations (\`reason\`, \`suggestion\`) must be in ${targetLang}.

JSON Schema:
{
  "summary": "Detailed analysis summary in ${targetLang}",
  "identified_issues": [
    {
       "category": "ai_logic" | "brand" | "product",
       "problematic_text": "...",
       "citation": "Exact Rule Label",
       "reason": "Explanation in ${targetLang}",
       "severity": "High" | "Medium" | "Low",
       "suggestion": "Rewritten sentence in ${targetLang}"
    }
  ]
}
`;

        const finalPrompt = constructedPrompt || `Audit this text:\n"""\n${text}\n"""`;

        const response = await openai.chat.completions.create({
          messages: [
            { role: "system", content: systemInstruction },
            { role: "user", content: finalPrompt }
          ],
          model: "deepseek-chat", // DeepSeek-V3
          temperature: 0.1,
          response_format: { type: "json_object" }, // Enforce JSON if model supports, else prompt does it
          max_tokens: 4096
        });

        const content = response.choices[0].message.content;
        return robustJSONParse(content);

      } catch (e) {
        console.error("DeepSeek Error:", e);
        errors.push("DeepSeek Error: " + e.message);
        return { summary: "Lỗi Logic Audit (DeepSeek).", identified_issues: [] };
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
    const [deepseekResult, hfResult] = await Promise.all([deepseekPromise, hfPromise]);

    const finalResult = {
      summary: (deepseekResult?.summary || "") + (hfResult?.identified_issues?.length ? ` | Note ngữ pháp: ${hfResult.summary}` : ""),
      identified_issues: [
        ...(deepseekResult?.identified_issues || []),
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
