import * as pdfjsLib from "/vendor/pdfjs/build/pdf.mjs";
import { PageFlip } from "/vendor/page-flip/page-flip.module.js";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "/vendor/pdfjs/build/pdf.worker.min.mjs";

const viewer = document.querySelector("#magazine-viewer");

if (viewer) {
  const stage = document.querySelector("#viewer-stage");
  const zoomLayer = document.querySelector("#book-zoom-layer");
  const flipbook = document.querySelector("#flipbook");
  const loading = document.querySelector("#viewer-loading");
  const errorPanel = document.querySelector("#viewer-error");
  const announcement = document.querySelector("#viewer-announcement");
  const pageStatus = document.querySelector("#page-status");
  const zoomStatus = document.querySelector("#zoom-status");
  const previousButton = document.querySelector("#previous-page");
  const nextButton = document.querySelector("#next-page");
  const zoomOutButton = document.querySelector("#zoom-out");
  const zoomInButton = document.querySelector("#zoom-in");
  const fullscreenButton = document.querySelector("#fullscreen");
  const layoutSwitch = document.querySelector("#layout-switch");
  const singleLayoutButton = document.querySelector("#layout-single");
  const spreadLayoutButton = document.querySelector("#layout-spread");
  const layoutDialog = document.querySelector("#layout-choice");
  const layoutChoiceButtons = layoutDialog.querySelectorAll(
    "[data-layout-choice]",
  );

  const state = {
    pdf: null,
    pageFlip: null,
    currentPage: 0,
    orientation: "portrait",
    preferredLayout: "single",
    layout: "loading",
    layoutEligible: false,
    layoutChoiceResolver: null,
    layoutChoiceCleanup: null,
    zoom: 1,
    renderCache: new Map(),
    resizeTimer: null,
    panning: null,
  };

  const desktopLayoutQuery = window.matchMedia(
    "(min-width: 1024px) and (hover: hover) and (pointer: fine)",
  );
  const prefersReducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  function updateLayoutButtons() {
    singleLayoutButton.setAttribute(
      "aria-pressed",
      String(state.preferredLayout === "single"),
    );
    spreadLayoutButton.setAttribute(
      "aria-pressed",
      String(state.preferredLayout === "spread"),
    );
  }

  function portraitMinWidth() {
    return Math.max(220, Math.floor(flipbook.clientWidth / 2) + 1);
  }

  function applyLayout(layout, announce = false) {
    const nextLayout = layout === "spread" ? "spread" : "single";
    const changed = state.layout !== nextLayout;
    state.layout = nextLayout;
    viewer.dataset.layout = nextLayout;
    updateLayoutButtons();

    if (!state.pageFlip) return;

    const currentPage = state.pageFlip.getCurrentPageIndex();
    const settings = state.pageFlip.getSettings();
    settings.usePortrait = nextLayout === "single";
    settings.minWidth =
      nextLayout === "single" ? portraitMinWidth() : 220;
    state.pageFlip.update();
    state.pageFlip.turnToPage(currentPage);
    updateOrientation(state.pageFlip.getOrientation());

    if (announce && changed) {
      announcement.textContent =
        nextLayout === "spread"
          ? "Two-page spread view"
          : "Single-page view";
    }
  }

  function syncLayoutAvailability(announce = false) {
    const wasEligible = state.layoutEligible;
    state.layoutEligible = desktopLayoutQuery.matches;
    layoutSwitch.hidden = !state.pageFlip || !state.layoutEligible;

    const effectiveLayout = state.layoutEligible
      ? state.preferredLayout
      : "single";
    applyLayout(
      effectiveLayout,
      announce && wasEligible !== state.layoutEligible,
    );
  }

  function selectPreferredLayout(layout, announce = true) {
    if (!state.layoutEligible) return;
    state.preferredLayout = layout === "spread" ? "spread" : "single";
    applyLayout(state.preferredLayout, announce);
  }

  function finishLayoutChoice(layout) {
    if (!state.layoutChoiceResolver) return;

    const resolve = state.layoutChoiceResolver;
    state.layoutChoiceCleanup?.();
    state.layoutChoiceResolver = null;
    state.layoutChoiceCleanup = null;
    if (layoutDialog.open) layoutDialog.close();
    resolve(layout === "spread" ? "spread" : "single");
  }

  function requestInitialLayout() {
    state.layoutEligible = desktopLayoutQuery.matches;
    layoutSwitch.hidden = true;

    if (!state.layoutEligible) {
      state.preferredLayout = "single";
      applyLayout("single");
      return Promise.resolve("single");
    }

    return new Promise((resolve) => {
      const onChoice = (event) => {
        finishLayoutChoice(event.currentTarget.dataset.layoutChoice);
      };

      state.layoutChoiceResolver = resolve;
      state.layoutChoiceCleanup = () => {
        layoutChoiceButtons.forEach((button) => {
          button.removeEventListener("click", onChoice);
        });
      };
      layoutChoiceButtons.forEach((button) => {
        button.addEventListener("click", onChoice);
      });
      layoutDialog.showModal();
    });
  }

  function pageElements(pageNumber) {
    return viewer.querySelectorAll(
      `[data-page-number="${pageNumber}"] .page-image`,
    );
  }

  function surfaceElements(pageNumber) {
    return viewer.querySelectorAll(
      `[data-page-number="${pageNumber}"] .page-surface`,
    );
  }

  function setRenderedImage(pageNumber, url) {
    pageElements(pageNumber).forEach((image) => {
      image.src = url;
    });
    surfaceElements(pageNumber).forEach((surface) => {
      surface.classList.add("is-rendered");
    });
  }

  function clearRenderedImage(pageNumber) {
    pageElements(pageNumber).forEach((image) => image.removeAttribute("src"));
    surfaceElements(pageNumber).forEach((surface) => {
      surface.classList.remove("is-rendered");
    });
  }

  function canvasBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) =>
          blob ? resolve(blob) : reject(new Error("Unable to rasterize page")),
        "image/webp",
        0.94,
      );
    });
  }

  function desiredRenderWidth() {
    const bounds = state.pageFlip?.getBoundsRect();
    const visibleWidth =
      bounds?.pageWidth ||
      stage.clientWidth / (state.orientation === "landscape" ? 2 : 1);
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    return Math.max(
      640,
      Math.min(2400, Math.round(visibleWidth * pixelRatio * state.zoom)),
    );
  }

  async function renderPage(pageIndex) {
    if (!state.pdf || pageIndex < 0 || pageIndex >= state.pdf.numPages) return;

    const targetWidth = desiredRenderWidth();
    const cached = state.renderCache.get(pageIndex);
    if (cached?.width >= targetWidth * 0.9) {
      setRenderedImage(pageIndex + 1, cached.url);
      return;
    }
    if (cached?.promise) {
      await cached.promise;
      if ((state.renderCache.get(pageIndex)?.width || 0) >= targetWidth * 0.9) {
        return;
      }
    }

    const renderPromise = (async () => {
      const page = await state.pdf.getPage(pageIndex + 1);
      const unscaled = page.getViewport({ scale: 1 });
      let scale = targetWidth / unscaled.width;
      if (unscaled.height * scale > 3200) {
        scale = 3200 / unscaled.height;
      }
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d", { alpha: false });

      await page.render({
        canvas,
        canvasContext: context,
        viewport,
      }).promise;

      const blob = await canvasBlob(canvas);
      const url = URL.createObjectURL(blob);
      const previous = state.renderCache.get(pageIndex);
      if (previous?.url) URL.revokeObjectURL(previous.url);
      state.renderCache.set(pageIndex, {
        url,
        width: canvas.width,
        promise: null,
      });
      setRenderedImage(pageIndex + 1, url);
      page.cleanup();
      canvas.width = 1;
      canvas.height = 1;
    })();

    state.renderCache.set(pageIndex, {
      url: cached?.url || null,
      width: cached?.width || 0,
      promise: renderPromise,
    });

    try {
      await renderPromise;
    } catch (renderError) {
      if (cached?.url) {
        state.renderCache.set(pageIndex, cached);
      } else {
        state.renderCache.delete(pageIndex);
      }
      throw renderError;
    }
  }

  async function renderAround(pageIndex) {
    const offsets =
      state.orientation === "landscape"
        ? [0, 1, -1, 2, -2, 3]
        : [0, 1, -1, 2, -2];
    const wanted = offsets
      .map((offset) => pageIndex + offset)
      .filter((index) => index >= 0 && index < state.pdf.numPages);

    for (const index of wanted) {
      try {
        await renderPage(index);
      } catch (renderError) {
        console.error(`Unable to render page ${index + 1}`, renderError);
        announcement.textContent = `Page ${index + 1} could not be rendered.`;
      }
    }

    const retentionRadius = state.orientation === "landscape" ? 6 : 4;
    state.renderCache.forEach((entry, index) => {
      if (
        Math.abs(index - pageIndex) > retentionRadius &&
        !entry.promise &&
        entry.url
      ) {
        clearRenderedImage(index + 1);
        URL.revokeObjectURL(entry.url);
        state.renderCache.delete(index);
      }
    });
  }

  function updatePageState(pageIndex, announce = false) {
    state.currentPage = Math.max(
      0,
      Math.min(pageIndex, state.pdf.numPages - 1),
    );
    viewer.dataset.currentPage = String(state.currentPage + 1);

    let label = `Page ${state.currentPage + 1} of ${state.pdf.numPages}`;
    if (
      state.orientation === "landscape" &&
      state.currentPage > 0 &&
      state.currentPage < state.pdf.numPages - 1
    ) {
      const secondPage = Math.min(state.pdf.numPages, state.currentPage + 2);
      label = `Pages ${state.currentPage + 1}–${secondPage} of ${
        state.pdf.numPages
      }`;
    }

    pageStatus.textContent = label;
    previousButton.disabled = state.currentPage <= 0;
    nextButton.disabled = state.currentPage >= state.pdf.numPages - 1;
    if (announce) announcement.textContent = label;
    void renderAround(state.currentPage);
  }

  function updateOrientation(orientation, announce = false) {
    state.orientation = orientation || "portrait";
    viewer.dataset.orientation = state.orientation;
    if (announce) {
      announcement.textContent =
        state.orientation === "landscape"
          ? "Two-page spread view"
          : "Single-page view";
    }
    updatePageState(state.currentPage);
  }

  function setZoom(nextZoom, announce = true) {
    const zoom = Math.min(2.5, Math.max(1, Math.round(nextZoom * 4) / 4));
    const oldScrollWidth = Math.max(stage.scrollWidth, stage.clientWidth);
    const oldScrollHeight = Math.max(stage.scrollHeight, stage.clientHeight);
    const centerX = (stage.scrollLeft + stage.clientWidth / 2) / oldScrollWidth;
    const centerY = (stage.scrollTop + stage.clientHeight / 2) / oldScrollHeight;

    state.zoom = zoom;
    zoomLayer.style.transform = `scale(${zoom})`;
    stage.classList.toggle("is-zoomed", zoom > 1);
    stage.style.touchAction = zoom > 1 ? "none" : "";
    zoomStatus.textContent = `${Math.round(zoom * 100)}%`;
    zoomOutButton.disabled = zoom <= 1;
    zoomInButton.disabled = zoom >= 2.5;

    requestAnimationFrame(() => {
      stage.scrollLeft =
        centerX * Math.max(stage.scrollWidth, stage.clientWidth) -
        stage.clientWidth / 2;
      stage.scrollTop =
        centerY * Math.max(stage.scrollHeight, stage.clientHeight) -
        stage.clientHeight / 2;
    });

    if (announce) {
      announcement.textContent = `Zoom ${Math.round(zoom * 100)} percent`;
    }
    void renderAround(state.currentPage);
  }

  function createPagePlaceholders(pageCount) {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < pageCount; index += 1) {
      const page = document.createElement("div");
      page.className = "page";
      page.dataset.pageNumber = String(index + 1);
      if (index === 0 || index === pageCount - 1) {
        page.dataset.density = "hard";
      }

      const surface = document.createElement("div");
      surface.className = "page-surface";
      const image = document.createElement("img");
      image.className = "page-image";
      image.alt = `Page ${index + 1}`;
      image.draggable = false;
      const fallback = document.createElement("span");
      fallback.className = "page-number-fallback";
      fallback.textContent = `Page ${index + 1}`;
      fallback.setAttribute("aria-hidden", "true");
      surface.append(image, fallback);
      page.append(surface);
      fragment.append(page);
    }
    flipbook.append(fragment);
  }

  function turn(direction) {
    if (!state.pageFlip) return;
    if (direction === "next") {
      prefersReducedMotion
        ? state.pageFlip.turnToNextPage()
        : state.pageFlip.flipNext("bottom");
    } else {
      prefersReducedMotion
        ? state.pageFlip.turnToPrevPage()
        : state.pageFlip.flipPrev("bottom");
    }
  }

  async function toggleFullscreen() {
    try {
      if (!document.fullscreenElement) {
        await viewer.requestFullscreen();
        fullscreenButton.setAttribute("aria-label", "Exit fullscreen");
      } else {
        await document.exitFullscreen();
        fullscreenButton.setAttribute("aria-label", "Enter fullscreen");
      }
    } catch {
      announcement.textContent = "Fullscreen is not available in this browser.";
    }
  }

  function installControls() {
    previousButton.addEventListener("click", () => turn("previous"));
    nextButton.addEventListener("click", () => turn("next"));
    zoomOutButton.addEventListener("click", () => setZoom(state.zoom - 0.25));
    zoomInButton.addEventListener("click", () => setZoom(state.zoom + 0.25));
    fullscreenButton.addEventListener("click", toggleFullscreen);
    singleLayoutButton.addEventListener("click", () => {
      selectPreferredLayout("single");
    });
    spreadLayoutButton.addEventListener("click", () => {
      selectPreferredLayout("spread");
    });
    layoutDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
    });

    if (!document.fullscreenEnabled) fullscreenButton.hidden = true;

    document.addEventListener("fullscreenchange", () => {
      fullscreenButton.setAttribute(
        "aria-label",
        document.fullscreenElement ? "Exit fullscreen" : "Enter fullscreen",
      );
    });

    document.addEventListener("keydown", (event) => {
      if (layoutDialog.open) return;
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (event.key === "ArrowLeft") turn("previous");
      if (event.key === "ArrowRight") turn("next");
      if (event.key === "+" || event.key === "=") setZoom(state.zoom + 0.25);
      if (event.key === "-") setZoom(state.zoom - 0.25);
      if (event.key.toLowerCase() === "f") void toggleFullscreen();
    });

    stage.addEventListener(
      "wheel",
      (event) => {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        setZoom(state.zoom + (event.deltaY < 0 ? 0.25 : -0.25));
      },
      { passive: false },
    );

    stage.addEventListener(
      "pointerdown",
      (event) => {
        if (state.zoom <= 1 || event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        stage.setPointerCapture(event.pointerId);
        state.panning = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          left: stage.scrollLeft,
          top: stage.scrollTop,
        };
      },
      true,
    );
    stage.addEventListener(
      "pointermove",
      (event) => {
        if (!state.panning || state.panning.id !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        stage.scrollLeft =
          state.panning.left - (event.clientX - state.panning.x);
        stage.scrollTop = state.panning.top - (event.clientY - state.panning.y);
      },
      true,
    );
    const endPan = (event) => {
      if (state.panning?.id === event.pointerId) state.panning = null;
    };
    stage.addEventListener("pointerup", endPan, true);
    stage.addEventListener("pointercancel", endPan, true);

    desktopLayoutQuery.addEventListener("change", () => {
      if (!desktopLayoutQuery.matches && layoutDialog.open) {
        finishLayoutChoice("single");
      }
      syncLayoutAvailability(true);
    });

    window.addEventListener("resize", () => {
      window.clearTimeout(state.resizeTimer);
      state.resizeTimer = window.setTimeout(() => {
        if (!state.pageFlip) return;
        syncLayoutAvailability();
      }, 180);
    });

    window.addEventListener("beforeunload", () => {
      state.renderCache.forEach((entry) => {
        if (entry.url) URL.revokeObjectURL(entry.url);
      });
      state.pageFlip?.destroy();
      state.pdf?.destroy();
    });
  }

  async function initialize() {
    try {
      installControls();
      const loadingTask = pdfjsLib.getDocument({
        url: viewer.dataset.pdfUrl,
        cMapUrl: "/vendor/pdfjs/cmaps/",
        cMapPacked: true,
      });
      const layoutPromise = requestInitialLayout();
      const [pdf, initialLayout] = await Promise.all([
        loadingTask.promise,
        layoutPromise,
      ]);
      state.pdf = pdf;
      state.preferredLayout = initialLayout;
      applyLayout(initialLayout);

      const firstPage = await state.pdf.getPage(1);
      const firstViewport = firstPage.getViewport({ scale: 1 });
      const baseWidth = 1000;
      const baseHeight = Math.round(
        baseWidth * (firstViewport.height / firstViewport.width),
      );
      firstPage.cleanup();

      createPagePlaceholders(state.pdf.numPages);
      state.pageFlip = new PageFlip(flipbook, {
        width: baseWidth,
        height: baseHeight,
        size: "stretch",
        minWidth:
          initialLayout === "single" ? portraitMinWidth() : 220,
        maxWidth: baseWidth,
        minHeight: Math.round(220 * (baseHeight / baseWidth)),
        maxHeight: baseHeight,
        autoSize: false,
        showCover: true,
        usePortrait: initialLayout === "single",
        mobileScrollSupport: false,
        swipeDistance: 24,
        flippingTime: prefersReducedMotion ? 1 : 650,
        maxShadowOpacity: 0.35,
      });

      state.pageFlip.on("init", (event) => {
        updateOrientation(event.data.mode || state.pageFlip.getOrientation());
        updatePageState(event.data.page || 0);
      });
      state.pageFlip.on("flip", (event) => {
        updatePageState(Number(event.data) || 0, true);
      });
      state.pageFlip.on("changeOrientation", (event) => {
        updateOrientation(String(event.data));
      });
      state.pageFlip.loadFromHTML(flipbook.querySelectorAll(".page"));
      syncLayoutAvailability();

      await renderPage(0);
      loading.hidden = true;
      previousButton.disabled = true;
      nextButton.disabled = state.pdf.numPages <= 1;
      zoomInButton.disabled = false;
      zoomOutButton.disabled = true;
      updateOrientation(state.pageFlip.getOrientation());
      updatePageState(state.pageFlip.getCurrentPageIndex());
    } catch (initializationError) {
      console.error("Unable to initialize magazine viewer", initializationError);
      state.layoutChoiceCleanup?.();
      state.layoutChoiceResolver = null;
      state.layoutChoiceCleanup = null;
      if (layoutDialog.open) layoutDialog.close();
      loading.hidden = true;
      errorPanel.hidden = false;
      viewer.dataset.orientation = "error";
      viewer.dataset.layout = "error";
    }
  }

  void initialize();
}
