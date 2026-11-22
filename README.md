# KAI TỒ REVIEW AI – Video Translator Studio

Website hỗ trợ Việt hóa video tiếng Trung chạy trực tiếp trên trình duyệt (HTML5, CSS3, JavaScript ES Modules, WebGPU, WebAssembly), tương thích GitHub Pages.

## Lưu ý khi chạy trên máy tính (Local)
Vì dự án dùng JavaScript Modules (`type="module"`), **không bấm đúp trực tiếp vào `index.html`** (trình duyệt sẽ chặn vì chính sách CORS của giao thức `file://`).
Hãy chạy bằng 1 trong 2 cách:
1. Dùng tiện ích **Live Server** trên VS Code → Chuột phải `index.html` → **Open with Live Server**.
2. Hoặc mở terminal tại thư mục dự án và gõ: `npx serve .`

## Cách đưa lên GitHub Pages (Miễn phí)
1. Tạo repository mới trên GitHub tên `KAI-TO-REVIEW-AI` (chế độ **Public**).
2. Tải toàn bộ cấu trúc thư mục (`index.html`, `style.css`, `script.js`, `modules/video.js`, `README.md`) lên nhánh `main`.
3. Vào mục **Settings** → **Pages**.
4. Tại phần **Build and deployment**:
   - Source: chọn **Deploy from a branch**.
   - Branch: chọn **main** và thư mục **`/ (root)`** → bấm **Save**.
5. Chờ 1–2 phút, truy cập đường dẫn `https://<ten-github>.github.io/KAI-TO-REVIEW-AI/` để kiểm tra.
