import { useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "peardrop.onboardingComplete";

let cache: boolean | null = null;
let hydrating: Promise<boolean> | null = null;

function ensureHydrated(): Promise<boolean> {
  if (cache !== null) return Promise.resolve(cache);
  if (!hydrating) {
    hydrating = AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        cache = raw === "true";
        hydrating = null;
        return cache;
      })
      .catch(() => {
        cache = false;
        hydrating = null;
        return false;
      });
  }
  return hydrating;
}

export async function isOnboardingComplete(): Promise<boolean> {
  return ensureHydrated();
}

export async function markOnboardingComplete(): Promise<void> {
  cache = true;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, "true");
  } catch {
    // Non-fatal: the in-memory flag prevents re-entering onboarding this session.
  }
}

export function useOnboardingHydration(): {
  hydrated: boolean;
  completed: boolean;
} {
  const [state, setState] = useState<{ hydrated: boolean; completed: boolean }>(
    { hydrated: cache !== null, completed: cache ?? false },
  );
  useEffect(() => {
    let cancelled = false;
    void ensureHydrated().then((v) => {
      if (!cancelled) setState({ hydrated: true, completed: v });
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}
