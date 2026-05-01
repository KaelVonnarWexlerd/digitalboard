(() => {
  "use strict";

  const STORAGE_KEY = "digitalBoardState:v1";
  const MIN_ZOOM = 0.55;
  const MAX_ZOOM = 2.5;
  const PDFJS_VERSION = "4.10.38";
  const PDFJS_CDN = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`;
  const PDFIUM_VERSION = "2.14.1";
  const PDFIUM_MODULE_URL = `https://cdn.jsdelivr.net/npm/@embedpdf/pdfium@${PDFIUM_VERSION}/+esm`;
  const PDFIUM_WASM_URL = `https://cdn.jsdelivr.net/npm/@embedpdf/pdfium@${PDFIUM_VERSION}/dist/pdfium.wasm`;
  const PDFIUM_RENDER_FLAGS = 16 | 1;

  const presetColors = [
    "#000000", "#444444", "#888888", "#CCCCCC", "#FFFFFF", "#FF0000",
    "#FF7F00", "#FFFF00", "#7FFF00", "#00FF00", "#00FF7F", "#00FFFF",
    "#007FFF", "#0000FF", "#7F00FF", "#FF00FF", "#FF007F", "#8B4513",
    "#FFC0CB", "#FFD700", "#ADFF2F", "#40E0D0", "#1E90FF", "#9370DB",
    "#DC143C", "#FF6347", "#FFA500", "#32CD32", "#20B2AA", "#4169E1",
    "#8A2BE2", "#C71585", "#A52A2A", "#708090", "#2F4F4F", "#F5F5DC"
  ];

  const shapeGroups = {
    line: [
      { type: "line", label: "直線" },
      { type: "arrow", label: "箭頭" },
      { type: "doubleArrow", label: "雙箭頭" },
      { type: "dashedLine", label: "虛線" },
      { type: "curve", label: "曲線" }
    ],
    flat: [
      { type: "circle", label: "圓形" },
      { type: "ellipse", label: "橢圓" },
      { type: "square", label: "正方形" },
      { type: "rectangle", label: "長方形" },
      { type: "triangle", label: "三角形" },
      { type: "polygon", label: "多邊形" }
    ],
    solid: [
      { type: "cube", label: "立方體" },
      { type: "cuboid", label: "長方體" },
      { type: "cylinder", label: "圓柱" },
      { type: "cone", label: "圓錐" },
      { type: "sphere", label: "球體" }
    ],
    table: [
      { type: "table2", label: "2 x 2" },
      { type: "table3", label: "3 x 3" },
      { type: "table4", label: "4 x 4" },
      { type: "tableCustom", label: "自訂表格" }
    ]
  };

  let pdfDocument = null;
  let pdfiumInstance = null;
  let pdfiumLoadPromise = null;
  let pdfjsLib = null;
  let pdfjsLoadPromise = null;
  let renderToken = 0;
  let pendingImportData = null;
  let dirty = false;

  const boardState = {
    fileName: "",
    currentTool: "cursor",
    currentPage: 1,
    scale: 1,
    mode: "pdf",
    activeZoomPageId: null,
    pen: { size: 4, opacity: 1, color: "#000000" },
    highlighter: { size: 18, opacity: 0.35, color: "#FFFF00" },
    eraser: { size: 24 },
    lasso: { mode: "rect" },
    shape: {
      group: "line",
      type: "line",
      strokeWidth: 3,
      color: "#00AEEF",
      opacity: 1,
      fillColor: "#FFFFFF",
      fillOpacity: 0,
      polygonSides: 6,
      startMarker: "none",
      endMarker: "none",
      rows: 3,
      cols: 3
    },
    customColors: {
      pen: new Array(36).fill(null),
      highlighter: new Array(36).fill(null),
      shape: new Array(36).fill(null),
      shapeFill: new Array(36).fill(null)
    },
    pages: {},
    zoomPages: {},
    history: {}
  };

  const Utils = {
    clone(value) {
      return JSON.parse(JSON.stringify(value));
    },

    id(prefix) {
      return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    },

    clamp(value, min, max) {
      return Math.min(max, Math.max(min, value));
    },

    normalizeHex(value) {
      if (!value) return null;
      let color = String(value).trim();
      if (!color.startsWith("#")) color = `#${color}`;
      if (/^#[0-9a-fA-F]{3}$/.test(color)) {
        color = `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`;
      }
      return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toUpperCase() : null;
    },

    targetKey(target) {
      return target.kind === "zoom" ? `zoom_${target.id}` : `page_${target.page}`;
    },

    getPage(pageNumber) {
      const pageKey = String(pageNumber);
      if (!boardState.pages[pageKey]) {
        boardState.pages[pageKey] = { annotations: [], zoomMarkers: [] };
      }
      return boardState.pages[pageKey];
    },

    getAnnotations(target) {
      if (target.kind === "zoom") {
        const zoomPage = boardState.zoomPages[target.id];
        if (!zoomPage) return [];
        if (!Array.isArray(zoomPage.annotations)) zoomPage.annotations = [];
        return zoomPage.annotations;
      }
      return this.getPage(target.page).annotations;
    },

    ensureHistory(target) {
      const key = this.targetKey(target);
      if (!boardState.history[key]) {
        boardState.history[key] = { undoStack: [], redoStack: [] };
      }
      return boardState.history[key];
    },

    activeTarget() {
      if (boardState.mode === "zoom" && boardState.activeZoomPageId) {
        return { kind: "zoom", id: boardState.activeZoomPageId };
      }
      return { kind: "page", page: boardState.currentPage || 1 };
    },

    isTypingTarget(event) {
      const tag = event.target && event.target.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || event.target.isContentEditable;
    },

    resetForFile(fileName) {
      boardState.fileName = fileName;
      boardState.currentTool = "cursor";
      boardState.currentPage = 1;
      boardState.scale = 1;
      boardState.mode = "pdf";
      boardState.activeZoomPageId = null;
      boardState.pages = {};
      boardState.zoomPages = {};
      boardState.history = {};
      dirty = false;
    }
  };

  class PDFiumDocumentAdapter {
    static open(pdfium, arrayBuffer) {
      const pdfData = new Uint8Array(arrayBuffer);
      const filePtr = pdfium.pdfium.wasmExports.malloc(pdfData.length);
      pdfium.pdfium.HEAPU8.set(pdfData, filePtr);

      const docPtr = pdfium.FPDF_LoadMemDocument(filePtr, pdfData.length, 0);
      if (!docPtr) {
        const errorCode = pdfium.FPDF_GetLastError();
        pdfium.pdfium.wasmExports.free(filePtr);
        throw new Error(`PDFium failed to load document: ${PDFiumDocumentAdapter.describeError(errorCode)}`);
      }

      const pageCount = pdfium.FPDF_GetPageCount(docPtr);
      return new PDFiumDocumentAdapter(pdfium, docPtr, filePtr, pageCount);
    }

    static describeError(errorCode) {
      const errors = {
        1: "unknown error",
        2: "file not found",
        3: "format error",
        4: "password required",
        5: "security handler error",
        6: "page not found"
      };
      return errors[errorCode] || `error ${errorCode}`;
    }

    constructor(pdfium, docPtr, filePtr, pageCount) {
      this.engine = "pdfium";
      this.pdfium = pdfium;
      this.docPtr = docPtr;
      this.filePtr = filePtr;
      this.numPages = pageCount;
      this.pageCache = new Map();
      this.closed = false;
    }

    async getPage(pageNumber) {
      if (this.closed) throw new Error("PDF document has been closed");
      const index = Number(pageNumber) - 1;
      if (index < 0 || index >= this.numPages) throw new Error(`Invalid page number: ${pageNumber}`);
      if (this.pageCache.has(pageNumber)) return this.pageCache.get(pageNumber);

      const pagePtr = this.pdfium.FPDF_LoadPage(this.docPtr, index);
      if (!pagePtr) {
        throw new Error(`PDFium failed to load page ${pageNumber}`);
      }

      try {
        const width = this.pdfium.FPDF_GetPageWidthF(pagePtr);
        const height = this.pdfium.FPDF_GetPageHeightF(pagePtr);
        const page = new PDFiumPageAdapter(this, pageNumber, index, width, height);
        this.pageCache.set(pageNumber, page);
        return page;
      } finally {
        this.pdfium.FPDF_ClosePage(pagePtr);
      }
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      this.pageCache.clear();
      this.pdfium.FPDF_CloseDocument(this.docPtr);
      this.pdfium.pdfium.wasmExports.free(this.filePtr);
    }

    destroy() {
      this.close();
      return Promise.resolve();
    }
  }

  class PDFiumPageAdapter {
    constructor(documentAdapter, pageNumber, pageIndex, width, height) {
      this.documentAdapter = documentAdapter;
      this.pageNumber = pageNumber;
      this.pageIndex = pageIndex;
      this.width = width;
      this.height = height;
    }

    getViewport(options = {}) {
      const scale = Number(options.scale) || 1;
      return {
        width: this.width * scale,
        height: this.height * scale,
        scale
      };
    }

    render({ canvasContext, viewport }) {
      return {
        promise: this.renderToCanvas(canvasContext, viewport)
      };
    }

    async renderToCanvas(canvasContext, viewport) {
      const documentAdapter = this.documentAdapter;
      const pdfium = documentAdapter.pdfium;
      const pagePtr = pdfium.FPDF_LoadPage(documentAdapter.docPtr, this.pageIndex);
      if (!pagePtr) throw new Error(`PDFium failed to render page ${this.pageNumber}`);

      const width = Math.max(1, Math.floor(viewport.width));
      const height = Math.max(1, Math.ceil(viewport.height));
      const canvas = canvasContext.canvas;
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;

      const bitmapPtr = pdfium.FPDFBitmap_Create(width, height, 0);
      if (!bitmapPtr) {
        pdfium.FPDF_ClosePage(pagePtr);
        throw new Error("PDFium failed to create render bitmap");
      }

      try {
        pdfium.FPDFBitmap_FillRect(bitmapPtr, 0, 0, width, height, 0xFFFFFFFF);
        pdfium.FPDF_RenderPageBitmap(bitmapPtr, pagePtr, 0, 0, width, height, 0, PDFIUM_RENDER_FLAGS);

        const bufferPtr = pdfium.FPDFBitmap_GetBuffer(bitmapPtr);
        if (!bufferPtr) throw new Error("PDFium failed to read render bitmap");

        const bufferSize = width * height * 4;
        const buffer = new Uint8Array(
          pdfium.pdfium.HEAPU8.buffer,
          pdfium.pdfium.HEAPU8.byteOffset + bufferPtr,
          bufferSize
        ).slice();
        const imageData = new ImageData(new Uint8ClampedArray(buffer.buffer), width, height);
        canvasContext.putImageData(imageData, 0, 0);
      } finally {
        pdfium.FPDFBitmap_Destroy(bitmapPtr);
        pdfium.FPDF_ClosePage(pagePtr);
      }
    }
  }

  const UI = {
    init() {
      this.refreshIcons();
      $(window).on("beforeunload", (event) => {
        if (!dirty) return undefined;
        event.preventDefault();
        event.returnValue = "";
        return "";
      });
      $("#pageJumpInput").on("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        PDFViewer.goToPage(event.currentTarget.value);
        event.currentTarget.blur();
      });
      $("#pageJumpInput").on("change", (event) => PDFViewer.goToPage(event.currentTarget.value));
      $("#hideTopBar").on("click", () => this.setTopBarHidden(true));
      $("#showTopBar").on("click", () => this.setTopBarHidden(false));
    },

    refreshIcons() {
      if (window.lucide) {
        window.lucide.createIcons();
      }
    },

    showBoard() {
      $("body").addClass("is-board");
      $("#boardScreen").addClass("active").removeClass("zoom-active");
      $("#zoomScreen").removeClass("active");
      $("#pdfBoard").removeClass("hidden");
      this.updateStatus();
    },

    showHome() {
      $("body").removeClass("is-board");
      $("#boardScreen").removeClass("active");
    },

    updateStatus() {
      const pageCount = pdfDocument ? pdfDocument.numPages : 0;
      $("#fileName").text(boardState.fileName || "尚未開啟 PDF");
      const pageInput = $("#pageJumpInput")[0];
      if (pageInput) {
        pageInput.max = String(Math.max(1, pageCount));
        pageInput.disabled = pageCount === 0;
        if (document.activeElement !== pageInput) {
          pageInput.value = String(boardState.currentPage || 1);
        }
      }
      $("#pageTotal").text(`/ ${pageCount}`);
      $("#zoomIndicator").text(`${Math.round(boardState.scale * 100)}%`);

      if (boardState.mode === "zoom") {
        const zoomPage = boardState.zoomPages[boardState.activeZoomPageId];
        const pageText = zoomPage ? `Zoom Board: Page ${zoomPage.sourcePage}` : "Zoom Board";
        $("#modeIndicator").text(pageText);
      } else {
        $("#modeIndicator").text("PDF Board");
      }
    },

    setTopBarHidden(hidden) {
      $("#boardScreen").toggleClass("top-bar-hidden", hidden);
      $("#showTopBar").toggleClass("hidden", !hidden);
      window.setTimeout(() => {
        ToolManager.updateEdgeSliders();
        LassoManager.renderSelection();
      }, 200);
    },

    markDirty() {
      dirty = true;
      $("#saveStatus").text("未儲存變更");
      StorageManager.autosave();
    },

    markSaved(label = "已儲存") {
      dirty = false;
      $("#saveStatus").text(label);
    },

    toast(message, type = "success") {
      const $toast = $("<div>", { class: `toast ${type}`, text: message });
      $("#toastContainer").append($toast);
      window.setTimeout(() => {
        $toast.fadeOut(160, () => $toast.remove());
      }, 2600);
    },

    confirm(message, options = {}) {
      return new Promise((resolve) => {
        const confirmText = options.confirmText || "確定";
        const cancelText = options.cancelText || "取消";
        const danger = options.danger !== false;
        const overlay = document.createElement("div");
        overlay.className = "confirm-overlay";
        overlay.innerHTML = `
          <div class="confirm-dialog" role="dialog" aria-modal="true" aria-label="確認">
            <p>${message}</p>
            <div class="confirm-actions">
              <button class="confirm-cancel" type="button">${cancelText}</button>
              <button class="confirm-ok${danger ? " danger" : ""}" type="button">${confirmText}</button>
            </div>
          </div>
        `;

        const cleanup = (result) => {
          document.removeEventListener("keydown", onKeydown);
          overlay.remove();
          resolve(result);
        };

        const onKeydown = (event) => {
          if (event.key === "Escape") cleanup(false);
          if (event.key === "Enter") cleanup(true);
        };

        overlay.querySelector(".confirm-cancel").addEventListener("click", () => cleanup(false));
        overlay.querySelector(".confirm-ok").addEventListener("click", () => cleanup(true));
        overlay.addEventListener("click", (event) => {
          if (event.target === overlay) cleanup(false);
        });
        document.addEventListener("keydown", onKeydown);
        document.body.appendChild(overlay);
        overlay.querySelector(".confirm-cancel").focus();
      });
    }
  };

  const PDFViewer = {
    resizeTimer: null,
    scrollSyncFrame: 0,
    documentFitWidth: 0,
    pageRenderObserver: null,
    pageRenderQueue: [],
    queuedPages: new Set(),
    renderQueueActive: false,
    renderQueueGeneration: 0,

    init() {
      $("#pdfUpload").on("change", (event) => {
        const file = event.target.files && event.target.files[0];
        if (file) this.handleFile(file);
        event.target.value = "";
      });

      $("#uploadBox")
        .on("click", (event) => {
          if (event.target && event.target.id === "pdfUpload") return;
          $("#pdfUpload")[0].click();
        })
        .on("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          $("#pdfUpload")[0].click();
        })
        .on("dragover", (event) => {
          event.preventDefault();
          $("#uploadBox").addClass("drag-over");
        })
        .on("dragleave drop", (event) => {
          event.preventDefault();
          $("#uploadBox").removeClass("drag-over");
        })
        .on("drop", (event) => {
          const file = event.originalEvent.dataTransfer.files[0];
          if (file) this.handleFile(file);
        });

      $("#pdfBoard").on("scroll", () => this.scheduleScrollSync());
      $("#pdfBoard").on("wheel", (event) => {
        if (!event.ctrlKey) return;
        event.preventDefault();
        if (event.originalEvent.deltaY < 0) this.zoomBy(0.1);
        else this.zoomBy(-0.1);
      });

      $("#backHome").on("click", () => UI.showHome());

      $(window).on("resize", () => {
        if (!pdfDocument || boardState.mode !== "pdf") return;
        window.clearTimeout(this.resizeTimer);
        this.resizeTimer = window.setTimeout(() => this.renderAllPages({ preserveView: true }), 160);
      });
    },

    scheduleScrollSync() {
      if (this.scrollSyncFrame) return;
      this.scrollSyncFrame = window.requestAnimationFrame(() => {
        this.scrollSyncFrame = 0;
        this.updateCurrentPageFromScroll();
        ToolManager.updateEdgeSliders();
      });
    },

    handleFile(file) {
      if (this.isPdfFile(file)) {
        this.loadFile(file);
        return;
      }
      if (StorageManager.isJsonFile(file)) {
        StorageManager.importFromFile(file);
        return;
      }
      UI.toast("請選擇 PDF 或 JSON/JASON 檔案", "error");
    },

    isPdfFile(file) {
      return Boolean(file && (file.type === "application/pdf" || /\.pdf$/i.test(file.name || "")));
    },

    async loadFile(file) {
      if (!this.isPdfFile(file)) {
        UI.toast("請選擇 PDF 檔案", "error");
        return;
      }

      try {
        UI.toast("正在載入 PDF");
        const data = await file.arrayBuffer();
        this.closeCurrentDocument();
        pdfDocument = await this.openPdfDocument(data);
        Utils.resetForFile(file.name);
        UI.showBoard();
        ToolManager.setTool("cursor");
        await this.renderAllPages({ preserveView: false });

        if (pendingImportData) {
          StorageManager.applyData(pendingImportData);
          pendingImportData = null;
        } else {
          StorageManager.offerCachedRestore(file.name);
        }

        UI.markSaved("已開啟");
      } catch (error) {
        console.error(error);
        this.closeCurrentDocument();
        UI.toast("PDF 載入失敗", "error");
      }
    },

    async openPdfDocument(data) {
      const pdfium = await this.ensurePdfium();
      if (pdfium) {
        try {
          return PDFiumDocumentAdapter.open(pdfium, data);
        } catch (error) {
          console.warn(error);
        }
      }

      const pdfjs = await this.ensurePdfJs();
      if (!pdfjs) {
        throw new Error("No PDF renderer is available");
      }

      return pdfjs.getDocument({
        data,
        cMapUrl: `${PDFJS_CDN}/cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${PDFJS_CDN}/standard_fonts/`,
        useSystemFonts: true,
        disableFontFace: false
      }).promise;
    },

    closeCurrentDocument() {
      renderToken += 1;
      this.resetPageRenderer();
      if (!pdfDocument) return;
      const documentToClose = pdfDocument;
      pdfDocument = null;
      try {
        if (typeof documentToClose.close === "function") {
          documentToClose.close();
        } else if (typeof documentToClose.destroy === "function") {
          documentToClose.destroy();
        }
      } catch (error) {
        console.warn(error);
      }
    },

    resetPageRenderer() {
      this.renderQueueGeneration += 1;
      if (this.pageRenderObserver) {
        this.pageRenderObserver.disconnect();
        this.pageRenderObserver = null;
      }
      this.pageRenderQueue = [];
      this.queuedPages.clear();
      this.renderQueueActive = false;
    },

    ensurePdfium() {
      if (pdfiumInstance) return Promise.resolve(pdfiumInstance);
      if (!pdfiumLoadPromise) {
        pdfiumLoadPromise = (async () => {
          const module = await import(PDFIUM_MODULE_URL);
          const response = await fetch(PDFIUM_WASM_URL);
          if (!response.ok) {
            throw new Error(`PDFium WASM request failed: ${response.status}`);
          }
          const wasmBinary = await response.arrayBuffer();
          const pdfium = await module.init({ wasmBinary });
          pdfium.PDFiumExt_Init();
          pdfiumInstance = pdfium;
          return pdfiumInstance;
        })().catch((error) => {
          console.error(error);
          pdfiumLoadPromise = null;
          return null;
        });
      }
      return pdfiumLoadPromise;
    },

    ensurePdfJs() {
      if (pdfjsLib) return Promise.resolve(pdfjsLib);
      if (!pdfjsLoadPromise) {
        pdfjsLoadPromise = import(`${PDFJS_CDN}/pdf.min.mjs`)
          .then((module) => {
            pdfjsLib = module;
            pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}/pdf.worker.min.mjs`;
            return pdfjsLib;
          })
          .catch((error) => {
            console.error(error);
            pdfjsLoadPromise = null;
            return null;
          });
      }
      return pdfjsLoadPromise;
    },

    async renderAllPages(options = {}) {
      if (!pdfDocument) return;
      const preserveView = options.preserveView !== false;
      const preservedView = preserveView ? this.capturePdfView() : null;
      const token = ++renderToken;
      this.resetPageRenderer();
      $("#pdfBoard").empty();
      this.documentFitWidth = await this.resolveDocumentFitWidth(token);
      if (token !== renderToken) return;

      for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
        if (token !== renderToken) return;
        Utils.getPage(pageNumber);
        Utils.ensureHistory({ kind: "page", page: pageNumber });
        const page = await pdfDocument.getPage(pageNumber);
        if (token !== renderToken) return;
        this.createPageShell(pageNumber, page);
      }

      this.observePageRendering(token);
      if (preservedView) {
        this.restorePdfView(preservedView, token);
      } else {
        this.updateCurrentPageFromScroll();
      }
      UI.updateStatus();
      CanvasManager.refreshCanvasCursors();
      LassoManager.renderSelection();
      ToolManager.updateEdgeSliders();
      this.enqueueNearbyPages(boardState.currentPage || 1, token);
    },

    capturePdfView() {
      const board = $("#pdfBoard")[0];
      if (!board || !pdfDocument) return null;
      const boardRect = board.getBoundingClientRect();
      const focusX = boardRect.left + boardRect.width / 2;
      const focusY = boardRect.top + boardRect.height / 2;
      let bestWrapper = null;
      let bestDistance = Infinity;

      document.querySelectorAll(".pdf-page").forEach((wrapper) => {
        const rect = wrapper.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const distance = Math.abs(rect.top + rect.height / 2 - focusY);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestWrapper = wrapper;
        }
      });

      if (!bestWrapper) {
        return {
          page: boardState.currentPage || 1,
          yRatio: 0,
          xRatio: 0.5,
          scrollLeft: board.scrollLeft,
          scrollTop: board.scrollTop
        };
      }

      const rect = bestWrapper.getBoundingClientRect();
      return {
        page: Number(bestWrapper.dataset.page) || boardState.currentPage || 1,
        yRatio: Utils.clamp((focusY - rect.top) / rect.height, 0, 1),
        xRatio: Utils.clamp((focusX - rect.left) / rect.width, 0, 1),
        scrollLeft: board.scrollLeft,
        scrollTop: board.scrollTop
      };
    },

    restorePdfView(view, token = renderToken) {
      if (!view) return;
      const applyView = () => {
        if (token !== renderToken || !pdfDocument) return;
        const board = $("#pdfBoard")[0];
        if (!board) return;
        const page = Utils.clamp(Number(view.page) || 1, 1, pdfDocument.numPages);
        const wrapper = document.querySelector(`.pdf-page[data-page="${page}"]`);
        if (!wrapper) return;

        const previousScrollBehavior = board.style.scrollBehavior;
        const maxScrollTop = Math.max(0, board.scrollHeight - board.clientHeight);
        const maxScrollLeft = Math.max(0, board.scrollWidth - board.clientWidth);
        const targetTop = wrapper.offsetTop + wrapper.offsetHeight * Utils.clamp(Number(view.yRatio) || 0, 0, 1) - board.clientHeight / 2;
        const targetLeft = wrapper.offsetLeft + wrapper.offsetWidth * Utils.clamp(Number(view.xRatio) || 0.5, 0, 1) - board.clientWidth / 2;

        board.style.scrollBehavior = "auto";
        board.scrollTop = Utils.clamp(targetTop, 0, maxScrollTop);
        board.scrollLeft = Utils.clamp(targetLeft, 0, maxScrollLeft);
        boardState.currentPage = page;
        UI.updateStatus();
        ToolManager.updateEdgeSliders();
        LassoManager.renderSelection();
        board.style.scrollBehavior = previousScrollBehavior;
      };

      applyView();
      window.requestAnimationFrame(() => {
        applyView();
        window.requestAnimationFrame(() => {
          applyView();
          this.updateCurrentPageFromScroll();
        });
      });
    },

    waitForPaint() {
      return new Promise((resolve) => window.requestAnimationFrame(resolve));
    },

    getAvailablePageWidth() {
      const board = $("#pdfBoard")[0];
      if (!board) return 960;
      const styles = window.getComputedStyle(board);
      const paddingX = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
      return Math.max(320, Math.floor(board.clientWidth - paddingX - 4));
    },

    async resolveDocumentFitWidth(token) {
      if (!pdfDocument) return 0;
      const widths = [];
      const sampleCount = Math.min(pdfDocument.numPages, 24);
      for (let pageNumber = 1; pageNumber <= sampleCount; pageNumber += 1) {
        if (token !== renderToken) return 0;
        const page = await pdfDocument.getPage(pageNumber);
        widths.push(page.getViewport({ scale: 1 }).width);
      }
      if (!widths.length) return 0;
      widths.sort((a, b) => a - b);
      return widths[Math.floor(widths.length / 2)];
    },

    getFitScaleForPage(page) {
      const viewport = page.getViewport({ scale: 1 });
      const availableWidth = this.getAvailablePageWidth();
      const documentWidth = this.documentFitWidth || viewport.width;
      const documentScale = availableWidth / documentWidth;
      const pageMaxScale = availableWidth / viewport.width;
      return Math.min(documentScale, pageMaxScale);
    },

    createPageShell(pageNumber, page) {
      const baseViewport = page.getViewport({ scale: 1 });
      const requestedScale = this.getFitScaleForPage(page) * boardState.scale;
      const requestedViewport = page.getViewport({ scale: requestedScale });
      const renderWidth = Math.max(1, Math.floor(requestedViewport.width));
      const scale = renderWidth / baseViewport.width;
      const viewport = page.getViewport({ scale });
      const renderHeight = Math.max(1, Math.ceil(viewport.height));
      const wrapper = document.createElement("div");
      wrapper.className = "pdf-page pending-render";
      wrapper.dataset.page = String(pageNumber);
      wrapper.dataset.scale = String(scale);

      const pdfCanvas = document.createElement("canvas");
      pdfCanvas.className = "pdf-canvas";
      pdfCanvas.dataset.page = String(pageNumber);
      const annotationCanvas = document.createElement("canvas");
      annotationCanvas.className = "annotation-canvas";
      annotationCanvas.dataset.page = String(pageNumber);
      annotationCanvas.dataset.kind = "page";
      annotationCanvas.dataset.coordScale = String(scale);

      const markerLayer = document.createElement("div");
      markerLayer.className = "marker-layer";
      const selectionLayer = document.createElement("div");
      selectionLayer.className = "selection-layer";

      wrapper.style.width = `${renderWidth}px`;
      wrapper.style.height = `${renderHeight}px`;
      wrapper.dataset.viewportWidth = String(viewport.width);
      wrapper.dataset.viewportHeight = String(viewport.height);
      pdfCanvas.width = renderWidth;
      pdfCanvas.height = renderHeight;
      pdfCanvas.style.width = `${renderWidth}px`;
      pdfCanvas.style.height = `${renderHeight}px`;
      annotationCanvas.width = renderWidth;
      annotationCanvas.height = renderHeight;
      annotationCanvas.style.width = `${renderWidth}px`;
      annotationCanvas.style.height = `${renderHeight}px`;

      wrapper.append(pdfCanvas, annotationCanvas, markerLayer, selectionLayer);
      $("#pdfBoard")[0].appendChild(wrapper);

      const context = pdfCanvas.getContext("2d");
      context.fillStyle = "#FFFFFF";
      context.fillRect(0, 0, renderWidth, renderHeight);

      CanvasManager.bindCanvas(annotationCanvas);
      Renderer.redrawPage(pageNumber);
      ZoomManager.renderMarkers(pageNumber);
      return wrapper;
    },

    observePageRendering(token) {
      if (!window.IntersectionObserver) {
        this.enqueueNearbyPages(boardState.currentPage || 1, token);
        return;
      }

      const board = $("#pdfBoard")[0];
      if (!board) return;
      this.pageRenderObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          this.enqueuePageRender(Number(entry.target.dataset.page), token);
        });
      }, {
        root: board,
        rootMargin: "1400px 0px"
      });

      document.querySelectorAll(".pdf-page").forEach((wrapper) => {
        this.pageRenderObserver.observe(wrapper);
      });
    },

    enqueueNearbyPages(pageNumber, token = renderToken) {
      [pageNumber, pageNumber + 1, pageNumber - 1].forEach((nextPage) => {
        if (nextPage >= 1 && pdfDocument && nextPage <= pdfDocument.numPages) {
          this.enqueuePageRender(nextPage, token);
        }
      });
    },

    enqueuePageRender(pageNumber, token = renderToken) {
      const wrapper = document.querySelector(`.pdf-page[data-page="${pageNumber}"]`);
      if (!wrapper || wrapper.dataset.rendered === "true" || wrapper.dataset.rendering === "true") return;
      if (this.queuedPages.has(pageNumber)) return;
      this.queuedPages.add(pageNumber);
      this.pageRenderQueue.push({ pageNumber, token });
      this.runPageRenderQueue();
    },

    async runPageRenderQueue() {
      if (this.renderQueueActive) return;
      this.renderQueueActive = true;
      const generation = this.renderQueueGeneration;

      try {
        while (this.pageRenderQueue.length) {
          if (generation !== this.renderQueueGeneration) return;
          const job = this.pageRenderQueue.shift();
          this.queuedPages.delete(job.pageNumber);
          if (job.token !== renderToken || !pdfDocument) continue;
          await this.renderQueuedPage(job.pageNumber, job.token);
          await this.waitForPaint();
        }
      } finally {
        if (generation === this.renderQueueGeneration) {
          this.renderQueueActive = false;
        }
      }
    },

    async renderQueuedPage(pageNumber, token) {
      const wrapper = document.querySelector(`.pdf-page[data-page="${pageNumber}"]`);
      if (!wrapper || wrapper.dataset.rendered === "true" || wrapper.dataset.rendering === "true") return;

      wrapper.dataset.rendering = "true";
      try {
        const page = await pdfDocument.getPage(pageNumber);
        if (token !== renderToken) return;
        const pdfCanvas = wrapper.querySelector(".pdf-canvas");
        const scale = Number(wrapper.dataset.scale || 1);
        const viewport = page.getViewport({ scale });
        await page.render({
          canvasContext: pdfCanvas.getContext("2d"),
          viewport,
          annotationMode: this.getAnnotationRenderMode()
        }).promise;

        wrapper.dataset.rendered = "true";
        wrapper.classList.remove("pending-render");
      } finally {
        delete wrapper.dataset.rendering;
      }

      Renderer.redrawPage(pageNumber);
      ZoomManager.renderMarkers(pageNumber);
    },

    async renderPage(pageNumber, page) {
      const wrapper = this.createPageShell(pageNumber, page);
      await page.render({
        canvasContext: wrapper.querySelector(".pdf-canvas").getContext("2d"),
        viewport: page.getViewport({ scale: Number(wrapper.dataset.scale || 1) }),
        annotationMode: this.getAnnotationRenderMode()
      }).promise;
      wrapper.dataset.rendered = "true";
      wrapper.classList.remove("pending-render");
      Renderer.redrawPage(pageNumber);
      ZoomManager.renderMarkers(pageNumber);
    },

    getAnnotationRenderMode() {
      const annotationMode = pdfjsLib && pdfjsLib.AnnotationMode;
      return annotationMode ? annotationMode.ENABLE : undefined;
    },

    updateCurrentPageFromScroll() {
      const board = $("#pdfBoard")[0];
      if (!board || !pdfDocument) return;
      const boardRect = board.getBoundingClientRect();
      const centerY = boardRect.top + boardRect.height / 2;
      let bestPage = boardState.currentPage || 1;
      let bestDistance = Infinity;

      $(".pdf-page").each((_, element) => {
        const rect = element.getBoundingClientRect();
        const distance = Math.abs(rect.top + rect.height / 2 - centerY);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestPage = Number(element.dataset.page);
        }
      });

      if (bestPage !== boardState.currentPage) {
        boardState.currentPage = bestPage;
        UI.updateStatus();
        this.enqueueNearbyPages(bestPage);
      }
      LassoManager.renderSelection();
    },

    zoomBy(delta) {
      if (!pdfDocument || boardState.mode === "zoom") return;
      const nextScale = Utils.clamp(Number((boardState.scale + delta).toFixed(2)), MIN_ZOOM, MAX_ZOOM);
      if (nextScale === boardState.scale) return;
      boardState.scale = nextScale;
      this.renderAllPages();
    },

    goToPage(pageNumber) {
      if (!pdfDocument) return;
      const nextPage = Utils.clamp(Number(pageNumber) || 1, 1, pdfDocument.numPages);
      if (boardState.mode === "zoom") {
        ZoomManager.exitToPdf({ restoreView: false });
      }
      const board = $("#pdfBoard")[0];
      const wrapper = document.querySelector(`.pdf-page[data-page="${nextPage}"]`);
      if (!board || !wrapper) return;
      boardState.currentPage = nextPage;
      this.enqueueNearbyPages(nextPage);
      const previousScrollBehavior = board.style.scrollBehavior;
      board.style.scrollBehavior = "auto";
      board.scrollTop = Math.max(0, wrapper.offsetTop - 8);
      window.requestAnimationFrame(() => {
        board.style.scrollBehavior = previousScrollBehavior;
        this.updateCurrentPageFromScroll();
      });
      UI.updateStatus();
      ToolManager.updateEdgeSliders();
    }
  };

  const ToolManager = {
    edgeSliderDrag: null,

    init() {
      $(".tool-btn[data-tool]").on("click", (event) => {
        this.setTool($(event.currentTarget).data("tool"));
      });

      $(".tool-btn[data-action]").on("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.runAction($(event.currentTarget).data("action"));
      });

      $(".edge-slider")
        .on("pointerdown", (event) => this.startEdgeSlider(event))
        .on("pointermove", (event) => this.moveEdgeSlider(event))
        .on("pointerup pointercancel", (event) => this.finishEdgeSlider(event));

      $("#moreToolsButton").on("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.toggleMoreMenu();
      });

      $(document).on("click", (event) => {
        if (!$(event.target).closest(".more-tools").length) {
          this.closeMoreMenu();
        }
      });

      $(document).on("keydown", (event) => this.handleKeydown(event));
      $(document).on("fullscreenchange webkitfullscreenchange", () => this.updateFullscreenButton());
      this.updateEdgeSliders();
      this.updateFullscreenButton();
    },

    startEdgeSlider(event) {
      event.preventDefault();
      const slider = event.currentTarget;
      slider.setPointerCapture(event.pointerId);
      const board = $("#pdfBoard")[0];
      if (board) $(board).addClass("drag-scroll");
      this.edgeSliderDrag = {
        slider,
        pointerId: event.pointerId,
        side: $(slider).data("rail-side"),
        startY: event.clientY,
        lastY: event.clientY,
        startScrollTop: board ? board.scrollTop : 0,
        scrollSpeed: event.pointerType === "touch" ? 4 : 7,
        moved: false
      };
    },

    moveEdgeSlider(event) {
      if (!this.edgeSliderDrag || event.pointerId !== this.edgeSliderDrag.pointerId) return;
      event.preventDefault();
      const board = $("#pdfBoard")[0];
      if (!board) return;
      const deltaY = event.clientY - this.edgeSliderDrag.startY;
      if (Math.abs(deltaY) > 4) this.edgeSliderDrag.moved = true;
      if (!this.edgeSliderDrag.moved) return;

      const stepY = event.clientY - this.edgeSliderDrag.lastY;
      const maxScroll = Math.max(0, board.scrollHeight - board.clientHeight);
      board.scrollTop = Utils.clamp(
        board.scrollTop + stepY * this.edgeSliderDrag.scrollSpeed,
        0,
        maxScroll
      );
      this.edgeSliderDrag.lastY = event.clientY;
      this.updateEdgeSliders();
    },

    finishEdgeSlider(event) {
      if (!this.edgeSliderDrag || event.pointerId !== this.edgeSliderDrag.pointerId) return;
      event.preventDefault();
      const drag = this.edgeSliderDrag;
      this.edgeSliderDrag = null;
      $("#pdfBoard").removeClass("drag-scroll");
      if (!drag.moved) this.toggleRail(drag.side);
    },

    updateEdgeSliders() {
      const board = $("#pdfBoard")[0];
      if (!board) return;
      document.querySelectorAll(".edge-slider").forEach((slider) => {
        const track = this.getEdgeSliderTrack(slider);
        const thumbHeight = this.getEdgeThumbHeight(slider, board, track.height);
        const maxScroll = Math.max(0, board.scrollHeight - board.clientHeight);
        const ratio = maxScroll > 0 ? board.scrollTop / maxScroll : 0;
        const top = track.top + (track.height - thumbHeight) * ratio;
        slider.style.setProperty("--slider-thumb-top", `${Math.round(top)}px`);
        slider.style.setProperty("--slider-thumb-height", `${Math.round(thumbHeight)}px`);
      });
    },

    getEdgeSliderTrack(slider) {
      const height = Math.max(1, slider.clientHeight - 60);
      return { top: 30, height };
    },

    getEdgeThumbHeight(slider, board, trackHeight) {
      if (!board.scrollHeight || board.scrollHeight <= board.clientHeight) return trackHeight;
      const ratio = board.clientHeight / board.scrollHeight;
      return Utils.clamp(trackHeight * ratio, 44, trackHeight);
    },

    toggleRail(side) {
      const normalizedSide = side === "right" ? "right" : "left";
      const $rail = $("#leftRail");
      const isOpen = !$rail.hasClass("collapsed");
      const isSameSide = $rail.hasClass(normalizedSide);
      this.setRailSide(normalizedSide);

      if (isOpen && isSameSide) {
        $rail.addClass("collapsed");
        $("#boardScreen").removeClass("rail-open");
        $(".edge-slider").removeClass("active").attr("aria-expanded", "false");
        this.closeMoreMenu();
        PanelManager.close();
        return;
      }

      $rail.removeClass("left right collapsed").addClass(normalizedSide);
      $("#boardScreen").addClass("rail-open");
      $(".edge-slider").removeClass("active").attr("aria-expanded", "false");
      $(`.edge-slider[data-rail-side="${normalizedSide}"]`).addClass("active").attr("aria-expanded", "true");
    },

    setRailSide(side) {
      const normalizedSide = side === "right" ? "right" : "left";
      $("#boardScreen")
        .toggleClass("rail-right", normalizedSide === "right")
        .toggleClass("rail-left", normalizedSide === "left");
    },

    toggleMoreMenu() {
      const $menu = $("#moreToolsMenu");
      const willOpen = $menu.hasClass("hidden");
      if (willOpen) PanelManager.close();
      $menu.toggleClass("hidden", !willOpen);
      $("#moreToolsButton")
        .toggleClass("menu-open", willOpen)
        .attr("aria-expanded", String(willOpen));
    },

    closeMoreMenu() {
      $("#moreToolsMenu").addClass("hidden");
      $("#moreToolsButton").removeClass("menu-open").attr("aria-expanded", "false");
    },

    setTool(tool) {
      const isSameTool = boardState.currentTool === tool;
      const isExpanded = PanelManager.isOpenFor(tool);
      boardState.currentTool = tool;
      $(".tool-btn[data-tool]").removeClass("active");
      $(`.tool-btn[data-tool="${tool}"]`).addClass("active");
      this.closeMoreMenu();
      if (isSameTool && isExpanded) {
        PanelManager.close();
      } else {
        PanelManager.open(tool);
      }
      CanvasManager.refreshCanvasCursors();
      if (tool !== "lasso") LassoManager.clearSelection();

      if (isSameTool && isExpanded) return;
      if (tool === "clearPage") {
        UI.toast("點擊目前頁面即可清除該頁註記");
      }
      if (tool === "zoomArea") {
        UI.toast("在 PDF 頁面拖曳出矩形區域");
      }
      if (tool === "lasso") {
        UI.toast("拖曳套索選取註記；有複製內容時點一下即可貼上");
      }
    },

    runAction(action) {
      switch (action) {
        case "zoomIn":
          PDFViewer.zoomBy(0.1);
          break;
        case "zoomOut":
          PDFViewer.zoomBy(-0.1);
          break;
        case "undo":
          HistoryManager.undo(Utils.activeTarget());
          break;
        case "redo":
          HistoryManager.redo(Utils.activeTarget());
          break;
        case "save":
          StorageManager.save();
          break;
        case "export":
          StorageManager.downloadJSON();
          break;
        case "import":
          StorageManager.openJsonPicker();
          break;
        case "fullscreen":
          this.toggleFullscreen();
          break;
        default:
          break;
      }
    },

    isFullscreen() {
      return Boolean(document.fullscreenElement || document.webkitFullscreenElement);
    },

    async toggleFullscreen() {
      const preservedView = PDFViewer.capturePdfView();
      try {
        if (this.isFullscreen()) {
          if (document.exitFullscreen) {
            await document.exitFullscreen();
          } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
          }
        } else {
          const target = document.documentElement;
          if (target.requestFullscreen) {
            await target.requestFullscreen();
          } else if (target.webkitRequestFullscreen) {
            target.webkitRequestFullscreen();
          } else {
            UI.toast("此瀏覽器不支援全螢幕", "error");
          }
        }
      } catch (error) {
        console.error(error);
        UI.toast("全螢幕切換失敗", "error");
      } finally {
        this.updateFullscreenButton();
        PDFViewer.restorePdfView(preservedView);
        window.setTimeout(() => PDFViewer.restorePdfView(preservedView), 260);
      }
    },

    updateFullscreenButton() {
      const button = document.getElementById("fullscreenButton");
      if (!button) return;
      const active = this.isFullscreen();
      button.classList.toggle("active", active);
      button.title = active ? "退出全螢幕" : "全螢幕";
      button.setAttribute("aria-label", active ? "退出全螢幕" : "全螢幕");
      button.innerHTML = `<i data-lucide="${active ? "minimize" : "maximize"}"></i>`;
      UI.refreshIcons();
    },

    handleKeydown(event) {
      if (Utils.isTypingTarget(event)) return;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) HistoryManager.redo(Utils.activeTarget());
        else HistoryManager.undo(Utils.activeTarget());
        return;
      }

      if ((event.ctrlKey || event.metaKey) && (event.key === "+" || event.key === "=")) {
        event.preventDefault();
        PDFViewer.zoomBy(0.1);
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key === "-") {
        event.preventDefault();
        PDFViewer.zoomBy(-0.1);
        return;
      }

      const key = event.key.toLowerCase();
      const keyMap = {
        v: "cursor",
        l: "lasso",
        p: "pen",
        h: "highlighter",
        e: "eraser"
      };
      if (keyMap[key]) {
        this.setTool(keyMap[key]);
      } else if (key === "s") {
        StorageManager.save();
      }
    }
  };

  const PanelManager = {
    panelMap: {
      pen: "#penPanel",
      highlighter: "#highlighterPanel",
      eraser: "#eraserPanel",
      lasso: "#lassoPanel",
      shape: "#shapePanel"
    },

    init() {
      $(".panel-close").on("click", () => this.close());
    },

    close() {
      $(".floating-panel").removeClass("active");
    },

    isOpenFor(tool) {
      const selector = this.panelMap[tool];
      return Boolean(selector && $(selector).hasClass("active"));
    },

    open(tool) {
      this.close();
      if (this.panelMap[tool]) {
        $(this.panelMap[tool]).addClass("active");
      }
    }
  };

  const ColorManager = {
    init() {
      this.buildColorTools("pen");
      this.buildColorTools("highlighter");
      this.buildColorTools("shape");
      this.buildColorTools("shapeFill");
      this.bindInputs();
      this.buildShapeOptions("line");
      this.updateFillTransparentState();
    },

    buildColorTools(tool) {
      this.buildPresetGrid(tool);
      this.buildCustomGrid(tool);
      this.buildHueGrid(tool);
      this.refreshActive(tool);
    },

    buildPresetGrid(tool) {
      const $grid = $(`#${tool}PresetColors`).empty();
      presetColors.forEach((color) => {
        $("<button>", {
          class: "color-chip",
          type: "button",
          title: color,
          "aria-label": color
        })
          .css("background", color)
          .data("color", color)
          .on("click", () => this.setColor(tool, color))
          .appendTo($grid);
      });
    },

    buildCustomGrid(tool) {
      const $grid = $(`#${tool}CustomColors`).empty();
      if (!boardState.customColors[tool]) {
        boardState.customColors[tool] = new Array(36).fill(null);
      }
      boardState.customColors[tool].forEach((color, index) => {
        const $slot = $("<div>", {
          class: "custom-color-slot"
        })
          .toggleClass("has-color", Boolean(color))
          .appendTo($grid);

        $("<button>", {
          class: "color-chip",
          type: "button",
          title: color || "自訂顏色",
          "aria-label": color || "自訂顏色"
        })
          .toggleClass("empty", !color)
          .css("background", color || "")
          .data("color", color || "")
          .on("click", () => {
            if (!boardState.customColors[tool][index]) {
              const inputColor = Utils.normalizeHex($(`#${tool}ColorCode`).val());
              if (!inputColor) {
                UI.toast("色碼格式不正確", "error");
                return;
              }
              boardState.customColors[tool][index] = inputColor;
              this.buildCustomGrid(tool);
              this.setColor(tool, inputColor);
              UI.markDirty();
            } else {
              this.setColor(tool, boardState.customColors[tool][index]);
            }
          })
          .appendTo($slot);

        $("<button>", {
          class: "custom-color-reset",
          type: "button",
          title: "還原自訂色",
          "aria-label": "還原自訂色",
          text: "×"
        })
          .on("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!boardState.customColors[tool][index]) return;
            boardState.customColors[tool][index] = null;
            this.buildCustomGrid(tool);
            this.refreshActive(tool);
            UI.markDirty();
          })
          .appendTo($slot);
      });
    },

    buildHueGrid(tool) {
      const $grid = $(`#${tool}ColorWheel`).empty();
      this.generatePaletteColors().forEach((color) => {
        $("<button>", {
          class: "hue-chip",
          type: "button",
          title: color,
          "aria-label": color
        })
          .css("background", color)
          .on("click", () => this.setColor(tool, color))
          .appendTo($grid);
      });
    },

    generatePaletteColors() {
      const hues = [0, 18, 36, 52, 72, 96, 132, 168, 196, 224, 264, 304];
      const saturations = [95, 78, 60, 42, 24];
      const lightnesses = [22, 34, 46, 58, 70, 82];
      const colors = [];

      lightnesses.forEach((lightness) => {
        hues.forEach((hue) => {
          saturations.forEach((saturation) => {
            colors.push(this.hslToHex(hue, saturation, lightness));
          });
        });
      });

      const grays = [
        "#050505", "#151515", "#252525", "#353535", "#454545", "#555555",
        "#666666", "#777777", "#888888", "#999999", "#AAAAAA", "#BBBBBB",
        "#CCCCCC", "#D8D8D8", "#E4E4E4", "#F0F0F0", "#FAFAFA", "#FFFFFF"
      ];
      return colors.slice(0, 342).concat(grays);
    },

    hslToHex(h, s, l) {
      s /= 100;
      l /= 100;
      const k = (n) => (n + h / 30) % 12;
      const a = s * Math.min(l, 1 - l);
      const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
      const toHex = (x) => Math.round(255 * x).toString(16).padStart(2, "0");
      return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`.toUpperCase();
    },

    setColor(tool, color) {
      const normalized = Utils.normalizeHex(color);
      if (!normalized) {
        UI.toast("色碼格式不正確", "error");
        return;
      }
      if (tool === "shape") {
        boardState.shape.color = normalized;
      } else if (tool === "shapeFill") {
        boardState.shape.fillColor = normalized;
        if (Number(boardState.shape.fillOpacity || 0) <= 0) {
          this.syncShapeFillOpacity(1);
        } else {
          this.updateFillTransparentState();
        }
      } else {
        boardState[tool].color = normalized;
      }
      $(`#${tool}ColorCode`).val(normalized);
      this.refreshActive(tool);
      UI.markDirty();
    },

    refreshActive(tool) {
      const color = tool === "shape"
        ? boardState.shape.color
        : tool === "shapeFill"
          ? boardState.shape.fillColor
          : boardState[tool].color;
      $(`#${tool}PresetColors .color-chip, #${tool}CustomColors .color-chip`).each((_, chip) => {
        const chipColor = $(chip).data("color") || $(chip).attr("title");
        $(chip).toggleClass("active", chipColor && chipColor.toUpperCase() === color.toUpperCase());
      });
    },

    syncShapeFillOpacity(value) {
      const fillOpacity = Utils.clamp(Number(value) || 0, 0, 1);
      boardState.shape.fillOpacity = fillOpacity;
      $("#shapeFillOpacity").val(fillOpacity);
      $("#shapeFillOpacityValue").text(fillOpacity);
      this.updateFillTransparentState();
    },

    updateFillTransparentState() {
      $("#shapeFillTransparent").toggleClass("active", Number(boardState.shape.fillOpacity || 0) <= 0);
    },

    bindInputs() {
      $("#penSize").on("input", (event) => {
        boardState.pen.size = Number(event.target.value);
        $("#penSizeValue").text(boardState.pen.size);
        UI.markDirty();
      });
      $("#penOpacity").on("input", (event) => {
        boardState.pen.opacity = Number(event.target.value);
        $("#penOpacityValue").text(boardState.pen.opacity);
        UI.markDirty();
      });
      $("#highlighterSize").on("input", (event) => {
        boardState.highlighter.size = Number(event.target.value);
        $("#highlighterSizeValue").text(boardState.highlighter.size);
        UI.markDirty();
      });
      $("#highlighterOpacity").on("input", (event) => {
        boardState.highlighter.opacity = Number(event.target.value);
        $("#highlighterOpacityValue").text(boardState.highlighter.opacity);
        UI.markDirty();
      });
      $("#eraserSize").on("input", (event) => {
        boardState.eraser.size = Number(event.target.value);
        $("#eraserSizeValue").text(boardState.eraser.size);
        $("#eraserPreview").css("--preview-size", `${boardState.eraser.size}px`);
        UI.markDirty();
      });
      $("#shapeStrokeWidth").on("input", (event) => {
        boardState.shape.strokeWidth = Number(event.target.value);
        $("#shapeStrokeWidthValue").text(boardState.shape.strokeWidth);
        UI.markDirty();
      });
      $("#shapeFillOpacity").on("input", (event) => {
        this.syncShapeFillOpacity(event.target.value);
        UI.markDirty();
      });
      $("#shapeFillTransparent").on("click", () => {
        this.syncShapeFillOpacity(0);
        UI.markDirty();
      });
      $("#shapePolygonSides").on("input", (event) => {
        boardState.shape.polygonSides = Utils.clamp(Number(event.target.value) || 3, 3, 24);
        event.target.value = boardState.shape.polygonSides;
        UI.markDirty();
      });
      $("#shapeStartMarker").on("change", (event) => {
        boardState.shape.startMarker = event.target.value;
        UI.markDirty();
      });
      $("#shapeEndMarker").on("change", (event) => {
        boardState.shape.endMarker = event.target.value;
        UI.markDirty();
      });
      $("#shapeRows").on("input", (event) => {
        boardState.shape.rows = Utils.clamp(Number(event.target.value) || 1, 1, 12);
        UI.markDirty();
      });
      $("#shapeCols").on("input", (event) => {
        boardState.shape.cols = Utils.clamp(Number(event.target.value) || 1, 1, 12);
        UI.markDirty();
      });

      ["pen", "highlighter", "shape", "shapeFill"].forEach((tool) => {
        $(`#${tool}ColorCode`).on("change", (event) => this.setColor(tool, event.target.value));
      });

      $(".shape-tabs button").on("click", (event) => {
        const group = $(event.currentTarget).data("shape-group");
        boardState.shape.group = group;
        $(".shape-tabs button").removeClass("active");
        $(event.currentTarget).addClass("active");
        this.buildShapeOptions(group);
        $("#tableControls").toggleClass("active", group === "table");
        this.syncShapeExtraControls();
        UI.markDirty();
      });

      $(".lasso-tabs button").on("click", (event) => {
        boardState.lasso.mode = $(event.currentTarget).data("lasso-mode");
        $(".lasso-tabs button").removeClass("active");
        $(event.currentTarget).addClass("active");
        UI.markDirty();
      });
    },

    buildShapeOptions(group) {
      const $options = $("#shapeOptions").empty();
      const hasCurrentType = shapeGroups[group].some((option) => option.type === boardState.shape.type);
      shapeGroups[group].forEach((option, index) => {
        $("<button>", {
          class: "shape-option",
          type: "button",
          text: option.label
        })
          .toggleClass("active", hasCurrentType ? option.type === boardState.shape.type : index === 0)
          .on("click", (event) => {
            boardState.shape.type = option.type;
            $(".shape-option").removeClass("active");
            $(event.currentTarget).addClass("active");
            this.syncShapeExtraControls();
            UI.markDirty();
          })
          .appendTo($options);
      });

      if (!hasCurrentType) {
        boardState.shape.type = shapeGroups[group][0].type;
        $(".shape-option").removeClass("active").first().addClass("active");
      }
      this.syncShapeExtraControls();
    },

    syncShapeExtraControls() {
      const isLineGroup = boardState.shape.group === "line";
      $("#lineMarkerControls").toggleClass("active", isLineGroup);
      $("#polygonControls").toggleClass("active", boardState.shape.type === "polygon");
    },

    syncPanelValues() {
      $("#penSize").val(boardState.pen.size);
      $("#penSizeValue").text(boardState.pen.size);
      $("#penOpacity").val(boardState.pen.opacity);
      $("#penOpacityValue").text(boardState.pen.opacity);
      $("#penColorCode").val(boardState.pen.color);

      $("#highlighterSize").val(boardState.highlighter.size);
      $("#highlighterSizeValue").text(boardState.highlighter.size);
      $("#highlighterOpacity").val(boardState.highlighter.opacity);
      $("#highlighterOpacityValue").text(boardState.highlighter.opacity);
      $("#highlighterColorCode").val(boardState.highlighter.color);

      $("#eraserSize").val(boardState.eraser.size);
      $("#eraserSizeValue").text(boardState.eraser.size);
      $("#eraserPreview").css("--preview-size", `${boardState.eraser.size}px`);

      $("#shapeStrokeWidth").val(boardState.shape.strokeWidth);
      $("#shapeStrokeWidthValue").text(boardState.shape.strokeWidth);
      $("#shapeColorCode").val(boardState.shape.color);
      this.syncShapeFillOpacity(boardState.shape.fillOpacity || 0);
      $("#shapeFillColorCode").val(boardState.shape.fillColor || "#FFFFFF");
      $("#shapePolygonSides").val(boardState.shape.polygonSides || 6);
      $("#shapeStartMarker").val(boardState.shape.startMarker || "none");
      $("#shapeEndMarker").val(boardState.shape.endMarker || "none");
      $("#shapeRows").val(boardState.shape.rows);
      $("#shapeCols").val(boardState.shape.cols);
      $(".lasso-tabs button").removeClass("active");
      $(`.lasso-tabs button[data-lasso-mode="${boardState.lasso.mode || "rect"}"]`).addClass("active");
      $(".shape-tabs button").removeClass("active");
      $(`.shape-tabs button[data-shape-group="${boardState.shape.group}"]`).addClass("active");
      $("#tableControls").toggleClass("active", boardState.shape.group === "table");
      this.buildShapeOptions(boardState.shape.group);
      this.syncShapeExtraControls();
      ["pen", "highlighter", "shape", "shapeFill"].forEach((tool) => {
        this.buildCustomGrid(tool);
        this.refreshActive(tool);
      });
    }
  };

  const CanvasManager = {
    active: null,

    bindCanvas(canvas) {
      if (canvas.dataset.bound === "true") return;
      canvas.dataset.bound = "true";
      canvas.addEventListener("pointerdown", (event) => this.handleDown(event));
      canvas.addEventListener("pointermove", (event) => this.handleMove(event));
      canvas.addEventListener("pointerup", (event) => this.handleUp(event));
      canvas.addEventListener("pointercancel", (event) => this.handleUp(event));
      canvas.addEventListener("pointerleave", (event) => this.handleLeave(event));
    },

    getCanvasTarget(canvas) {
      if (canvas.dataset.kind === "zoom") {
        return { kind: "zoom", id: canvas.dataset.zoomId };
      }
      return { kind: "page", page: Number(canvas.dataset.page) };
    },

    getCanvasScale(canvas) {
      return Number(canvas.dataset.coordScale || 1);
    },

    getPoint(event, canvas) {
      if (canvas.dataset.kind === "zoom") {
        return ZoomManager.screenToWorld(event, canvas);
      }
      const rect = canvas.getBoundingClientRect();
      const scale = this.getCanvasScale(canvas);
      return {
        x: (event.clientX - rect.left) / scale,
        y: (event.clientY - rect.top) / scale
      };
    },

    handleDown(event) {
      const tool = boardState.currentTool;
      const canvas = event.currentTarget;
      const target = this.getCanvasTarget(canvas);
      this.updateEraserCursor(event, canvas);
      if (tool === "cursor") {
        event.preventDefault();
        canvas.setPointerCapture(event.pointerId);
        if (target.kind === "page") {
          const board = $("#pdfBoard")[0];
          this.active = {
            mode: "pdfPan",
            canvas,
            target,
            startClientX: event.clientX,
            startClientY: event.clientY,
            startScrollLeft: board.scrollLeft,
            startScrollTop: board.scrollTop
          };
          $(canvas).addClass("pan-active");
          return;
        }
        this.active = {
          mode: "zoomPan",
          canvas,
          target,
          startClientX: event.clientX,
          startClientY: event.clientY,
          startCamera: ZoomManager.getCamera(target.id)
        };
        $(canvas).addClass("pan-active");
        return;
      }

      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      const point = this.getPoint(event, canvas);

      if (target.kind === "page") {
        boardState.currentPage = target.page;
        UI.updateStatus();
      }

      if (tool === "clearPage") {
        this.clearTarget(target);
        return;
      }

      if (tool === "zoomArea") {
        if (target.kind !== "page") {
          UI.toast("放大區域只能在 PDF 頁面建立", "error");
          return;
        }
        this.startZoomSelection(canvas, target, point);
        return;
      }

      if (tool === "lasso") {
        this.active = LassoManager.start(canvas, target, point, event);
        return;
      }

      if (tool === "shape") {
        this.active = {
          mode: "shape",
          canvas,
          target,
          start: point,
          latest: point
        };
        return;
      }

      if (tool === "pen" || tool === "highlighter" || tool === "eraser") {
        const annotation = this.createStroke(tool, target, point);
        this.active = {
          mode: "stroke",
          canvas,
          target,
          annotation
        };
      }
    },

    handleMove(event) {
      this.updateEraserCursor(event, event.currentTarget);
      if (!this.active) return;
      event.preventDefault();
      const { canvas } = this.active;
      const point = this.getPoint(event, canvas);

      if (this.active.mode === "stroke") {
        const points = this.active.annotation.points;
        const previous = points[points.length - 1];
        points.push(point);
        if (this.active.annotation.tool === "highlighter") {
          Renderer.redrawTarget(this.active.target, [this.active.annotation]);
        } else if (this.active.target.kind === "zoom") {
          Renderer.drawStrokeSegment(canvas, this.active.annotation, previous, point, this.active.target);
        } else {
          Renderer.drawStrokeSegment(canvas, this.active.annotation, previous, point);
        }
      }

      if (this.active.mode === "shape") {
        this.active.latest = point;
        Renderer.redrawTarget(this.active.target);
        const preview = this.createShape(this.active.target, this.active.start, this.active.latest);
        if (this.active.target.kind === "zoom") {
          Renderer.drawZoomPreview(canvas, preview, this.active.target.id);
        } else {
          Renderer.drawAnnotation(canvas.getContext("2d"), preview, this.getCanvasScale(canvas));
        }
      }

      if (this.active.mode === "zoomSelection") {
        this.active.latest = point;
        this.updateZoomSelection();
      }

      if (this.active.mode === "zoomPan") {
        ZoomManager.panTo(
          this.active.target.id,
          this.active.startCamera.x + event.clientX - this.active.startClientX,
          this.active.startCamera.y + event.clientY - this.active.startClientY
        );
      }

      if (this.active.mode === "pdfPan") {
        const board = $("#pdfBoard")[0];
        board.scrollLeft = this.active.startScrollLeft - (event.clientX - this.active.startClientX);
        board.scrollTop = this.active.startScrollTop - (event.clientY - this.active.startClientY);
        LassoManager.renderSelection();
      }

      if (this.active.mode === "lasso") {
        this.active.latest = point;
        LassoManager.update(this.active, point, event);
      }
    },

    handleUp(event) {
      if (!this.active) return;
      event.preventDefault();
      const active = this.active;
      this.active = null;
      if (active.mode === "zoomPan") {
        $(active.canvas).removeClass("pan-active");
        UI.markDirty();
        return;
      }

      if (active.mode === "pdfPan") {
        $(active.canvas).removeClass("pan-active");
        return;
      }

      if (active.mode === "lasso") {
        LassoManager.finish(active, event);
        return;
      }

      if (active.mode === "stroke") {
        if (active.annotation.points.length > 1) {
          Utils.getAnnotations(active.target).push(active.annotation);
          HistoryManager.push(active.target, {
            type: "addAnnotation",
            annotation: Utils.clone(active.annotation)
          });
          UI.markDirty();
          if (active.annotation.tool === "highlighter") Renderer.redrawTarget(active.target);
        } else {
          Renderer.redrawTarget(active.target);
        }
      }

      if (active.mode === "shape") {
        const annotation = this.createShape(active.target, active.start, active.latest);
        const distance = Math.hypot(annotation.x2 - annotation.x1, annotation.y2 - annotation.y1);
        if (distance > 4) {
          Utils.getAnnotations(active.target).push(annotation);
          HistoryManager.push(active.target, {
            type: "addAnnotation",
            annotation: Utils.clone(annotation)
          });
          UI.markDirty();
        }
        Renderer.redrawTarget(active.target);
      }

      if (active.mode === "zoomSelection") {
        const rect = this.getRect(active.start, active.latest, active.canvas);
        this.clearSelectionLayer(active.canvas);
        if (!rect || rect.width < 24 || rect.height < 24) {
          ZoomManager.createBlankFromPoint(active.target.page, active.start);
          return;
        }
        ZoomManager.createFromSelection(active.target.page, rect);
      }
    },

    handleLeave(event) {
      this.hideEraserCursor();
      if (!this.active || this.active.mode === "zoomSelection" || this.active.mode === "zoomPan" || this.active.mode === "pdfPan") return;
      if (event.buttons === 0) this.handleUp(event);
    },

    createStroke(tool, target, point) {
      const source = tool === "highlighter" ? boardState.highlighter : boardState.pen;
      return {
        id: Utils.id("anno"),
        context: Utils.targetKey(target),
        type: "stroke",
        tool,
        points: [point],
        color: tool === "eraser" ? "#000000" : source.color,
        size: tool === "eraser" ? boardState.eraser.size : source.size,
        opacity: tool === "eraser" ? 1 : source.opacity,
        createdAt: Date.now()
      };
    },

    createShape(target, start, end) {
      return {
        id: Utils.id("shape"),
        context: Utils.targetKey(target),
        type: "shape",
        shapeType: boardState.shape.type,
        x1: start.x,
        y1: start.y,
        x2: end.x,
        y2: end.y,
        strokeWidth: boardState.shape.strokeWidth,
        color: boardState.shape.color,
        opacity: boardState.shape.opacity,
        fillColor: boardState.shape.fillColor,
        fillOpacity: boardState.shape.fillOpacity,
        polygonSides: boardState.shape.polygonSides,
        startMarker: boardState.shape.startMarker,
        endMarker: boardState.shape.endMarker,
        rows: this.resolveTableRows(),
        cols: this.resolveTableCols(),
        createdAt: Date.now()
      };
    },

    resolveTableRows() {
      if (boardState.shape.type === "table2") return 2;
      if (boardState.shape.type === "table3") return 3;
      if (boardState.shape.type === "table4") return 4;
      return boardState.shape.rows;
    },

    resolveTableCols() {
      if (boardState.shape.type === "table2") return 2;
      if (boardState.shape.type === "table3") return 3;
      if (boardState.shape.type === "table4") return 4;
      return boardState.shape.cols;
    },

    async clearTarget(target) {
      const annotations = Utils.getAnnotations(target);
      if (!annotations.length) {
        UI.toast("目前沒有註記可清除");
        return;
      }
      const confirmed = await UI.confirm("確定要清除目前頁面的所有註記？", {
        confirmText: "清除",
        danger: true
      });
      if (!confirmed) return;
      const previous = Utils.clone(annotations);
      annotations.length = 0;
      HistoryManager.push(target, { type: "clearAnnotations", previous });
      Renderer.redrawTarget(target);
      UI.markDirty();
      UI.toast("已清除目前頁面");
    },

    startZoomSelection(canvas, target, point) {
      this.clearSelectionLayer(canvas);
      const selection = document.createElement("div");
      selection.className = "selection-box";
      canvas.parentElement.querySelector(".selection-layer").appendChild(selection);
      this.active = {
        mode: "zoomSelection",
        canvas,
        target,
        start: point,
        latest: point,
        selection
      };
      this.updateZoomSelection();
    },

    updateZoomSelection() {
      const active = this.active;
      const rect = this.getRect(active.start, active.latest, active.canvas);
      const scale = this.getCanvasScale(active.canvas);
      active.selection.style.left = `${rect.x * scale}px`;
      active.selection.style.top = `${rect.y * scale}px`;
      active.selection.style.width = `${rect.width * scale}px`;
      active.selection.style.height = `${rect.height * scale}px`;
    },

    getRect(start, end, canvas) {
      const baseWidth = canvas.width / this.getCanvasScale(canvas);
      const baseHeight = canvas.height / this.getCanvasScale(canvas);
      const x1 = Utils.clamp(start.x, 0, baseWidth);
      const y1 = Utils.clamp(start.y, 0, baseHeight);
      const x2 = Utils.clamp(end.x, 0, baseWidth);
      const y2 = Utils.clamp(end.y, 0, baseHeight);
      return {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1)
      };
    },

    clearSelectionLayer(canvas) {
      const layer = canvas.parentElement && canvas.parentElement.querySelector(".selection-layer");
      if (layer) layer.innerHTML = "";
    },

    refreshCanvasCursors() {
      $(".annotation-canvas, .zoom-annotation-canvas")
        .removeClass("draw-ready erase-ready pan-ready lasso-ready")
        .each((_, canvas) => {
          if (boardState.currentTool === "cursor") {
            $(canvas).addClass("pan-ready");
            return;
          }
          if (boardState.currentTool === "lasso") {
            $(canvas).addClass("lasso-ready");
            return;
          }
          if (boardState.currentTool === "eraser") $(canvas).addClass("erase-ready");
          else $(canvas).addClass("draw-ready");
        });
      if (boardState.currentTool !== "eraser") this.hideEraserCursor();
    },

    updateEraserCursor(event, canvas) {
      if (boardState.currentTool !== "eraser" || !canvas) {
        this.hideEraserCursor();
        return;
      }
      const size = Math.max(8, boardState.eraser.size);
      $("#eraserCursor")
        .css({
          display: "block",
          left: `${event.clientX}px`,
          top: `${event.clientY}px`,
          width: `${size}px`,
          height: `${size}px`
        });
    },

    hideEraserCursor() {
      $("#eraserCursor").hide();
    }
  };

  const LassoManager = {
    selection: null,
    clipboard: null,
    selectionEl: null,
    draftEl: null,
    transform: null,

    init() {
      this.selectionEl = document.createElement("div");
      this.selectionEl.className = "lasso-selection hidden";
      this.selectionEl.innerHTML = `
        <button class="lasso-rotate" type="button" title="旋轉" aria-label="旋轉">⟳</button>
        <button class="lasso-handle" data-corner="nw" type="button" title="左上縮放" aria-label="左上縮放"></button>
        <button class="lasso-handle" data-corner="ne" type="button" title="右上縮放" aria-label="右上縮放"></button>
        <button class="lasso-handle" data-corner="sw" type="button" title="左下縮放" aria-label="左下縮放"></button>
        <button class="lasso-handle" data-corner="se" type="button" title="右下縮放" aria-label="右下縮放"></button>
        <button class="lasso-handle edge" data-corner="n" type="button" title="上邊調整" aria-label="上邊調整"></button>
        <button class="lasso-handle edge" data-corner="e" type="button" title="右邊調整" aria-label="右邊調整"></button>
        <button class="lasso-handle edge" data-corner="s" type="button" title="下邊調整" aria-label="下邊調整"></button>
        <button class="lasso-handle edge" data-corner="w" type="button" title="左邊調整" aria-label="左邊調整"></button>
        <div class="lasso-actions">
          <button class="lasso-action" data-lasso-action="copy" type="button">複製</button>
          <button class="lasso-action" data-lasso-action="cut" type="button">剪下</button>
        </div>
      `;
      document.body.appendChild(this.selectionEl);

      this.selectionEl.querySelectorAll(".lasso-handle").forEach((handle) => {
        handle.addEventListener("pointerdown", (event) => this.startResize(event, handle.dataset.corner));
      });
      this.selectionEl.querySelector(".lasso-rotate").addEventListener("pointerdown", (event) => this.startRotate(event));
      this.selectionEl.querySelectorAll(".lasso-action").forEach((button) => {
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (button.dataset.lassoAction === "copy") this.copySelection();
          if (button.dataset.lassoAction === "cut") this.cutSelection();
        });
      });

      document.addEventListener("pointermove", (event) => this.handleTransformMove(event));
      document.addEventListener("pointerup", () => this.finishTransform());
      window.addEventListener("resize", () => this.renderSelection());
    },

    start(canvas, target, point, event) {
      this.clearSelection();
      const active = {
        mode: "lasso",
        canvas,
        target,
        start: point,
        latest: point,
        lassoMode: boardState.lasso.mode || "rect",
        worldPoints: [point],
        screenPoints: [{ x: event.clientX, y: event.clientY }]
      };
      this.showDraft(active);
      return active;
    },

    update(active, point, event) {
      active.latest = point;
      if (active.lassoMode === "freehand") {
        active.worldPoints.push(point);
        active.screenPoints.push({ x: event.clientX, y: event.clientY });
      }
      this.showDraft(active);
    },

    finish(active) {
      this.clearDraft();
      const distance = Math.hypot(active.latest.x - active.start.x, active.latest.y - active.start.y);
      if (distance < 4) {
        if (this.clipboard) {
          this.pasteAt(active.target, active.latest);
        } else {
          this.clearSelection();
        }
        return;
      }

      const ids = active.lassoMode === "freehand"
        ? this.pickByPolygon(active.target, active.worldPoints)
        : this.pickByRect(active.target, this.normalizeRect(active.start.x, active.start.y, active.latest.x, active.latest.y));

      if (!ids.length) {
        UI.toast("沒有選到註記");
        this.clearSelection();
        return;
      }
      this.selection = { target: active.target, ids };
      this.renderSelection();
    },

    showDraft(active) {
      this.clearDraft();
      if (active.lassoMode === "freehand") {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.classList.add("lasso-draft-svg");
        const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
        polyline.setAttribute("points", active.screenPoints.map((point) => `${point.x},${point.y}`).join(" "));
        svg.appendChild(polyline);
        document.body.appendChild(svg);
        this.draftEl = svg;
        return;
      }

      const start = this.worldToScreen(active.target, active.start);
      const latest = this.worldToScreen(active.target, active.latest);
      const rect = this.normalizeRect(start.x, start.y, latest.x, latest.y);
      const draft = document.createElement("div");
      draft.className = "lasso-draft";
      draft.style.left = `${rect.x}px`;
      draft.style.top = `${rect.y}px`;
      draft.style.width = `${rect.width}px`;
      draft.style.height = `${rect.height}px`;
      document.body.appendChild(draft);
      this.draftEl = draft;
    },

    clearDraft() {
      if (this.draftEl) this.draftEl.remove();
      this.draftEl = null;
    },

    clearSelection() {
      this.selection = null;
      if (this.selectionEl) this.selectionEl.classList.add("hidden");
    },

    renderSelection() {
      if (!this.selection || !this.selectionEl) return;
      const annotations = this.getSelectedAnnotations(this.selection.target);
      if (!annotations.length) {
        this.clearSelection();
        return;
      }
      const bounds = this.getAnnotationsBounds(annotations);
      if (!bounds) {
        this.clearSelection();
        return;
      }
      const topLeft = this.worldToScreen(this.selection.target, { x: bounds.x, y: bounds.y });
      const bottomRight = this.worldToScreen(this.selection.target, { x: bounds.x + bounds.width, y: bounds.y + bounds.height });
      const screenRect = this.normalizeRect(topLeft.x, topLeft.y, bottomRight.x, bottomRight.y);

      this.selectionEl.classList.remove("hidden");
      this.selectionEl.style.left = `${screenRect.x}px`;
      this.selectionEl.style.top = `${screenRect.y}px`;
      this.selectionEl.style.width = `${Math.max(1, screenRect.width)}px`;
      this.selectionEl.style.height = `${Math.max(1, screenRect.height)}px`;
    },

    getTargetCanvas(target) {
      if (target.kind === "zoom") return document.getElementById("zoomAnnotationCanvas");
      return document.querySelector(`.annotation-canvas[data-page="${target.page}"]`);
    },

    worldToScreen(target, point) {
      const canvas = this.getTargetCanvas(target);
      if (!canvas) return { x: point.x, y: point.y };
      const rect = canvas.getBoundingClientRect();
      if (target.kind === "zoom") {
        const camera = ZoomManager.getCamera(target.id);
        return { x: rect.left + point.x + camera.x, y: rect.top + point.y + camera.y };
      }
      const scale = Number(canvas.dataset.coordScale || 1);
      return { x: rect.left + point.x * scale, y: rect.top + point.y * scale };
    },

    screenToWorld(target, clientX, clientY) {
      const canvas = this.getTargetCanvas(target);
      if (!canvas) return { x: clientX, y: clientY };
      const rect = canvas.getBoundingClientRect();
      if (target.kind === "zoom") {
        const camera = ZoomManager.getCamera(target.id);
        return { x: clientX - rect.left - camera.x, y: clientY - rect.top - camera.y };
      }
      const scale = Number(canvas.dataset.coordScale || 1);
      return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
    },

    pickByRect(target, rect) {
      return Utils.getAnnotations(target)
        .filter((annotation) => this.boundsOverlap(this.getAnnotationBounds(annotation), rect))
        .map((annotation) => annotation.id);
    },

    pickByPolygon(target, polygon) {
      if (polygon.length < 3) return [];
      return Utils.getAnnotations(target)
        .filter((annotation) => this.annotationHitsPolygon(annotation, polygon))
        .map((annotation) => annotation.id);
    },

    annotationHitsPolygon(annotation, polygon) {
      const bounds = this.getAnnotationBounds(annotation);
      const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      if (this.pointInPolygon(center, polygon)) return true;
      if (annotation.type === "stroke") {
        return annotation.points.some((point) => this.pointInPolygon(point, polygon));
      }
      return this.shapeCorners(annotation).some((point) => this.pointInPolygon(point, polygon));
    },

    pointInPolygon(point, polygon) {
      let inside = false;
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
        const xi = polygon[i].x;
        const yi = polygon[i].y;
        const xj = polygon[j].x;
        const yj = polygon[j].y;
        const intersects = yi > point.y !== yj > point.y &&
          point.x < ((xj - xi) * (point.y - yi)) / (yj - yi || 1) + xi;
        if (intersects) inside = !inside;
      }
      return inside;
    },

    getSelectedAnnotations(target = this.selection && this.selection.target) {
      if (!this.selection || !target) return [];
      const ids = new Set(this.selection.ids);
      return Utils.getAnnotations(target).filter((annotation) => ids.has(annotation.id));
    },

    getAnnotationsBounds(annotations) {
      const bounds = annotations.map((annotation) => this.getAnnotationBounds(annotation)).filter(Boolean);
      if (!bounds.length) return null;
      const minX = Math.min(...bounds.map((rect) => rect.x));
      const minY = Math.min(...bounds.map((rect) => rect.y));
      const maxX = Math.max(...bounds.map((rect) => rect.x + rect.width));
      const maxY = Math.max(...bounds.map((rect) => rect.y + rect.height));
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    },

    getAnnotationBounds(annotation) {
      if (annotation.type === "stroke") {
        const padding = (annotation.size || 1) / 2;
        const xs = annotation.points.map((point) => point.x);
        const ys = annotation.points.map((point) => point.y);
        return {
          x: Math.min(...xs) - padding,
          y: Math.min(...ys) - padding,
          width: Math.max(...xs) - Math.min(...xs) + padding * 2,
          height: Math.max(...ys) - Math.min(...ys) + padding * 2
        };
      }

      const corners = this.shapeCorners(annotation);
      const xs = corners.map((point) => point.x);
      const ys = corners.map((point) => point.y);
      const padding = annotation.strokeWidth || 1;
      return {
        x: Math.min(...xs) - padding,
        y: Math.min(...ys) - padding,
        width: Math.max(...xs) - Math.min(...xs) + padding * 2,
        height: Math.max(...ys) - Math.min(...ys) + padding * 2
      };
    },

    shapeCorners(annotation) {
      const rect = this.normalizeRect(annotation.x1, annotation.y1, annotation.x2, annotation.y2);
      const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      const corners = [
        { x: rect.x, y: rect.y },
        { x: rect.x + rect.width, y: rect.y },
        { x: rect.x + rect.width, y: rect.y + rect.height },
        { x: rect.x, y: rect.y + rect.height }
      ];
      if (!annotation.rotation) return corners;
      return corners.map((point) => this.rotatePoint(point, center, annotation.rotation));
    },

    normalizeRect(x1, y1, x2, y2) {
      return {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1)
      };
    },

    boundsOverlap(a, b) {
      return a && b &&
        a.x <= b.x + b.width &&
        a.x + a.width >= b.x &&
        a.y <= b.y + b.height &&
        a.y + a.height >= b.y;
    },

    copySelection() {
      const annotations = this.getSelectedAnnotations();
      if (!annotations.length) return;
      this.clipboard = {
        annotations: Utils.clone(annotations),
        bounds: this.getAnnotationsBounds(annotations)
      };
      UI.toast("已複製選取內容");
    },

    cutSelection() {
      const annotations = this.getSelectedAnnotations();
      if (!annotations.length) return;
      this.clipboard = {
        annotations: Utils.clone(annotations),
        bounds: this.getAnnotationsBounds(annotations)
      };
      const previous = Utils.clone(annotations);
      this.removeAnnotations(this.selection.target, this.selection.ids);
      HistoryManager.push(this.selection.target, { type: "removeAnnotations", annotations: previous });
      Renderer.redrawTarget(this.selection.target);
      UI.markDirty();
      UI.toast("已剪下選取內容");
      this.clearSelection();
    },

    pasteAt(target, point) {
      if (!this.clipboard || !this.clipboard.annotations.length) return;
      const bounds = this.clipboard.bounds;
      const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      const offset = { x: point.x - center.x, y: point.y - center.y };
      const annotations = this.clipboard.annotations.map((annotation) => {
        const clone = Utils.clone(annotation);
        clone.id = Utils.id(annotation.type === "shape" ? "shape" : "anno");
        clone.context = Utils.targetKey(target);
        this.offsetAnnotation(clone, offset.x, offset.y);
        clone.createdAt = Date.now();
        return clone;
      });
      Utils.getAnnotations(target).push(...annotations);
      HistoryManager.push(target, { type: "addAnnotations", annotations: Utils.clone(annotations) });
      Renderer.redrawTarget(target);
      this.selection = { target, ids: annotations.map((annotation) => annotation.id) };
      this.renderSelection();
      UI.markDirty();
      UI.toast("已貼上選取內容");
    },

    removeAnnotations(target, ids) {
      const idSet = new Set(ids);
      const annotations = Utils.getAnnotations(target);
      for (let index = annotations.length - 1; index >= 0; index -= 1) {
        if (idSet.has(annotations[index].id)) annotations.splice(index, 1);
      }
    },

    replaceAnnotations(target, replacements) {
      const map = new Map(replacements.map((annotation) => [annotation.id, annotation]));
      const annotations = Utils.getAnnotations(target);
      annotations.forEach((annotation, index) => {
        if (map.has(annotation.id)) annotations[index] = Utils.clone(map.get(annotation.id));
      });
    },

    offsetAnnotation(annotation, dx, dy) {
      if (annotation.type === "stroke") {
        annotation.points.forEach((point) => {
          point.x += dx;
          point.y += dy;
        });
        return;
      }
      annotation.x1 += dx;
      annotation.y1 += dy;
      annotation.x2 += dx;
      annotation.y2 += dy;
    },

    startResize(event, corner) {
      if (!this.selection) return;
      event.preventDefault();
      event.stopPropagation();
      const annotations = this.getSelectedAnnotations();
      this.transform = {
        type: "resize",
        corner,
        target: this.selection.target,
        ids: [...this.selection.ids],
        previous: Utils.clone(annotations),
        original: Utils.clone(annotations),
        bounds: this.getAnnotationsBounds(annotations)
      };
    },

    startRotate(event) {
      if (!this.selection) return;
      event.preventDefault();
      event.stopPropagation();
      const annotations = this.getSelectedAnnotations();
      const bounds = this.getAnnotationsBounds(annotations);
      const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      const point = this.screenToWorld(this.selection.target, event.clientX, event.clientY);
      this.transform = {
        type: "rotate",
        target: this.selection.target,
        ids: [...this.selection.ids],
        previous: Utils.clone(annotations),
        original: Utils.clone(annotations),
        bounds,
        center,
        startAngle: Math.atan2(point.y - center.y, point.x - center.x)
      };
    },

    handleTransformMove(event) {
      if (!this.transform) return;
      const point = this.screenToWorld(this.transform.target, event.clientX, event.clientY);
      if (this.transform.type === "resize") {
        const next = this.resizeAnnotations(this.transform.original, this.transform.bounds, this.transform.corner, point);
        this.replaceAnnotations(this.transform.target, next);
      }
      if (this.transform.type === "rotate") {
        const angle = Math.atan2(point.y - this.transform.center.y, point.x - this.transform.center.x);
        const next = this.rotateAnnotations(this.transform.original, this.transform.center, angle - this.transform.startAngle);
        this.replaceAnnotations(this.transform.target, next);
      }
      Renderer.redrawTarget(this.transform.target);
      this.selection = { target: this.transform.target, ids: [...this.transform.ids] };
      this.renderSelection();
    },

    finishTransform() {
      if (!this.transform) return;
      const target = this.transform.target;
      const ids = [...this.transform.ids];
      const next = Utils.clone(this.getSelectedAnnotations(target));
      HistoryManager.push(target, {
        type: "replaceAnnotations",
        previous: this.transform.previous,
        next
      });
      this.transform = null;
      this.selection = { target, ids };
      this.renderSelection();
      UI.markDirty();
    },

    resizeAnnotations(annotations, oldBounds, corner, point) {
      const nextBounds = this.getResizeBounds(oldBounds, corner, point);
      const sx = nextBounds.width / Math.max(1, oldBounds.width);
      const sy = nextBounds.height / Math.max(1, oldBounds.height);
      const averageScale = (sx + sy) / 2;

      return annotations.map((annotation) => {
        const clone = Utils.clone(annotation);
        if (clone.type === "stroke") {
          clone.points.forEach((strokePoint) => {
            strokePoint.x = nextBounds.x + (strokePoint.x - oldBounds.x) * sx;
            strokePoint.y = nextBounds.y + (strokePoint.y - oldBounds.y) * sy;
          });
          clone.size = Math.max(1, clone.size * averageScale);
          return clone;
        }
        clone.x1 = nextBounds.x + (clone.x1 - oldBounds.x) * sx;
        clone.y1 = nextBounds.y + (clone.y1 - oldBounds.y) * sy;
        clone.x2 = nextBounds.x + (clone.x2 - oldBounds.x) * sx;
        clone.y2 = nextBounds.y + (clone.y2 - oldBounds.y) * sy;
        clone.strokeWidth = Math.max(1, clone.strokeWidth * averageScale);
        return clone;
      });
    },

    getResizeBounds(oldBounds, handle, point) {
      const minSize = 6;
      const left = oldBounds.x;
      const right = oldBounds.x + oldBounds.width;
      const top = oldBounds.y;
      const bottom = oldBounds.y + oldBounds.height;

      if (handle === "n") {
        return { x: left, y: Math.min(point.y, bottom - minSize), width: oldBounds.width, height: bottom - Math.min(point.y, bottom - minSize) };
      }
      if (handle === "s") {
        return { x: left, y: top, width: oldBounds.width, height: Math.max(minSize, point.y - top) };
      }
      if (handle === "w") {
        const nextLeft = Math.min(point.x, right - minSize);
        return { x: nextLeft, y: top, width: right - nextLeft, height: oldBounds.height };
      }
      if (handle === "e") {
        return { x: left, y: top, width: Math.max(minSize, point.x - left), height: oldBounds.height };
      }

      const opposite = {
        nw: { x: right, y: bottom },
        ne: { x: left, y: bottom },
        sw: { x: right, y: top },
        se: { x: left, y: top }
      }[handle] || { x: left, y: top };
      const nextBounds = this.normalizeRect(opposite.x, opposite.y, point.x, point.y);
      nextBounds.width = Math.max(minSize, nextBounds.width);
      nextBounds.height = Math.max(minSize, nextBounds.height);
      return nextBounds;
    },

    rotateAnnotations(annotations, center, angle) {
      return annotations.map((annotation) => {
        const clone = Utils.clone(annotation);
        if (clone.type === "stroke") {
          clone.points = clone.points.map((point) => this.rotatePoint(point, center, angle));
          return clone;
        }
        const rect = this.normalizeRect(clone.x1, clone.y1, clone.x2, clone.y2);
        const shapeCenter = this.rotatePoint(
          { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
          center,
          angle
        );
        clone.x1 = shapeCenter.x - rect.width / 2;
        clone.y1 = shapeCenter.y - rect.height / 2;
        clone.x2 = shapeCenter.x + rect.width / 2;
        clone.y2 = shapeCenter.y + rect.height / 2;
        clone.rotation = (clone.rotation || 0) + angle;
        return clone;
      });
    },

    rotatePoint(point, center, angle) {
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const dx = point.x - center.x;
      const dy = point.y - center.y;
      return {
        x: center.x + dx * cos - dy * sin,
        y: center.y + dx * sin + dy * cos
      };
    }
  };

  const Renderer = {
    redrawTarget(target, extraAnnotations = []) {
      if (target.kind === "zoom") this.redrawZoom(target.id, extraAnnotations);
      else this.redrawPage(target.page, extraAnnotations);
    },

    redrawPage(pageNumber, extraAnnotations = []) {
      const canvas = document.querySelector(`.annotation-canvas[data-page="${pageNumber}"]`);
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const scale = Number(canvas.dataset.coordScale || 1);
      const annotations = Utils.getAnnotations({ kind: "page", page: pageNumber }).concat(extraAnnotations);
      this.drawAnnotationList(ctx, annotations, scale);
    },

    redrawZoom(zoomPageId, extraAnnotations = []) {
      const canvas = document.getElementById("zoomAnnotationCanvas");
      if (!canvas || canvas.dataset.zoomId !== zoomPageId) return;
      const zoomPage = boardState.zoomPages[zoomPageId];
      if (!zoomPage) return;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.translate(zoomPage.cameraX || 0, zoomPage.cameraY || 0);
      const annotations = Utils.getAnnotations({ kind: "zoom", id: zoomPageId }).concat(extraAnnotations);
      this.drawAnnotationList(ctx, annotations, 1);
      ctx.restore();
    },

    drawStrokeSegment(canvas, annotation, from, to, target = null) {
      const ctx = canvas.getContext("2d");
      const scale = Number(canvas.dataset.coordScale || 1);
      ctx.save();
      if (target && target.kind === "zoom") {
        const zoomPage = boardState.zoomPages[target.id];
        ctx.translate((zoomPage && zoomPage.cameraX) || 0, (zoomPage && zoomPage.cameraY) || 0);
      }
      this.applyStrokeStyle(ctx, annotation, scale);
      ctx.beginPath();
      ctx.moveTo(from.x * scale, from.y * scale);
      ctx.lineTo(to.x * scale, to.y * scale);
      ctx.stroke();
      ctx.restore();
    },

    drawZoomPreview(canvas, annotation, zoomPageId) {
      const zoomPage = boardState.zoomPages[zoomPageId];
      if (!zoomPage) return;
      const ctx = canvas.getContext("2d");
      ctx.save();
      ctx.translate(zoomPage.cameraX || 0, zoomPage.cameraY || 0);
      this.drawAnnotation(ctx, annotation, 1);
      ctx.restore();
    },

    drawAnnotation(ctx, annotation, scale) {
      if (annotation.type === "stroke") {
        this.drawStroke(ctx, annotation, scale);
      } else if (annotation.type === "shape") {
        this.drawShape(ctx, annotation, scale);
      }
    },

    drawAnnotationList(ctx, annotations, scale) {
      let highlighters = [];
      let normalAnnotations = [];
      const flushSegment = () => {
        if (highlighters.length) {
          this.drawHighlighterGroup(ctx, highlighters, scale);
          highlighters = [];
        }
        normalAnnotations.forEach((annotation) => this.drawAnnotation(ctx, annotation, scale));
        normalAnnotations = [];
      };

      annotations.forEach((annotation) => {
        if (annotation.type === "stroke" && annotation.tool === "highlighter") {
          highlighters.push(annotation);
          return;
        }
        if (annotation.type === "stroke" && annotation.tool === "eraser") {
          flushSegment();
          this.drawAnnotation(ctx, annotation, scale);
          return;
        }
        normalAnnotations.push(annotation);
      });
      flushSegment();
    },

    drawHighlighterGroup(ctx, annotations, scale) {
      const groups = new Map();
      annotations.forEach((annotation) => {
        const color = Utils.normalizeHex(annotation.color) || "#FFFF00";
        const opacity = Utils.clamp(Number(annotation.opacity) || 0.35, 0, 1);
        const key = `${color}|${opacity}`;
        if (!groups.has(key)) groups.set(key, { color, opacity, annotations: [] });
        groups.get(key).annotations.push(annotation);
      });

      groups.forEach((group) => {
        const mask = document.createElement("canvas");
        mask.width = ctx.canvas.width;
        mask.height = ctx.canvas.height;
        const maskCtx = mask.getContext("2d");
        maskCtx.setTransform(ctx.getTransform());
        maskCtx.globalAlpha = 1;
        maskCtx.globalCompositeOperation = "source-over";
        maskCtx.strokeStyle = group.color;
        maskCtx.lineCap = "round";
        maskCtx.lineJoin = "round";
        group.annotations.forEach((annotation) => {
          if (!annotation.points || annotation.points.length < 2) return;
          maskCtx.lineWidth = this.getToolWidth(annotation.size);
          maskCtx.beginPath();
          maskCtx.moveTo(annotation.points[0].x * scale, annotation.points[0].y * scale);
          for (let index = 1; index < annotation.points.length; index += 1) {
            maskCtx.lineTo(annotation.points[index].x * scale, annotation.points[index].y * scale);
          }
          maskCtx.stroke();
        });

        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = group.opacity;
        ctx.globalCompositeOperation = "source-over";
        ctx.drawImage(mask, 0, 0);
        ctx.restore();
      });
    },

    drawStroke(ctx, annotation, scale) {
      if (!annotation.points || annotation.points.length < 2) return;
      ctx.save();
      this.applyStrokeStyle(ctx, annotation, scale);
      ctx.beginPath();
      ctx.moveTo(annotation.points[0].x * scale, annotation.points[0].y * scale);
      for (let index = 1; index < annotation.points.length; index += 1) {
        ctx.lineTo(annotation.points[index].x * scale, annotation.points[index].y * scale);
      }
      ctx.stroke();
      ctx.restore();
    },

    applyStrokeStyle(ctx, annotation, scale) {
      ctx.globalCompositeOperation = annotation.tool === "eraser" ? "destination-out" : "source-over";
      ctx.globalAlpha = annotation.opacity;
      ctx.strokeStyle = annotation.color;
      ctx.lineWidth = this.getToolWidth(annotation.size);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
    },

    getToolWidth(width) {
      return Math.max(1, Number(width) || 1);
    },

    drawShape(ctx, annotation, scale) {
      const x1 = annotation.x1 * scale;
      const y1 = annotation.y1 * scale;
      const x2 = annotation.x2 * scale;
      const y2 = annotation.y2 * scale;
      const rect = this.normalizeRect(x1, y1, x2, y2);

      ctx.save();
      ctx.globalAlpha = this.getStrokeOpacity(annotation);
      ctx.strokeStyle = annotation.color || "#00AEEF";
      ctx.fillStyle = annotation.fillColor || "#FFFFFF";
      ctx.lineWidth = this.getToolWidth(annotation.strokeWidth);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      let drawX1 = x1;
      let drawY1 = y1;
      let drawX2 = x2;
      let drawY2 = y2;
      let drawRect = rect;
      if (annotation.rotation) {
        const centerX = rect.x + rect.width / 2;
        const centerY = rect.y + rect.height / 2;
        ctx.translate(centerX, centerY);
        ctx.rotate(annotation.rotation);
        drawX1 = -rect.width / 2;
        drawY1 = -rect.height / 2;
        drawX2 = rect.width / 2;
        drawY2 = rect.height / 2;
        drawRect = { x: -rect.width / 2, y: -rect.height / 2, width: rect.width, height: rect.height };
      }

      switch (annotation.shapeType) {
        case "line":
          this.line(ctx, drawX1, drawY1, drawX2, drawY2);
          this.drawLineMarkers(ctx, drawX1, drawY1, drawX2, drawY2, annotation);
          break;
        case "arrow":
          this.arrow(ctx, drawX1, drawY1, drawX2, drawY2);
          this.drawLineMarkers(ctx, drawX1, drawY1, drawX2, drawY2, annotation);
          break;
        case "doubleArrow":
          this.arrow(ctx, drawX1, drawY1, drawX2, drawY2);
          this.arrow(ctx, drawX2, drawY2, drawX1, drawY1);
          this.drawLineMarkers(ctx, drawX1, drawY1, drawX2, drawY2, annotation);
          break;
        case "dashedLine":
          ctx.setLineDash([12 * scale, 8 * scale]);
          this.line(ctx, drawX1, drawY1, drawX2, drawY2);
          ctx.setLineDash([]);
          this.drawLineMarkers(ctx, drawX1, drawY1, drawX2, drawY2, annotation);
          break;
        case "curve":
          this.curve(ctx, drawX1, drawY1, drawX2, drawY2);
          this.drawLineMarkers(ctx, drawX1, drawY1, drawX2, drawY2, annotation);
          break;
        case "circle":
          this.ellipse(ctx, drawRect.x, drawRect.y, Math.max(drawRect.width, drawRect.height), Math.max(drawRect.width, drawRect.height), annotation);
          break;
        case "ellipse":
          this.ellipse(ctx, drawRect.x, drawRect.y, drawRect.width, drawRect.height, annotation);
          break;
        case "square":
          this.rectangle(ctx, drawRect.x, drawRect.y, Math.max(drawRect.width, drawRect.height), Math.max(drawRect.width, drawRect.height), annotation);
          break;
        case "rectangle":
          this.rectangle(ctx, drawRect.x, drawRect.y, drawRect.width, drawRect.height, annotation);
          break;
        case "triangle":
          this.triangle(ctx, drawRect.x, drawRect.y, drawRect.width, drawRect.height, annotation);
          break;
        case "polygon":
          this.polygon(ctx, drawRect.x, drawRect.y, drawRect.width, drawRect.height, annotation, annotation.polygonSides);
          break;
        case "cube":
        case "cuboid":
          this.cube(ctx, drawRect.x, drawRect.y, drawRect.width, drawRect.height, annotation);
          break;
        case "cylinder":
          this.cylinder(ctx, drawRect.x, drawRect.y, drawRect.width, drawRect.height, annotation);
          break;
        case "cone":
          this.cone(ctx, drawRect.x, drawRect.y, drawRect.width, drawRect.height, annotation);
          break;
        case "sphere":
          this.sphere(ctx, drawRect.x, drawRect.y, drawRect.width, drawRect.height, annotation);
          break;
        case "table2":
        case "table3":
        case "table4":
        case "tableCustom":
          this.table(ctx, drawRect.x, drawRect.y, drawRect.width, drawRect.height, annotation.rows, annotation.cols, annotation);
          break;
        default:
          this.rectangle(ctx, drawRect.x, drawRect.y, drawRect.width, drawRect.height, annotation);
      }
      ctx.restore();
    },

    getStrokeOpacity(annotation) {
      return Utils.clamp(Number(annotation.opacity ?? 1), 0, 1);
    },

    getFillOpacity(annotation) {
      return Utils.clamp(Number(annotation.fillOpacity) || 0, 0, 1);
    },

    fillAndStrokePath(ctx, annotation) {
      const fillOpacity = this.getFillOpacity(annotation);
      if (fillOpacity > 0) {
        ctx.save();
        ctx.globalAlpha = fillOpacity;
        ctx.fillStyle = annotation.fillColor || "#FFFFFF";
        ctx.fill();
        ctx.restore();
      }
      ctx.save();
      ctx.globalAlpha = this.getStrokeOpacity(annotation);
      ctx.stroke();
      ctx.restore();
    },

    normalizeRect(x1, y1, x2, y2) {
      return {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1)
      };
    },

    line(ctx, x1, y1, x2, y2) {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    },

    arrow(ctx, x1, y1, x2, y2) {
      this.line(ctx, x1, y1, x2, y2);
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const headLength = Math.max(12, ctx.lineWidth * 4);
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - headLength * Math.cos(angle - Math.PI / 6), y2 - headLength * Math.sin(angle - Math.PI / 6));
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - headLength * Math.cos(angle + Math.PI / 6), y2 - headLength * Math.sin(angle + Math.PI / 6));
      ctx.stroke();
    },

    curve(ctx, x1, y1, x2, y2) {
      const cx = (x1 + x2) / 2;
      const cy = Math.min(y1, y2) - Math.abs(x2 - x1) / 4;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.quadraticCurveTo(cx, cy, x2, y2);
      ctx.stroke();
    },

    drawLineMarkers(ctx, x1, y1, x2, y2, annotation) {
      const startMarker = annotation.startMarker || "none";
      const endMarker = annotation.endMarker || "none";
      if (startMarker === "none" && endMarker === "none") return;
      const angle = Math.atan2(y2 - y1, x2 - x1);
      if (startMarker !== "none") this.lineMarker(ctx, x1, y1, angle + Math.PI, startMarker, annotation);
      if (endMarker !== "none") this.lineMarker(ctx, x2, y2, angle, endMarker, annotation);
    },

    lineMarker(ctx, x, y, angle, marker, annotation) {
      if (!["square", "diamond", "triangle"].includes(marker)) return;
      const size = Math.max(10, ctx.lineWidth * 3.2);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.beginPath();
      if (marker === "square") {
        ctx.rect(-size / 2, -size / 2, size, size);
      } else if (marker === "diamond") {
        ctx.moveTo(0, -size / 2);
        ctx.lineTo(size / 2, 0);
        ctx.lineTo(0, size / 2);
        ctx.lineTo(-size / 2, 0);
        ctx.closePath();
      } else if (marker === "triangle") {
        ctx.moveTo(size / 2, 0);
        ctx.lineTo(-size / 2, -size / 2);
        ctx.lineTo(-size / 2, size / 2);
        ctx.closePath();
      }
      this.fillAndStrokePath(ctx, annotation);
      ctx.restore();
    },

    rectangle(ctx, x, y, width, height, annotation) {
      ctx.beginPath();
      ctx.rect(x, y, width, height);
      this.fillAndStrokePath(ctx, annotation);
    },

    ellipse(ctx, x, y, width, height, annotation) {
      ctx.beginPath();
      ctx.ellipse(x + width / 2, y + height / 2, Math.abs(width / 2), Math.abs(height / 2), 0, 0, Math.PI * 2);
      this.fillAndStrokePath(ctx, annotation);
    },

    triangle(ctx, x, y, width, height, annotation) {
      ctx.beginPath();
      ctx.moveTo(x + width / 2, y);
      ctx.lineTo(x + width, y + height);
      ctx.lineTo(x, y + height);
      ctx.closePath();
      this.fillAndStrokePath(ctx, annotation);
    },

    polygon(ctx, x, y, width, height, annotation, sides) {
      const cx = x + width / 2;
      const cy = y + height / 2;
      const radiusX = Math.abs(width / 2);
      const radiusY = Math.abs(height / 2);
      const sideCount = Utils.clamp(Number(sides) || 6, 3, 24);
      ctx.beginPath();
      for (let i = 0; i < sideCount; i += 1) {
        const angle = -Math.PI / 2 + (Math.PI * 2 * i) / sideCount;
        const px = cx + Math.cos(angle) * radiusX;
        const py = cy + Math.sin(angle) * radiusY;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      this.fillAndStrokePath(ctx, annotation);
    },

    cube(ctx, x, y, width, height, annotation) {
      const offset = Math.min(width, height) * 0.18;
      this.rectangle(ctx, x, y + offset, Math.max(1, width - offset), Math.max(1, height - offset), annotation);
      this.rectangle(ctx, x + offset, y, Math.max(1, width - offset), Math.max(1, height - offset), annotation);
      this.line(ctx, x, y + offset, x + offset, y);
      this.line(ctx, x + width - offset, y + offset, x + width, y);
      this.line(ctx, x, y + height, x + offset, y + height - offset);
      this.line(ctx, x + width - offset, y + height, x + width, y + height - offset);
    },

    cylinder(ctx, x, y, width, height, annotation) {
      const ry = Math.max(6, height * 0.12);
      const fillOpacity = this.getFillOpacity(annotation);
      if (fillOpacity > 0) {
        ctx.save();
        ctx.globalAlpha = fillOpacity;
        ctx.fillStyle = annotation.fillColor || "#FFFFFF";
        ctx.fillRect(x, y + ry, width, Math.max(1, height - ry * 2));
        ctx.restore();
      }
      ctx.beginPath();
      ctx.ellipse(x + width / 2, y + ry, Math.abs(width / 2), ry, 0, 0, Math.PI * 2);
      this.fillAndStrokePath(ctx, annotation);
      this.line(ctx, x, y + ry, x, y + height - ry);
      this.line(ctx, x + width, y + ry, x + width, y + height - ry);
      ctx.beginPath();
      ctx.ellipse(x + width / 2, y + height - ry, Math.abs(width / 2), ry, 0, 0, Math.PI * 2);
      this.fillAndStrokePath(ctx, annotation);
    },

    cone(ctx, x, y, width, height, annotation) {
      const bottomY = y + height;
      ctx.beginPath();
      ctx.moveTo(x + width / 2, y);
      ctx.lineTo(x, bottomY - height * 0.12);
      ctx.lineTo(x + width, bottomY - height * 0.12);
      ctx.closePath();
      this.fillAndStrokePath(ctx, annotation);
      ctx.beginPath();
      ctx.ellipse(x + width / 2, bottomY - height * 0.12, Math.abs(width / 2), Math.max(5, height * 0.1), 0, 0, Math.PI * 2);
      this.fillAndStrokePath(ctx, annotation);
    },

    sphere(ctx, x, y, width, height, annotation) {
      this.ellipse(ctx, x, y, width, height, annotation);
      ctx.beginPath();
      ctx.ellipse(x + width / 2, y + height / 2, Math.abs(width * 0.18), Math.abs(height / 2), 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(x + width / 2, y + height / 2, Math.abs(width / 2), Math.abs(height * 0.18), 0, 0, Math.PI * 2);
      ctx.stroke();
    },

    table(ctx, x, y, width, height, rows, cols, annotation) {
      rows = Utils.clamp(Number(rows) || 1, 1, 12);
      cols = Utils.clamp(Number(cols) || 1, 1, 12);
      this.rectangle(ctx, x, y, width, height, annotation);
      for (let row = 1; row < rows; row += 1) {
        const yy = y + (height * row) / rows;
        this.line(ctx, x, yy, x + width, yy);
      }
      for (let col = 1; col < cols; col += 1) {
        const xx = x + (width * col) / cols;
        this.line(ctx, xx, y, xx, y + height);
      }
    }
  };

  const HistoryManager = {
    push(target, action) {
      const history = Utils.ensureHistory(target);
      history.undoStack.push(action);
      history.redoStack = [];
    },

    undo(target) {
      const history = Utils.ensureHistory(target);
      const action = history.undoStack.pop();
      if (!action) {
        UI.toast("沒有可還原的動作");
        return;
      }
      this.applyInverse(target, action);
      history.redoStack.push(action);
      Renderer.redrawTarget(target);
      if (target.kind === "page") ZoomManager.renderMarkers(target.page);
      UI.markDirty();
    },

    redo(target) {
      const history = Utils.ensureHistory(target);
      const action = history.redoStack.pop();
      if (!action) {
        UI.toast("沒有可返還原的動作");
        return;
      }
      this.applyForward(target, action);
      history.undoStack.push(action);
      Renderer.redrawTarget(target);
      if (target.kind === "page") ZoomManager.renderMarkers(target.page);
      UI.markDirty();
    },

    applyInverse(target, action) {
      const annotations = Utils.getAnnotations(target);
      if (action.type === "addAnnotation") {
        const index = annotations.findIndex((item) => item.id === action.annotation.id);
        if (index >= 0) annotations.splice(index, 1);
      }
      if (action.type === "addAnnotations") {
        const ids = new Set(action.annotations.map((annotation) => annotation.id));
        for (let index = annotations.length - 1; index >= 0; index -= 1) {
          if (ids.has(annotations[index].id)) annotations.splice(index, 1);
        }
      }
      if (action.type === "removeAnnotations") {
        annotations.push(...Utils.clone(action.annotations));
      }
      if (action.type === "replaceAnnotations") {
        LassoManager.replaceAnnotations(target, action.previous);
      }
      if (action.type === "clearAnnotations") {
        annotations.length = 0;
        annotations.push(...Utils.clone(action.previous));
      }
      if (action.type === "saveZoomPage") {
        const page = Utils.getPage(action.marker.page);
        page.zoomMarkers = page.zoomMarkers.filter((marker) => marker.id !== action.marker.id);
        if (boardState.zoomPages[action.zoomPageId]) {
          boardState.zoomPages[action.zoomPageId].saved = false;
          boardState.zoomPages[action.zoomPageId].marker = null;
        }
      }
    },

    applyForward(target, action) {
      const annotations = Utils.getAnnotations(target);
      if (action.type === "addAnnotation") {
        annotations.push(Utils.clone(action.annotation));
      }
      if (action.type === "addAnnotations") {
        annotations.push(...Utils.clone(action.annotations));
      }
      if (action.type === "removeAnnotations") {
        const ids = new Set(action.annotations.map((annotation) => annotation.id));
        for (let index = annotations.length - 1; index >= 0; index -= 1) {
          if (ids.has(annotations[index].id)) annotations.splice(index, 1);
        }
      }
      if (action.type === "replaceAnnotations") {
        LassoManager.replaceAnnotations(target, action.next);
      }
      if (action.type === "clearAnnotations") {
        annotations.length = 0;
      }
      if (action.type === "saveZoomPage") {
        const page = Utils.getPage(action.marker.page);
        if (!page.zoomMarkers.some((marker) => marker.id === action.marker.id)) {
          page.zoomMarkers.push(Utils.clone(action.marker));
        }
        if (boardState.zoomPages[action.zoomPageId]) {
          boardState.zoomPages[action.zoomPageId].saved = true;
          boardState.zoomPages[action.zoomPageId].marker = Utils.clone(action.marker);
        }
      }
    }
  };

  const ZoomManager = {
    resizeTimer: null,
    imageCache: new Map(),
    pdfReturnView: null,

    init() {
      const zoomCanvas = document.getElementById("zoomAnnotationCanvas");
      zoomCanvas.dataset.kind = "zoom";
      zoomCanvas.dataset.coordScale = "1";
      CanvasManager.bindCanvas(zoomCanvas);

      $("#saveZoomPage").on("click", () => this.saveActive());
      $("#deleteZoomPage").on("click", () => this.deleteActive());

      $(window).on("resize", () => {
        if (boardState.mode !== "zoom" || !boardState.activeZoomPageId) return;
        window.clearTimeout(this.resizeTimer);
        this.resizeTimer = window.setTimeout(() => this.renderZoomPage(boardState.activeZoomPageId), 120);
      });
    },

    createFromSelection(pageNumber, rect) {
      const wrapper = document.querySelector(`.pdf-page[data-page="${pageNumber}"]`);
      if (!wrapper) return;
      const pdfCanvas = wrapper.querySelector(".pdf-canvas");
      const annotationCanvas = wrapper.querySelector(".annotation-canvas");
      const scale = Number(annotationCanvas.dataset.coordScale || 1);
      const sx = Math.round(rect.x * scale);
      const sy = Math.round(rect.y * scale);
      const sw = Math.max(1, Math.round(rect.width * scale));
      const sh = Math.max(1, Math.round(rect.height * scale));
      const capture = document.createElement("canvas");
      capture.width = sw;
      capture.height = sh;
      capture.getContext("2d").drawImage(pdfCanvas, sx, sy, sw, sh, 0, 0, sw, sh);

      const id = Utils.id("zoom");
      const boardSize = this.getZoomBoardSize(sw, sh);
      boardState.zoomPages[id] = {
        id,
        sourcePage: pageNumber,
        rect: Utils.clone(rect),
        spaceType: "infinite-whiteboard",
        imageData: capture.toDataURL("image/png"),
        imageWidth: boardSize.width,
        imageHeight: boardSize.height,
        imageX: -boardSize.width / 2,
        imageY: 80,
        cameraX: null,
        cameraY: 0,
        annotations: [],
        saved: false,
        marker: null,
        createdAt: Date.now()
      };
      Utils.ensureHistory({ kind: "zoom", id });
      this.enter(id);
      UI.markDirty();
    },

    createBlankFromPoint(pageNumber, point) {
      const id = Utils.id("zoom");
      const x = Number(point && point.x) || 0;
      const y = Number(point && point.y) || 0;
      boardState.zoomPages[id] = {
        id,
        sourcePage: pageNumber,
        rect: { x, y, width: 1, height: 1 },
        spaceType: "infinite-whiteboard",
        imageData: null,
        imageWidth: 0,
        imageHeight: 0,
        imageX: 0,
        imageY: 0,
        cameraX: null,
        cameraY: 0,
        annotations: [],
        saved: false,
        marker: null,
        createdAt: Date.now()
      };
      Utils.ensureHistory({ kind: "zoom", id });
      this.enter(id);
      UI.markDirty();
    },

    getZoomBoardSize(sourceWidth, sourceHeight) {
      const maxWidth = 1040;
      const maxHeight = 820;
      const minLongSide = 640;
      let width = sourceWidth * 2.2;
      let height = sourceHeight * 2.2;
      const grow = Math.max(1, minLongSide / Math.max(width, height));
      width *= grow;
      height *= grow;
      const shrink = Math.min(1, maxWidth / width, maxHeight / height);
      return {
        width: Math.max(160, Math.round(width * shrink)),
        height: Math.max(160, Math.round(height * shrink))
      };
    },

    enter(id) {
      const zoomPage = boardState.zoomPages[id];
      if (!zoomPage) return;
      this.pdfReturnView = this.capturePdfReturnView();
      boardState.mode = "zoom";
      boardState.activeZoomPageId = id;
      $("#boardScreen").addClass("zoom-active");
      $("#pdfBoard").addClass("hidden");
      $("#zoomScreen").addClass("active");
      $("#zoomAnnotationCanvas").attr("data-zoom-id", id);
      this.renderZoomPage(id);
      ToolManager.setTool("cursor");
      UI.updateStatus();
      CanvasManager.refreshCanvasCursors();
    },

    capturePdfReturnView() {
      const board = $("#pdfBoard")[0];
      if (!board) return null;
      return {
        scrollLeft: board.scrollLeft,
        scrollTop: board.scrollTop,
        currentPage: boardState.currentPage || 1
      };
    },

    exitToPdf(options = {}) {
      const restoreView = options.restoreView !== false;
      boardState.mode = "pdf";
      boardState.activeZoomPageId = null;
      $("#boardScreen").removeClass("zoom-active");
      $("#zoomScreen").removeClass("active");
      $("#pdfBoard").removeClass("hidden");
      if (restoreView) {
        this.restorePdfReturnView();
      } else {
        this.pdfReturnView = null;
      }
      UI.updateStatus();
    },

    restorePdfReturnView() {
      const view = this.pdfReturnView;
      const board = $("#pdfBoard")[0];
      this.pdfReturnView = null;
      if (!view || !board) return;

      boardState.currentPage = view.currentPage;
      const previousScrollBehavior = board.style.scrollBehavior;
      board.style.scrollBehavior = "auto";
      board.scrollLeft = view.scrollLeft;
      board.scrollTop = view.scrollTop;
      window.requestAnimationFrame(() => {
        board.style.scrollBehavior = previousScrollBehavior;
        board.scrollLeft = view.scrollLeft;
        board.scrollTop = view.scrollTop;
        UI.updateStatus();
        ToolManager.updateEdgeSliders();
        LassoManager.renderSelection();
      });
    },

    renderZoomPage(id) {
      const zoomPage = boardState.zoomPages[id];
      const imageCanvas = document.getElementById("zoomImageCanvas");
      const annotationCanvas = document.getElementById("zoomAnnotationCanvas");
      if (!zoomPage) return;

      this.ensureZoomLayout(zoomPage);
      this.resizeViewportCanvases();
      annotationCanvas.dataset.coordScale = "1";

      this.renderZoomImage(id);
      this.renderZoomAnnotations(id);
    },

    ensureZoomLayout(zoomPage) {
      const width = zoomPage.imageWidth || zoomPage.boardWidth || zoomPage.boardSize || 820;
      const height = zoomPage.imageHeight || zoomPage.boardHeight || zoomPage.boardSize || width;
      zoomPage.imageWidth = width;
      zoomPage.imageHeight = height;
      if (!Number.isFinite(zoomPage.imageX)) zoomPage.imageX = -width / 2;
      if (!Number.isFinite(zoomPage.imageY)) zoomPage.imageY = 80;

      const stage = document.getElementById("zoomStage");
      const stageWidth = Math.max(320, stage.clientWidth || window.innerWidth);
      if (!Number.isFinite(zoomPage.cameraX)) zoomPage.cameraX = stageWidth / 2;
      if (!Number.isFinite(zoomPage.cameraY)) zoomPage.cameraY = 0;
    },

    resizeViewportCanvases() {
      const stage = document.getElementById("zoomStage");
      const width = Math.max(320, Math.round(stage.clientWidth || window.innerWidth));
      const height = Math.max(240, Math.round(stage.clientHeight || window.innerHeight - 160));
      ["zoomImageCanvas", "zoomAnnotationCanvas"].forEach((id) => {
        const canvas = document.getElementById(id);
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
      });
    },

    getCamera(id) {
      const zoomPage = boardState.zoomPages[id];
      if (!zoomPage) return { x: 0, y: 0 };
      this.ensureZoomLayout(zoomPage);
      return { x: zoomPage.cameraX || 0, y: zoomPage.cameraY || 0 };
    },

    screenToWorld(event, canvas) {
      const target = CanvasManager.getCanvasTarget(canvas);
      const zoomPage = boardState.zoomPages[target.id];
      const rect = canvas.getBoundingClientRect();
      if (!zoomPage) {
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
      }
      this.ensureZoomLayout(zoomPage);
      return {
        x: event.clientX - rect.left - zoomPage.cameraX,
        y: event.clientY - rect.top - zoomPage.cameraY
      };
    },

    panTo(id, cameraX, cameraY) {
      const zoomPage = boardState.zoomPages[id];
      if (!zoomPage) return;
      zoomPage.cameraX = cameraX;
      zoomPage.cameraY = cameraY;
      this.renderZoomImage(id);
      Renderer.redrawZoom(id);
      LassoManager.renderSelection();
    },

    drawBlankWhiteboard(ctx, width, height) {
      ctx.save();
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    },

    getZoomImage(id) {
      const zoomPage = boardState.zoomPages[id];
      if (!zoomPage) return Promise.resolve(null);
      if (!zoomPage.imageData) return Promise.resolve(null);
      const cached = this.imageCache.get(id);
      if (cached && cached.src === zoomPage.imageData && cached.complete) {
        return Promise.resolve(cached);
      }

      return new Promise((resolve) => {
        const image = new Image();
        image.onload = () => {
          this.imageCache.set(id, image);
          resolve(image);
        };
        image.onerror = () => resolve(null);
        image.src = zoomPage.imageData;
      });
    },

    async renderZoomImage(id) {
      const zoomPage = boardState.zoomPages[id];
      const imageCanvas = document.getElementById("zoomImageCanvas");
      if (!zoomPage || !imageCanvas) return;
      this.ensureZoomLayout(zoomPage);
      const ctx = imageCanvas.getContext("2d");
      this.drawBlankWhiteboard(ctx, imageCanvas.width, imageCanvas.height);

      const loadedImage = await this.getZoomImage(id);
      if (!loadedImage) return;
      ctx.save();
      ctx.drawImage(
        loadedImage,
        zoomPage.imageX + zoomPage.cameraX,
        zoomPage.imageY + zoomPage.cameraY,
        zoomPage.imageWidth,
        zoomPage.imageHeight
      );
      ctx.restore();
    },

    renderZoomAnnotations(id) {
      Renderer.redrawZoom(id);
    },

    saveActive() {
      const id = boardState.activeZoomPageId;
      const zoomPage = boardState.zoomPages[id];
      if (!zoomPage) return;

      if (!zoomPage.saved) {
        const marker = {
          id: Utils.id("marker"),
          page: zoomPage.sourcePage,
          x: zoomPage.rect.x + zoomPage.rect.width / 2,
          y: zoomPage.rect.y + zoomPage.rect.height / 2,
          zoomPageId: id
        };
        zoomPage.saved = true;
        zoomPage.marker = Utils.clone(marker);
        Utils.getPage(zoomPage.sourcePage).zoomMarkers.push(marker);
        HistoryManager.push({ kind: "page", page: zoomPage.sourcePage }, {
          type: "saveZoomPage",
          zoomPageId: id,
          marker: Utils.clone(marker)
        });
      }

      this.renderMarkers(zoomPage.sourcePage);
      this.exitToPdf();
      UI.markDirty();
      UI.toast("已儲存放大頁");
    },

    async deleteActive() {
      const id = boardState.activeZoomPageId;
      const zoomPage = boardState.zoomPages[id];
      if (!zoomPage) return;
      const confirmed = await UI.confirm("確定要刪除此放大頁？", {
        confirmText: "刪除",
        danger: true
      });
      if (!confirmed) return;
      const page = Utils.getPage(zoomPage.sourcePage);
      page.zoomMarkers = page.zoomMarkers.filter((marker) => marker.zoomPageId !== id);
      delete boardState.zoomPages[id];
      delete boardState.history[`zoom_${id}`];
      this.renderMarkers(zoomPage.sourcePage);
      this.exitToPdf();
      UI.markDirty();
      UI.toast("已刪除放大頁");
    },

    renderMarkers(pageNumber) {
      const wrapper = document.querySelector(`.pdf-page[data-page="${pageNumber}"]`);
      if (!wrapper) return;
      const layer = wrapper.querySelector(".marker-layer");
      layer.innerHTML = "";
      const annotationCanvas = wrapper.querySelector(".annotation-canvas");
      const scale = Number(annotationCanvas.dataset.coordScale || 1);
      Utils.getPage(pageNumber).zoomMarkers.forEach((marker) => {
        const button = document.createElement("button");
        button.className = "zoom-marker";
        button.type = "button";
        button.title = "開啟放大頁";
        button.setAttribute("aria-label", "開啟放大頁");
        button.style.left = `${marker.x * scale}px`;
        button.style.top = `${marker.y * scale}px`;
        button.innerHTML = '<i data-lucide="plus"></i>';
        button.addEventListener("click", () => this.enter(marker.zoomPageId));
        layer.appendChild(button);
      });
      UI.refreshIcons();
    }
  };

  const StorageManager = {
    init() {
    },

    bindJsonInput(input, removeAfterUse = false) {
      if (!input) return;
      input.addEventListener("change", (event) => {
        const file = event.target.files && event.target.files[0];
        if (file) this.importFromFile(file);
        event.target.value = "";
        if (removeAfterUse) input.remove();
      }, { once: removeAfterUse });
    },

    openJsonPicker() {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json,.jason,application/json,text/json";
      input.className = "file-input";
      document.body.appendChild(input);
      this.bindJsonInput(input, true);
      input.value = "";
      input.click();

      window.setTimeout(() => {
        if (document.body.contains(input) && (!input.files || input.files.length === 0)) {
          input.remove();
        }
      }, 30000);
    },

    isJsonFile(file) {
      return Boolean(
        file &&
          (file.type === "application/json" ||
            file.type === "text/json" ||
            /\.(json|jason)$/i.test(file.name || ""))
      );
    },

    serialize() {
      return {
        version: 1,
        exportedAt: new Date().toISOString(),
        fileName: boardState.fileName,
        state: {
          pages: boardState.pages,
          zoomPages: boardState.zoomPages,
          pen: boardState.pen,
          highlighter: boardState.highlighter,
          eraser: boardState.eraser,
          lasso: boardState.lasso,
          shape: boardState.shape,
          customColors: boardState.customColors
        }
      };
    },

    autosave() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.serialize()));
      } catch (error) {
        console.warn("Autosave failed", error);
      }
    },

    save() {
      if (!pdfDocument && !boardState.fileName) {
        UI.toast("尚未開啟 PDF", "error");
        return;
      }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.serialize()));
        UI.markSaved("已暫存");
        UI.toast("已暫存到本機");
      } catch (error) {
        console.error(error);
        UI.toast("儲存失敗", "error");
      }
    },

    downloadJSON() {
      if (!boardState.fileName) {
        UI.toast("尚未開啟 PDF", "error");
        return;
      }
      const blob = new Blob([JSON.stringify(this.serialize(), null, 2)], {
        type: "application/json"
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${boardState.fileName.replace(/\.pdf$/i, "") || "digital-board"}-annotations.json`;
      link.click();
      URL.revokeObjectURL(url);
      UI.markSaved("已匯出 JSON");
    },

    async importFromFile(file) {
      if (!this.isJsonFile(file)) {
        UI.toast("請選擇 JSON 或 JASON 檔案", "error");
        return;
      }
      try {
        const text = await file.text();
        const payload = JSON.parse(text);
        if (!pdfDocument) {
          pendingImportData = payload;
          UI.toast("註記已暫存，請上傳對應 PDF");
          return;
        }
        this.applyData(payload);
      } catch (error) {
        console.error(error);
        UI.toast("JSON 匯入失敗", "error");
      }
    },

    offerCachedRestore(fileName) {
      try {
        const cached = localStorage.getItem(STORAGE_KEY);
        if (!cached) return;
        const payload = JSON.parse(cached);
        if (payload.fileName !== fileName) return;
        if (window.confirm("找到此 PDF 的本機暫存註記，是否還原？")) {
          this.applyData(payload);
        }
      } catch (error) {
        console.warn("Restore failed", error);
      }
    },

    applyData(payload) {
      const data = payload && payload.state ? payload.state : payload;
      if (!data) {
        UI.toast("JSON 格式不正確", "error");
        return;
      }

      boardState.pages = data.pages || {};
      boardState.zoomPages = data.zoomPages || {};
      boardState.pen = Object.assign(boardState.pen, data.pen || {});
      boardState.highlighter = Object.assign(boardState.highlighter, data.highlighter || {});
      boardState.eraser = Object.assign(boardState.eraser, data.eraser || {});
      boardState.lasso = Object.assign(boardState.lasso, data.lasso || {});
      boardState.shape = Object.assign(boardState.shape, data.shape || {});
      boardState.customColors = Object.assign(boardState.customColors, data.customColors || {});
      boardState.history = {};

      Object.keys(boardState.pages).forEach((page) => Utils.ensureHistory({ kind: "page", page: Number(page) }));
      Object.keys(boardState.zoomPages).forEach((id) => Utils.ensureHistory({ kind: "zoom", id }));

      ColorManager.syncPanelValues();
      $(".pdf-page").each((_, pageElement) => {
        const page = Number(pageElement.dataset.page);
        Renderer.redrawPage(page);
        ZoomManager.renderMarkers(page);
      });
      if (boardState.mode === "zoom" && boardState.activeZoomPageId) {
        ZoomManager.renderZoomPage(boardState.activeZoomPageId);
      }

      UI.markDirty();
      UI.toast("已匯入註記資料");
    }
  };

  const App = {
    init() {
      UI.init();
      PDFViewer.init();
      ToolManager.init();
      PanelManager.init();
      ColorManager.init();
      ZoomManager.init();
      LassoManager.init();
      $("#eraserPreview").css("--preview-size", `${boardState.eraser.size}px`);
    }
  };

  $(App.init.bind(App));
})();
