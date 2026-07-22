import type { CSSProperties, ReactElement } from "react";
import type { CodingRun } from "./useAgentSocket.ts";

const MAX_VISIBLE_STEPS = 6;

const cardStyle: CSSProperties = {
  width: 280,
  padding: "6px 10px 8px",
  borderRadius: 6,
  border: "1px solid #e2e2e6",
  background: "rgba(255, 255, 255, 0.94)",
  boxShadow: "0 2px 10px rgba(15, 23, 42, 0.08)",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  backdropFilter: "blur(4px)",
};

const statusMeta = (status: CodingRun["status"]): { label: string; color: string } => {
  if (status === "running") return { label: "working", color: "#d97706" };
  if (status === "error") return { label: "error", color: "#dc2626" };
  return { label: "done", color: "#16a34a" };
};

const RunCard = ({ run }: { run: CodingRun }): ReactElement => {
  const { label, color } = statusMeta(run.status);
  const hidden = Math.max(0, run.steps.length - MAX_VISIBLE_STEPS);
  const steps = run.steps.slice(-MAX_VISIBLE_STEPS);
  const lastIndex = steps.length - 1;

  return (
    <div style={cardStyle}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 4,
        }}
      >
        <span style={{ fontSize: 10, color: "#6b7280", letterSpacing: 0.4 }}>{run.title}</span>
        <span style={{ fontSize: 10, color }}>● {label}</span>
      </div>
      {hidden > 0 && (
        <div style={{ fontSize: 9, color: "#c2c6cc", lineHeight: 1.6 }}>
          … {hidden} earlier step{hidden === 1 ? "" : "s"}
        </div>
      )}
      {steps.map((step, index) => {
        const isCurrent = index === lastIndex && run.status === "running";
        // Steps are append-only, so the absolute position is a stable identity.
        const absoluteIndex = hidden + index;
        return (
          <div
            key={absoluteIndex}
            style={{
              fontSize: 10,
              lineHeight: 1.7,
              color: isCurrent ? "#111827" : "#9ca3af",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {isCurrent ? "▸ " : "· "}
            {step}
          </div>
        );
      })}
    </div>
  );
};

export const CodingStatusPanel = ({ runs }: { runs: CodingRun[] }): ReactElement | null => {
  if (runs.length === 0) return null;
  return (
    <div
      style={{
        position: "absolute",
        top: 56,
        left: 12,
        zIndex: 900,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        pointerEvents: "none",
      }}
    >
      {runs.map((run) => (
        <RunCard key={run.runId} run={run} />
      ))}
    </div>
  );
};
