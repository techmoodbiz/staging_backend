
import admin from 'firebase-admin';
import { robustJSONParse } from '../../utils.js';
import { loadSkill } from '../../skillLoader.js';

export async function performAudit({ text, brand_id, platform, language }) {
  const db = admin.firestore();
  const errors = [];
  let tokensLogic = 0;
  let tokensBrand = 0;
  let tokensLang = 0;

  // --- 1. LOGIC & LEGAL STREAM (DeepSeek) ---
  const logicLegalPromise = (async () => {
    let result = { identified_issues: [] };
    try {
      const { OpenAI } = await import('openai');
      const openai = new OpenAI({ baseURL: 'https://api.deepseek.com', apiKey: process.env.DEEPSEEK_API_KEY });
      const skillContent = await loadSkill('audit-logic-legal');
      
      const systemInstruction = `You are **MOODBIZ LOGIC & LEGAL AUDITOR**. Use skill: ${skillContent}`;
      const response = await openai.chat.completions.create({
        messages: [{ role: "system", content: systemInstruction }, { role: "user", content: text }],
        model: "deepseek-chat",
        temperature: 0.1,
        response_format: { type: "json_object" }
      });
      result = robustJSONParse(response.choices[0].message.content);
    } catch (e) {
      console.error("Logic Audit Error:", e.message);
    }
    return result;
  })();

  // --- 2. BRAND & PRODUCT STREAM (Gemini) ---
  const brandProductPromise = (async () => {
    let result = { identified_issues: [] };
    try {
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const skillContent = await loadSkill('audit-brand-product');
      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

      const prompt = `Audit text: "${text}" using Brand Skill: ${skillContent}. Context: Brand ${brand_id}, Platform ${platform}`;
      const response = await model.generateContent(prompt);
      result = robustJSONParse(response.response.text());
    } catch (e) {
      console.error("Brand Audit Error:", e.message);
    }
    return result;
  })();

  const [logicRes, brandRes] = await Promise.all([logicLegalPromise, brandProductPromise]);

  return {
    summary: `${logicRes.summary || ""} | ${brandRes.summary || ""}`.trim(),
    identified_issues: [...(logicRes.identified_issues || []), ...(brandRes.identified_issues || [])]
  };
}
