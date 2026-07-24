// Postcard preview + print wiring (implementation lives in app.js for now).
if (elPrintPostcardBtn) {
  elPrintPostcardBtn.addEventListener("click", () => {
    printPostcardImmediatelyFromStep2();
  });
}

if (elPostcardPreviewCloseBtn) {
  elPostcardPreviewCloseBtn.addEventListener("click", () => {
    closePostcardPreview();
  });
}

if (elPostcardPreviewPrintBtn) {
  elPostcardPreviewPrintBtn.addEventListener("click", () => {
    downloadPngFromPostcardPreview();
  });
}

if (elPostcardPreviewNativePrintBtn) {
  elPostcardPreviewNativePrintBtn.addEventListener("click", () => {
    printPostcardFromPreview();
  });
}

if (elPostcardRotateBtn) {
  elPostcardRotateBtn.addEventListener("click", () => {
    postcardRotate90 = !postcardRotate90;
    syncPostcardRotateUi();
    applyPostcardRotationLayout();
  });
}

if (elPostcardPreviewOverlay) {
  elPostcardPreviewOverlay.addEventListener("click", (e) => {
    // Only close when clicking the backdrop area, not the toolbar buttons.
    const t = e.target;
    if (t && t.classList && t.classList.contains("postcardPreviewBackdrop")) {
      closePostcardPreview();
    }
  });
}
