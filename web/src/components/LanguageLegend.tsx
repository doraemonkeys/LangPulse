import clsx from "clsx";
import type { CompareLanguageEntry } from "../api/types";
import type { UnavailableReason } from "../charts/series";

interface LanguageLegendProps {
  languages: CompareLanguageEntry[];
  palette: Map<string, string>;
  pinnedLanguages: ReadonlySet<string>;
  onToggle: (languageId: string) => void;
  // Optional X-to-remove affordance. When provided, each chip renders a small
  // close button revealed on hover/focus. The caller owns the replacement
  // policy — the legend itself only signals "user wants this one gone."
  onRemove?: (languageId: string) => void;
  unavailableByLanguage?: ReadonlyMap<string, UnavailableReason>;
}

const UNAVAILABLE_MESSAGE: Record<UnavailableReason, string> = {
  no_data: "No data in this range",
  zero_baseline: "Baseline is zero — no relative change to show",
  no_baseline: "No positive baseline available",
};

export function LanguageLegend({
  languages,
  palette,
  pinnedLanguages,
  onToggle,
  onRemove,
  unavailableByLanguage,
}: LanguageLegendProps) {
  return (
    <div className="legend" role="group" aria-label="Chart legend">
      {languages.map((language) => {
        const color = palette.get(language.id) ?? "currentColor";
        const pinned = pinnedLanguages.has(language.id);
        const unavailable = unavailableByLanguage?.get(language.id) ?? null;
        const reasonText = unavailable === null ? null : UNAVAILABLE_MESSAGE[unavailable];
        const pinStateLabel = pinned ? "pinned" : "transient";
        const ariaLabel = reasonText
          ? `${language.label} (${pinStateLabel}, ${reasonText})`
          : `${language.label} (${pinStateLabel})`;
        return (
          <span
            key={language.id}
            className={clsx(
              "legend-chip",
              pinned && "legend-chip--pinned",
              reasonText && "legend-chip--unavailable",
            )}
            title={reasonText ?? undefined}
          >
            <button
              type="button"
              className="legend-chip__main"
              aria-pressed={pinned}
              aria-label={ariaLabel}
              onClick={() => onToggle(language.id)}
            >
              <span className="legend-chip__swatch" style={{ backgroundColor: color }} />
              <span>{language.label}</span>
            </button>
            {onRemove ? (
              <button
                type="button"
                className="legend-chip__remove"
                aria-label={`Remove ${language.label} from chart`}
                onClick={() => onRemove(language.id)}
              >
                <svg
                  viewBox="0 0 12 12"
                  width="10"
                  height="10"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path
                    d="M2 2 L10 10 M10 2 L2 10"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}
