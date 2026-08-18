export type ThemeId =
  | "void"
  | "pear"
  | "ocean"
  | "paper"
  | "ember"
  | "forest"
  | "lavender"
  | "rose"
  | "slate"
  | "cream"
  | "synth";

export type AppTheme = {
  id: ThemeId;
  label: string;
  description: string;
  bg: string;
  card: string;
  cardStrong: string;
  border: string;
  text: string;
  muted: string;
  primary: string;
  primaryMuted: string;
  secondary: string;
  secondaryDark: string;
  openAccent: string;
  danger: string;
  onPrimary: string;
  surfaceSubtle: string;
  tabActiveOverlay: string;
  tabBadgeBg: string;
  /** v5: amber "Sharing (NN%)" state color. Per-theme so contrast is right on every surface. */
  warning: string;
  /** v5: two-stop gradient for the Grab CTA — [primary, primaryMuted] per theme. */
  grabGradient: readonly [string, string];
  radius: number;
  pad: number;
};

const voidTheme: AppTheme = {
  id: "void",
  label: "Pear dark",
  description: "Near-black background and pear green accents.",
  bg: "#08080d",
  card: "rgba(255,255,255,0.05)",
  cardStrong: "rgba(255,255,255,0.07)",
  border: "rgba(255,255,255,0.08)",
  text: "#F3F4F6",
  muted: "rgba(255,255,255,0.45)",
  primary: "#a8cf3a",
  primaryMuted: "#75bf52",
  secondary: "#489fc1",
  secondaryDark: "#2d6586",
  openAccent: "#60a5fa",
  danger: "#EF4444",
  onPrimary: "#0a140a",
  surfaceSubtle: "rgba(255,255,255,0.03)",
  tabActiveOverlay: "rgba(168, 207, 58, 0.12)",
  tabBadgeBg: "rgba(255,255,255,0.1)",
  warning: "#f59e0b",
  grabGradient: ["#a8cf3a", "#75bf52"] as const,
  radius: 16,
  pad: 16,
};

const pearTheme: AppTheme = {
  id: "pear",
  label: "Pear",
  description: "Light pear-green surface with the brand green as primary.",
  bg: "#f5f9ec",
  card: "#ffffff",
  cardStrong: "#eef5db",
  border: "rgba(26, 36, 16, 0.14)",
  text: "#1a2410",
  muted: "#556155",
  primary: "#a8cf3a",
  primaryMuted: "#4d7c0f",
  secondary: "#0891b2",
  secondaryDark: "#0e7490",
  openAccent: "#2563eb",
  danger: "#b91c1c",
  onPrimary: "#0a140a",
  surfaceSubtle: "rgba(26, 36, 16, 0.05)",
  tabActiveOverlay: "rgba(168, 207, 58, 0.22)",
  tabBadgeBg: "rgba(26, 36, 16, 0.08)",
  warning: "#b45309",
  grabGradient: ["#a8cf3a", "#4d7c0f"] as const,
  radius: 16,
  pad: 16,
};

const oceanTheme: AppTheme = {
  id: "ocean",
  label: "Ocean",
  description: "Deep blue surfaces with cyan highlights.",
  bg: "#0a1628",
  card: "rgba(56, 189, 248, 0.06)",
  cardStrong: "rgba(15, 23, 42, 0.85)",
  border: "rgba(125, 211, 252, 0.12)",
  text: "#e0f2fe",
  muted: "rgba(224, 242, 254, 0.55)",
  primary: "#22d3ee",
  primaryMuted: "#06b6d4",
  secondary: "#38bdf8",
  secondaryDark: "#0ea5e9",
  openAccent: "#7dd3fc",
  danger: "#f87171",
  onPrimary: "#042f2e",
  surfaceSubtle: "rgba(14, 165, 233, 0.08)",
  tabActiveOverlay: "rgba(34, 211, 238, 0.18)",
  tabBadgeBg: "rgba(56, 189, 248, 0.2)",
  warning: "#fbbf24",
  grabGradient: ["#22d3ee", "#06b6d4"] as const,
  radius: 16,
  pad: 16,
};

const paperTheme: AppTheme = {
  id: "paper",
  label: "Paper",
  description: "Light background with dark text and pear green actions.",
  bg: "#f4f4f5",
  card: "#ffffff",
  cardStrong: "#fafafa",
  // Contrast audit: bumped border opacity from 0.1 → 0.14 so card outlines
  // remain visible over near-white surfaces.
  border: "rgba(24, 24, 27, 0.14)",
  text: "#18181b",
  // Contrast audit: muted was #71717a (~4.4:1 on #f4f4f5). Dropping to
  // zinc-600 (#52525b) pushes small-text contrast above WCAG AA (~7:1).
  muted: "#52525b",
  primary: "#84cc16",
  // Contrast audit: WCAG prefers deeper greens for accent text over white
  // cards; primaryMuted moved to #4d7c0f (lime-700) for border/checkbox
  // secondary states.
  primaryMuted: "#4d7c0f",
  secondary: "#0891b2",
  secondaryDark: "#0e7490",
  openAccent: "#2563eb",
  danger: "#b91c1c",
  onPrimary: "#0f172a",
  surfaceSubtle: "rgba(24, 24, 27, 0.05)",
  tabActiveOverlay: "rgba(132, 204, 22, 0.22)",
  tabBadgeBg: "rgba(24, 24, 27, 0.08)",
  warning: "#b45309",
  grabGradient: ["#84cc16", "#4d7c0f"] as const,
  radius: 16,
  pad: 16,
};

const emberTheme: AppTheme = {
  id: "ember",
  label: "Ember",
  description: "Warm browns and amber highlights, easy on the eyes at night.",
  bg: "#14110e",
  card: "rgba(251, 191, 36, 0.06)",
  cardStrong: "rgba(68, 64, 60, 0.55)",
  border: "rgba(251, 191, 36, 0.12)",
  text: "#fafaf9",
  muted: "rgba(250, 250, 249, 0.5)",
  primary: "#f59e0b",
  primaryMuted: "#d97706",
  secondary: "#fb923c",
  secondaryDark: "#ea580c",
  openAccent: "#fcd34d",
  danger: "#f87171",
  onPrimary: "#1c1410",
  surfaceSubtle: "rgba(245, 158, 11, 0.07)",
  tabActiveOverlay: "rgba(245, 158, 11, 0.15)",
  tabBadgeBg: "rgba(251, 191, 36, 0.12)",
  warning: "#fcd34d",
  grabGradient: ["#f59e0b", "#d97706"] as const,
  radius: 16,
  pad: 16,
};

const forestTheme: AppTheme = {
  id: "forest",
  label: "Forest",
  description: "Dark green surfaces with emerald action buttons.",
  bg: "#0c1612",
  card: "rgba(52, 211, 153, 0.07)",
  cardStrong: "rgba(20, 83, 45, 0.35)",
  border: "rgba(167, 243, 208, 0.12)",
  text: "#ecfdf5",
  muted: "rgba(236, 253, 245, 0.5)",
  primary: "#34d399",
  primaryMuted: "#10b981",
  secondary: "#2dd4bf",
  secondaryDark: "#0d9488",
  openAccent: "#6ee7b7",
  danger: "#fb7185",
  onPrimary: "#022c22",
  surfaceSubtle: "rgba(16, 185, 129, 0.08)",
  tabActiveOverlay: "rgba(52, 211, 153, 0.16)",
  tabBadgeBg: "rgba(167, 243, 208, 0.12)",
  warning: "#fbbf24",
  grabGradient: ["#34d399", "#10b981"] as const,
  radius: 16,
  pad: 16,
};

const lavenderTheme: AppTheme = {
  id: "lavender",
  label: "Lavender",
  description: "Cool purple-gray base with soft violet accents.",
  bg: "#13101a",
  card: "rgba(167, 139, 250, 0.08)",
  cardStrong: "rgba(76, 29, 149, 0.35)",
  border: "rgba(196, 181, 253, 0.14)",
  text: "#f5f3ff",
  muted: "rgba(245, 243, 255, 0.52)",
  primary: "#a78bfa",
  primaryMuted: "#8b5cf6",
  secondary: "#c084fc",
  secondaryDark: "#9333ea",
  openAccent: "#c4b5fd",
  danger: "#f472b6",
  onPrimary: "#1e1b4b",
  surfaceSubtle: "rgba(139, 92, 246, 0.1)",
  tabActiveOverlay: "rgba(167, 139, 250, 0.18)",
  tabBadgeBg: "rgba(196, 181, 253, 0.12)",
  warning: "#fbbf24",
  grabGradient: ["#a78bfa", "#8b5cf6"] as const,
  radius: 16,
  pad: 16,
};

const roseTheme: AppTheme = {
  id: "rose",
  label: "Rose",
  description: "Soft pinks and rose gold accents on a dark plum base.",
  bg: "#181016",
  card: "rgba(244, 114, 182, 0.07)",
  cardStrong: "rgba(131, 24, 67, 0.4)",
  border: "rgba(251, 207, 232, 0.14)",
  text: "#fdf2f8",
  muted: "rgba(253, 242, 248, 0.52)",
  primary: "#f472b6",
  primaryMuted: "#ec4899",
  secondary: "#fb7185",
  secondaryDark: "#e11d48",
  openAccent: "#fda4af",
  danger: "#fbbf24",
  onPrimary: "#500724",
  surfaceSubtle: "rgba(244, 114, 182, 0.09)",
  tabActiveOverlay: "rgba(244, 114, 182, 0.16)",
  tabBadgeBg: "rgba(251, 207, 232, 0.12)",
  warning: "#fbbf24",
  grabGradient: ["#f472b6", "#ec4899"] as const,
  radius: 16,
  pad: 16,
};

const slateTheme: AppTheme = {
  id: "slate",
  label: "Slate",
  description: "Blue-gray chrome and silver accents on charcoal.",
  bg: "#0f1419",
  card: "rgba(148, 163, 184, 0.08)",
  cardStrong: "rgba(51, 65, 85, 0.45)",
  border: "rgba(148, 163, 184, 0.14)",
  text: "#f1f5f9",
  muted: "rgba(241, 245, 249, 0.48)",
  primary: "#94a3b8",
  primaryMuted: "#64748b",
  secondary: "#7dd3fc",
  secondaryDark: "#38bdf8",
  openAccent: "#bae6fd",
  danger: "#f87171",
  onPrimary: "#0f172a",
  surfaceSubtle: "rgba(71, 85, 105, 0.2)",
  tabActiveOverlay: "rgba(148, 163, 184, 0.18)",
  tabBadgeBg: "rgba(148, 163, 184, 0.15)",
  warning: "#fbbf24",
  grabGradient: ["#94a3b8", "#64748b"] as const,
  radius: 16,
  pad: 16,
};

const creamTheme: AppTheme = {
  id: "cream",
  label: "Cream",
  description: "Warm off-white with terracotta and cocoa text.",
  bg: "#faf7f2",
  card: "#ffffff",
  cardStrong: "#f5efe6",
  // Contrast audit: slight bump for clearer card outlines on warm paper.
  border: "rgba(68, 52, 44, 0.16)",
  text: "#292524",
  // Contrast audit: muted was #78716c (~4.1:1). Dropping to stone-600
  // (#57534e) puts caption text above WCAG AA (~7.1:1).
  muted: "#57534e",
  primary: "#c2410c",
  primaryMuted: "#7c2d12",
  secondary: "#0d9488",
  secondaryDark: "#0f766e",
  openAccent: "#1d4ed8",
  danger: "#b91c1c",
  onPrimary: "#fffbeb",
  surfaceSubtle: "rgba(68, 52, 44, 0.06)",
  tabActiveOverlay: "rgba(194, 65, 12, 0.14)",
  tabBadgeBg: "rgba(68, 52, 44, 0.09)",
  warning: "#b45309",
  grabGradient: ["#c2410c", "#7c2d12"] as const,
  radius: 16,
  pad: 16,
};

const synthTheme: AppTheme = {
  id: "synth",
  label: "Synth",
  description: "High-contrast neon pink and cyan on a pitch-black stage.",
  bg: "#050508",
  card: "rgba(236, 72, 153, 0.06)",
  cardStrong: "rgba(6, 182, 212, 0.08)",
  border: "rgba(34, 211, 238, 0.15)",
  text: "#fafafa",
  muted: "rgba(250, 250, 250, 0.45)",
  primary: "#ec4899",
  primaryMuted: "#db2777",
  secondary: "#22d3ee",
  secondaryDark: "#06b6d4",
  openAccent: "#67e8f9",
  danger: "#fbbf24",
  onPrimary: "#1e0424",
  surfaceSubtle: "rgba(236, 72, 153, 0.06)",
  tabActiveOverlay: "rgba(236, 72, 153, 0.14)",
  tabBadgeBg: "rgba(34, 211, 238, 0.12)",
  warning: "#fbbf24",
  grabGradient: ["#ec4899", "#db2777"] as const,
  radius: 16,
  pad: 16,
};

export const themes: Record<ThemeId, AppTheme> = {
  void: voidTheme,
  pear: pearTheme,
  ocean: oceanTheme,
  paper: paperTheme,
  ember: emberTheme,
  forest: forestTheme,
  lavender: lavenderTheme,
  rose: roseTheme,
  slate: slateTheme,
  cream: creamTheme,
  synth: synthTheme,
};

export const DEFAULT_THEME_ID: ThemeId = "paper";

export const THEME_ORDER: ThemeId[] = [
  "void",
  "pear",
  "ocean",
  "paper",
  "ember",
  "forest",
  "lavender",
  "rose",
  "slate",
  "cream",
  "synth",
];

/**
 * IDs of the themes whose backgrounds are light (i.e., need dark status-bar
 * icons for contrast). Consumed by ThemedRoot in app/index.tsx to pick the
 * right `StatusBar barStyle`. Add new light themes here as they're
 * introduced.
 */
export const LIGHT_THEME_IDS: ThemeId[] = ["pear", "paper", "cream"];
