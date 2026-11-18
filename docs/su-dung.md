# Từ frame đến bản vẽ đã lưu

## Chạy và theo dõi

1. Mở LandmarkDesk, đăng nhập CVAT và chọn loại job. Tab CVAT và bảng điều khiển dùng chung hồ sơ riêng của ứng dụng. **Mở CVAT** đưa tab editor ra trước.
2. Nhấp số frame để xem chi tiết hoặc **Xem trên CVAT** để mở frame đó trong editor. Ô tích cạnh số frame chỉ chọn phạm vi **chạy lại model**.
3. **Chạy toàn job** xét các frame còn cần xử lý. **Chạy frame đã tích** suy luận lại trên đúng danh sách đã chọn. Mỗi frame có ảnh gốc và kết quả từng lượt. Kiểm tra đúng người lái khi ảnh có nhiều người.
4. Dùng **Tạm dừng** để ngừng nhận frame tiếp theo. Nếu model đang trả lời, yêu cầu đang chạy có thể cần hoàn tất trước. Trong khoảng chờ 429, có thể dừng đếm ngược ngay.
5. Với frame có nhãn cũ, so đề xuất với dữ liệu đang lưu. Khi chấp nhận thay đổi, nhấn **Chọn để phê duyệt**. Sau khi rà hết job, nhấn **Áp dụng lựa chọn sau khi rà hết**, đọc danh sách frame và xác nhận. Hộp xác nhận này cho phép ghi annotation đã chọn.

## Đọc điểm và trạng thái

Trái/phải tính theo **ảnh đang hiển thị**. Điểm có hoành độ nhỏ hơn nằm gần mép trái ảnh hơn. Ví dụ, hai vai nằm ở x=120 và x=310 thì vai x=120 nằm bên trái ảnh. Với ảnh nghiêng, lần theo cả chuỗi chi để kiểm tra đúng bên.

| Trạng thái | Khi dùng | Tọa độ |
| --- | --- | --- |
| Visible | Thấy trực tiếp vị trí khớp hoặc mốc | Pixel trên ảnh gốc |
| Occluded | Bị che nhưng còn đủ dấu hiệu để định vị | Pixel ước lượng trong ảnh |
| Outside | Ngoài khung hoặc thiếu căn cứ để định vị | Để trống cả x và y |

**Pose 17** dùng ID 1 cho chóp mũi. Các cặp 2/3, 4/5, 6/7, 8/9, 10/11, 12/13, 14/15, 16/17 lần lượt là mắt, tai, vai, khuỷu tay, cổ tay, hông, gối, cổ chân. Trong mỗi cặp, ID chẵn ứng với bên phải ảnh. Studio chạy lượt 1 để đặt điểm, lượt 2 để đối chiếu với ảnh gốc và overlay. Khi frame trống có đề xuất người lái, workflow Pose vẽ ngay trong editor và Save. Track hoặc nhiều skeleton cùng nhãn cần kiểm tra thủ công.

**Face 50** kiểm tra mặt người lái qua hai lượt. Mở **Đối chiếu từng điểm** để sửa trạng thái, tọa độ và so với bản gốc. Mặt nghiêng hoặc có kính có thể cần kiểm tra mắt xa và đường môi trong.

| Nhãn skeleton trên CVAT | ID điểm | Hình dạng |
| --- | --- | --- |
| longmaytrai / longmayphai | 0–4 / 5–9 | Đường mở |
| songmui | 10–13 | Đường mở |
| mattrai / matphai | 14–21 / 22–29 | Vòng kín |
| moingoai / moitrong | 30–41 / 42–49 | Vòng kín |

Khi Face đã rà đủ toàn job, các frame trống đủ điều kiện được vẽ và lưu. Frame có pre-label thay đổi cần phê duyệt. **Gợi ý sửa đường viền** hỗ trợ các vòng giao cắt hoặc môi trong nằm ngoài môi ngoài. Kiểm tra lại trên ảnh trước khi xác nhận. Khi job có nhiều người/nhãn trùng hoặc track, mở CVAT để kiểm tra đối tượng.

## Save và Review

- Studio dùng **Draw skeleton → Shape** cho skeleton mới. Trước Save, ứng dụng so trạng thái và điểm trên canvas với dự kiến. Sau Save, ứng dụng đọc lại các điểm, ID và nguồn. Skeleton mới phải được CVAT xác nhận nguồn `manual` cho cả cha và điểm con. LandmarkDesk dùng AI để đề xuất vị trí.
- Sửa shape cũ cần khớp bản gốc. Nếu ai đó đã thay đổi nhãn, rà lại frame để nhận đề xuất mới. Các frame đã xác minh được ghi tiến độ riêng.
- **Review** mở cho dữ liệu đã lưu hoặc khớp bản đã có trên CVAT. Ghi biểu quyết, mã/tham chiếu Issue hoặc comment trên CVAT, kết luận mentor rồi hoàn tất. Bản ghi review lưu cục bộ, người dùng tạo Issue/comment trong CVAT khi cần.
- Cùng một bản đã giải nén giữ lại đăng nhập và lịch sử giữa các lần mở. Muốn đổi server/job, sửa URL trong `.env` rồi khởi động lại. Mở lại URL cũ sẽ đọc lịch sử tương ứng.

## Xử lý sự cố

| Dấu hiệu | Cách xử lý |
| --- | --- |
| Launcher dừng khi tải | Kiểm tra kết nối, quyền ghi thư mục và dòng lỗi trong cửa sổ. Chạy lại cùng launcher. |
| 401 hoặc 403 từ model | Kiểm tra provider, base URL, key và quyền dùng model trong `.env`. Sau khi sửa, khởi động lại. |
| 429 | Studio chờ ít nhất 30 rồi 60 giây hoặc theo Retry-After nếu lâu hơn. Thử lại tối đa hai lần và tiếp tục lượt đang dở. Nếu phải chờ hơn 15 phút, hoặc hết lượt thử, Studio liệt kê frame còn chờ. Khi có hạn mức, chọn lại frame cần chạy. |
| Model trả JSON thiếu điểm | Kiểm tra model nhận được nhiều ảnh và ngân sách đầu ra đủ cho 17 hoặc 50 điểm. |
| Không thấy nút Draw skeleton | Kiểm tra đúng link job, quyền tài khoản, nhãn skeleton và editor CVAT chuẩn. |
| Skeleton trên canvas khác bản đang lưu | So frame, đối tượng, trạng thái đang chỉnh trong editor với bản server. Sau khi xử lý thay đổi đang dở, rà lại đúng frame rồi duyệt. |
| Mới rà vài frame và nút áp dụng bị khóa | Mục **Đã rà** cho biết mức hoàn tất của job. Rà đủ phạm vi và xem các lỗi frame trước khi xác nhận danh sách chờ. |
