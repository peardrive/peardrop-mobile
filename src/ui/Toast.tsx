import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "./themes";

// The type and the copy table live in
// `src/lib/` so jest can reach the strings; re-exported here so every existing
// import site is unchanged. See `src/lib/toastCopy.ts` for why.
import type { ToastKind } from "../lib/toastKind";
// the "which outlet draws" rule is pure and lives in src/lib so the suite
// can reach it — this file is a .tsx and jest renders none.
import {
  isActiveToastOutlet,
  registerToastOutlet,
  unregisterToastOutlet,
  type ToastOutletId,
} from "../lib/toastOutletSelect";

export type { ToastKind } from "../lib/toastKind";
export type { ToastVariantId, ToastVariant } from "../lib/toastCopy";
export { TOAST_VARIANTS } from "../lib/toastCopy";

type ToastOptions = {
  kind?: ToastKind;
  durationMs?: number;
  /** Optional bold headline shown above the message. */
  title?: string;
};

type ToastApi = {
  show: (message: string, opts?: ToastOptions) => void;
  dismiss: () => void;
};

const ToastContext = createContext<ToastApi | null>(null);

const DEFAULT_DURATION = 2600;

/**
 * what the outlet reads, and the registry it joins.
 *
 * Kept in a SECOND context rather than widened into `ToastApi`, because
 * `ToastApi` is what every existing call site destructures, and its shape must
 * not move. 
 * `useToast()` still returns `{ show, dismiss }` and nothing else.
 *
 * Context crosses a `Modal` boundary — RN renders modal children with the same
 * renderer (`Modal.js:309`) — which is what makes an outlet inside a dialog
 * window able to read provider state at all.
 */
type ToastOutletState = {
  visible: boolean;
  message: string;
  title?: string;
  kind: ToastKind;
  /** Bumped on every `show`, so an outlet can re-run its entry animation. */
  generation: number;
  dismiss: () => void;
  registered: readonly ToastOutletId[];
  register: (id: ToastOutletId) => void;
  unregister: (id: ToastOutletId) => void;
  nextOutletId: () => ToastOutletId;
};

const ToastOutletContext = createContext<ToastOutletState | null>(null);

/**
 * Single-toast provider. Only one live toast at a time — consecutive calls
 * replace rather than stack. v5 restyle: optional bold `title` above the
 * message, and a left-side accent stripe whose color is severity-driven
 * (theme.danger for error, theme.primary for success, theme.secondary for
 * warning, theme.muted for info). Kind + copy come from callers; this
 * component owns styling only.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [visible, setVisible] = useState(false);
  const [message, setMessage] = useState("");
  const [title, setTitle] = useState<string | undefined>(undefined);
  const [kind, setKind] = useState<ToastKind>("info");
  const [generation, setGeneration] = useState(0);
  const [registered, setRegistered] = useState<readonly ToastOutletId[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idSeq = useRef(0);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /**
   * The provider no longer animates.
   *
   * It used to own the two `Animated.Value`s and drive them here. One
   * native-driver value cannot be attached to views in two different native
   * windows, so each outlet owns its own pair and runs the entry animation off
   * `generation` and the exit animation off `visible` going false. This
   * function therefore only flips state; the fade-out is the outlet's, and
   * `visible: false` is what starts it.
   */
  const dismiss = useCallback(() => {
    clearTimer();
    setVisible(false);
  }, [clearTimer]);

  const show = useCallback(
    (msg: string, opts?: ToastOptions) => {
      if (!msg) return;
      clearTimer();
      setMessage(msg);
      setTitle(opts?.title);
      setKind(opts?.kind ?? "info");
      setVisible(true);
      // Replace-not-stack is unchanged: a second `show` bumps the generation,
      // which re-runs the active outlet's entry animation in place.
      setGeneration((n) => n + 1);
      const duration = opts?.durationMs ?? DEFAULT_DURATION;
      timerRef.current = setTimeout(() => {
        clearTimer();
        setVisible(false);
      }, duration);
    },
    [clearTimer]
  );

  useEffect(() => {
    return () => clearTimer();
  }, [clearTimer]);

  const register = useCallback((id: ToastOutletId) => {
    setRegistered((prev) => registerToastOutlet(prev, id));
  }, []);
  const unregister = useCallback((id: ToastOutletId) => {
    setRegistered((prev) => unregisterToastOutlet(prev, id));
  }, []);
  const nextOutletId = useCallback(() => {
    idSeq.current += 1;
    return idSeq.current;
  }, []);

  const api = useMemo<ToastApi>(() => ({ show, dismiss }), [show, dismiss]);

  const outletState = useMemo<ToastOutletState>(
    () => ({
      visible,
      message,
      title,
      kind,
      generation,
      dismiss,
      registered,
      register,
      unregister,
      nextOutletId,
    }),
    [
      visible,
      message,
      title,
      kind,
      generation,
      dismiss,
      registered,
      register,
      unregister,
      nextOutletId,
    ]
  );

  return (
    <ToastContext.Provider value={api}>
      <ToastOutletContext.Provider value={outletState}>
        {children}
      </ToastOutletContext.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside ToastProvider");
  return ctx;
}

/**
 * One toast surface, in whatever window it is mounted in.
 *
 * Put one at the root (after the navigator) and one as the **last child inside
 * every shipped `Modal`**. Exactly one draws — `selectToastOutlet` picks the
 * last registered, which is the innermost open modal. See
 * `src/lib/toastOutletSelect.ts` for why that ordering holds.
 *
 * Owns its own `Animated.Value`s on purpose: a single native-driver value
 * attached to views in two native windows is untested here and the plausible
 * failure is an outlet stuck at opacity 0.
 */
export function ToastOutlet() {
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();
  const ctx = useContext(ToastOutletContext);
  if (!ctx) throw new Error("ToastOutlet must be used inside ToastProvider");
  const {
    visible,
    message,
    title,
    kind,
    generation,
    dismiss,
    registered,
    register,
    unregister,
    nextOutletId,
  } = ctx;

  const styles = useMemo(() => createStyles(theme), [theme]);
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(-10)).current;

  /**
   * A stable id for this outlet's whole mount, minted once.
   *
   * `useRef` + lazy init rather than `useState`, and the registration effect
   * below depends on `[id]` ALONE — which, because `id` is minted once per
   * mount and never reassigned, means it runs exactly once. Re-registering
   * moves an outlet to the end of the list, so an effect that re-ran on a
   * theme change would let the root outlet steal the toast out from under an
   * open sheet. Register on mount, unregister on unmount, never in between.
   */
  const idRef = useRef<ToastOutletId | null>(null);
  if (idRef.current === null) idRef.current = nextOutletId();
  const id = idRef.current;

  useEffect(() => {
    register(id);
    return () => unregister(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  /**
   * `rendered` is this outlet's own copy of "there is a toast on screen", kept
   * so the exit animation has something to animate before the view goes away.
   * The provider's `visible` turning false starts the fade; `rendered` clears
   * when it finishes.
   */
  const [rendered, setRendered] = useState(false);
  const active = isActiveToastOutlet(registered, id);

  useEffect(() => {
    if (!active) {
      // Another outlet owns the toast now. Drop ours immediately — animating
      // out in a window that may already be gone buys nothing.
      setRendered(false);
      return;
    }
    if (visible) {
      setRendered(true);
      opacity.setValue(0);
      translateY.setValue(-10);
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }),
        Animated.timing(translateY, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();
      return;
    }
    if (!rendered) return;
    Animated.parallel([
      Animated.timing(opacity, { toValue: 0, duration: 180, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: -10, duration: 180, useNativeDriver: true }),
    ]).start(({ finished }) => {
      // Guard the callback: a `show` landing mid-fade sets `visible` true
      // again and re-runs this effect, and an unguarded completion would then
      // unmount the toast that was just raised.
      if (finished) setRendered(false);
    });
    // `rendered` is deliberately not a dep — including it would re-run the
    // exit animation on its own state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, visible, generation, opacity, translateY]);

  if (!active || !rendered) return null;

  const iconName: keyof typeof Ionicons.glyphMap =
    kind === "success"
      ? "checkmark-circle"
      : kind === "error"
        ? "alert-circle"
        : kind === "warning"
          ? "warning"
          : "information-circle";
  const accent =
    kind === "success"
      ? theme.primary
      : kind === "error"
        ? theme.danger
        : kind === "warning"
          ? theme.secondary
          : theme.muted;

  return (
    <View pointerEvents="box-none" style={[styles.root, { top: insets.top + 12 }]}>
      <Animated.View
        style={[styles.toast, { opacity, transform: [{ translateY }] }]}
        accessibilityLiveRegion="polite"
        accessibilityRole="alert"
      >
        <View style={[styles.stripe, { backgroundColor: accent }]} />
        <View style={[styles.iconBadge, { borderColor: accent }]}>
          <Ionicons name={iconName} size={18} color={accent} />
        </View>
        <View style={styles.body}>
          {title ? (
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
          ) : null}
          <Text
            style={[styles.text, !title && styles.textSolo]}
            numberOfLines={3}
          >
            {message}
          </Text>
        </View>
        <Pressable
          onPress={dismiss}
          hitSlop={8}
          style={styles.dismiss}
          accessibilityRole="button"
          accessibilityLabel="Dismiss notification"
        >
          <Ionicons name="close" size={16} color={theme.muted} />
        </Pressable>
      </Animated.View>
    </View>
  );
}

/*
 * The variant copy that used to live here
 * moved to `src/lib/toastCopy.ts` and is re-exported at the top of this file.
 *
 * Its old doc comment ended *"Anything not in this list falls back to the raw
 * engine error message."* — which described a real defect as though it were
 * the design. It does not fall back to raw engine text any
 * more; `userFacingError` in `src/lib/errorMessage.ts` returns the caller's
 * own fallback and never the engine's message.
 */

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: {
      position: "absolute",
      left: 16,
      right: 16,
      alignItems: "center",
    },
    toast: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: theme.bg,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: theme.border,
      paddingVertical: 12,
      paddingRight: 12,
      paddingLeft: 0,
      maxWidth: 520,
      width: "100%",
      overflow: "hidden",
      shadowColor: "#000",
      shadowOpacity: 0.18,
      shadowOffset: { width: 0, height: 4 },
      shadowRadius: 10,
      elevation: 4,
    },
    stripe: {
      width: 4,
      alignSelf: "stretch",
      marginRight: 12,
    },
    iconBadge: {
      width: 28,
      height: 28,
      borderRadius: 14,
      borderWidth: 1,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.surfaceSubtle,
      marginRight: 10,
    },
    body: { flex: 1 },
    title: {
      color: theme.text,
      fontSize: 14,
      fontWeight: "700",
      marginBottom: 2,
    },
    text: { color: theme.muted, fontSize: 13, lineHeight: 18 },
    textSolo: {
      color: theme.text,
      fontSize: 14,
      fontWeight: "500",
    },
    dismiss: {
      marginLeft: 8,
      width: 24,
      height: 24,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 12,
    },
  });
}
