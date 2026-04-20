import type { ReactNode } from "react";

interface StateBannerProps {
  tone: "info" | "error";
  title: string;
  description?: string;
  action?: ReactNode;
}

export function StateBanner({ tone, title, description, action }: StateBannerProps) {
  return (
    <div className={`state-banner state-banner--${tone}`} role="status" aria-live="polite">
      <div>
        <p className="state-banner__title">{title}</p>
        {description !== undefined ? (
          <p className="state-banner__description">{description}</p>
        ) : null}
      </div>
      {action !== undefined ? <div className="state-banner__action">{action}</div> : null}
    </div>
  );
}
