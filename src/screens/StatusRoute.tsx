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
  | "something-wrong"
  | "report-sent";

type Preset = {
  tone: StatusScreenTone;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  title: string;
  body: string;
  /** Buttons rendered bottom-up; caller navigation logic wires each. */
  actionSpecs: {
    label: string;
    kind?: "primary" | "secondary";
    /** `back` = navigation.goBack(); `report` = navigate to ReportBug. */
    behavior: "back" | "report";
  }[];
};

const PRESETS: Record<StatusVariant, Preset> = {
  "no-connection": {
    tone: "warning",
    icon: "wifi-outline",
    title: "No connection",
    body: "PearDrop needs a network to find peers. Check your Wi-Fi or mobile data.",
    actionSpecs: [{ label: "Retry", behavior: "back" }],
  },
  "peer-not-found": {
    tone: "warning",
    icon: "search-outline",
    title: "Peer not found",
    body: "The sender may be offline or the link has expired. Ask them to share a new link.",
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
    actionSpecs: [
      { label: "Restart app", behavior: "back", kind: "primary" },
      { label: "Send crash report", behavior: "report", kind: "secondary" },
    ],
  },
  "report-sent": {
    tone: "primary",
    icon: "checkmark-circle",
    title: "Report sent",
    body: "Thanks for the feedback. We'll look into it as soon as possible.",
    actionSpecs: [{ label: "Done", behavior: "back" }],
  },
};

type Nav = NativeStackNavigationProp<{
  Status: { variant: StatusVariant };
  ReportBug: undefined;
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
      } else if (spec.behavior === "report") {
        nav.navigate("ReportBug");
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
