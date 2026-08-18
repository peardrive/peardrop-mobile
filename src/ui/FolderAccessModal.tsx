import React, { useMemo } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAppTheme } from "../state/ThemeContext";
import type { AppTheme } from "./themes";
import { folderDisplayName } from "../lib/fileBrowse";

export type FolderAccessModalProps = {
  visible: boolean;
  /** Granted folder URIs, in the order they were added. */
  folders: string[];
  onClose: () => void;
  onAdd: () => void;
  onRemove: (uri: string) => void;
};

/**
 * Manages which folders PearDrop can read.
 *
 * This is the honest surface for a permission the user granted piecemeal:
 * everything they've allowed, in one place, each removable. Android holds
 * these as persisted SAF grants, so without a screen like this the list
 * is invisible and only growable — which is exactly the pattern people
 * distrust in file-sharing apps.
 */
export default function FolderAccessModal({
  visible,
  folders,
  onClose,
  onAdd,
  onRemove,
}: FolderAccessModalProps) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable
        style={styles.backdrop}
        onPress={onClose}
        accessibilityLabel="Close folder access"
      >
        <Pressable style={styles.card} onPress={() => {}}>
          <View style={styles.titleRow}>
            <Text style={styles.title}>Folders</Text>
            <Pressable
              onPress={onClose}
              style={styles.closeCircle}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Ionicons name="close" size={16} color={theme.onPrimary} />
            </Pressable>
          </View>

          <Text style={styles.body}>
            Add your favorite folders here for quick access in Recent files.
            Remove one anytime to stop PearDrop from reading it.
          </Text>

          {folders.length > 0 ? (
            <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
              {folders.map((uri, i) => {
                const name = folderDisplayName(uri) || "Selected folder";
                return (
                  <React.Fragment key={uri}>
                    {i > 0 ? <View style={styles.divider} /> : null}
                    <View style={styles.row}>
                      <View style={styles.rowIcon}>
                        <Ionicons
                          name="folder-outline"
                          size={20}
                          color={theme.primary}
                        />
                      </View>
                      <Text style={styles.rowName} numberOfLines={1}>
                        {name}
                      </Text>
                      <Pressable
                        onPress={() => onRemove(uri)}
                        hitSlop={8}
                        accessibilityRole="button"
                        accessibilityLabel={`Remove access to ${name}`}
                        style={styles.removeBtn}
                      >
                        <Text style={styles.removeText}>Remove</Text>
                      </Pressable>
                    </View>
                  </React.Fragment>
                );
              })}
            </ScrollView>
          ) : (
            <Text style={styles.empty}>
              No folders yet. Add one and its files show up ready to send.
            </Text>
          )}

          <Pressable
            style={({ pressed }) => [styles.addBtn, pressed && styles.pressed]}
            onPress={onAdd}
            accessibilityRole="button"
            accessibilityLabel="Add a folder"
          >
            <Ionicons name="add" size={18} color={theme.onPrimary} />
            <Text style={styles.addText}>Add folder</Text>
          </Pressable>

          {/* The subtitle already covers what Remove does. This is the
              part it can't claim: removing stops us reading the folder,
              but Android keeps the persisted grant until the user takes
              it back in system settings. Saying "revoke" up top would
              overpromise, so the precise note lives here. */}
          <Text style={styles.footnote}>
            To take the Android permission back as well, use your
            device&apos;s app settings.
          </Text>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.5)",
      alignItems: "center",
      justifyContent: "center",
      padding: theme.pad,
    },
    card: {
      width: "100%",
      maxWidth: 420,
      borderRadius: 20,
      backgroundColor: theme.bg,
      borderWidth: 1,
      borderColor: theme.border,
      padding: theme.pad,
      gap: 12,
    },
    titleRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    title: { color: theme.text, fontWeight: "700", fontSize: 20 },
    closeCircle: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.danger,
    },
    body: { color: theme.muted, fontSize: 13, lineHeight: 18 },
    list: { maxHeight: 260 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 10,
    },
    rowIcon: {
      width: 36,
      height: 36,
      borderRadius: 10,
      backgroundColor: theme.surfaceSubtle,
      borderWidth: 1,
      borderColor: theme.border,
      alignItems: "center",
      justifyContent: "center",
    },
    rowName: { flex: 1, minWidth: 0, color: theme.text, fontSize: 15, fontWeight: "600" },
    removeBtn: { paddingHorizontal: 4, paddingVertical: 2 },
    removeText: { color: theme.danger, fontWeight: "700", fontSize: 13 },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: theme.border },
    empty: { color: theme.muted, fontSize: 13, lineHeight: 18, paddingVertical: 8 },
    addBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      backgroundColor: theme.primary,
      paddingVertical: 13,
      borderRadius: 14,
    },
    addText: { color: theme.onPrimary, fontWeight: "700", fontSize: 15 },
    pressed: { opacity: 0.9 },
    footnote: { color: theme.muted, fontSize: 11, lineHeight: 15 },
  });
}
