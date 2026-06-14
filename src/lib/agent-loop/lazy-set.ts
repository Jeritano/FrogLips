/* ── Lazy, registry-derived Set ─────────────────────────────────────────────
 *
 * The classifier Sets (DANGEROUS_TOOLS, READ_ONLY_TOOLS, DRY_RUN_TOOLS, …) are
 * DERIVED from TOOL_REGISTRY. The registry, dispatch.ts, and dry-run.ts form a
 * (call-time-safe) import cycle, so a Set that filtered TOOL_REGISTRY at
 * module-init could read it before the array literal finished constructing
 * (undefined → crash). This wrapper defers the derivation until the first
 * actual lookup, by which point every module has finished initializing.
 *
 * The returned object is a real `ReadonlySet<string>` subclass that builds its
 * contents on first access to any read/iteration member (has/size/iteration/…),
 * so every existing consumer (`SET.has(name)`, `[...SET]`, `SET.size`) works
 * unchanged. The ES2024 combinator methods (union/intersection/difference/…)
 * are also force-materialized via runtime wrappers (see constructor) so they
 * never run against the still-empty backing store — important because these
 * Sets are the security classifier gates (DANGEROUS_TOOLS, …).
 */

// ES2024 Set combinator methods. They are not in this project's ES2020 type lib,
// so we cannot `override` them by name (tsc TS2339); instead we install runtime
// wrappers for whichever ones the runtime exposes, each forcing #ensure() first.
const COMBINATOR_METHODS = [
  "union",
  "intersection",
  "difference",
  "symmetricDifference",
  "isSubsetOf",
  "isSupersetOf",
  "isDisjointFrom",
] as const;

class LazyDerivedSet extends Set<string> {
  #built = false;
  #build: () => Iterable<string>;

  constructor(build: () => Iterable<string>) {
    super();
    this.#build = build;

    // Force materialization before any ES2024 combinator runs, so it never
    // operates on the empty backing store (these gates are security-relevant).
    for (const name of COMBINATOR_METHODS) {
      const proto = Set.prototype as unknown as Record<string, unknown>;
      const original = proto[name];
      if (typeof original !== "function") continue;
      Object.defineProperty(this, name, {
        configurable: true,
        enumerable: false,
        writable: true,
        value: (...args: unknown[]): unknown => {
          this.#ensure();
          return (original as (...a: unknown[]) => unknown).apply(this, args);
        },
      });
    }
  }

  #ensure(): void {
    if (this.#built) return;
    this.#built = true;
    for (const v of this.#build()) super.add(v);
  }

  override has(value: string): boolean {
    this.#ensure();
    return super.has(value);
  }

  override get size(): number {
    this.#ensure();
    return super.size;
  }

  override values(): SetIterator<string> {
    this.#ensure();
    return super.values();
  }

  override keys(): SetIterator<string> {
    this.#ensure();
    return super.keys();
  }

  override entries(): SetIterator<[string, string]> {
    this.#ensure();
    return super.entries();
  }

  override forEach(
    cb: (value: string, value2: string, set: Set<string>) => void,
    thisArg?: unknown,
  ): void {
    this.#ensure();
    super.forEach(cb, thisArg);
  }

  override [Symbol.iterator](): SetIterator<string> {
    this.#ensure();
    return super[Symbol.iterator]();
  }
}

/**
 * Build a `ReadonlySet<string>` whose membership is computed lazily on first
 * access (deferred past the registry/dispatch/dry-run import cycle).
 */
export function lazyDerivedSet(
  build: () => Iterable<string>,
): ReadonlySet<string> {
  return new LazyDerivedSet(build);
}
