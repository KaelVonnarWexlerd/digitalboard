# Digital Board

靜態版 PDF 電子白板網站，依照 `design.md` 與 `skill.md` 規格建立。

## 使用方式

直接開啟 `index.html`，上傳 PDF 後即可進入全螢幕註記模式。

## 已完成

- PDF 上傳與 PDF.js 頁面渲染，載入後自動符合可用螢幕寬度
- 每頁 PDF canvas 與 annotation canvas 分層
- 左右圓形工具列與收合控制
- 筆、螢光筆、橡皮擦
- 36 色預設色、36 個自訂色、360 hue 色盤與色碼輸入
- 清除目前頁註記
- 線條、箭頭、平面圖形、立體簡圖、表格
- Undo / Redo
- 矩形放大區域選取、獨立放大白板頁、儲存標記點、刪除放大頁
- localStorage 本機暫存與 JSON 匯入 / 匯出
- 基本觸控與 Pointer Events 支援

## 主要檔案

- `index.html`
- `css/style.css`
- `js/app.js`

## 外部資源

此版本以 CDN 載入：

- jQuery
- PDF.js
- Lucide icons
