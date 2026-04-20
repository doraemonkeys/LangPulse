import { useEffect, useId, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { PublicLanguage, SnapshotLanguageCount } from "../api/types";
import { isActiveOn } from "../utils/dates";
import { formatFullCount } from "../utils/format";

interface LanguagePickerProps {
  languages: PublicLanguage[];
  snapshotEntries: SnapshotLanguageCount[];
  observedDate: string | null;
  pinnedLanguages: ReadonlySet<string>;
  maxPinned: number;
  onTogglePin: (languageId: string) => void;
}

interface PickerOption {
  id: string;
  label: string;
  count: number | null;
  pinned: boolean;
  disabled: boolean;
}

function normalize(value: string): string {
  return value.toLowerCase().trim();
}

function optionDomId(baseId: string, languageId: string): string {
  return `${baseId}-opt-${languageId}`;
}

function matchesSubsequence(candidate: string, normalized: string): boolean {
  if (normalized === "") return true;
  let cursor = 0;
  for (let index = 0; index < candidate.length && cursor < normalized.length; index += 1) {
    if (candidate[index] === normalized[cursor]) cursor += 1;
  }
  return cursor === normalized.length;
}

function buildOptions(
  languages: PublicLanguage[],
  countsById: Map<string, number>,
  pinnedLanguages: ReadonlySet<string>,
  atCap: boolean,
  query: string,
): PickerOption[] {
  const normalized = normalize(query);
  const filtered = languages.filter((language) => {
    // Subsequence match on label or id so 'rb' finds 'Ruby' without requiring
    // a contiguous substring. Keeps typeahead forgiving of typos and interleaved chars.
    const label = language.label.toLowerCase();
    const id = language.id.toLowerCase();
    return matchesSubsequence(label, normalized) || matchesSubsequence(id, normalized);
  });
  filtered.sort((a, b) => a.label.localeCompare(b.label));
  return filtered.map((language) => {
    const pinned = pinnedLanguages.has(language.id);
    return {
      id: language.id,
      label: language.label,
      count: countsById.get(language.id) ?? null,
      pinned,
      disabled: atCap && !pinned,
    };
  });
}

export function LanguagePicker(props: LanguagePickerProps) {
  const { languages, snapshotEntries, observedDate, pinnedLanguages, maxPinned, onTogglePin } =
    props;
  const reactId = useId();
  const baseId = `lang-picker-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const listboxId = `${baseId}-listbox`;

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const countsById = useMemo(() => {
    const map = new Map<string, number>();
    snapshotEntries.forEach((entry) => map.set(entry.id, entry.count));
    return map;
  }, [snapshotEntries]);

  const activeLanguages = useMemo(
    () => languages.filter((language) => isActiveOn(language, observedDate)),
    [languages, observedDate],
  );

  const atCap = pinnedLanguages.size >= maxPinned;
  const options = useMemo(
    () => buildOptions(activeLanguages, countsById, pinnedLanguages, atCap, query),
    [activeLanguages, countsById, pinnedLanguages, atCap, query],
  );

  useEffect(() => {
    if (activeIndex >= options.length) {
      setActiveIndex(options.length === 0 ? 0 : options.length - 1);
    }
  }, [options.length, activeIndex]);

  useEffect(() => {
    if (!isOpen) return;
    function handleMouseDown(event: MouseEvent): void {
      if (rootRef.current === null) return;
      if (!rootRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [isOpen]);

  function openList(): void {
    setIsOpen(true);
  }

  function handleQueryChange(event: React.ChangeEvent<HTMLInputElement>): void {
    setQuery(event.target.value);
    setActiveIndex(0);
    setIsOpen(true);
  }

  function toggleOption(option: PickerOption): void {
    if (option.disabled) return;
    onTogglePin(option.id);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") {
      setIsOpen(false);
      return;
    }
    if (!isOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        setIsOpen(true);
        event.preventDefault();
      }
      return;
    }
    if (options.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % options.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + options.length) % options.length);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(options.length - 1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const option = options[activeIndex];
      if (option !== undefined) toggleOption(option);
    }
  }

  const activeOption = options[activeIndex];
  const activeDescendant =
    isOpen && activeOption !== undefined ? optionDomId(baseId, activeOption.id) : undefined;
  const labelId = `${baseId}-label`;

  return (
    <div ref={rootRef} className="language-picker">
      <label id={labelId} htmlFor={baseId} className="language-picker__label">
        Find language
      </label>
      <input
        ref={inputRef}
        id={baseId}
        type="text"
        role="combobox"
        className="language-picker__input"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-labelledby={labelId}
        aria-activedescendant={activeDescendant}
        value={query}
        placeholder="Search languages..."
        onFocus={openList}
        onClick={openList}
        onChange={handleQueryChange}
        onKeyDown={handleKeyDown}
      />
      {isOpen ? (
        <ul id={listboxId} role="listbox" className="language-picker__listbox">
          {options.length === 0 ? (
            <li className="language-picker__empty" aria-disabled="true">
              No languages match "{query}"
            </li>
          ) : (
            options.map((option, index) => {
              const isActive = index === activeIndex;
              return (
                <li
                  key={option.id}
                  id={optionDomId(baseId, option.id)}
                  role="option"
                  aria-selected={option.pinned}
                  aria-disabled={option.disabled}
                  className={clsx(
                    "language-picker__option",
                    isActive && "language-picker__option--active",
                    option.pinned && "language-picker__option--pinned",
                    option.disabled && "language-picker__option--disabled",
                  )}
                  onMouseDown={(event) => {
                    // Prevent input blur before click registers.
                    event.preventDefault();
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => toggleOption(option)}
                >
                  <span className="language-picker__pin" aria-hidden="true">
                    {option.pinned ? "\u2605" : "\u2606"}
                  </span>
                  <span className="language-picker__option-label">{option.label}</span>
                  <span className="language-picker__option-count">
                    {option.count === null ? "\u2014" : formatFullCount(option.count)}
                  </span>
                  {option.disabled ? (
                    <span className="language-picker__option-hint">{maxPinned} max</span>
                  ) : null}
                </li>
              );
            })
          )}
        </ul>
      ) : null}
    </div>
  );
}
