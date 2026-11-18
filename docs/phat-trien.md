# Mã nguồn và vận hành

## Các thành phần

| Tệp hoặc thư mục | Vai trò |
| --- | --- |
| `Start-LandmarkDesk.cmd`, `scripts/start.ps1` | Điểm vào Windows, kiểm tra bộ cài, cài Node/Python/Chromium, mở cấu hình lần đầu và chạy studio. |
| `app/config.cjs` | Đọc đúng các biến trong `.env`, phân tích link CVAT, xác định thư mục dữ liệu theo nguồn. Biến môi trường cùng tên được ưu tiên. |
| `app/studio.cjs`, `studio.html`, `studio-ui.js` | Quản lý phiên Chromium, tab editor và bảng điều khiển. Một phiên cho mỗi thư mục ứng dụng. |
| `app/cvat.cjs` | Kết nối job, đọc cấu hình nhãn và dữ liệu frame, chạy worker Python, xử lý thời gian chờ của API. |
| `app/job.cjs`, `face-job.cjs` | Lập danh sách frame, điều phối hai lượt suy luận, lưu tiến độ và xử lý phê duyệt. |
| `app/vision_api.py` | Tạo request theo giao thức đã chọn, gửi ảnh, đọc JSON và phân loại lỗi HTTP. |
| `app/pose.py`, `face.py`, `face50.json` | Quy tắc điểm, ảnh tham chiếu, kiểm tra đầu ra và checkpoint từng frame. |
| `app/native.cjs`, `face-native.cjs`, `review.cjs`, `face-qc.cjs` | Vẽ hoặc sửa trong CVAT, bảo vệ ID và nguồn của shape, xác minh Save, kiểm tra đường viền và lưu đánh giá. |
| `tests/` | Kiểm thử giao thức HTTP, giới hạn job, suy luận hai lượt, bảng điều khiển, quy tắc điểm và điều kiện Save. |

## Luồng dữ liệu

1. Studio kết nối editor bằng URL đã cấu hình, đọc job, metadata và labels qua phiên CVAT của người dùng.
2. Khi được yêu cầu chạy, Studio đọc ảnh frame và ảnh chụp trạng thái annotation. Worker Python gửi nội dung ảnh và hướng dẫn đặt điểm cho model. Dữ liệu trả về được kiểm tra trước khi làm đề xuất.
3. Với shape mới, editor tạo đối tượng qua **Draw skeleton → Shape**. Với shape có sẵn, Studio kiểm tra bản gốc và lựa chọn đã xác nhận. Editor thực hiện Save. Bộ lọc chỉ cho phép request Save phù hợp với máy chủ, job, frame, nhãn và điểm dự kiến.
4. Studio đọc lại dữ liệu trên máy chủ. Một bản lưu bị gián đoạn có thông tin để đối chiếu khi chạy lại. Tab Review sử dụng dữ liệu đã xác minh. Tệp JSON trong thư mục dữ liệu là checkpoint, đề xuất, lựa chọn và biên nhận cục bộ.

## Bộ cài

Bộ cài dùng PowerShell có sẵn trên Windows và giải nén Node.js cùng uv đã khóa phiên bản. Hai tệp nén được đối chiếu SHA-256 trước khi dùng. uv cài CPython và Pillow trong môi trường riêng. npm cài theo `package-lock.json`, rồi Playwright tải bản Chromium tương ứng. Các lần mở sau kiểm tra trạng thái cài đặt và sử dụng lại runtime. Khi chuyển sang máy mới, clone hoặc giải nén bản phát hành vào thư mục mới và chạy launcher để tạo runtime trên máy đó.

Chỉ chuẩn bị môi trường, không mở giao diện, từ thư mục gốc:

```powershell
.\Start-LandmarkDesk.cmd -InstallOnly
```

## Chạy kiểm thử cục bộ

Sau khi cài runtime, chạy trong PowerShell tại gốc repo:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = (Resolve-Path .runtime/browsers).Path
$env:LANDMARK_PYTHON = (Resolve-Path .runtime/venv/Scripts/python.exe).Path
.\.runtime\node-v24.14.0-win-x64\node.exe --test tests/*.test.cjs
& $env:LANDMARK_PYTHON -B -X utf8 -m unittest discover -s tests -p 'test_*.py'
```

Bài tích hợp dùng Chromium headless, ảnh tổng hợp và máy chủ HTTP trên loopback. Bài kiểm tra lưu xác minh cả nguồn của skeleton cha và từng điểm. Các kiểm thử này chạy độc lập với tài khoản CVAT và tài khoản model.

## Đưa lên GitHub

Tạo một repository trống trong tài khoản hoặc tổ chức của bạn. Mở terminal tại thư mục **LandmarkDesk**, kiểm tra `git status` và `git ls-files`, rồi điền remote thật:

```powershell
git remote add origin https://github.com/OWNER/LandmarkDesk.git
git push -u origin main
```

Bản bàn giao có nhánh `main`. Nếu dùng bản tải ZIP từ GitHub, ZIP chỉ chứa nội dung các tệp. Để làm việc tiếp cùng lịch sử commit, dùng `git clone`. Dữ liệu chạy và khóa thật chỉ ở máy sử dụng.
