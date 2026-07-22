# Thiết kế đọc Google Docs theo quyền truy cập của tab

**Ngày:** 2026-07-23

**Trạng thái:** Thiết kế đã duyệt; chờ triển khai

**Phạm vi:** Đọc Google Docs dạng https://docs.google.com/document/d/<id>/...
khi người dùng đã mở tài liệu và trình duyệt có quyền xem, bao gồm tài liệu công
khai và tài liệu đăng nhập.

## Tóm tắt

Google Docs là ứng dụng động. Trang tài liệu không có cây article, main,
heading hoặc paragraph để Mozilla Readability trích xuất; editor nằm trong các
iframe và lớp UI nội bộ. Extractor hiện tại vì thế trả null, rồi background
phát lỗi trích xuất chung.

Content script sẽ nhận diện chính xác URL tài liệu và lấy text export của chính
tài liệu đó từ endpoint cùng origin:

    /document/d/<document-id>/export?format=txt

Request dùng quyền xem và cookie hiện có của tab. Text export được chuyển thành
Article và đi qua nguyên pipeline playback hiện có.

## Mục tiêu và ngoài phạm vi

### Mục tiêu

- Đọc mọi Google Docs mà tab hiện tại có quyền xem.
- Giữ Readability và hành vi của mọi URL không phải Google Docs.
- Không đọc DOM editor nội bộ, raw page UI, toolbar, menu hoặc iframe.
- Không gửi nội dung sang readit.dev, Google Drive API hay dịch vụ thứ ba; không
  lưu text export vào extension storage.
- Có lỗi rõ ràng nếu Google không cho export, tài liệu mất quyền xem, response
  không hợp lệ hoặc text rỗng.

### Ngoài phạm vi

- Google Sheets, Slides, Drive files hoặc Docs URL không theo /document/d/<id>.
- Google Drive API, OAuth, token riêng, host permission mới hoặc backend.
- Scrape DOM, canvas hoặc iframe nội bộ Google Docs.
- Bỏ qua quyền xem, hạn chế tải xuống/sao chép/in hoặc kiểm soát truy cập của
  chủ tài liệu.
- Lưu, đồng bộ, tóm tắt hoặc chỉnh sửa tài liệu.

## Kiến trúc

### Google Docs adapter

src/content/google_docs_extractor.ts là adapter duy nhất cho Google Docs. Nó
nhận URL tài liệu hợp lệ, tải/kiểm tra plain text export, rồi trả Article hoặc
failure code có cấu trúc.

Adapter dùng fetch với credentials: same-origin. Content script khởi tạo request
theo origin của trang mà nó được inject; request đến docs.google.com là cùng
origin với tab đã được người dùng yêu cầu đọc. Không thêm host_permissions:
endpoint export cùng origin của active tab hiện có.

### Không fallback sang DOM editor hay Readability

Trong tài liệu thực tế đã kiểm tra, top-level document có 0 article, main,
heading và paragraph; editor nằm trong iframe. Cấu hình content script hiện tại
cũng chỉ inject top frame. Dùng all_frames/match_about_blank để scrape editor sẽ
phụ thuộc DOM không công khai và có nguy cơ đọc toolbar hoặc text sai thứ tự.

Khi URL được nhận diện là Google Docs, export failure là kết quả cuối cùng.
Không thử Readability hay raw UI sau đó. src/content/article_extractor.ts vẫn
là extractor Readability đồng bộ, độc lập cho website thông thường.

## Luồng dữ liệu

1. Người dùng chọn **Đọc trang hiện tại** trên tab Google Docs.
2. Background gửi EXTRACT_ARTICLE tới content script như hiện tại.
3. Content script parse hostname docs.google.com và path
   /document/d/<document-id>/... bằng URL.
4. Với Google Docs hợp lệ, adapter tạo endpoint export từ ID đã parse và fetch
   text với credentials: same-origin.
5. Adapter chỉ nhận response ok, content type plain text và text sau trim
   không rỗng; nó chuẩn hoá CRLF/CR sang LF nhưng giữ paragraph breaks.
6. Adapter tạo Article từ tiêu đề trang hiện có, text export, URL gốc và
   language hiện có của document.
7. Content script trả success; background bắt đầu pipeline playback, offscreen
   TTS, badge và session hiện có mà không có nhánh TTS mới.
8. Với URL khác, content script giữ nguyên extractArticleFromDocument() và
   Readability.

Text Google Docs chỉ cần không rỗng, thay vì buộc qua ngưỡng bài báo 120 ký tự.
Đây là nguồn tài liệu chuyên biệt, nên tài liệu ngắn hợp lệ vẫn phải đọc được.

## Failure contract và UX

Adapter trả error code ổn định googleDocsExportUnavailable khi Google trả status
lỗi, response không phải plain text, request lỗi hoặc text rỗng.

Background giữ code này trong cả error session và CommandResponse.
src/shared/constants.ts thêm key EN/VI hướng dẫn người dùng kiểm tra quyền
xem/tải xuống hoặc dùng văn bản đã chọn/dán. Popup và Side Panel map code từ
cả session lẫn command response sang translation key qua helper hiện có, không
thêm literal UI string.

- Google Docs failure không khởi động TTS.
- Nếu manual text đang đọc, web start thất bại chỉ trả lỗi; không dừng hoặc thay
  thế manual session.
- Không log response body, text export hoặc document ID.

## Thay đổi theo tệp

| Tệp | Thay đổi |
| --- | --- |
| src/content/google_docs_extractor.ts | Parse URL, tạo endpoint export, request/validate text và trả Article hoặc failure code. Fetch dependency được truyền vào để unit test. |
| src/content/content_script.ts | Chọn Google Docs adapter cho EXTRACT_ARTICLE, await kết quả và giữ response contract. |
| src/background/background.ts | Phân biệt Google Docs failure code khi tạo error session và trả command response. |
| src/shared/constants.ts | Thêm translation key EN/VI cho lỗi export Google Docs. |
| src/popup/App.tsx | Map failure code sang translation key. |
| src/sidepanel/App.tsx | Dùng cùng map lỗi cho current-page start. |
| tests/unit/google_docs_extractor.test.ts | Test URL parser, endpoint, validation và normalize text. |
| tests/e2e/reader.spec.ts | Test Google Docs export mock và export failure. |

## Kiểm thử

### Unit

- Nhận diện docs.google.com/document/d/<id>/edit; từ chối hostname, path và
  document ID không hợp lệ.
- Endpoint export chỉ dùng ID đã parse, không nhận URL tự do.
- 200 text/plain có text tạo Article và bảo toàn paragraph breaks.
- 403, lỗi request, content type khác plain text và text rỗng đều trả
  googleDocsExportUnavailable.
- Tài liệu ngắn nhưng không rỗng vẫn hợp lệ.

### End-to-end

- Route mock top-level Google Docs không có article, main hay paragraph;
  route export trả plain text. EXTRACT_ARTICLE phải thành công bằng text export.
- Export 403 trả Google Docs failure, không có Article và không khởi động TTS.
- Popup và Side Panel hiển thị message EN/VI; manual session giữ nguyên khi
  current-page start thất bại.
- Existing normal-article và navigation-only tests tiếp tục pass.

### Verification sau triển khai

Chạy tuần tự: unit tests, pnpm build, targeted Playwright, E2E liên quan và
git diff --check. Playwright dùng route mock, không phụ thuộc Google Docs thật,
tài khoản Google hoặc network bên ngoài.

## Tiêu chí chấp nhận

- Link Google Docs đã báo cáo đọc được khi tab có quyền export text.
- Nội dung đọc là text export, không phải menu, toolbar hoặc raw UI.
- Export failure có hướng dẫn, không tạo audio và không rò rỉ nội dung.
- Website khác vẫn dùng Readability như trước.
- Không có quyền manifest mới, backend/OAuth, persisted document content hoặc
  telemetry.
