type ButtonProps = {
  label: string;
  tone?: "primary" | "secondary";
};

export function Button({ label, tone = "primary" }: ButtonProps) {
  return (
    <button style={tone === "primary" ? primaryStyle : secondaryStyle} type="button">
      {label}
    </button>
  );
}

const baseStyle = {
  appearance: "none" as const,
  borderRadius: "999px",
  padding: "13px 20px",
  border: "1px solid transparent",
  cursor: "pointer",
  transition: "transform 120ms ease, opacity 120ms ease",
};

const primaryStyle = {
  ...baseStyle,
  background: "#e3a24d",
  color: "#1c1308",
};

const secondaryStyle = {
  ...baseStyle,
  background: "rgba(248, 241, 223, 0.05)",
  color: "#f8f1df",
  border: "1px solid rgba(248, 241, 223, 0.12)",
};
