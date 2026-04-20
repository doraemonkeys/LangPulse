import { ThemeToggle } from "./ThemeToggle";

interface AppHeaderProps {
  observedDate: string | null;
  windowDays: number;
}

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
        <ThemeToggle />
      </div>
    </header>
  );
}
