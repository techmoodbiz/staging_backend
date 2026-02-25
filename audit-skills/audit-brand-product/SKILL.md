---
name: audit-brand-product
description: Chuyên gia thương hiệu và thông số sản phẩm.
tags: [audit, brand, product, marketing]
version: 2
---

# Brand & Product Audit Skill

## Mục tiêu
- **Chế độ Toàn thương hiệu (General)**: Đảm bảo nội dung đúng "chất" thương hiệu (Tone of Voice, Visual Style). KHÔNG kiểm tra thông số sản phẩm cụ thể.
- **Chế độ Sản phẩm (Product)**: Đảm bảo cả "chất" thương hiệu VÀ các thông số kỹ thuật, đặc tính của sản phẩm đó phải chính xác tuyệt đối.

## Quy tắc Audit (MANDATORY)

### 1. Brand Voice & Tone Audit
- Kiểm tra Forbidden words (Từ cấm dùng) — bao gồm cả **biến thể** và **từ đồng nghĩa**.
  → **Ví dụ**: Nếu "giá rẻ" là forbidden word, thì "siêu rẻ", "rẻ bất ngờ" cũng phải bắt.
- Kiểm tra Tone of Voice phải **nhất quán xuyên suốt bài viết**.
  → **Ví dụ lỗi (Tone Drift)**: Mở đầu rất chuyên nghiệp "Kính gửi Quý khách hàng" nhưng kết thúc "Nhanh tay đặt hàng ngay bạn nhé!" → severity: Medium
- Kiểm tra Encouraged Words (Do-Words): nội dung có sử dụng từ ngữ khuyên dùng không?
  → Nếu brand có do-words nhưng bài viết không dùng bất kỳ từ nào → gợi ý nhẹ (severity: Low)

### 2. Brand Personality Consistency
- So sánh toàn bộ giọng văn với Brand Personality được cung cấp.
- **Ví dụ**: Brand Personality = "Chuyên nghiệp, Tin cậy" nhưng bài viết dùng emoji quá nhiều (😍🔥💯) → severity: Medium
- **Ví dụ**: Brand Personality = "Gần gũi, Hài hước" nhưng bài viết quá cứng nhắc, nhiều thuật ngữ chuyên môn → severity: Low

### 3. Product Specifications (CONDITIONAL)
- **QUY TẮC**: CHỈ thực hiện audit sản phẩm nếu PRODUCT_AUDIT_ENABLED = YES.
- **NẾU KHÔNG CÓ THÔNG TIN SẢN PHẨM**: Tuyệt đối KHÔNG báo lỗi về thông số sản phẩm.

#### 3a. Factual Accuracy
- Kiểm tra TỪNG số liệu, thông số kỹ thuật so với Product Info gốc.
- **Ví dụ lỗi**: Product Info nói "pin 5000mAh" nhưng bài viết nói "pin 6000mAh" → severity: High
- **Ví dụ KHÔNG phải lỗi**: Bài viết nói "pin khỏe" mà không nêu số cụ thể → OK (mô tả chung)

#### 3b. USP Consistency
- Kiểm tra xem bài viết có **bóp méo hoặc phóng đại USP** không.
- **Ví dụ lỗi**: USP là "Giao hàng trong 24h nội thành" nhưng bài viết nói "Giao hàng siêu tốc chỉ 1 giờ" → severity: High
- Kiểm tra bài viết có **claim tính năng không tồn tại** trong Product Info → severity: High

#### 3c. Target Audience Match
- Kiểm tra ngôn ngữ, ví dụ, và kịch bản trong bài có phù hợp với Target Audience không.
- **Ví dụ lỗi**: Target Audience = "Doanh nghiệp lớn" nhưng bài viết dùng ngôn ngữ Gen Z → severity: Medium

### 4. Suggestions
- Gợi ý sửa đổi phải bám sát định hướng của thương hiệu.
- Suggestion phải cụ thể: thay vì nói "sửa tone", phải nói "thay 'ĐẸP QUÁ TRỜI' bằng 'Thiết kế tinh tế'".
