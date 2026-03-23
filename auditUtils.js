import { robustJSONParse } from './utils.js';
import { loadSkill } from './skillLoader.js';

/**
 * Core Multi-Model Audit Logic
 * Orchestrates DeepSeek (Logic/Legal), Gemini (Brand/Product), and Gemini (Language)
 */
export async function performFullAudit({ text, language, platform, constructedPrompt }) {
  const errors = [];
  let tokensLogic = 0;
  let tokensBrand = 0;
  let tokensLang = 0;

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

### CONTEXT:
- Platform: ${platform || 'General'}
- Language: ${language || 'Vietnamese'}

### NHIỆM VỤ QUAN TRỌNG NHẤT (MANDATORY):
1. Chỉ được báo cáo lỗi khi tìm thấy sự vi phạm trực tiếp đối với các quy tắc được cung cấp.
2. ƯU TIÊN LEGAL: Nếu một lỗi vi phạm cả MarkRule và LegalRule, CHỈ báo cáo là 'legal'.
3. TRÍCH DẪN CHÍNH XÁC: Trường "citation" phải khớp TÊN quy tắc.
4. CẤM BỊA ĐẶT: Nếu không vi phạm -> KHÔNG ĐƯỢC BÁO LỖI.
5. LEGAL RED FLAGS: Luôn được kiểm tra bất kể có LegalRule hay không.

### CHAIN-OF-THOUGHT:
1. Đọc toàn bộ văn bản. 2. Liệt kê tuyên bố. 3. So sánh mâu thuẫn. 4. Kiểm tra SOP/Legal. 5. Báo cáo nếu >= 90% chắc chắn.

JSON Schema:
{
  "summary": "Tóm tắt ngắn gọn",
  "identified_issues": [
    {
       "category": "ai_logic" | "legal",
       "problematic_text": "đoạn văn vi phạm",
       "citation": "Tên chính xác quy tắc",
       "reason": "Giải thích chi tiết lỗi (Tiếng Việt)",
       "severity": "High" | "Medium" | "Low",
       "suggestion": "Gợi ý sửa đổi"
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
      errors.push(`Logic / Legal Error: ${e.message}`);
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
      const promptString = constructedPrompt || "";
      const hasProductData = (promptString.includes("Product Information") || promptString.includes("Thông tin sản phẩm")) && !promptString.includes("Chung (Toàn thương hiệu)");

      const systemInstruction = `
You are **MOODBIZ BRAND & PRODUCT AUDITOR**.
Base your auditing on the following skill definition:

${skillContent}

### CURRENT CONTEXT:
- PRODUCT_AUDIT_ENABLED: ${hasProductData ? "YES" : "NO"}
- Platform: ${platform || 'General'}
- Language: ${language || 'Vietnamese'}

JSON Output Only. Summary / Reason in Vietnamese. Suggestion in ${language || 'Vietnamese'}.
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
      errors.push(`Brand / Product Error: ${e.message}`);
    }
    return result;
  })();

  // --- 3. LANGUAGE STREAM (Gemini) ---
  const languagePromise = (async () => {
    const targetLang = language || 'Vietnamese';
    let result = { identified_issues: [] };
    try {
      const gmKey = process.env.GEMINI_API_KEY;
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
                category: { type: SchemaType.STRING },
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

      const skillContent = await loadSkill('audit-linguistic-expert');
      const systemInstruction = `
You are **MOODBIZ LINGUISTIC EXPERT**.
Base your auditing on the following skill definition:

${skillContent}

### ADDITIONAL CONTEXT:
- Target Language: ${targetLang}
- Platform: ${platform || 'General'}

JSON Output Only. Summary / Reason in Vietnamese. Suggestion in original language.
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
      errors.push(`Language Agent Error: ${e.message}`);
    }
    return result;
  })();

  const [logicLegalResult, brandProductResult, languageResult] = await Promise.all([logicLegalPromise, brandProductPromise, languagePromise]);

  // Merge & Deduplicate
  const allIssues = [
    ...(logicLegalResult?.identified_issues || []),
    ...(brandProductResult?.identified_issues || []),
    ...(languageResult?.identified_issues || [])
  ];

  const uniqueIssues = [];
  const seenIssues = new Set();
  for (const issue of allIssues) {
    if (!issue.problematic_text || !issue.suggestion) continue;
    if (issue.problematic_text.trim() === issue.suggestion.trim()) continue;
    const key = `${issue.problematic_text}|${issue.suggestion}`;
    if (!seenIssues.has(key)) {
      uniqueIssues.push(issue);
      seenIssues.add(key);
    }
  }

  const finalResult = {
    summary: [logicLegalResult?.summary, brandProductResult?.summary, languageResult?.summary].filter(s => s?.trim()).join(' | ') || "Hoàn tất kiểm tra.",
    identified_issues: uniqueIssues
  };

  return {
    result: finalResult,
    errors,
    usage: {
      tokensLogic,
      tokensBrand,
      tokensLang,
      totalTokens: tokensLogic + tokensBrand + tokensLang
    }
  };
}
