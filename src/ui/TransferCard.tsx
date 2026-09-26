import React, { useMemo } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "./themes";
import type { TransferSummary } from "../state/types";
import { clampPercent, formatBytes, formatEta, formatRate } from "../lib/format";
import { useTransferRate } from "../lib/transferRate";
import { useDevMode } from "../state/devModeStorage";

export type TransferCardProps = {
  transfer: TransferSummary;
  /** When true, shows extended details (bytes + drive id + peers). */
  expanded?: boolean;
  onToggleExpanded?: () => void;
  /** Pressing the primary action cancels or clears, depending on state. */
  onCancel?: () => void;
  onClear?: () => void;
  /**
   * Show a small × in the top-right that calls `onClear`, for contexts where
   * the card is a transient strip rather than a persistent bundle card.
   * No-op when `onClear` is missing.
   */
  showDismiss?: boolean;
};

/**
 * One card that adapts its wording and its single primary action to the
 * transfer's state: cancel while it is running, clear once it is over.
 * A "Details" affordance expands bytes, drive id and peer info, and speed
 * and ETA show inline while the transfer is active.
 */
export function TransferCard({
  transfer,
  expanded = false,
  onToggleExpanded,
  onCancel,
  onClear,
  showDismiss = false,
}: TransferCardProps) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { speedBps, etaSec } = useTransferRate(transfer);
  const { enabled: devMode } = useDevMode();

  const isHosted = transfer.origin === "hosted";
  const isActive = !transfer.completed && transfer.peersConnected > 0;
  const isStalled = !transfer.completed && transfer.peersConnected === 0 && (transfer.percent ?? 0) < 100;

  // Checked ahead of `completed` everywhere below: a cancel sets `completed`
  // too, and every completed branch reads as success.
  const isCancelled = transfer.cancelled;

  // Clamp to 99 until the backend says done. A cancelled transfer keeps the
  // percent it reached: snapping to 100 would claim the bytes arrived.
  const rawPct = clampPercent(transfer.percent);
  const pct = isCancelled ? rawPct : transfer.completed ? 100 : Math.min(rawPct, 99);

  // The upload path pins the raw percent at 99 until an explicit completion
  // event arrives; say so, or the transfer looks frozen.
  const isFinalizing = !transfer.completed && !isStalled && rawPct >= 99;

  // The hosted percent is unreliable: UDX sockets do not expose written
  // bytes the way the tracker expects, so it often reads 0 forever. Hosted
  // transfers therefore show a coarse state and a spinner instead of a
  // number; received transfers keep the percent, which counts real bytes.
  const useCoarseHostedDisplay = isHosted && !transfer.completed;
  const hostedActiveCoarse =
    useCoarseHostedDisplay && transfer.peersConnected > 0;

  const status = isCancelled
    ? "Cancelled"
    : transfer.completed
    ? isHosted
      ? "Sent"
      : "Got it"
    : isStalled
      ? isHosted
        ? "Waiting for the other pear…"
        : "Finding the other side…"
      : isHosted
        ? // Hosted active: split on whether any progress event has arrived,
          // so the wording never claims data is flowing before it is.
          transfer.progressEverReceived
          ? "Sending…"
          : "Connected, sending…"
        : isFinalizing
          ? "Almost there…"
          : "Grabbing";

  const primaryLabel = transfer.completed || isStalled ? "Clear" : "Cancel";
  const primaryHandler = transfer.completed || isStalled ? onClear : onCancel;
  const primaryIsDanger = !transfer.completed && !isStalled;

  // No speed or ETA on hosted: the byte counter that would feed them is the
  // same unreliable source as the hosted percent.
  const showRate = isActive && !transfer.completed && speedBps > 0 && !isHosted;

  return (
    <View style={styles.card} accessibilityLabel={`${status} ${pct}%`}>
      <View style={styles.head}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{status}</Text>
          <Text style={styles.sub}>
            {(() => {
              // Dev mode shows raw peer counts; otherwise the states avoid
              // protocol vocabulary.
              if (devMode) {
                if (transfer.peersConnected === 0) return "No one connected";
                if (transfer.peersConnected === 1) return "With one pear";
                return `With ${transfer.peersConnected} pears`;
              }
              // Before `peersConnected`: a cancelled transfer has zero peers
              // by construction, and "Not connected" names a failure that
              // did not happen.
              if (isCancelled) return "Stopped by you";
              if (transfer.peersConnected > 0) return "Connected";
              if (!transfer.completed && !isStalled) return "Looking…";
              return "Not connected";
            })()}
            {showRate ? ` · ${formatRate(speedBps)}` : ""}
            {showRate && etaSec != null ? ` · ${formatEta(etaSec)} left` : ""}
          </Text>
        </View>
        {/* Spinner instead of percent for hosted active states. Percent
         * stays for received, where it is accurate, and for completed or
         * stalled states on either side. */}
        {hostedActiveCoarse ? (
          <ActivityIndicator color={theme.primary} style={styles.hostedSpinner} />
        ) : useCoarseHostedDisplay ? null : (
          <Text style={styles.pct}>{Math.round(pct)}%</Text>
        )}
        {showDismiss && onClear ? (
          <Pressable
            onPress={onClear}
            hitSlop={8}
            style={styles.dismissBtn}
            accessibilityRole="button"
            accessibilityLabel="Clear this card"
          >
            <Ionicons name="close" size={16} color={theme.muted} />
          </Pressable>
        ) : null}
      </View>

      {/* No progress bar for hosted active states: the underlying percent
       * reads zero, and a static empty bar is misleading. The bar stays for
       * received transfers and for completed states on either side. */}
      {!hostedActiveCoarse && !useCoarseHostedDisplay ? (
        <View
          style={styles.track}
          accessibilityRole="progressbar"
          accessibilityValue={{ now: Math.round(pct), min: 0, max: 100 }}
          accessibilityLabel={`${status} ${Math.round(pct)} percent`}
        >
          <View style={[styles.fill, { width: `${pct}%` }]} />
        </View>
      ) : null}

      <View style={styles.actions}>
        <Pressable
          style={[styles.btn, primaryIsDanger && styles.btnDanger]}
          onPress={primaryHandler}
          disabled={!primaryHandler}
          accessibilityRole="button"
          accessibilityLabel={primaryLabel}
        >
          <Text style={[styles.btnText, primaryIsDanger && styles.btnTextDanger]}>{primaryLabel}</Text>
        </Pressable>
        {onToggleExpanded && (
          <Pressable
            style={styles.ghostBtn}
            onPress={onToggleExpanded}
            accessibilityRole="button"
            accessibilityLabel={expanded ? "Hide details" : "Show details"}
          >
            <Ionicons
              name={expanded ? "chevron-up" : "chevron-down"}
              size={14}
              color={theme.muted}
              style={{ marginRight: 4 }}
            />
            <Text style={styles.ghostBtnText}>{expanded ? "Hide" : "Details"}</Text>
          </Pressable>
        )}
      </View>

      {expanded && (
        <View style={styles.detail}>
          <Text style={styles.detailText}>
            {formatBytes(transfer.bytesTransferred)}
            {transfer.totalBytes != null ? ` of ${formatBytes(transfer.totalBytes)}` : ""}
          </Text>
          {transfer.driveSize != null && (
            <Text style={styles.detailText}>Size: {formatBytes(transfer.driveSize)}</Text>
          )}
          {/* Internal IDs are dev-only — meaningless to end users. */}
          {devMode && (
            <Text style={styles.detailText}>ID: {transfer.driveId}</Text>
          )}
          {devMode && transfer.peerIds.length > 0 && (
            <Text style={styles.detailText}>
              Peers: {transfer.peerIds.join(", ")}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    card: {
      borderRadius: 14,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.cardStrong,
      padding: 12,
      gap: 8,
    },
    head: { flexDirection: "row", alignItems: "center" },
    title: { color: theme.text, fontWeight: "700", fontSize: 14 },
    sub: { color: theme.muted, fontSize: 12, marginTop: 2 },
    pct: { color: theme.text, fontWeight: "700", fontSize: 14, marginLeft: 8 },
    hostedSpinner: { marginLeft: 8 },
    track: {
      height: 6,
      borderRadius: 999,
      backgroundColor: theme.surfaceSubtle,
      overflow: "hidden",
    },
    fill: { height: "100%", backgroundColor: theme.primary },
    actions: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 2 },
    btn: {
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 6,
      backgroundColor: theme.surfaceSubtle,
    },
    btnDanger: { borderColor: theme.danger, backgroundColor: "transparent" },
    btnText: { color: theme.text, fontSize: 12, fontWeight: "600" },
    btnTextDanger: { color: theme.danger },
    ghostBtn: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 8,
      paddingVertical: 6,
    },
    ghostBtnText: { color: theme.muted, fontSize: 12, fontWeight: "600" },
    detail: { gap: 4, paddingTop: 4 },
    detailText: { color: theme.muted, fontSize: 12 },
    dismissBtn: {
      marginLeft: 8,
      width: 24,
      height: 24,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 12,
    },
  });
}
