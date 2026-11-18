# LandmarkDesk

LandmarkDesk giúp gán nhãn **người lái xe** trên CVAT. Bảng điều khiển hỗ trợ skeleton 17 khớp cơ thể và 50 điểm khuôn mặt. Model thị giác nhận ảnh qua API, đề xuất tọa độ theo hai lượt, sau đó LandmarkDesk vẽ trong editor CVAT và đối chiếu kết quả sau Save.

## Bắt đầu trên Windows

1. Tải **Code → Download ZIP** từ GitHub, giải nén toàn bộ vào một thư mục bạn có quyền ghi, hoặc dùng `git clone`. Bộ cài dành cho **Windows 10/11 x64**, cần Internet trong lần đầu.
2. Nhấp đúp **Start-LandmarkDesk.cmd**. Launcher cài Node.js, Python, Pillow, Playwright và Chromium vào thư mục dự án. Giữ cửa sổ launcher mở trong lúc làm việc.
3. Lần đầu, launcher tạo `.env` từ `.env.example` và mở trình soạn thảo. Điền **API key**, **tên model có khả năng đọc ảnh**, **base URL** và ít nhất một **link job CVAT**. Lưu rồi đóng trình soạn thảo để tiếp tục. [Ví dụ cấu hình cho cả hai nhà cung cấp](docs/cau-hinh.md)
4. Đăng nhập trong tab CVAT của LandmarkDesk. Chờ trạng thái **Đã kết nối**, chọn một frame, tích ô bên cạnh rồi bấm **Chạy frame đã tích**. Nếu đã điền hai job, chọn Pose hoặc Face trên thanh đầu trang.
5. Những lần sau mở cùng tệp `.cmd`. Launcher dùng lại môi trường và hồ sơ Chromium riêng của bản sao. CVAT có thể yêu cầu đăng nhập lại khi phiên hết hạn.

## Chức năng

| Nhu cầu | Thao tác |
| --- | --- |
| Xử lý một số ảnh hoặc cả job | Tích các frame rồi chạy, hoặc chọn **Chạy toàn job**. Phạm vi frame lấy từ CVAT. |
| Kiểm tra từng khớp, từng contour | Mở **Vẽ và phê duyệt** để so ảnh gốc, đề xuất, sai lệch với nhãn hiện có và điểm dự kiến lưu. |
| Sửa vị trí hoặc đổi bên | Chỉnh tọa độ, trạng thái, dùng **Đổi trái ↔ phải** với nhóm cần sửa, rồi kiểm tra ảnh xem trước. |
| Duyệt thay đổi trên nhãn có sẵn | **Chọn để phê duyệt** đưa frame vào hàng chờ cục bộ. Sau khi rà hết job, kiểm tra danh sách và xác nhận lưu. |
| Đánh giá bản đã lưu | Tab **Review** ghi biểu quyết, tham chiếu Issue/comment trên CVAT và kết luận mentor. |
| Tiếp tục sau HTTP 429 | Bảng hiển thị thời gian chờ. Studio thử lại đúng frame và tận dụng lượt đầu đã xong. |

Việc tạo skeleton và Save diễn ra trong editor. LandmarkDesk đọc lại annotation từ máy chủ trước khi hiển thị **Đã lưu CVAT**. Dự án không dùng chức năng Import/Export của CVAT.

## Tài liệu

- [Cấu hình model, khóa API và link job](docs/cau-hinh.md)
- [Quy trình Pose, Face, phê duyệt và xử lý sự cố](docs/su-dung.md)
- [Cấu trúc mã nguồn, kiểm thử và đưa repo lên GitHub](docs/phat-trien.md)

Ảnh, đề xuất, kết quả review và hồ sơ trình duyệt nằm trong `.local/`. Môi trường chạy nằm trong `.runtime/` và `node_modules/`. Git bỏ qua các thư mục này và `.env`. Model nhận ảnh job khi bạn chủ động chạy suy luận.
