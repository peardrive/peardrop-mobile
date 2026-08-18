import React, { useMemo, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "./themes";
import BottomSheet from "./BottomSheet";

export type FilterId =
  | "all"
  | "files"
  | "folders"
  | "active"
  | "completed";
export type SortId = "recent" | "name" | "size";

export const FILTER_OPTIONS: { value: FilterId; label: string; icon: React.ComponentProps<typeof Ionicons>["name"] }[] = [
  { value: "all", label: "All", icon: "apps-outline" },
  { value: "files", label: "Files only", icon: "document-outline" },
  { value: "folders", label: "Folders only", icon: "folder-outline" },
  { value: "active", label: "Active only", icon: "radio-outline" },
  { value: "completed", label: "Completed only", icon: "checkmark-done-outline" },
];

export const SORT_OPTIONS: { value: SortId; label: string; icon: React.ComponentProps<typeof Ionicons>["name"] }[] = [
  { value: "recent", label: "Most recent", icon: "time-outline" },
  { value: "name", label: "Name A–Z", icon: "text-outline" },
  { value: "size", label: "Size (largest first)", icon: "resize-outline" },
];

export type ListToolbarProps = {
  search: string;
  onSearchChange: (next: string) => void;
  filter: FilterId;
  onFilterChange: (next: FilterId) => void;
  sort: SortId;
  onSortChange: (next: SortId) => void;
  placeholder?: string;
};

/**
 * v5 list toolbar: search field + filter dropdown + sort control. Filter/
 * sort open bottom-anchored menus (data-driven, themed). All colors from
 * theme tokens.
 */
export default function ListToolbar({
  search,
  onSearchChange,
  filter,
  onFilterChange,
  sort,
  onSortChange,
  placeholder = "Search shares…",
}: ListToolbarProps) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [openMenu, setOpenMenu] = useState<null | "filter" | "sort">(null);
  const activeFilter = FILTER_OPTIONS.find((o) => o.value === filter);
  return (
    <View style={styles.row}>
      <View style={styles.searchWrap}>
        <Ionicons
          name="search"
          size={16}
          color={theme.muted}
          style={styles.searchIcon}
        />
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={onSearchChange}
          placeholder={placeholder}
          placeholderTextColor={theme.muted}
          returnKeyType="search"
          autoCorrect={false}
          accessibilityLabel="Search shares"
        />
        {search.length > 0 ? (
          <Pressable
            onPress={() => onSearchChange("")}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            style={styles.clearBtn}
          >
            <Ionicons name="close-circle" size={16} color={theme.muted} />
          </Pressable>
        ) : null}
      </View>

      <Pressable
        style={styles.iconBtn}
        onPress={() => setOpenMenu("filter")}
        accessibilityRole="button"
        accessibilityLabel={`Filter: ${activeFilter?.label ?? "All"}`}
      >
        <Ionicons name="funnel-outline" size={16} color={theme.text} />
        <Ionicons
          name="chevron-down"
          size={12}
          color={theme.muted}
          style={{ marginLeft: 2 }}
        />
      </Pressable>

      <Pressable
        style={styles.iconBtn}
        onPress={() => setOpenMenu("sort")}
        accessibilityRole="button"
        accessibilityLabel="Sort"
      >
        <Ionicons name="swap-vertical" size={18} color={theme.text} />
      </Pressable>

      <BottomSheet
        visible={openMenu !== null}
        onClose={() => setOpenMenu(null)}
      >
        <Text style={styles.menuTitle}>
          {openMenu === "filter" ? "Filter" : "Sort by"}
        </Text>
        {(openMenu === "filter" ? FILTER_OPTIONS : SORT_OPTIONS).map(
          (opt, i) => {
            const selected =
              openMenu === "filter"
                ? opt.value === filter
                : opt.value === sort;
            return (
              <React.Fragment key={opt.value}>
                {i > 0 ? <View style={styles.divider} /> : null}
                <Pressable
                  style={styles.menuRow}
                  onPress={() => {
                    if (openMenu === "filter") {
                      onFilterChange(opt.value as FilterId);
                    } else {
                      onSortChange(opt.value as SortId);
                    }
                    setOpenMenu(null);
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={opt.label}
                >
                  <Ionicons name={opt.icon} size={18} color={theme.text} />
                  <Text style={styles.menuRowText}>{opt.label}</Text>
                  {selected ? (
                    <Ionicons
                      name="checkmark"
                      size={18}
                      color={theme.primary}
                    />
                  ) : null}
                </Pressable>
              </React.Fragment>
            );
          },
        )}
      </BottomSheet>
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: theme.pad,
      paddingVertical: 10,
    },
    searchWrap: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      borderRadius: 999,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.cardStrong,
      paddingHorizontal: 12,
      height: 38,
    },
    searchIcon: { marginRight: 8 },
    searchInput: {
      flex: 1,
      color: theme.text,
      fontSize: 14,
      padding: 0,
    },
    clearBtn: { marginLeft: 4, padding: 2 },
    iconBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      minWidth: 44,
      height: 38,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.cardStrong,
      paddingHorizontal: 10,
    },
    menuTitle: {
      color: theme.muted,
      fontSize: 12,
      fontWeight: "700",
      textTransform: "uppercase",
      letterSpacing: 0.6,
      paddingVertical: 6,
    },
    menuRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
      paddingVertical: 14,
    },
    menuRowText: {
      flex: 1,
      color: theme.text,
      fontSize: 15,
      fontWeight: "500",
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.border,
    },
  });
}
