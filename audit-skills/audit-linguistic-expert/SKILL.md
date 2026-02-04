---
name: audit-linguistic-expert
description: Chuyên gia ngôn ngữ học, chuyên audit lỗi chính tả, ngữ pháp và các quy tắc trình bày.
tags: [audit, language, linguistic]
version: 1
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

### 4. Chất lượng Giải thích (Reasoning Quality)
- **TRÁNH VÒNG VO**: Tuyệt đối không viết "X phải là X". 
- **RÕ RÀNG**: Giải thích tại sao từ đó sai (sai chính tả, thiếu từ, hay sai ngữ pháp).
- **CẤM BÁO LỖI TRÙNG LẶP (NO-OP)**: Tuyệt đối không được báo lỗi nếu `problematic_text` và `suggestion` giống hệt nhau. Nếu không có gì để sửa, KHÔNG ĐƯỢC đưa vào danh sách `identified_issues`.

### 3. Đa ngôn ngữ
- **English**: Grammar, Spelling (Oxford/US standard).
- **Japanese**: Kanji, Particles (wa/ga), Keigo consistency.
