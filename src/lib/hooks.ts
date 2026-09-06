"use client";

import * as React from "react";

/**
 * Local state that follows a server-provided value.
 *
 * Several components hold optimistic local state — a checkbox, a stage, a
 * toggle — that must snap back to the server's value when a revalidation
 * delivers new props. The obvious way to write that is an effect calling
 * setState, but React documents the "adjust state during render" pattern for
 * exactly this case: it reconciles in the same render pass instead of painting
 * the stale value first and correcting it on a second pass.
 *
 * See https://react.dev/reference/react/useState#storing-information-from-previous-renders
 */
export function useSyncedState<T>(source: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = React.useState(source);
  const [lastSource, setLastSource] = React.useState(source);

  if (!Object.is(source, lastSource)) {
    setLastSource(source);
    setValue(source);
  }

  return [value, setValue];
}

/**
 * Debounced value, for search inputs that would otherwise fire a request per
 * keystroke. The timer is the external system here, so an effect is correct.
 */
export function useDebounced<T>(value: T, delay = 200): T {
  const [debounced, setDebounced] = React.useState(value);

  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

/**
 * A value persisted in localStorage, read through `useSyncExternalStore`.
 *
 * localStorage is an external store, and this is the API React provides for
 * reading one: it returns a server snapshot during SSR (so hydration matches),
 * subscribes to cross-tab `storage` events, and needs no effect that writes
 * state on mount.
 */
export function useStoredValue<T extends string>(
  key: string,
  fallback: T,
  allowed?: readonly T[],
): [T, (next: T) => void] {
  const subscribe = React.useCallback((onChange: () => void) => {
    const handler = (event: StorageEvent) => {
      if (event.key === key || event.key === null) onChange();
    };
    window.addEventListener("storage", handler);
    window.addEventListener(LOCAL_CHANGE, onChange);
    return () => {
      window.removeEventListener("storage", handler);
      window.removeEventListener(LOCAL_CHANGE, onChange);
    };
  }, [key]);

  const getSnapshot = React.useCallback(() => {
    try {
      const raw = localStorage.getItem(key) as T | null;
      if (raw && (!allowed || allowed.includes(raw))) return raw;
    } catch {
      // Private browsing, or site data blocked. The fallback is correct.
    }
    return fallback;
  }, [key, fallback, allowed]);

  const value = React.useSyncExternalStore(subscribe, getSnapshot, () => fallback);

  const set = React.useCallback(
    (next: T) => {
      try {
        localStorage.setItem(key, next);
      } catch {
        // Still notify, so the UI updates for this session.
      }
      // `storage` does not fire in the tab that wrote it, so nudge our own.
      window.dispatchEvent(new Event(LOCAL_CHANGE));
    },
    [key],
  );

  return [value, set];
}

const LOCAL_CHANGE = "tinycrm:local-storage";
