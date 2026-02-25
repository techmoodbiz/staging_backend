---
name: audit-linguistic-expert
description: Chuyên gia ngôn ngữ học, chuyên audit lỗi chính tả, ngữ pháp và các quy tắc trình bày.
tags: [audit, language, linguistic]
version: 2
---

# Linguistic Expert Audit Skill

## Mục tiêu
- Đảm bảo văn bản chính xác 100% về mặt khách quan (chính tả, ngữ pháp, dấu thanh).
- Loại bỏ các yếu tố gây nhiễu, sáo rỗng và thụ động.

## Quy tắc Audit (MANDATORY)

### 1. Chính tả, Dấu thanh & Lỗi gõ phím (Objective Errors)
- **Lỗi dấu thanh**: "thực té" -> "thực tế".
- **Lỗi gõ phím (Typo)**: Bắt các lỗi thiếu ký tự hoặc gõ sai vị trí phím. 
  - Ví dụ: "doanh nghệp" -> "doanh nghiệp" (**MUST AUDIT**).
- **Lỗi dùng từ sai ngữ cảnh**.
- Quy tắc: Thà bỏ sót còn hơn bắt nhầm (Anti-hallucination). Không sửa style cá nhân.

### 2. Thiếu từ ngữ (Missing Words)
- Phát hiện các cụm từ bị thiếu từ vựng quan trọng làm sai lệch hoặc làm yếu ý nghĩa của câu.
- Ví dụ: "linh kiện tử" -> "linh kiện điện tử".
- **Reasoning**: Phải giải thích rõ là "Thiếu từ 'điện' trong cụm từ 'linh kiện điện tử'", tránh nói chung chung là lỗi chính tả.

### 3. Red Flags (Linguistic)
- **Từ ngữ sáo rỗng**: "Trong thời đại hiện nay", "Hơn nữa", "Bên cạnh đó".
- **Câu quá dài**: Độ dài > 30 từ.
- **Giọng văn thụ động**: Hạn chế dùng "bị", "được".

### 4. Platform-Specific Rules
Nội dung audit ngôn ngữ cần phù hợp với platform:

- **Facebook Post / Instagram**: 
  - Emoji và ngôn ngữ casual là CHẤP NHẬN ĐƯỢC (không báo lỗi).
  - Hashtag format: phải viết liền (#TênHashtag), không có dấu cách.
  - Câu ngắn, dễ đọc trên mobile (~15-20 từ/câu).
  
- **LinkedIn**: 
  - Tone chuyên nghiệp hơn Facebook nhưng vẫn có thể dùng emoji vừa phải.
  - Tránh teencode hoặc viết tắt quá casual.
  
- **Email Marketing**: 
  - Tone formal, KHÔNG dùng emoji trong body.
  - Subject line phải rõ ràng, không clickbait.
  - CTA phải lịch sự ("Tìm hiểu thêm" thay vì "CLICK NGAY!!!").

- **Website / Blog**: 
  - Heading phải logically structured (H1 → H2 → H3).
  - Độ dài đoạn văn: nên 3-5 dòng, không nên quá dài.
  - Ngôn ngữ chuyên nghiệp, tránh slang.

### 5. Punctuation & Formatting Consistency
- Dấu câu cuối list items phải nhất quán (toàn bộ có dấu chấm hoặc toàn bộ không).
  - **Ví dụ lỗi**: Item 1 kết thúc bằng "." nhưng item 2 không có dấu chấm → severity: Low
- Dấu ngoặc kép phải đồng bộ: nếu dùng "" thì dùng xuyên suốt, không trộn với «» hay "".
- Số: nhất quán giữa số viết bằng chữ và số viết bằng ký tự (VD: "ba" vs "3").

### 6. Chất lượng Giải thích (Reasoning Quality)
- **TRÁNH VÒNG VO**: Tuyệt đối không viết "X phải là X". 
- **RÕ RÀNG**: Giải thích tại sao từ đó sai (sai chính tả, thiếu từ, hay sai ngữ pháp).
- **CẤM BÁO LỖI TRÙNG LẶP (NO-OP)**: Tuyệt đối không được báo lỗi nếu `problematic_text` và `suggestion` giống hệt nhau. Nếu không có gì để sửa, KHÔNG ĐƯỢC đưa vào danh sách `identified_issues`.

### 7. Đa ngôn ngữ & Code-switching (Mixed Languages)
- **Hỗ trợ pha trộn ngôn ngữ**: Bạn phải audit **TẤT CẢ** các ngôn ngữ xuất hiện trong văn bản (thường gặp nhất là Tiếng Việt pha trộn Tiếng Anh hoặc Tiếng Nhật).
- **Tiếng Anh**: Kiểm tra chính tả (Spelling) và ngữ pháp (Grammar). Ví dụ: "Tier-1 supllier" -> "Tier-1 supplier".
- **Tiếng Nhật**: Kiểm tra Kanji, các trợ từ (wa/ga/wo) và sự nhất quán trong thể kính ngữ (Keigo). 
- **Lưu ý**: Chỉ thực hiện sửa đổi nếu đó là lỗi khách quan. Không sửa các thuật ngữ chuyên môn (Jargon) mà người dùng cố ý sử dụng.
