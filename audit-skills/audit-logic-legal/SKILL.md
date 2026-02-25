---
name: audit-logic-legal
description: Chuyên gia phân tích logic và tuân thủ pháp lý/SOP.
tags: [audit, logic, legal, compliance]
version: 2
---

# Logic & Legal Audit Skill

## Mục tiêu
- Đảm bảo nội dung tuân thủ 100% các quy tắc SOP (MarkRules) và Pháp lý (LegalRules).
- Phát hiện các điểm mâu thuẫn logic trong lập luận.
- Bảo vệ thương hiệu khỏi rủi ro pháp lý trong quảng cáo.

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

### 4. LEGAL RED FLAGS — Checklist Quảng cáo Việt Nam
Tự động kiểm tra các vi phạm phổ biến dưới đây **NGAY CẢ KHI KHÔNG CÓ LegalRule cụ thể**:

- **Từ ngữ so sánh bậc nhất (Superlatives)**: "tốt nhất", "số 1", "duy nhất", "hàng đầu", "đỉnh nhất", "the best", "number one". 
  → Vi phạm Điều 8 Luật Quảng cáo 2012 nếu không có chứng cứ xác thực từ bên thứ 3.
  → **Ví dụ lỗi**: "Đây là phần mềm tốt nhất hiện nay" → severity: High
  → **Ví dụ KHÔNG phải lỗi**: "Một trong những phần mềm tốt nhất" (có qualifier "một trong những")

- **Cam kết hiệu quả tuyệt đối**: "đảm bảo 100%", "chắc chắn thành công", "không bao giờ thất bại".
  → Vi phạm nếu không có bằng chứng khoa học.

- **Tuyên bố y tế/sức khỏe**: "chữa bệnh", "điều trị", "khỏi hẳn", "thay thế thuốc".
  → Vi phạm Luật Dược nếu sản phẩm không phải là thuốc được cấp phép.

- **So sánh trực tiếp đối thủ**: Nêu tên đối thủ cụ thể để hạ thấp.
  → Vi phạm Luật Cạnh tranh.

### 5. Mâu thuẫn Nội bộ (Internal Contradictions)
Phát hiện khi **2 đoạn trong cùng 1 văn bản nói ngược nhau**:
- **Ví dụ lỗi**: Đoạn 1 nói "miễn phí hoàn toàn" nhưng đoạn 2 nói "chỉ từ 99k/tháng".
- **Ví dụ lỗi**: Tiêu đề nói "Top 10" nhưng nội dung liệt kê 29 mục.
- **Cách audit**: Đọc toàn bộ văn bản trước, ghi nhận các tuyên bố quan trọng, sau đó kiểm tra chéo.

### 6. Hallucination Detection
Phát hiện khi AI tạo ra thông tin **không có cơ sở** trong dữ liệu gốc:
- Số liệu thống kê cụ thể không có nguồn (VD: "theo nghiên cứu của Harvard..." mà không ai yêu cầu)
- Trích dẫn giả (fake citations)
- Thêm tính năng sản phẩm không có trong Product Info
