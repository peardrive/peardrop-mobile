import React, { useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "./themes";
import { formatBytes } from "../lib/format";
import { fileIcon } from "../lib/files";

export type GrabIntoFolderFile = {
  name: string;
  size: number;
};

export type GrabIntoFolderResult = {
  folderName: string;
  selectedFileNames: string[];
};

export type GrabIntoFolderSheetProps = {
  visible: boolean;
  onClose: () => void;
  /** Files to offer for grabbing. */
  files: GrabIntoFolderFile[];
  /** Prefilled folder name. Editable. */
  defaultFolderName?: string;
  /** Initial checked set. Defaults to all files selected. */
  initialSelected?: string[];
  /** Fired when the user taps Grab. Parent hands off to the existing download path. */
  onGrab: (result: GrabIntoFolderResult) => void;
};

/**
 * Post-selection sheet for the "grab into folder" flow: editable folder
 * name, file checklist, Pick-all toggle, full-width Grab CTA. Purely
 * presentational — parent owns the download plumbing.
 */
export default function GrabIntoFolderSheet({
  visible,
  onClose,
  files,
  defaultFolderName = "New folder",
  initialSelected,
  onGrab,
}: GrabIntoFolderSheetProps) {
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const [folderName, setFolderName] = useState(defaultFolderName);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialSelected ?? files.map((f) => f.name)),
  );

  const allSelected = selected.size === files.length && files.length > 0;
  const canGrab = selected.size > 0 && folderName.trim().length > 0;
  const selectedBytes = files
    .filter((f) => selected.has(f.name))
    .reduce((sum, f) => sum + (f.size ?? 0), 0);

  const toggle = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const pickAll = () => {
    setSelected(allSelected ? new Set() : new Set(files.map((f) => f.name)));
  };

  const submit = () => {
    if (!canGrab) return;
    onGrab({
      folderName: folderName.trim(),
      selectedFileNames: Array.from(selected),
    });
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable
        style={styles.backdrop}
        onPress={onClose}
        accessibilityLabel="Close grab sheet"
      >
        <View
          style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}
          onStartShouldSetResponder={() => true}
        >
          <View style={styles.handle} />
          <Text style={styles.title}>Grab into folder</Text>

          <Text style={styles.fieldLabel}>Folder name</Text>
          <TextInput
            value={folderName}
            onChangeText={setFolderName}
            placeholder="New folder"
            placeholderTextColor={theme.muted}
            style={styles.input}
            autoCorrect={false}
            autoCapitalize="none"
            accessibilityLabel="Folder name"
          />

          <View style={styles.pickAllRow}>
            <Text style={styles.fieldLabel}>
              Files{" "}
              <Text style={styles.selectionCount}>
                ({selected.size} of {files.length} · {formatBytes(selectedBytes)})
              </Text>
            </Text>
            <Pressable
              onPress={pickAll}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={allSelected ? "Deselect all" : "Pick all"}
            >
              <Text style={styles.pickAll}>
                {allSelected ? "Deselect all" : "Pick all"}
              </Text>
            </Pressable>
          </View>

          <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
            {files.map((f, i) => {
              const checked = selected.has(f.name);
              return (
                <Pressable
                  key={f.name}
                  style={[styles.fileRow, i === 0 && styles.fileRowFirst]}
                  onPress={() => toggle(f.name)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked }}
                  accessibilityLabel={f.name}
                >
                  <View
                    style={[styles.checkbox, checked && styles.checkboxChecked]}
                  >
                    {checked ? (
                      <Ionicons name="checkmark" size={14} color={theme.onPrimary} />
                    ) : null}
                  </View>
                  <Text style={styles.fileIcon}>{fileIcon(f.name)}</Text>
                  <View style={styles.fileMain}>
                    <Text style={styles.fileName} numberOfLines={1}>
                      {f.name}
                    </Text>
                    <Text style={styles.fileMeta}>{formatBytes(f.size)}</Text>
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>

          <Pressable
            disabled={!canGrab}
            onPress={submit}
            accessibilityRole="button"
            accessibilityLabel="Grab"
            style={!canGrab && styles.ctaDisabled}
          >
            <LinearGradient
              colors={theme.grabGradient as unknown as [string, string]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.cta}
            >
              <Ionicons
                name="download-outline"
                size={18}
                color={theme.onPrimary}
                style={{ marginRight: 8 }}
              />
              <Text style={styles.ctaLabel}>Grab</Text>
            </LinearGradient>
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.5)",
      justifyContent: "flex-end",
    },
    sheet: {
      maxHeight: "88%",
      backgroundColor: theme.bg,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      borderTopWidth: 1,
      borderColor: theme.border,
      paddingHorizontal: theme.pad,
      paddingTop: 8,
    },
    handle: {
      alignSelf: "center",
      width: 40,
      height: 4,
      borderRadius: 2,
      backgroundColor: theme.border,
      marginBottom: 8,
    },
    title: {
      color: theme.text,
      fontWeight: "700",
      fontSize: 18,
      marginBottom: 12,
    },
    fieldLabel: {
      color: theme.muted,
      fontSize: 12,
      fontWeight: "700",
      textTransform: "uppercase",
      letterSpacing: 0.6,
      marginBottom: 6,
    },
    selectionCount: {
      color: theme.muted,
      fontWeight: "500",
      textTransform: "none",
      letterSpacing: 0,
    },
    input: {
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: theme.radius,
      paddingHorizontal: 12,
      paddingVertical: 12,
      color: theme.text,
      fontSize: 15,
      backgroundColor: theme.cardStrong,
      marginBottom: 14,
    },
    pickAllRow: {
      flexDirection: "row",
      alignItems: "flex-end",
      justifyContent: "space-between",
      marginBottom: 8,
    },
    pickAll: {
      color: theme.primary,
      fontWeight: "600",
      fontSize: 13,
      paddingBottom: 4,
    },
    list: {
      maxHeight: 300,
    },
    fileRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
    fileRowFirst: { borderTopWidth: 0 },
    checkbox: {
      width: 22,
      height: 22,
      borderRadius: 6,
      borderWidth: 1.5,
      borderColor: theme.border,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.surfaceSubtle,
    },
    checkboxChecked: {
      backgroundColor: theme.primary,
      borderColor: theme.primary,
    },
    fileIcon: { width: 28, textAlign: "center", fontSize: 18 },
    fileMain: { flex: 1, minWidth: 0 },
    fileName: { color: theme.text, fontSize: 14, fontWeight: "500" },
    fileMeta: { color: theme.muted, fontSize: 12, marginTop: 2 },
    cta: {
      flexDirection: "row",
      borderRadius: theme.radius,
      paddingVertical: 14,
      alignItems: "center",
      justifyContent: "center",
      marginTop: 12,
    },
    ctaDisabled: { opacity: 0.5 },
    ctaLabel: {
      color: theme.onPrimary,
      fontSize: 15,
      fontWeight: "700",
    },
  });
}
