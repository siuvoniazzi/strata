import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Maximize2,
  RotateCcw,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

export interface LightboxImageItem {
  src: string;
  alt: string;
}

interface ImageLightboxModalProps {
  images: LightboxImageItem[];
  initialIndex: number;
  onClose: () => void;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;
const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5];

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export const ImageLightboxModal: React.FC<ImageLightboxModalProps> = ({
  images,
  initialIndex,
  onClose,
}) => {
  const [currentIndex, setCurrentIndex] = useState<number>(() =>
    clamp(initialIndex, 0, Math.max(0, images.length - 1))
  );
  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState<boolean>(false);
  const [animateZoom, setAnimateZoom] = useState<boolean>(false);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [stageSize, setStageSize] = useState<{ w: number; h: number }>(() => ({
    w: typeof window !== 'undefined' ? Math.max(320, window.innerWidth - 64) : 1100,
    h: typeof window !== 'undefined' ? Math.max(260, window.innerHeight - 156) : 720,
  }));

  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragOriginRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originPanX: number;
    originPanY: number;
    moved: boolean;
  } | null>(null);
  const suppressBackdropClickRef = useRef<boolean>(false);

  const currentImage = images[currentIndex] || images[0];

  // Measure available stage dimensions responsively
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width > 80 && height > 80) {
        setStageSize({ w: Math.max(240, width - 48), h: Math.max(200, height - 32) });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Compute crisp base display size at zoom = 100% ("Large Fit")
  const baseDisplaySize = useMemo(() => {
    if (!naturalSize || naturalSize.w <= 0 || naturalSize.h <= 0) {
      return { w: Math.min(stageSize.w, 860), h: Math.min(stageSize.h, 580) };
    }
    const fitRatio = Math.min(stageSize.w / naturalSize.w, stageSize.h / naturalSize.h);
    const targetRatio =
      fitRatio < 1
        ? fitRatio
        : Math.min(
            fitRatio,
            Math.max(1, Math.min(1.65, 900 / Math.max(naturalSize.w, naturalSize.h)))
          );
    return {
      w: Math.max(120, Math.round(naturalSize.w * targetRatio)),
      h: Math.max(90, Math.round(naturalSize.h * targetRatio)),
    };
  }, [naturalSize, stageSize]);

  const clampPanOffset = useCallback(
    (rawPan: { x: number; y: number }, targetZoom: number) => {
      if (targetZoom <= 1) {
        return { x: 0, y: 0 };
      }
      const scaledW = baseDisplaySize.w * targetZoom;
      const scaledH = baseDisplaySize.h * targetZoom;
      const maxX = Math.max(96, (scaledW - stageSize.w * 0.35) / 2);
      const maxY = Math.max(96, (scaledH - stageSize.h * 0.35) / 2);
      return {
        x: clamp(rawPan.x, -maxX, maxX),
        y: clamp(rawPan.y, -maxY, maxY),
      };
    },
    [baseDisplaySize.w, baseDisplaySize.h, stageSize.w, stageSize.h]
  );

  const applyZoom = useCallback(
    (
      nextZoomRaw: number,
      options?: { smooth?: boolean; anchorClientX?: number; anchorClientY?: number }
    ) => {
      const nextZoom = Math.round(clamp(nextZoomRaw, MIN_ZOOM, MAX_ZOOM) * 100) / 100;
      setAnimateZoom(Boolean(options?.smooth));

      setZoom((prevZoom) => {
        if (nextZoom <= 1) {
          setPan({ x: 0, y: 0 });
          return nextZoom;
        }
        if (
          options?.anchorClientX !== undefined &&
          options?.anchorClientY !== undefined &&
          stageRef.current &&
          prevZoom > 0
        ) {
          const rect = stageRef.current.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          const dx = options.anchorClientX - cx;
          const dy = options.anchorClientY - cy;
          const ratio = nextZoom / prevZoom;
          setPan((prevPan) =>
            clampPanOffset(
              {
                x: dx - (dx - prevPan.x) * ratio,
                y: dy - (dy - prevPan.y) * ratio,
              },
              nextZoom
            )
          );
        } else {
          setPan((prevPan) => clampPanOffset(prevPan, nextZoom));
        }
        return nextZoom;
      });
    },
    [clampPanOffset]
  );

  const stepZoomIn = useCallback(() => {
    const next = ZOOM_STEPS.find((s) => s > zoom + 0.04) ?? MAX_ZOOM;
    applyZoom(next, { smooth: true });
  }, [zoom, applyZoom]);

  const stepZoomOut = useCallback(() => {
    const reversed = [...ZOOM_STEPS].reverse();
    const prev = reversed.find((s) => s < zoom - 0.04) ?? MIN_ZOOM;
    applyZoom(prev, { smooth: true });
  }, [zoom, applyZoom]);

  const resetZoomAndPan = useCallback(() => {
    setAnimateZoom(true);
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const zoomToNativePixels = useCallback(() => {
    if (!naturalSize || baseDisplaySize.w <= 0) {
      applyZoom(2, { smooth: true });
      return;
    }
    const nativeZoom = naturalSize.w / baseDisplaySize.w;
    if (Math.abs(zoom - nativeZoom) < 0.05 && Math.abs(nativeZoom - 1) > 0.05) {
      resetZoomAndPan();
    } else {
      applyZoom(Math.abs(nativeZoom - 1) < 0.05 ? 2 : nativeZoom, { smooth: true });
    }
  }, [naturalSize, baseDisplaySize.w, zoom, applyZoom, resetZoomAndPan]);

  const navigateToImage = useCallback(
    (nextIdx: number) => {
      if (images.length <= 1) return;
      const wrapped = ((nextIdx % images.length) + images.length) % images.length;
      setCurrentIndex(wrapped);
      setAnimateZoom(false);
      setZoom(1);
      setPan({ x: 0, y: 0 });
      setNaturalSize(null);
    },
    [images.length]
  );

  // Non-passive wheel / trackpad pinch zoom on the lightbox stage
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.ctrlKey ? -e.deltaY * 0.012 : -e.deltaY * 0.0022;
      const factor = Math.exp(clamp(delta, -0.35, 0.35));
      setAnimateZoom(false);
      setZoom((prevZoom) => {
        const nextZoom = Math.round(clamp(prevZoom * factor, MIN_ZOOM, MAX_ZOOM) * 100) / 100;
        if (nextZoom <= 1) {
          setPan({ x: 0, y: 0 });
        } else {
          const rect = el.getBoundingClientRect();
          const dx = e.clientX - (rect.left + rect.width / 2);
          const dy = e.clientY - (rect.top + rect.height / 2);
          const ratio = nextZoom / prevZoom;
          setPan((prevPan) =>
            clampPanOffset(
              {
                x: dx - (dx - prevPan.x) * ratio,
                y: dy - (dy - prevPan.y) * ratio,
              },
              nextZoom
            )
          );
        }
        return nextZoom;
      });
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [clampPanOffset]);

  // Global keyboard shortcuts while modal is open
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        stepZoomIn();
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        stepZoomOut();
      } else if (e.key === '0') {
        e.preventDefault();
        resetZoomAndPan();
      } else if (e.key === 'ArrowLeft' && images.length > 1) {
        e.preventDefault();
        navigateToImage(currentIndex - 1);
      } else if (e.key === 'ArrowRight' && images.length > 1) {
        e.preventDefault();
        navigateToImage(currentIndex + 1);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose, stepZoomIn, stepZoomOut, resetZoomAndPan, navigateToImage, images.length, currentIndex]);

  const handleImagePointerDown = (e: React.PointerEvent<HTMLImageElement>) => {
    if (e.button !== 0 || zoom <= 1) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setAnimateZoom(false);
    setIsPanning(true);
    dragOriginRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originPanX: pan.x,
      originPanY: pan.y,
      moved: false,
    };
  };

  const handleImagePointerMove = (e: React.PointerEvent<HTMLImageElement>) => {
    const origin = dragOriginRef.current;
    if (!origin || origin.pointerId !== e.pointerId) return;
    const dx = e.clientX - origin.startX;
    const dy = e.clientY - origin.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      origin.moved = true;
      suppressBackdropClickRef.current = true;
    }
    setPan(
      clampPanOffset(
        {
          x: origin.originPanX + dx,
          y: origin.originPanY + dy,
        },
        zoom
      )
    );
  };

  const handleImagePointerUp = (e: React.PointerEvent<HTMLImageElement>) => {
    const origin = dragOriginRef.current;
    if (!origin || origin.pointerId !== e.pointerId) return;
    dragOriginRef.current = null;
    setIsPanning(false);
    setTimeout(() => {
      suppressBackdropClickRef.current = false;
    }, 60);
  };

  const handleImageDoubleClick = (e: React.MouseEvent<HTMLImageElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (zoom > 1.05) {
      resetZoomAndPan();
    } else {
      applyZoom(2, {
        smooth: true,
        anchorClientX: e.clientX,
        anchorClientY: e.clientY,
      });
    }
  };

  if (!currentImage) return null;

  const zoomPercent = Math.round(zoom * 100);
  const renderedWidth = Math.round(baseDisplaySize.w * zoom);
  const renderedHeight = Math.round(baseDisplaySize.h * zoom);

  return (
    <div
      id="image-lightbox-modal"
      className="lightbox-backdrop no-print"
      role="dialog"
      aria-modal="true"
      aria-label={currentImage.alt || 'Image large view'}
      onClick={() => {
        if (!suppressBackdropClickRef.current) {
          onClose();
        }
      }}
    >
      {/* Top Bar */}
      <div className="lightbox-topbar" onClick={(e) => e.stopPropagation()}>
        <div className="lightbox-meta">
          <span className="lightbox-title">{currentImage.alt || 'Pasted image'}</span>
          {naturalSize && (
            <span className="lightbox-dims">
              {naturalSize.w} × {naturalSize.h} px
            </span>
          )}
          {images.length > 1 && (
            <span className="lightbox-dims">
              {currentIndex + 1} / {images.length}
            </span>
          )}
        </div>

        <div className="lightbox-top-actions">
          <a
            href={currentImage.src}
            download={`${(currentImage.alt || 'strata-image').replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase()}.png`}
            className="lightbox-icon-btn"
            title="Download image"
            onClick={(e) => e.stopPropagation()}
          >
            <Download size={16} />
          </a>
          <button
            id="lightbox-close-btn"
            type="button"
            className="lightbox-icon-btn"
            title="Close large view (Esc)"
            aria-label="Close large view"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Interactive Zoom & Pan Stage */}
      <div ref={stageRef} className="lightbox-stage">
        {images.length > 1 && (
          <button
            type="button"
            className="lightbox-nav-btn lightbox-nav-prev"
            title="Previous image (←)"
            aria-label="Previous image"
            onClick={(e) => {
              e.stopPropagation();
              navigateToImage(currentIndex - 1);
            }}
          >
            <ChevronLeft size={20} />
          </button>
        )}

        <img
          id="lightbox-main-image"
          src={currentImage.src}
          alt={currentImage.alt || 'Pasted image'}
          draggable={false}
          className={[
            'lightbox-image',
            zoom > 1 ? 'can-pan' : 'can-zoom-in',
            isPanning ? 'is-panning' : '',
            animateZoom && !isPanning ? 'smooth-zoom' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          style={{
            width: `${renderedWidth}px`,
            height: `${renderedHeight}px`,
            transform: `translate3d(${pan.x}px, ${pan.y}px, 0)`,
          }}
          onLoad={(e) => {
            const img = e.currentTarget;
            if (img.naturalWidth > 0 && img.naturalHeight > 0) {
              setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
            }
          }}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={handleImageDoubleClick}
          onPointerDown={handleImagePointerDown}
          onPointerMove={handleImagePointerMove}
          onPointerUp={handleImagePointerUp}
          onPointerCancel={handleImagePointerUp}
        />

        {images.length > 1 && (
          <button
            type="button"
            className="lightbox-nav-btn lightbox-nav-next"
            title="Next image (→)"
            aria-label="Next image"
            onClick={(e) => {
              e.stopPropagation();
              navigateToImage(currentIndex + 1);
            }}
          >
            <ChevronRight size={20} />
          </button>
        )}
      </div>

      {/* Bottom Floating Zoom Controls Pill */}
      <div className="lightbox-controls" onClick={(e) => e.stopPropagation()}>
        <button
          id="lightbox-zoom-out"
          type="button"
          className="lightbox-ctrl-btn"
          title="Zoom out (−)"
          aria-label="Zoom out"
          disabled={zoom <= MIN_ZOOM + 0.01}
          onClick={stepZoomOut}
        >
          <ZoomOut size={16} />
        </button>

        <input
          id="lightbox-zoom-slider"
          type="range"
          className="lightbox-zoom-slider"
          aria-label="Zoom percentage"
          min={Math.round(MIN_ZOOM * 100)}
          max={Math.round(MAX_ZOOM * 100)}
          step={5}
          value={zoomPercent}
          onChange={(e) => applyZoom(Number(e.target.value) / 100, { smooth: false })}
        />

        <button
          id="lightbox-zoom-in"
          type="button"
          className="lightbox-ctrl-btn"
          title="Zoom in (+)"
          aria-label="Zoom in"
          disabled={zoom >= MAX_ZOOM - 0.01}
          onClick={stepZoomIn}
        >
          <ZoomIn size={16} />
        </button>

        <span className="lightbox-ctrl-sep" />

        <button
          id="lightbox-zoom-reset"
          type="button"
          className="lightbox-zoom-readout"
          title="Click to reset zoom to 100% (0)"
          onClick={resetZoomAndPan}
        >
          {zoomPercent}%
        </button>

        <button
          type="button"
          className="lightbox-ctrl-btn"
          title="Toggle 2x / native detail zoom"
          aria-label="Toggle detail zoom"
          onClick={zoomToNativePixels}
        >
          <Maximize2 size={15} />
        </button>

        {(zoom !== 1 || pan.x !== 0 || pan.y !== 0) && (
          <button
            type="button"
            className="lightbox-ctrl-btn"
            title="Fit to screen (0)"
            aria-label="Fit to screen"
            onClick={resetZoomAndPan}
          >
            <RotateCcw size={15} />
          </button>
        )}
      </div>
    </div>
  );
};
