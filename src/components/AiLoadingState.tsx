import React, { useEffect, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';

export interface AiLoadingStateProps {
  title: string;
  subtitle?: string;
  providerLabel?: string;
  compact?: boolean;
}

export const AiLoadingState: React.FC<AiLoadingStateProps> = ({
  title,
  subtitle,
  providerLabel,
  compact = false,
}) => {
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => {
      setElapsedSec((prev) => prev + 1);
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div
      className={`ai-loading-card ${compact ? 'compact' : ''}`}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="ai-loading-top">
        <div className="ai-loading-icon-wrap" aria-hidden="true">
          <Loader2 size={compact ? 15 : 18} className="ai-spin" />
        </div>
        <div className="ai-loading-copy">
          <div className="ai-loading-title-row">
            <span className="ai-loading-title">{title}</span>
            {elapsedSec >= 1 && (
              <span className="ai-loading-elapsed" aria-label={`${elapsedSec} seconds elapsed`}>
                {elapsedSec}s
              </span>
            )}
          </div>
          {subtitle && <div className="ai-loading-subtitle">{subtitle}</div>}
          {providerLabel && (
            <div className="ai-loading-meta">
              <Sparkles size={10} />
              <span>{providerLabel}</span>
            </div>
          )}
        </div>
      </div>

      <div className="ai-loading-skeleton" aria-hidden="true">
        <div className="ai-skeleton-line" style={{ width: '92%' }} />
        <div className="ai-skeleton-line" style={{ width: '78%' }} />
        {!compact && <div className="ai-skeleton-line" style={{ width: '61%' }} />}
      </div>
    </div>
  );
};
