import { ThemeToggle } from "./ThemeToggle";

interface AppHeaderProps {
  observedDate: string | null;
  windowDays: number;
}

const REPO_URL = "https://github.com/doraemonkeys/LangPulse";

export function AppHeader({ observedDate, windowDays }: AppHeaderProps) {
  return (
    <header className="app-header">
      <div className="app-header__titles">
        <p className="app-header__eyebrow">LangPulse</p>
        <h1 className="app-header__title">Which languages are gaining traction?</h1>
        <p className="app-header__lede">
          Public repositories pushed in the last {windowDays} days, ranked and compared across
          star thresholds. One published snapshot per day.
        </p>
      </div>
      <div className="app-header__meta">
        <span className="app-header__pill" aria-label="Latest observed UTC date">
          <span className="app-header__pill-label">Observed</span>
          <strong>{observedDate ?? "\u2014"}</strong>
        </span>
        <a
          className="icon-button"
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="View LangPulse source on GitHub"
        >
          <svg
            aria-hidden="true"
            focusable="false"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.387.6.11.82-.26.82-.577 0-.285-.01-1.04-.016-2.04-3.338.725-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.744.083-.729.083-.729 1.205.085 1.838 1.237 1.838 1.237 1.07 1.834 2.807 1.304 3.492.997.108-.776.42-1.305.763-1.605-2.665-.303-5.467-1.332-5.467-5.93 0-1.31.468-2.382 1.236-3.222-.124-.303-.536-1.524.117-3.176 0 0 1.008-.322 3.3 1.23A11.5 11.5 0 0 1 12 5.803a11.5 11.5 0 0 1 3.003.404c2.29-1.552 3.297-1.23 3.297-1.23.655 1.652.243 2.873.12 3.176.77.84 1.235 1.912 1.235 3.222 0 4.61-2.807 5.624-5.48 5.92.43.372.814 1.103.814 2.222 0 1.604-.015 2.896-.015 3.29 0 .32.217.694.825.576C20.565 21.796 24 17.298 24 12c0-6.63-5.37-12-12-12Z"
            />
          </svg>
        </a>
        <ThemeToggle />
      </div>
    </header>
  );
}
