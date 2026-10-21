import type { LanguagePack } from "./types.js";

export const vietnamese: LanguagePack = {
  code: "vi",
  stopwords: `
    à ạ anh bạn bị các cho chúng có còn của cũng đã đang để đến đó được gì hay khi không là lại lần
    mà mình một này nào nên nếu nhé như những ở ra rất rồi sẽ ta theo thế thì tôi trong trước và vào
    vì với chưa quá thật sự đúng đủ về vậy nữa luôn thôi đây kia`,
  taskWords: `
    chuỗi mảng kèm cần muốn đề xuất ngắn gọn gạch đầu dòng ví dụ
    cách giúp lại làm lần nhớ sao trước tối ưu giao diện đẹp tách nhỏ hơn thành
    sửa thêm viết kiểm tra giải thích tạo lỗi xem chạy đoạn hàm file gì vậy cái đi nhé
    dựa ngữ cảnh dùng trả lời câu biết chỉ bạn hãy nói
    nhận xét đánh giá góp ý gửi`,
  passwordWords: ["mật khẩu", "mat khau"],
  loginWords: ["tài khoản", "đăng nhập"],
  // Not "quyết" alone: it is also half of "giải quyết" (solve).
  decisionWords: [
    "chốt",
    "quyết định",
    "thống nhất",
    "đã chọn",
    "chọn phương án",
    "theo phương án",
    "đi theo hướng",
    "đồng ý",
    "duyệt",
    "làm luôn",
    "cứ làm",
    "triển khai đi",
  ],
  // Not "không phải" alone: it is the everyday "is not".
  correctionWords: [
    "sai",
    "nhầm",
    "lộn",
    "đính chính",
    "chưa đúng",
    "không đúng",
    "ko đúng",
    "thực ra",
    "à không",
    "ý tôi là",
    "không phải vậy",
    "không phải thế",
  ],
};
