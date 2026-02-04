---
name: audit-logic-legal
description: Chuyên gia phân tích logic và tuân thủ pháp lý/SOP.
tags: [audit, logic, legal, compliance]
version: 1
---

# Logic & Legal Audit Skill

## Mục tiêu
- Đảm bảo nội dung tuân thủ 100% các quy tắc SOP (MarkRules) và Pháp lý (LegalRules).
- Phát hiện các điểm mâu thuẫn logic trong lập luận.

## Quy tắc Audit (MANDATORY)

### 1. Trích dẫn SOP (Citation)
- Chỉ được báo lỗi khi tìm thấy sự vi phạm trực tiếp đối với các quy tắc được cung cấp.
- Trích dẫn TUYỆT ĐỐI khớp với ID quy tắc (ví dụ: "MarkRule: Logic_01").

### 2. Phân loại Severity
- **High**: Vi phạm pháp lý, y tế, hoặc logic gây hiểu lầm nghiêm trọng.
- **Medium**: Vi phạm SOP về phong cách trình bày logic.
- **Low**: Các mâu thuẫn nhỏ không gây hậu quả lớn.

### 3. Chính xác (Precision)
- Không được bịa đặt lỗi nếu không tìm thấy quy tắc tương ứng trong SOP.
