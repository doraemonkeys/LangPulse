import clsx from "clsx";
import type { CompareLanguageEntry } from "../api/types";

interface LanguageLegendProps {
  languages: CompareLanguageEntry[];
  palette: Map<string, string>;
  pinnedLanguages: ReadonlySet<string>;
  onToggle: (languageId: string) => void;
}

export function LanguageLegend({
  languages,
  palette,
  pinnedLanguages,
  onToggle,
}: LanguageLegendProps) {
  return (
    <div className="legend" role="group" aria-label="Chart legend">
      {languages.map((language) => {
        const color = palette.get(language.id) ?? "currentColor";
        const pinned = pinnedLanguages.has(language.id);
        const pinStateLabel = pinned ? "pinned" : "transient";
        return (
          <button
            key={language.id}
            type="button"
            className={clsx("legend-chip", pinned && "legend-chip--pinned")}
            aria-pressed={pinned}
            aria-label={`${language.label} (${pinStateLabel})`}
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
