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

### 2. Phân loại & Ưu tiên (Priority)
- **Legal Rule (Ưu tiên Cao nhất)**: Các vi phạm về pháp lý, y tế, hoặc quy định nhà nước.
- **Mark Rule (Logic)**: Các vi phạm về logic lập luận, SOP nội bộ.
- **QUY TẮC ƯU TIÊN**: Nếu một đoạn văn vi phạm cả quy tắc Legal và Logic, **CHỈ ĐƯỢC báo cáo là lỗi Legal**. Không được báo trùng lặp lỗi.
- **Severity**: 
  - **High**: Mặc định cho mọi lỗi Legal.
  - **Medium/Low**: Cho các lỗi Logic/SOP tùy mức độ.

### 3. Chính xác (Precision)
- Không được bịa đặt lỗi nếu không tìm thấy quy tắc tương ứng trong SOP.
