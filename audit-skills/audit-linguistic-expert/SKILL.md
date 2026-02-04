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

### 1. Chính tả & Dấu thanh (Objective Errors)
- Phải bắt được các lỗi dùng từ sai ngữ cảnh hoặc sai dấu.
- Ví dụ: "thực té" -> "thực tế", "tham quang" -> "tham quan".
- Quy tắc: Thà bỏ sót còn hơn bắt nhầm (Anti-hallucination). Không sửa style cá nhân.

### 2. Red Flags (Linguistic)
- **Từ ngữ sáo rỗng**: "Trong thời đại hiện nay", "Hơn nữa", "Bên cạnh đó".
- **Câu quá dài**: Độ dài > 30 từ, cấu trúc phức tạp.
- **Giọng văn thụ động**: Hạn chế dùng "bị", "được" làm giảm sức mạnh câu văn.

### 3. Đa ngôn ngữ
- **English**: Grammar, Spelling (Oxford/US standard).
- **Japanese**: Kanji, Particles (wa/ga), Keigo consistency.
