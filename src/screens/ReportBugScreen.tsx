import React, { useCallback, useMemo, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useAppTheme } from "../state/ThemeContext";
import { useToast } from "../ui/Toast";
import type { AppTheme } from "../ui/themes";

const MAX_LEN = 500;

type Nav = NativeStackNavigationProp<{
  Status: { variant: string };
  ReportBug: undefined;
  Main: undefined;
  Settings: undefined;
}>;

/**
 * v5 "Report a bug" form. Textarea + optional location + attach-device-info
 * toggle. Submit is currently a stub: it toasts success and navigates to
 * the Status "report-sent" screen. Wiring to a real backend/email intent
 * is a follow-up decision.
 */
export default function ReportBugScreen() {
  const nav = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { theme } = useAppTheme();
  const { show: showToast } = useToast();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const [what, setWhat] = useState("");
  const [where, setWhere] = useState("");
  const [attachInfo, setAttachInfo] = useState(true);

  const remaining = MAX_LEN - what.length;
  const canSend = what.trim().length > 0;

  const onBack = useCallback(() => {
    if (nav.canGoBack()) nav.goBack();
  }, [nav]);

  const onSend = useCallback(() => {
    if (!canSend) return;
    // Submit target TBD — for now, land on the Report sent status.
    showToast("Report sent", { kind: "success" });
    nav.navigate("Status", { variant: "report-sent" });
  }, [canSend, nav, showToast]);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.bg }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView
        style={[styles.root, { paddingTop: insets.top + 4 }]}
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.headerRow}>
          <Pressable
            onPress={onBack}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Back"
            style={styles.backBtn}
          >
            <Ionicons name="chevron-back" size={22} color={theme.text} />
          </Pressable>
          <Text style={styles.title}>Report a bug</Text>
        </View>

        <Text style={styles.fieldLabel}>What went wrong?</Text>
        <View style={styles.textareaWrap}>
          <TextInput
            style={styles.textarea}
            value={what}
            onChangeText={(t) => setWhat(t.slice(0, MAX_LEN))}
            placeholder="Describe what happened…"
            placeholderTextColor={theme.muted}
            multiline
            textAlignVertical="top"
            accessibilityLabel="Describe what went wrong"
          />
          <Text style={styles.counter}>
            {what.length}/{MAX_LEN}
          </Text>
        </View>

        <Text style={styles.fieldLabel}>Where did it happen?</Text>
        <TextInput
          style={styles.input}
          value={where}
          onChangeText={setWhere}
          placeholder="where did it happen"
          placeholderTextColor={theme.muted}
          accessibilityLabel="Where did it happen"
        />

        <View style={styles.toggleRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.toggleTitle}>Attach device info</Text>
            <Text style={styles.toggleSub}>App version, OS, device model</Text>
          </View>
          <Switch
            value={attachInfo}
            onValueChange={setAttachInfo}
            accessibilityLabel="Attach device info"
          />
        </View>
        {attachInfo ? (
          <View style={styles.chipRow}>
            <View style={styles.chip}>
              <Text style={styles.chipText}>v0.1.02</Text>
            </View>
            <View style={styles.chip}>
              <Text style={styles.chipText}>{Platform.OS === "ios" ? "iOS" : "Android"}</Text>
            </View>
            <View style={styles.chip}>
              <Text style={styles.chipText}>Device</Text>
            </View>
          </View>
        ) : (
          <View style={{ height: 8 }} />
        )}

        <Pressable
          onPress={onSend}
          disabled={!canSend}
          style={[styles.sendBtn, !canSend && styles.sendBtnDisabled]}
          accessibilityRole="button"
          accessibilityLabel="Send Report"
        >
          <Text style={styles.sendBtnLabel}>Send Report</Text>
        </Pressable>

        <Text style={remaining < 20 ? styles.counterNearLimit : styles.counter}>
          {/* keep the counter visually anchored under the button too */}
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.bg, paddingHorizontal: theme.pad },
    headerRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      marginBottom: 16,
    },
    backBtn: {
      width: 32,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
    },
    title: { fontSize: 24, fontWeight: "800", color: theme.text },
    fieldLabel: {
      color: theme.muted,
      fontSize: 12,
      fontWeight: "700",
      textTransform: "uppercase",
      letterSpacing: 0.6,
      marginTop: 12,
      marginBottom: 6,
    },
    textareaWrap: {
      backgroundColor: theme.cardStrong,
      borderRadius: theme.radius,
      borderWidth: 1,
      borderColor: theme.border,
      padding: 12,
    },
    textarea: {
      color: theme.text,
      fontSize: 15,
      minHeight: 130,
      lineHeight: 20,
    },
    counter: {
      color: theme.muted,
      fontSize: 12,
      textAlign: "right",
      marginTop: 6,
    },
    counterNearLimit: {
      color: theme.warning,
      fontSize: 12,
      textAlign: "right",
      marginTop: 6,
    },
    input: {
      color: theme.text,
      fontSize: 15,
      backgroundColor: theme.cardStrong,
      borderRadius: theme.radius,
      borderWidth: 1,
      borderColor: theme.border,
      paddingHorizontal: 12,
      paddingVertical: 12,
    },
    toggleRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      marginTop: 20,
    },
    toggleTitle: { color: theme.text, fontSize: 15, fontWeight: "600" },
    toggleSub: {
      color: theme.muted,
      fontSize: 12,
      marginTop: 2,
    },
    chipRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      marginTop: 10,
    },
    chip: {
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 999,
      backgroundColor: theme.surfaceSubtle,
      borderWidth: 1,
      borderColor: theme.border,
    },
    chipText: { color: theme.muted, fontSize: 12, fontWeight: "500" },
    sendBtn: {
      marginTop: 24,
      backgroundColor: theme.primary,
      borderRadius: theme.radius,
      paddingVertical: 14,
      alignItems: "center",
    },
    sendBtnDisabled: { opacity: 0.5 },
    sendBtnLabel: {
      color: theme.onPrimary,
      fontSize: 15,
      fontWeight: "700",
    },
  });
}
