import * as React from "react";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { useEditor } from "tldraw";
import type { AgentRole, ModelRef } from "./protocol.ts";
import type { AgentChat, ChatMessage } from "./useAgentSocket.ts";

const { useEffect, useRef, useState } = React;
type FormEvent<T> = React.FormEvent<T>;
type ReactElement = React.ReactElement;
type SyntheticEvent = React.SyntheticEvent;
type WheelEvent<T> = React.WheelEvent<T>;

type Props = {
  chat: AgentChat;
};

const roleLabel = (role: ChatMessage["role"]): string => {
  if (role === "user") return "you";
  if (role === "assistant") return "pi";
  if (role === "thinking") return "thought";
  if (role === "tool") return "tool";
  return "system";
};

const encodeModel = (m: ModelRef): string => `${m.provider}/${m.id}`;

const decodeModel = (value: string): ModelRef | null => {
  const [provider, ...rest] = value.split("/");
  const id = rest.join("/");
  return provider && id ? { provider, id } : null;
};

const AGENT_ROLES: AgentRole[] = ["main", "research"];

const selectStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "4px 6px",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  background: "#fff",
  font: "inherit",
  fontSize: 12,
  cursor: "pointer",
};

const rowStyle: React.CSSProperties = { display: "flex", gap: 6, alignItems: "center" };

const labelStyle: React.CSSProperties = { fontSize: 11, color: "#6b7280" };

/** Model and thinking-level pickers for one agent role. */
const RoleControls = ({ chat, role }: { chat: AgentChat; role: AgentRole }): ReactElement => {
  const { current, thinkingLevel, availableThinkingLevels } = chat.roles[role];
  const modelInfo = chat.models.find(
    (model) => model.provider === current?.provider && model.id === current?.id,
  );
  const thinkingDisabled = !chat.ready || availableThinkingLevels.length <= 1;

  return (
    <>
      <div style={rowStyle}>
        <label style={{ ...labelStyle, width: 44 }}>{role}</label>
        <select
          value={current ? encodeModel(current) : ""}
          onChange={(e) => {
            const selection = decodeModel(e.target.value);
            if (selection) chat.setModel(role, selection);
          }}
          disabled={!chat.ready || chat.models.length === 0}
          style={selectStyle}
        >
          {current === null && (
            <option value="" disabled>
              {chat.models.length === 0 ? "no models available" : "select model"}
            </option>
          )}
          {chat.models.map((m) => (
            <option key={encodeModel(m)} value={encodeModel(m)}>
              {m.name} ({m.provider})
            </option>
          ))}
        </select>
      </div>
      <div style={rowStyle}>
        <label style={{ ...labelStyle, width: 72 }}>{role} think</label>
        <select
          value={thinkingLevel}
          onChange={(e) => chat.setThinking(role, e.target.value as ModelThinkingLevel)}
          disabled={thinkingDisabled}
          style={{ ...selectStyle, cursor: thinkingDisabled ? "not-allowed" : "pointer" }}
          title={modelInfo && !modelInfo.reasoning ? `${role} model has no reasoning` : undefined}
        >
          {availableThinkingLevels.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </div>
    </>
  );
};

export const ChatSidebar = ({ chat }: Props): ReactElement => {
  const editor = useEditor();
  const [input, setInput] = useState("");
  const [view, setView] = useState("main");
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.messages, chat.busy]);

  const onSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (!chat.ready || chat.busy) return;
    const text = input.trim();
    if (text.length === 0) return;
    const selection = editor.getSelectionPageBounds();
    const pointer = editor.inputs.currentPagePoint;
    const viewport = editor.getViewportPageBounds();
    const anchor = selection
      ? { x: selection.x + selection.w + 24, y: selection.y }
      : pointer
        ? { x: pointer.x, y: pointer.y }
        : { x: viewport.x + viewport.w / 2, y: viewport.y + viewport.h / 2 };
    chat.send(text, anchor);
    setInput("");
  };

  const markTldrawHandled = (e: SyntheticEvent): void => editor.markEventAsHandled(e);

  const onWheel = (e: WheelEvent<HTMLElement>): void => {
    editor.markEventAsHandled(e);
    e.stopPropagation();
  };

  const status = chat.ready ? (chat.busy ? "thinking…" : "ready") : "disconnected";
  const statusColor = chat.ready ? (chat.busy ? "#d97706" : "#16a34a") : "#dc2626";
  const selectedRun = chat.runs.find((run) => run.runId === view);

  return (
    <aside
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        display: "flex",
        flexDirection: "column",
        width: "min(360px, calc(100% - 24px))",
        height: "100%",
        zIndex: 1000,
        pointerEvents: "auto",
        borderLeft: "1px solid #e5e7eb",
        background: "#fafafa",
        boxShadow: "-8px 0 24px rgba(15, 23, 42, 0.08)",
        fontFamily: "system-ui, sans-serif",
        fontSize: 14,
      }}
      onPointerDown={markTldrawHandled}
      onPointerUp={markTldrawHandled}
      onTouchStart={markTldrawHandled}
      onTouchEnd={markTldrawHandled}
      onKeyDown={markTldrawHandled}
      onKeyUp={markTldrawHandled}
      onWheel={onWheel}
    >
      <header
        style={{
          padding: "10px 14px",
          borderBottom: "1px solid #e5e7eb",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          background: "#fff",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <strong>piet</strong>
          <span style={{ color: statusColor, fontSize: 12 }}>● {status}</span>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", color: "#6b7280" }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: chat.actor?.color ?? "#9ca3af",
            }}
          />
          <span style={{ fontSize: 12 }}>main agent with background subagents</span>
        </div>
        {AGENT_ROLES.map((role) => (
          <RoleControls key={role} chat={chat} role={role} />
        ))}
      </header>

      <nav
        style={{
          display: "flex",
          gap: 4,
          padding: "7px 10px",
          overflowX: "auto",
          borderBottom: "1px solid #e5e7eb",
          background: "#fff",
        }}
      >
        <button
          type="button"
          onClick={() => setView("main")}
          style={{ fontWeight: view === "main" ? 700 : 400, whiteSpace: "nowrap" }}
        >
          main {chat.busy ? "●" : ""}
        </button>
        {chat.runs.map((run) => (
          <button
            key={run.runId}
            type="button"
            onClick={() => setView(run.runId)}
            style={{
              fontWeight: view === run.runId ? 700 : 400,
              whiteSpace: "nowrap",
              color:
                run.status === "error"
                  ? "#dc2626"
                  : run.status === "running"
                    ? "#d97706"
                    : "#16a34a",
            }}
          >
            {run.title} {run.status === "running" ? "●" : run.status === "error" ? "×" : "✓"}
          </button>
        ))}
      </nav>

      <div
        ref={listRef}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 12,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {view === "main" && chat.messages.length === 0 && (
          <div style={{ color: "#9ca3af", fontSize: 12 }}>send a message to start.</div>
        )}
        {selectedRun && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 8,
                alignItems: "center",
                fontSize: 12,
                color: "#6b7280",
              }}
            >
              <span>
                {selectedRun.status === "running"
                  ? "Subagent is working in the background. You can continue chatting with main."
                  : `Subagent ${selectedRun.status}.`}
              </span>
              {selectedRun.status !== "running" && (
                <button
                  type="button"
                  onClick={() => {
                    chat.dismissRun(selectedRun.runId);
                    setView("main");
                  }}
                >
                  dismiss
                </button>
              )}
            </div>
            {selectedRun.steps.map((step, index) => (
              <div
                key={step}
                style={{
                  padding: "7px 9px",
                  border: "1px solid #e5e7eb",
                  borderRadius: 7,
                  background: index === selectedRun.steps.length - 1 ? "#fff" : "#f9fafb",
                  color: index === selectedRun.steps.length - 1 ? "#111827" : "#6b7280",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontSize: 11,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {step}
              </div>
            ))}
          </div>
        )}
        {(view === "main" ? chat.messages : []).map((m) => {
          const bg =
            m.role === "user"
              ? "#dbeafe"
              : m.role === "system"
                ? "#fee2e2"
                : m.role === "thinking"
                  ? "#f3e8ff"
                  : m.role === "tool"
                    ? m.isError
                      ? "#fee2e2"
                      : "#ecfdf5"
                    : "#fff";
          const fg =
            m.role === "thinking"
              ? "#7c3aed"
              : m.role === "tool"
                ? m.isError
                  ? "#dc2626"
                  : "#059669"
                : "#6b7280";
          const fontStyle =
            m.role === "thinking" ? "italic" : m.role === "tool" ? undefined : "normal";
          const fontSize = m.role === "thinking" || m.role === "tool" ? 11 : 14;
          return (
            <div
              key={m.id}
              style={{
                alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                maxWidth: "85%",
                padding: "6px 10px",
                borderRadius: 8,
                background: bg,
                border: "1px solid #e5e7eb",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              <div style={{ fontSize: 10, color: fg, marginBottom: 2, fontStyle }}>
                {roleLabel(m.role)}
              </div>
              <div style={{ fontSize, fontStyle }}>{m.text}</div>
            </div>
          );
        })}
        {view === "main" && chat.busy && (
          <div style={{ color: "#9ca3af", fontSize: 12, alignSelf: "flex-start" }}>
            pi is thinking…
          </div>
        )}
      </div>

      <form
        onSubmit={onSubmit}
        style={{
          padding: 10,
          borderTop: "1px solid #e5e7eb",
          background: "#fff",
          display: "flex",
          gap: 8,
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit(e as unknown as FormEvent<HTMLFormElement>);
            }
          }}
          placeholder={chat.ready ? "ask pi…" : "connecting…"}
          rows={2}
          disabled={!chat.ready}
          style={{
            flex: 1,
            resize: "none",
            padding: 8,
            border: "1px solid #d1d5db",
            borderRadius: 6,
            font: "inherit",
            outline: "none",
          }}
        />
        <button
          type="submit"
          disabled={!chat.ready || chat.busy || input.trim().length === 0}
          style={{
            padding: "0 14px",
            border: "1px solid #2563eb",
            background: "#2563eb",
            color: "#fff",
            borderRadius: 6,
            cursor: "pointer",
            opacity: !chat.ready || chat.busy || input.trim().length === 0 ? 0.5 : 1,
          }}
        >
          send
        </button>
      </form>
    </aside>
  );
};
