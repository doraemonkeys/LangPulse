import clsx from "clsx";
import type { CompareLanguageEntry } from "../api/types";
import type { UnavailableReason } from "../charts/series";

interface LanguageLegendProps {
  languages: CompareLanguageEntry[];
  palette: Map<string, string>;
  pinnedLanguages: ReadonlySet<string>;
  onToggle: (languageId: string) => void;
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
          <button
            key={language.id}
            type="button"
            className={clsx(
              "legend-chip",
              pinned && "legend-chip--pinned",
              reasonText && "legend-chip--unavailable",
            )}
            aria-pressed={pinned}
            aria-label={ariaLabel}
            title={reasonText ?? undefined}
            onClick={() => onToggle(language.id)}
          >
            <span className="legend-chip__swatch" style={{ backgroundColor: color }} />
            <span>{language.label}</span>
          </button>
        );
      })}
    </div>
  );
}
