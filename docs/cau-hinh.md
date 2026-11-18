# Cấu hình kết nối

Mở `.env` ở cùng cấp với `Start-LandmarkDesk.cmd`. Mỗi dòng chứa một biến. Nếu thay đổi khi LandmarkDesk đang chạy, lưu công việc, đóng cửa sổ Chromium của LandmarkDesk và mở lại launcher để nạp cấu hình.

## OpenAI-compatible

```dotenv
AI_PROVIDER=openai
AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=
AI_MODEL=
AI_MAX_TOKENS=
CVAT_POSE_URL=https://cvat.example.org/tasks/12/jobs/34
CVAT_FACE_URL=
```

Điền key và ID model mà tài khoản của bạn có quyền dùng. Có thể thay base URL bằng gateway hỗ trợ **Chat Completions đa phương thức**. LandmarkDesk nối thêm `/chat/completions`, dùng Bearer token và gửi ảnh PNG trong các khối `image_url`. Model cần nhận nhiều ảnh trong một yêu cầu và trả về JSON dạng văn bản. Khi để trống ngân sách đầu ra, gateway dùng mặc định. Nếu điền `AI_MAX_TOKENS`, gateway phải hỗ trợ trường `max_completion_tokens`.

## Anthropic Messages

```dotenv
AI_PROVIDER=anthropic
AI_BASE_URL=https://api.anthropic.com/v1
AI_API_KEY=
AI_MODEL=
AI_MAX_TOKENS=8192
CVAT_POSE_URL=
CVAT_FACE_URL=https://cvat.example.org/tasks/18/jobs/63
```

LandmarkDesk nối thêm `/messages`, gửi header `x-api-key`, `anthropic-version` và ảnh PNG base64 trong các khối `image`. Chọn tên model vision đúng theo tài khoản. `AI_MAX_TOKENS` là số nguyên dương, mặc định 8192 cho Messages. Kết quả bị cắt giữa JSON sẽ báo lỗi đầu ra.

## Chọn job CVAT

- Sao chép URL từ **editor của job**, dạng `https://máy-chủ/tasks/<task>/jobs/<job>`. Link có `?frame=…` cũng dùng được. Studio lấy danh sách frame từ job sau khi đăng nhập.
- Điền một hoặc cả hai biến URL. `CVAT_POSE_URL` dành cho job có một nhãn skeleton `person` hoặc `person_vf17`, gồm các nhãn con kiểu points có tên số **1–17**. `CVAT_FACE_URL` dành cho job có bảy nhãn đúng quy cách trong hướng dẫn sử dụng.
- Hai job có thể ở hai máy chủ khác nhau. Kết quả cục bộ được tách theo địa chỉ máy chủ, task, job và loại tác vụ.
- Cần tài khoản CVAT có quyền đọc job và lưu annotation. Đăng nhập trong Chromium của LandmarkDesk. Thông tin đăng nhập CVAT thuộc hồ sơ trình duyệt. Key của model thuộc `.env`.
- Endpoint model dùng HTTPS. Gateway chạy trên chính máy tính có thể dùng HTTP ở `localhost`, `127.0.0.1` hoặc `[::1]`. Đặt đường dẫn base trước phần `/messages` hoặc `/chat/completions`.
- Mỗi lượt suy luận gửi ảnh gốc, ảnh tăng tương phản và khi cần cả overlay hoặc ảnh crop đến endpoint bạn chọn. Chọn dịch vụ được phép xử lý ảnh của job. Chi phí và giới hạn phụ thuộc tài khoản API của bạn.

Khi chia sẻ dự án, đưa `.env.example` lên GitHub. Mỗi máy tự tạo `.env` và nhập thông tin riêng.
