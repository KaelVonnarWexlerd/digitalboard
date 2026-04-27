(() => {
  "use strict";

  const STORAGE_KEY = "digitalBoardState:v1";
  const MIN_ZOOM = 0.55;
  const MAX_ZOOM = 2.5;

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
    shape: {
      group: "line",
      type: "line",
      strokeWidth: 3,
      color: "#00AEEF",
      opacity: 1,
      rows: 3,
      cols: 3
    },
    customColors: {
      pen: new Array(36).fill(null),
      highlighter: new Array(36).fill(null),
      shape: new Array(36).fill(null)
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

  const UI = {
    init() {
      this.refreshIcons();
      $(window).on("beforeunload", (event) => {
        if (!dirty) return undefined;
        event.preventDefault();
        event.returnValue = "";
        return "";
      });
    },

    refreshIcons() {
      if (window.lucide) {
        window.lucide.createIcons();
      }
    },

    showBoard() {
      $("body").addClass("is-board");
      $("#boardScreen").addClass("active");
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
      $("#pageIndicator").text(`Page ${boardState.currentPage || 0} / ${pageCount}`);
      $("#zoomIndicator").text(`${Math.round(boardState.scale * 100)}%`);

      if (boardState.mode === "zoom") {
        const zoomPage = boardState.zoomPages[boardState.activeZoomPageId];
        const pageText = zoomPage ? `Zoom Board: Page ${zoomPage.sourcePage}` : "Zoom Board";
        $("#modeIndicator").text(pageText);
      } else {
        $("#modeIndicator").text("PDF Board");
      }
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
    }
  };

  const PDFViewer = {
    resizeTimer: null,

    init() {
      if (window.pdfjsLib) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      }

      $("#pdfUpload").on("change", (event) => {
        const file = event.target.files && event.target.files[0];
        if (file) this.loadFile(file);
        event.target.value = "";
      });

      $("#uploadBox")
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
          if (file) this.loadFile(file);
        });

      $("#pdfBoard").on("scroll", () => this.updateCurrentPageFromScroll());
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
        this.resizeTimer = window.setTimeout(() => this.renderAllPages(), 160);
      });
    },

    async loadFile(file) {
      if (!file || file.type !== "application/pdf") {
        UI.toast("請選擇 PDF 檔案", "error");
        return;
      }
      if (!window.pdfjsLib) {
        UI.toast("PDF.js 尚未載入，請確認網路連線", "error");
        return;
      }

      try {
        UI.toast("正在載入 PDF");
        const data = await file.arrayBuffer();
        pdfDocument = await window.pdfjsLib.getDocument({ data }).promise;
        Utils.resetForFile(file.name);
        UI.showBoard();
        ToolManager.setTool("cursor");
        await this.renderAllPages();

        if (pendingImportData) {
          StorageManager.applyData(pendingImportData);
          pendingImportData = null;
        } else {
          StorageManager.offerCachedRestore(file.name);
        }

        UI.markSaved("已開啟");
      } catch (error) {
        console.error(error);
        UI.toast("PDF 載入失敗", "error");
      }
    },

    async renderAllPages() {
      if (!pdfDocument) return;
      const token = ++renderToken;
      $("#pdfBoard").empty();

      for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
        if (token !== renderToken) return;
        Utils.getPage(pageNumber);
        Utils.ensureHistory({ kind: "page", page: pageNumber });
        const page = await pdfDocument.getPage(pageNumber);
        if (token !== renderToken) return;
        await this.renderPage(pageNumber, page);
      }

      this.updateCurrentPageFromScroll();
      UI.updateStatus();
      CanvasManager.refreshCanvasCursors();
    },

    getAvailablePageWidth() {
      const board = $("#pdfBoard")[0];
      if (!board) return 960;
      const styles = window.getComputedStyle(board);
      const paddingX = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
      return Math.max(320, board.clientWidth - paddingX);
    },

    getFitScaleForPage(page) {
      const viewport = page.getViewport({ scale: 1 });
      return this.getAvailablePageWidth() / viewport.width;
    },

    async renderPage(pageNumber, page) {
      const scale = this.getFitScaleForPage(page) * boardState.scale;
      const viewport = page.getViewport({ scale });
      const wrapper = document.createElement("div");
      wrapper.className = "pdf-page";
      wrapper.dataset.page = String(pageNumber);

      const pdfCanvas = document.createElement("canvas");
      pdfCanvas.className = "pdf-canvas";
      const annotationCanvas = document.createElement("canvas");
      annotationCanvas.className = "annotation-canvas";
      annotationCanvas.dataset.page = String(pageNumber);
      annotationCanvas.dataset.kind = "page";
      annotationCanvas.dataset.coordScale = String(scale);

      const markerLayer = document.createElement("div");
      markerLayer.className = "marker-layer";
      const selectionLayer = document.createElement("div");
      selectionLayer.className = "selection-layer";

      wrapper.style.width = `${viewport.width}px`;
      wrapper.style.height = `${viewport.height}px`;
      pdfCanvas.width = viewport.width;
      pdfCanvas.height = viewport.height;
      annotationCanvas.width = viewport.width;
      annotationCanvas.height = viewport.height;

      wrapper.append(pdfCanvas, annotationCanvas, markerLayer, selectionLayer);
      $("#pdfBoard")[0].appendChild(wrapper);

      await page.render({
        canvasContext: pdfCanvas.getContext("2d"),
        viewport
      }).promise;

      CanvasManager.bindCanvas(annotationCanvas);
      Renderer.redrawPage(pageNumber);
      ZoomManager.renderMarkers(pageNumber);
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
      }
    },

    zoomBy(delta) {
      if (!pdfDocument || boardState.mode === "zoom") return;
      const nextScale = Utils.clamp(Number((boardState.scale + delta).toFixed(2)), MIN_ZOOM, MAX_ZOOM);
      if (nextScale === boardState.scale) return;
      boardState.scale = nextScale;
      this.renderAllPages();
    }
  };

  const ToolManager = {
    init() {
      $(".tool-btn[data-tool]").on("click", (event) => {
        this.setTool($(event.currentTarget).data("tool"));
      });

      $(".tool-btn[data-action]").on("click", (event) => {
        this.runAction($(event.currentTarget).data("action"));
      });

      $(".rail-handle").on("click", (event) => {
        $(event.currentTarget).closest(".tool-rail").toggleClass("collapsed");
      });

      $(document).on("keydown", (event) => this.handleKeydown(event));
    },

    setTool(tool) {
      boardState.currentTool = tool;
      $(".tool-btn[data-tool]").removeClass("active");
      $(`.tool-btn[data-tool="${tool}"]`).addClass("active");
      PanelManager.open(tool);
      CanvasManager.refreshCanvasCursors();

      if (tool === "clearPage") {
        UI.toast("點擊目前頁面即可清除該頁註記");
      }
      if (tool === "zoomArea") {
        UI.toast("在 PDF 頁面拖曳出矩形區域");
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
          $("#jsonUpload").trigger("click");
          break;
        default:
          break;
      }
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
    init() {
      $(".panel-close").on("click", () => $(".floating-panel").removeClass("active"));
    },

    open(tool) {
      $(".floating-panel").removeClass("active");
      const panelMap = {
        pen: "#penPanel",
        highlighter: "#highlighterPanel",
        eraser: "#eraserPanel",
        shape: "#shapePanel"
      };
      if (panelMap[tool]) {
        $(panelMap[tool]).addClass("active");
      }
    }
  };

  const ColorManager = {
    init() {
      this.buildColorTools("pen");
      this.buildColorTools("highlighter");
      this.buildColorTools("shape");
      this.bindInputs();
      this.buildShapeOptions("line");
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
      boardState.customColors[tool].forEach((color, index) => {
        $("<button>", {
          class: "color-chip",
          type: "button",
          title: color || "自訂顏色",
          "aria-label": color || "自訂顏色"
        })
          .toggleClass("empty", !color)
          .css("background", color || "")
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
          .appendTo($grid);
      });
    },

    buildHueGrid(tool) {
      const $grid = $(`#${tool}ColorWheel`).empty();
      for (let h = 0; h < 360; h += 1) {
        const color = `hsl(${h}, 100%, 50%)`;
        $("<button>", {
          class: "hue-chip",
          type: "button",
          title: `${h}`
        })
          .css("background", color)
          .on("click", () => this.setColor(tool, this.hslToHex(h, 100, 50)))
          .appendTo($grid);
      }
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
      if (tool === "shape") boardState.shape.color = normalized;
      else boardState[tool].color = normalized;
      $(`#${tool}ColorCode`).val(normalized);
      this.refreshActive(tool);
      UI.markDirty();
    },

    refreshActive(tool) {
      const color = tool === "shape" ? boardState.shape.color : boardState[tool].color;
      $(`#${tool}PresetColors .color-chip, #${tool}CustomColors .color-chip`).each((_, chip) => {
        const chipColor = $(chip).data("color") || $(chip).attr("title");
        $(chip).toggleClass("active", chipColor && chipColor.toUpperCase() === color.toUpperCase());
      });
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
      $("#shapeRows").on("input", (event) => {
        boardState.shape.rows = Utils.clamp(Number(event.target.value) || 1, 1, 12);
        UI.markDirty();
      });
      $("#shapeCols").on("input", (event) => {
        boardState.shape.cols = Utils.clamp(Number(event.target.value) || 1, 1, 12);
        UI.markDirty();
      });

      ["pen", "highlighter", "shape"].forEach((tool) => {
        $(`#${tool}ColorCode`).on("change", (event) => this.setColor(tool, event.target.value));
      });

      $(".shape-tabs button").on("click", (event) => {
        const group = $(event.currentTarget).data("shape-group");
        boardState.shape.group = group;
        $(".shape-tabs button").removeClass("active");
        $(event.currentTarget).addClass("active");
        this.buildShapeOptions(group);
        $("#tableControls").toggleClass("active", group === "table");
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
            UI.markDirty();
          })
          .appendTo($options);
      });

      if (!hasCurrentType) {
        boardState.shape.type = shapeGroups[group][0].type;
        $(".shape-option").removeClass("active").first().addClass("active");
      }
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
      $("#shapeRows").val(boardState.shape.rows);
      $("#shapeCols").val(boardState.shape.cols);
      $(".shape-tabs button").removeClass("active");
      $(`.shape-tabs button[data-shape-group="${boardState.shape.group}"]`).addClass("active");
      $("#tableControls").toggleClass("active", boardState.shape.group === "table");
      this.buildShapeOptions(boardState.shape.group);
      ["pen", "highlighter", "shape"].forEach((tool) => {
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
      if (tool === "cursor") return;

      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      const target = this.getCanvasTarget(canvas);
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
      if (!this.active) return;
      event.preventDefault();
      const { canvas } = this.active;
      const point = this.getPoint(event, canvas);

      if (this.active.mode === "stroke") {
        const points = this.active.annotation.points;
        const previous = points[points.length - 1];
        points.push(point);
        Renderer.drawStrokeSegment(canvas, this.active.annotation, previous, point);
      }

      if (this.active.mode === "shape") {
        this.active.latest = point;
        Renderer.redrawTarget(this.active.target);
        const preview = this.createShape(this.active.target, this.active.start, this.active.latest);
        Renderer.drawAnnotation(canvas.getContext("2d"), preview, this.getCanvasScale(canvas));
      }

      if (this.active.mode === "zoomSelection") {
        this.active.latest = point;
        this.updateZoomSelection();
      }
    },

    handleUp(event) {
      if (!this.active) return;
      event.preventDefault();
      const active = this.active;
      this.active = null;

      if (active.mode === "stroke") {
        if (active.annotation.points.length > 1) {
          Utils.getAnnotations(active.target).push(active.annotation);
          HistoryManager.push(active.target, {
            type: "addAnnotation",
            annotation: Utils.clone(active.annotation)
          });
          UI.markDirty();
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
          UI.toast("選取區域太小", "error");
          return;
        }
        ZoomManager.createFromSelection(active.target.page, rect);
      }
    },

    handleLeave(event) {
      if (!this.active || this.active.mode === "zoomSelection") return;
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

    clearTarget(target) {
      const annotations = Utils.getAnnotations(target);
      if (!annotations.length) {
        UI.toast("目前沒有註記可清除");
        return;
      }
      if (!window.confirm("確定要清除目前頁面的所有註記？")) return;
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
        .removeClass("draw-ready erase-ready")
        .each((_, canvas) => {
          if (boardState.currentTool === "cursor") return;
          if (boardState.currentTool === "eraser") $(canvas).addClass("erase-ready");
          else $(canvas).addClass("draw-ready");
        });
    }
  };

  const Renderer = {
    redrawTarget(target) {
      if (target.kind === "zoom") this.redrawZoom(target.id);
      else this.redrawPage(target.page);
    },

    redrawPage(pageNumber) {
      const canvas = document.querySelector(`.annotation-canvas[data-page="${pageNumber}"]`);
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const scale = Number(canvas.dataset.coordScale || 1);
      Utils.getAnnotations({ kind: "page", page: pageNumber }).forEach((annotation) => {
        this.drawAnnotation(ctx, annotation, scale);
      });
    },

    redrawZoom(zoomPageId) {
      const canvas = document.getElementById("zoomAnnotationCanvas");
      if (!canvas || canvas.dataset.zoomId !== zoomPageId) return;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      Utils.getAnnotations({ kind: "zoom", id: zoomPageId }).forEach((annotation) => {
        this.drawAnnotation(ctx, annotation, 1);
      });
    },

    drawStrokeSegment(canvas, annotation, from, to) {
      const ctx = canvas.getContext("2d");
      const scale = Number(canvas.dataset.coordScale || 1);
      ctx.save();
      this.applyStrokeStyle(ctx, annotation, scale);
      ctx.beginPath();
      ctx.moveTo(from.x * scale, from.y * scale);
      ctx.lineTo(to.x * scale, to.y * scale);
      ctx.stroke();
      ctx.restore();
    },

    drawAnnotation(ctx, annotation, scale) {
      if (annotation.type === "stroke") {
        this.drawStroke(ctx, annotation, scale);
      } else if (annotation.type === "shape") {
        this.drawShape(ctx, annotation, scale);
      }
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
      ctx.lineWidth = Math.max(1, annotation.size * scale);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
    },

    drawShape(ctx, annotation, scale) {
      const x1 = annotation.x1 * scale;
      const y1 = annotation.y1 * scale;
      const x2 = annotation.x2 * scale;
      const y2 = annotation.y2 * scale;
      const rect = this.normalizeRect(x1, y1, x2, y2);

      ctx.save();
      ctx.globalAlpha = annotation.opacity;
      ctx.strokeStyle = annotation.color;
      ctx.fillStyle = annotation.color;
      ctx.lineWidth = Math.max(1, annotation.strokeWidth * scale);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      switch (annotation.shapeType) {
        case "line":
          this.line(ctx, x1, y1, x2, y2);
          break;
        case "arrow":
          this.arrow(ctx, x1, y1, x2, y2);
          break;
        case "doubleArrow":
          this.arrow(ctx, x1, y1, x2, y2);
          this.arrow(ctx, x2, y2, x1, y1);
          break;
        case "dashedLine":
          ctx.setLineDash([12 * scale, 8 * scale]);
          this.line(ctx, x1, y1, x2, y2);
          break;
        case "curve":
          this.curve(ctx, x1, y1, x2, y2);
          break;
        case "circle":
          this.ellipse(ctx, rect.x, rect.y, Math.max(rect.width, rect.height), Math.max(rect.width, rect.height));
          break;
        case "ellipse":
          this.ellipse(ctx, rect.x, rect.y, rect.width, rect.height);
          break;
        case "square":
          this.rectangle(ctx, rect.x, rect.y, Math.max(rect.width, rect.height), Math.max(rect.width, rect.height));
          break;
        case "rectangle":
          this.rectangle(ctx, rect.x, rect.y, rect.width, rect.height);
          break;
        case "triangle":
          this.triangle(ctx, rect.x, rect.y, rect.width, rect.height);
          break;
        case "polygon":
          this.polygon(ctx, rect.x, rect.y, rect.width, rect.height);
          break;
        case "cube":
        case "cuboid":
          this.cube(ctx, rect.x, rect.y, rect.width, rect.height);
          break;
        case "cylinder":
          this.cylinder(ctx, rect.x, rect.y, rect.width, rect.height);
          break;
        case "cone":
          this.cone(ctx, rect.x, rect.y, rect.width, rect.height);
          break;
        case "sphere":
          this.sphere(ctx, rect.x, rect.y, rect.width, rect.height);
          break;
        case "table2":
        case "table3":
        case "table4":
        case "tableCustom":
          this.table(ctx, rect.x, rect.y, rect.width, rect.height, annotation.rows, annotation.cols);
          break;
        default:
          this.rectangle(ctx, rect.x, rect.y, rect.width, rect.height);
      }
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

    rectangle(ctx, x, y, width, height) {
      ctx.strokeRect(x, y, width, height);
    },

    ellipse(ctx, x, y, width, height) {
      ctx.beginPath();
      ctx.ellipse(x + width / 2, y + height / 2, Math.abs(width / 2), Math.abs(height / 2), 0, 0, Math.PI * 2);
      ctx.stroke();
    },

    triangle(ctx, x, y, width, height) {
      ctx.beginPath();
      ctx.moveTo(x + width / 2, y);
      ctx.lineTo(x + width, y + height);
      ctx.lineTo(x, y + height);
      ctx.closePath();
      ctx.stroke();
    },

    polygon(ctx, x, y, width, height) {
      const cx = x + width / 2;
      const cy = y + height / 2;
      const radiusX = Math.abs(width / 2);
      const radiusY = Math.abs(height / 2);
      ctx.beginPath();
      for (let i = 0; i < 6; i += 1) {
        const angle = -Math.PI / 2 + (Math.PI * 2 * i) / 6;
        const px = cx + Math.cos(angle) * radiusX;
        const py = cy + Math.sin(angle) * radiusY;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
    },

    cube(ctx, x, y, width, height) {
      const offset = Math.min(width, height) * 0.18;
      ctx.strokeRect(x, y + offset, Math.max(1, width - offset), Math.max(1, height - offset));
      ctx.strokeRect(x + offset, y, Math.max(1, width - offset), Math.max(1, height - offset));
      this.line(ctx, x, y + offset, x + offset, y);
      this.line(ctx, x + width - offset, y + offset, x + width, y);
      this.line(ctx, x, y + height, x + offset, y + height - offset);
      this.line(ctx, x + width - offset, y + height, x + width, y + height - offset);
    },

    cylinder(ctx, x, y, width, height) {
      const ry = Math.max(6, height * 0.12);
      ctx.beginPath();
      ctx.ellipse(x + width / 2, y + ry, Math.abs(width / 2), ry, 0, 0, Math.PI * 2);
      ctx.stroke();
      this.line(ctx, x, y + ry, x, y + height - ry);
      this.line(ctx, x + width, y + ry, x + width, y + height - ry);
      ctx.beginPath();
      ctx.ellipse(x + width / 2, y + height - ry, Math.abs(width / 2), ry, 0, 0, Math.PI * 2);
      ctx.stroke();
    },

    cone(ctx, x, y, width, height) {
      const bottomY = y + height;
      ctx.beginPath();
      ctx.moveTo(x + width / 2, y);
      ctx.lineTo(x, bottomY - height * 0.12);
      ctx.moveTo(x + width / 2, y);
      ctx.lineTo(x + width, bottomY - height * 0.12);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(x + width / 2, bottomY - height * 0.12, Math.abs(width / 2), Math.max(5, height * 0.1), 0, 0, Math.PI * 2);
      ctx.stroke();
    },

    sphere(ctx, x, y, width, height) {
      this.ellipse(ctx, x, y, width, height);
      ctx.beginPath();
      ctx.ellipse(x + width / 2, y + height / 2, Math.abs(width * 0.18), Math.abs(height / 2), 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(x + width / 2, y + height / 2, Math.abs(width / 2), Math.abs(height * 0.18), 0, 0, Math.PI * 2);
      ctx.stroke();
    },

    table(ctx, x, y, width, height, rows, cols) {
      rows = Utils.clamp(Number(rows) || 1, 1, 12);
      cols = Utils.clamp(Number(cols) || 1, 1, 12);
      ctx.strokeRect(x, y, width, height);
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
    init() {
      const zoomCanvas = document.getElementById("zoomAnnotationCanvas");
      zoomCanvas.dataset.kind = "zoom";
      zoomCanvas.dataset.coordScale = "1";
      CanvasManager.bindCanvas(zoomCanvas);

      $("#saveZoomPage").on("click", () => this.saveActive());
      $("#deleteZoomPage").on("click", () => this.deleteActive());
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
        imageData: capture.toDataURL("image/png"),
        boardWidth: boardSize.width,
        boardHeight: boardSize.height,
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
      boardState.mode = "zoom";
      boardState.activeZoomPageId = id;
      $("#pdfBoard").addClass("hidden");
      $("#zoomScreen").addClass("active");
      $("#zoomAnnotationCanvas").attr("data-zoom-id", id);
      this.renderZoomPage(id);
      UI.updateStatus();
      CanvasManager.refreshCanvasCursors();
    },

    exitToPdf() {
      boardState.mode = "pdf";
      boardState.activeZoomPageId = null;
      $("#zoomScreen").removeClass("active");
      $("#pdfBoard").removeClass("hidden");
      UI.updateStatus();
    },

    renderZoomPage(id) {
      const zoomPage = boardState.zoomPages[id];
      const imageCanvas = document.getElementById("zoomImageCanvas");
      const annotationCanvas = document.getElementById("zoomAnnotationCanvas");
      const width = zoomPage.boardWidth || zoomPage.boardSize || 820;
      const height = zoomPage.boardHeight || zoomPage.boardSize || width;

      imageCanvas.width = width;
      imageCanvas.height = height;
      annotationCanvas.width = width;
      annotationCanvas.height = height;
      annotationCanvas.dataset.coordScale = "1";

      const image = new Image();
      image.onload = () => {
        const ctx = imageCanvas.getContext("2d");
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(image, 0, 0, width, height);
        this.renderZoomAnnotations(id);
      };
      image.src = zoomPage.imageData;
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

    deleteActive() {
      const id = boardState.activeZoomPageId;
      const zoomPage = boardState.zoomPages[id];
      if (!zoomPage) return;
      if (!window.confirm("確定要刪除此放大頁？")) return;
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
      $("#jsonUpload").on("change", (event) => {
        const file = event.target.files && event.target.files[0];
        if (file) this.importFromFile(file);
        event.target.value = "";
      });

      $("#importJsonHome").on("click", () => $("#jsonUpload").trigger("click"));
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
        UI.markSaved("已儲存本機");
        UI.toast("已儲存到本機");
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
        Renderer.redrawZoom(boardState.activeZoomPageId);
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
      $("#eraserPreview").css("--preview-size", `${boardState.eraser.size}px`);
    }
  };

  $(App.init.bind(App));
})();
