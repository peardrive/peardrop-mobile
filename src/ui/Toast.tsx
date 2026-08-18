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
import { useMainDockBottomInset } from "../navigation/dockLayout";

export type ToastKind = "info" | "success" | "error" | "warning";

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
 * Single-toast provider. Only one live toast at a time — consecutive calls
 * replace rather than stack. An optional bold `title` sits above the
 * message, with a left-side accent stripe whose color is severity-driven
 * (theme.danger for error, theme.primary for success, theme.secondary for
 * warning, theme.muted for info). Kind + copy come from callers; this
 * component owns styling only.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();
  const dockBottom = useMainDockBottomInset();
  const [visible, setVisible] = useState(false);
  const [message, setMessage] = useState("");
  const [title, setTitle] = useState<string | undefined>(undefined);
  const [kind, setKind] = useState<ToastKind>("info");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(10)).current;

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const dismiss = useCallback(() => {
    clearTimer();
    Animated.parallel([
      Animated.timing(opacity, { toValue: 0, duration: 180, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 10, duration: 180, useNativeDriver: true }),
    ]).start(() => setVisible(false));
  }, [clearTimer, opacity, translateY]);

  const show = useCallback(
    (msg: string, opts?: ToastOptions) => {
      if (!msg) return;
      clearTimer();
      setMessage(msg);
      setTitle(opts?.title);
      setKind(opts?.kind ?? "info");
      setVisible(true);
      opacity.setValue(0);
      translateY.setValue(10);
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }),
        Animated.timing(translateY, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();
      const duration = opts?.durationMs ?? DEFAULT_DURATION;
      timerRef.current = setTimeout(dismiss, duration);
    },
    [clearTimer, dismiss, opacity, translateY]
  );

  useEffect(() => {
    return () => clearTimer();
  }, [clearTimer]);

  const api = useMemo<ToastApi>(() => ({ show, dismiss }), [show, dismiss]);

  const styles = useMemo(() => createStyles(theme), [theme]);

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

  const RECEIVE_INPUT_CLEARANCE = 24;
  const offsetBottom =
    Math.max(dockBottom, insets.bottom + 12) + 12 + RECEIVE_INPUT_CLEARANCE;

  return (
    <ToastContext.Provider value={api}>
      {children}
      {visible && (
        <View pointerEvents="box-none" style={[styles.root, { bottom: offsetBottom }]}>
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
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside ToastProvider");
  return ctx;
}

/**
 * Preset copy for the standard v5 error/status variants. Toast callers can
 * spread the result into `show(msg, opts)` — never a hardcoded color.
 * Anything not in this list falls back to the raw engine error message.
 */
export type ToastVariantId =
  | "no-connection"
  | "peer-not-found"
  | "file-unavailable"
  | "something-wrong"
  | "report-sent";

export type ToastVariant = {
  title: string;
  body: string;
  kind: ToastKind;
};

export const TOAST_VARIANTS: Record<ToastVariantId, ToastVariant> = {
  "no-connection": {
    title: "No connection",
    body: "Check your internet and try again.",
    kind: "error",
  },
  "peer-not-found": {
    title: "Peer not found",
    body: "The other pear may be offline or the link may have expired.",
    kind: "warning",
  },
  "file-unavailable": {
    title: "File unavailable",
    body: "The file couldn't be reached right now.",
    kind: "warning",
  },
  "something-wrong": {
    title: "Something went wrong",
    body: "We hit an unexpected snag. Try again in a moment.",
    kind: "error",
  },
  "report-sent": {
    title: "Report sent",
    body: "Thanks — we'll take a look.",
    kind: "success",
  },
};

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
