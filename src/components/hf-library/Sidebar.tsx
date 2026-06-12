/**
 * Left-rail filter sidebar for the HF library view.
 *
 * Each section is a collapsible panel with a top-N pill list and a "+ N more"
 * popover that surfaces the rest. Multi-select is the only mode (clicking
 * the same pill twice toggles it off).
 */
import { useState } from "react";
import {
  TASKS_TOP,
  TASKS_MORE,
  LIBRARIES_TOP,
  LIBRARIES_MORE,
  APPS_TOP,
  APPS_MORE,
  PROVIDERS_TOP,
  PROVIDERS_MORE,
  PARAM_TICKS,
  type FilterEntry,
} from "./constants";

interface Props {
  tasks: string[];
  libraries: string[];
  apps: string[];
  providers: string[];
  paramMin: number;
  paramMax: number;
  onChange: (
    next: Partial<{
      tasks: string[];
      libraries: string[];
      apps: string[];
      providers: string[];
      paramMin: number;
      paramMax: number;
    }>,
  ) => void;
}

/** A single pill — used inside both the top-N row and the "more" popover. */
function Pill({
  entry,
  selected,
  onToggle,
}: {
  entry: FilterEntry;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`hfl-pill ${selected ? "selected" : ""}`}
      onClick={onToggle}
      data-testid={`hfl-pill-${entry.slug}`}
      aria-pressed={selected}
    >
      {entry.label}
    </button>
  );
}

/** Generic section with collapse + "+ N more" expander. */
function Section({
  title,
  top,
  more,
  selected,
  onToggle,
}: {
  title: string;
  top: FilterEntry[];
  more: FilterEntry[];
  selected: string[];
  onToggle: (slug: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [showMore, setShowMore] = useState(false);
  return (
    <div className="hfl-section">
      <button
        type="button"
        className="hfl-section-header"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
      >
        <span className="hfl-section-title">{title}</span>
        <span className="hfl-caret">{collapsed ? "▸" : "▾"}</span>
      </button>
      {!collapsed && (
        <div className="hfl-pill-list">
          {top.map((e) => (
            <Pill
              key={e.slug}
              entry={e}
              selected={selected.includes(e.slug)}
              onToggle={() => onToggle(e.slug)}
            />
          ))}
          {more.length > 0 && (
            <button
              type="button"
              className="hfl-pill hfl-more"
              onClick={() => setShowMore((v) => !v)}
              data-testid={`hfl-more-${title.toLowerCase().replace(/\s+/g, "-")}`}
            >
              {showMore ? "− Show fewer" : `+ ${more.length}`}
            </button>
          )}
          {showMore && (
            <div className="hfl-more-popover">
              {more.map((e) => (
                <Pill
                  key={`${e.slug}-${e.label}`}
                  entry={e}
                  selected={selected.includes(e.slug)}
                  onToggle={() => onToggle(e.slug)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Two-thumb HTML range slider. The thumbs are stacked on top of each other
 *  with z-index gymnastics so the user can drag either end. We render the
 *  tick labels along the bottom. */
function ParamSlider({
  min,
  max,
  onChange,
}: {
  min: number;
  max: number;
  onChange: (lo: number, hi: number) => void;
}) {
  const last = PARAM_TICKS.length - 1;
  return (
    <div className="hfl-param-slider">
      <div className="hfl-param-track">
        <div
          className="hfl-param-range"
          style={{
            left: `${(min / last) * 100}%`,
            right: `${((last - max) / last) * 100}%`,
          }}
        />
        <input
          type="range"
          min={0}
          max={last}
          step={1}
          value={min}
          onChange={(e) => {
            const v = Number(e.target.value);
            onChange(Math.min(v, max), max);
          }}
          aria-label="Minimum parameters"
          data-testid="hfl-param-min"
          className="hfl-param-input hfl-param-min"
        />
        <input
          type="range"
          min={0}
          max={last}
          step={1}
          value={max}
          onChange={(e) => {
            const v = Number(e.target.value);
            onChange(min, Math.max(v, min));
          }}
          aria-label="Maximum parameters"
          data-testid="hfl-param-max"
          className="hfl-param-input hfl-param-max"
        />
      </div>
      <div className="hfl-param-marks">
        {PARAM_TICKS.map((t) => (
          <span key={t.label} className="hfl-param-mark">
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export function Sidebar(props: Props) {
  const toggle = (
    key: "tasks" | "libraries" | "apps" | "providers",
    slug: string,
  ) => {
    const cur = props[key];
    const next = cur.includes(slug)
      ? cur.filter((s) => s !== slug)
      : [...cur, slug];
    props.onChange({ [key]: next });
  };
  return (
    <aside className="hfl-sidebar" data-testid="hfl-sidebar">
      <Section
        title="Tasks"
        top={TASKS_TOP}
        more={TASKS_MORE}
        selected={props.tasks}
        onToggle={(s) => toggle("tasks", s)}
      />
      <div className="hfl-section">
        <div className="hfl-section-header" aria-disabled="true">
          <span className="hfl-section-title">Parameters</span>
        </div>
        <ParamSlider
          min={props.paramMin}
          max={props.paramMax}
          onChange={(lo, hi) => props.onChange({ paramMin: lo, paramMax: hi })}
        />
      </div>
      <Section
        title="Libraries"
        top={LIBRARIES_TOP}
        more={LIBRARIES_MORE}
        selected={props.libraries}
        onToggle={(s) => toggle("libraries", s)}
      />
      <Section
        title="Apps"
        top={APPS_TOP}
        more={APPS_MORE}
        selected={props.apps}
        onToggle={(s) => toggle("apps", s)}
      />
      <Section
        title="Inference Providers"
        top={PROVIDERS_TOP}
        more={PROVIDERS_MORE}
        selected={props.providers}
        onToggle={(s) => toggle("providers", s)}
      />
    </aside>
  );
}
