import React, { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

interface PdfCanvasViewerProps {
  url: string;
  fileName: string;
}

export const PdfCanvasViewer: React.FC<PdfCanvasViewerProps> = ({ url, fileName }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [scale, setScale] = useState<number>(1.2);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const pdfDocRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNumPages(0);
    let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null;

    (async () => {
      try {
        const res = await fetch(url);
        const buf = await res.arrayBuffer();
        loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buf) });
        const doc = await loadingTask.promise;
        if (cancelled) {
          void loadingTask.destroy();
          return;
        }
        pdfDocRef.current = doc;
        setNumPages(doc.numPages);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Unable to render PDF');
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (loadingTask) {
        void loadingTask.destroy();
      }
      pdfDocRef.current = null;
    };
  }, [url]);

  useEffect(() => {
    const doc = pdfDocRef.current;
    const container = containerRef.current;
    if (!doc || !container || numPages === 0) return;

    let cancelled = false;
    container.innerHTML = '';

    (async () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        if (cancelled) return;
        const page = await doc.getPage(pageNum);
        if (cancelled) return;

        const viewport = page.getViewport({ scale });
        const pageWrap = document.createElement('div');
        pageWrap.className = 'pdf-canvas-page';

        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        pageWrap.appendChild(canvas);
        container.appendChild(pageWrap);

        const ctx = canvas.getContext('2d');
        if (!ctx) continue;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        await page.render({
          canvasContext: ctx,
          canvas,
          viewport,
        }).promise;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [numPages, scale]);

  if (error) {
    return (
      <div className="attachment-preview-fallback">
        <p style={{ fontWeight: 600, marginBottom: 6 }}>Could not render {fileName} inline</p>
        <p className="muted" style={{ fontSize: 12, marginBottom: 14 }}>
          {error}
        </p>
        <a href={url} download={fileName} className="btn btn-primary">
          Download PDF
        </a>
      </div>
    );
  }

  return (
    <div className="pdf-viewer-shell">
      <div className="pdf-viewer-toolbar">
        <span className="muted" style={{ fontSize: 12 }}>
          {loading ? 'Loading PDF…' : `${numPages} page${numPages === 1 ? '' : 's'}`}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            className="btn btn-xs"
            onClick={() => setScale((s) => Math.max(0.6, +(s - 0.2).toFixed(1)))}
            title="Zoom out"
          >
            −
          </button>
          <span style={{ fontSize: 12, minWidth: 42, textAlign: 'center' }}>
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            className="btn btn-xs"
            onClick={() => setScale((s) => Math.min(2.6, +(s + 0.2).toFixed(1)))}
            title="Zoom in"
          >
            +
          </button>
        </div>
      </div>
      <div ref={containerRef} className="pdf-viewer-pages" />
    </div>
  );
};
