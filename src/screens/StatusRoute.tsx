import React from "react";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RouteProp } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import StatusScreen, {
  type StatusScreenAction,
  type StatusScreenTone,
} from "../ui/StatusScreen";

export type StatusVariant =
  | "no-connection"
  | "peer-not-found"
  | "file-unavailable"
  | "something-wrong";

type Preset = {
  tone: StatusScreenTone;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  title: string;
  body: string;
  /** Buttons rendered bottom-up; caller navigation logic wires each. */
  actionSpecs: {
    label: string;
    kind?: "primary" | "secondary";
    /** `back` = navigation.goBack(). */
    behavior: "back";
  }[];
};

const PRESETS: Record<StatusVariant, Preset> = {
  "no-connection": {
    tone: "warning",
    icon: "wifi-outline",
    title: "No connection",
    // There is no connectivity detection here, so this copy cannot claim a
    // network is missing or send the user to a Wi-Fi setting. Say what
    // happened, never why.
    body: "PearDrop couldn't reach any peers. Both phones need to be awake with PearDrop open — try again in a moment.",
    actionSpecs: [{ label: "Retry", behavior: "back" }],
  },
  "peer-not-found": {
    tone: "warning",
    icon: "search-outline",
    title: "Peer not found",
    // Two claims the app cannot make: there is no offline detection, and a
    // share link never expires while the sender still hosts it.
    body: "PearDrop couldn't reach the sender. Their phone needs to be awake with PearDrop open — ask them to try again.",
    actionSpecs: [{ label: "Go back", behavior: "back" }],
  },
  "file-unavailable": {
    tone: "danger",
    icon: "warning",
    title: "File unavailable",
    body: "The sender removed this file or stopped sharing it. Ask them to share a new link.",
    actionSpecs: [{ label: "Dismiss", behavior: "back" }],
  },
  "something-wrong": {
    tone: "primary",
    icon: "alert-circle",
    title: "Something went wrong",
    body: "PearDrop ran into an unexpected problem and had to stop. Your files are safe.",
    actionSpecs: [{ label: "Restart app", behavior: "back", kind: "primary" }],
  },
};

type Nav = NativeStackNavigationProp<{
  Status: { variant: StatusVariant };
  Main: undefined;
}>;

type Route = RouteProp<{ Status: { variant: StatusVariant } }, "Status">;

export default function StatusRoute() {
  const nav = useNavigation<Nav>();
  const route = useRoute<Route>();
  const preset = PRESETS[route.params?.variant] ?? PRESETS["something-wrong"];

  const actions: StatusScreenAction[] = preset.actionSpecs.map((spec) => ({
    label: spec.label,
    kind: spec.kind,
    onPress: () => {
      if (spec.behavior === "back") {
        if (nav.canGoBack()) nav.goBack();
        else nav.reset({ index: 0, routes: [{ name: "Main" }] });
      }
    },
  }));

  return (
    <StatusScreen
      tone={preset.tone}
      icon={preset.icon}
      title={preset.title}
      body={preset.body}
      actions={actions}
    />
  );
}
