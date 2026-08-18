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
   * Show a small × affordance in the top-right that calls `onClear`. Intended
   * for contexts where the card is a transient strip (Receive) rather than
   * a persistent bundle card (Share). No-op if `onClear` is missing.
   */
  showDismiss?: boolean;
};

/**
 * TransferCard v2. A single card that adapts its wording and single primary
 * action to the transfer's state:
 *
 *   - Active      → "Cancel" (danger)
 *   - Completed   → "Clear"
 *   - Disconnected→ "Clear" (peers dropped and we can't recover)
 *
 * A secondary "Details" affordance expands bytes / drive id / peer info.
 * Speed and ETA are shown inline while the transfer is active.
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

  // Clamp to 99 until backend says done. See HomeScreen for the same logic
  // applied to the legacy inline card; we keep it here so any consumer gets
  // the fix for free.
  const rawPct = clampPercent(transfer.percent);
  const pct = transfer.completed ? 100 : Math.min(rawPct, 99);

  // Once the raw percent is pinned at 99 (upload path clamps there until an
  // explicit upload-complete event arrives), surface that to the user so
  // they don't think the transfer is frozen.
  const isFinalizing = !transfer.completed && !isStalled && rawPct >= 99;

  // Hosted percent is unreliable: Hyperswarm UDX sockets don't expose
  // `socket.bytesWritten` the way Node net.Socket does, so the tracker often
  // reads 0 forever and the percent never advances. Hosted transfers show a
  // coarse state instead — peer connected vs. data flowing — plus a spinner.
  // Received transfers keep the percent; engineDownload tallies real bytes.
  const useCoarseHostedDisplay = isHosted && !transfer.completed;
  const hostedActiveCoarse =
    useCoarseHostedDisplay && transfer.peersConnected > 0;

  const status = transfer.completed
    ? isHosted
      ? "Sent"
      : "Got it"
    : isStalled
      ? isHosted
        ? "Waiting for the other pear…"
        : "Finding the other side…"
      : isHosted
        ? // Hosted active: split on whether any progress event has arrived.
          // "Connected, sending…" before the engine's tracker has emitted
          // anything; "Sending…" once data has demonstrably been flowing.
          // Both states get a spinner instead of a percent number.
          transfer.progressEverReceived
          ? "Sending…"
          : "Connected, sending…"
        : isFinalizing
          ? "Almost there…"
          : "Grabbing";

  const primaryLabel = transfer.completed || isStalled ? "Clear" : "Cancel";
  const primaryHandler = transfer.completed || isStalled ? onClear : onCancel;
  const primaryIsDanger = !transfer.completed && !isStalled;

  // Hide the speed/ETA on hosted because we don't actually know the rate
  // (same root cause as the broken percent — the byte counter lies).
  const showRate = isActive && !transfer.completed && speedBps > 0 && !isHosted;

  return (
    <View style={styles.card} accessibilityLabel={`${status} ${pct}%`}>
      <View style={styles.head}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{status}</Text>
          <Text style={styles.sub}>
            {(() => {
              // Dev mode: show raw peer counts. Off: surface user-friendly
              // states ("Connected" / "Looking…" / "Not connected") that
              // don't expose protocol vocabulary.
              if (devMode) {
                if (transfer.peersConnected === 0) return "No one connected";
                if (transfer.peersConnected === 1) return "With one pear";
                return `With ${transfer.peersConnected} pears`;
              }
              if (transfer.peersConnected > 0) return "Connected";
              if (!transfer.completed && !isStalled) return "Looking…";
              return "Not connected";
            })()}
            {showRate ? ` · ${formatRate(speedBps)}` : ""}
            {showRate && etaSec != null ? ` · ${formatEta(etaSec)} left` : ""}
          </Text>
        </View>
        {/* Spinner instead of percent for hosted active states. Percent stays
         * for received, where it's accurate, and for completed/stalled. */}
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

      {/* No progress bar for hosted active states: the underlying percent is
       * the false zero from socket.bytesWritten, so a static empty bar is
       * misleading. Shown for received transfers and completed states. */}
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
