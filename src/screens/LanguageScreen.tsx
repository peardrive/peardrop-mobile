// Single option: no i18n layer exists yet, so English is the only true answer.
import React, { useCallback, useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "../ui/themes";

export default function LanguageScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const { theme } = useAppTheme();

  const onBack = useCallback(() => {
    if (navigation.canGoBack()) navigation.goBack();
  }, [navigation]);

  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <ScrollView
      style={[styles.root, { paddingTop: insets.top + theme.pad }]}
      contentContainerStyle={[
        styles.content,
        { paddingBottom: insets.bottom + 96 },
      ]}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.titleRow}>
        <Pressable
          onPress={onBack}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.backBtn}
        >
          <Ionicons name="chevron-back" size={22} color={theme.text} />
        </Pressable>
        <Text style={styles.title}>Language</Text>
      </View>

      <View style={styles.sectionCard}>
        <LanguageRow theme={theme} icon="language-outline" label="English" />
      </View>
    </ScrollView>
  );
}

/**
 * Trimmed copy of SettingsScreen's SettingsRow — no subtitle/value/onPress/
 * first; the trailing icon is a fixed checkmark, not a nav chevron.
 */
function LanguageRow({
  theme,
  icon,
  label,
}: {
  theme: AppTheme;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  label: string;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 14,
      }}
      accessibilityRole="radio"
      accessibilityState={{ selected: true }}
      accessibilityLabel={label}
    >
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: 10,
          backgroundColor: theme.primary,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Ionicons name={icon} size={18} color={theme.onPrimary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text
          style={{
            color: theme.text,
            fontSize: 15,
            fontWeight: "500",
          }}
        >
          {label}
        </Text>
      </View>
      <Ionicons name="checkmark" size={18} color={theme.primary} />
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.bg },
    content: { paddingHorizontal: theme.pad },
    titleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      // Settings has SectionLabel's marginTop below its title; this page
      // goes straight to a card, so the gap lives here instead.
      marginBottom: 20,
    },
    backBtn: {
      width: 32,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
    },
    title: { fontSize: 26, fontWeight: "700", color: theme.text },
    sectionCard: {
      backgroundColor: theme.card,
      borderRadius: theme.radius,
      borderWidth: 1,
      borderColor: theme.border,
      overflow: "hidden",
    },
  });
}
