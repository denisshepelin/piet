import * as React from "react";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { useEditor } from "tldraw";
import type { AgentChat, ChatMessage } from "./useAgentSocket.ts";

const { useEffect, useMemo, useRef, useState } = React;
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

const encodeModel = (m: { provider: string; id: string }): string => `${m.provider}/${m.id}`;

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

export const ChatSidebar = ({ chat }: Props): ReactElement => {
  const editor = useEditor();
  const [input, setInput] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.messages, chat.busy]);

  const canvasModelInfo: Model<Api> | undefined = useMemo(() => {
    if (!chat.currentCanvasModel) return undefined;
    return chat.models.find(
      (m) =>
        m.provider === chat.currentCanvasModel?.provider && m.id === chat.currentCanvasModel?.id,
    );
  }, [chat.models, chat.currentCanvasModel]);

  const codingModelInfo: Model<Api> | undefined = useMemo(() => {
    if (!chat.currentCodingModel) return undefined;
    return chat.models.find(
      (m) =>
        m.provider === chat.currentCodingModel?.provider && m.id === chat.currentCodingModel?.id,
    );
  }, [chat.models, chat.currentCodingModel]);

  const onSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (!chat.ready || chat.busy) return;
    const text = input.trim();
    if (text.length === 0) return;
    chat.send(text);
    setInput("");
  };

  const onModelChange = (target: "canvas" | "coding", value: string): void => {
    const [provider, ...rest] = value.split("/");
    const id = rest.join("/");
    if (!provider || !id) return;
    const selection = { provider, id };
    if (target === "canvas") chat.setCanvasModel(selection);
    else chat.setCodingModel(selection);
  };

  const markTldrawHandled = (e: SyntheticEvent): void => editor.markEventAsHandled(e);

  const onWheel = (e: WheelEvent<HTMLElement>): void => {
    editor.markEventAsHandled(e);
    e.stopPropagation();
  };

  const status = chat.ready ? (chat.busy ? "thinking…" : "ready") : "disconnected";
  const statusColor = chat.ready ? (chat.busy ? "#d97706" : "#16a34a") : "#dc2626";
  const canvasThinkingDisabled = !chat.ready || chat.canvasAvailableThinkingLevels.length <= 1;
  const codingThinkingDisabled = !chat.ready || chat.codingAvailableThinkingLevels.length <= 1;

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
          <strong>pi pairs</strong>
          <span style={{ color: statusColor, fontSize: 12 }}>● {status}</span>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: chat.activePair?.actor.color ?? "#9ca3af",
            }}
          />
          <select
            value={chat.activePairId ?? ""}
            onChange={(e) => chat.selectPair(e.target.value)}
            disabled={!chat.ready || chat.pairs.length === 0}
            style={selectStyle}
          >
            {chat.pairs.map((pair) => (
              <option key={pair.id} value={pair.id}>
                {pair.actor.name}
                {pair.busy ? " (working)" : ""}
              </option>
            ))}
          </select>
          <button type="button" onClick={chat.createPair} disabled={!chat.ready} title="New pair">
            new
          </button>
          <button
            type="button"
            onClick={() => chat.activePairId && chat.removePair(chat.activePairId)}
            disabled={!chat.ready || chat.pairs.length <= 1 || chat.busy}
            title="Remove pair"
          >
            remove
          </button>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <label style={{ fontSize: 11, color: "#6b7280", width: 44 }}>canvas</label>
          <select
            value={chat.currentCanvasModel ? encodeModel(chat.currentCanvasModel) : ""}
            onChange={(e) => onModelChange("canvas", e.target.value)}
            disabled={!chat.ready || chat.models.length === 0}
            style={selectStyle}
          >
            {chat.currentCanvasModel === null && (
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
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <label style={{ fontSize: 11, color: "#6b7280", width: 44 }}>coding</label>
          <select
            value={chat.currentCodingModel ? encodeModel(chat.currentCodingModel) : ""}
            onChange={(e) => onModelChange("coding", e.target.value)}
            disabled={!chat.ready || chat.models.length === 0}
            style={selectStyle}
          >
            {chat.currentCodingModel === null && (
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
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <label style={{ fontSize: 11, color: "#6b7280", width: 72 }}>canvas think</label>
          <select
            value={chat.canvasThinkingLevel}
            onChange={(e) => chat.setCanvasThinking(e.target.value as ModelThinkingLevel)}
            disabled={canvasThinkingDisabled}
            style={{
              ...selectStyle,
              cursor: canvasThinkingDisabled ? "not-allowed" : "pointer",
            }}
            title={
              canvasModelInfo && !canvasModelInfo.reasoning
                ? "canvas model has no reasoning"
                : undefined
            }
          >
            {chat.canvasAvailableThinkingLevels.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <label style={{ fontSize: 11, color: "#6b7280", width: 72 }}>coding think</label>
          <select
            value={chat.codingThinkingLevel}
            onChange={(e) => chat.setCodingThinking(e.target.value as ModelThinkingLevel)}
            disabled={codingThinkingDisabled}
            style={{
              ...selectStyle,
              cursor: codingThinkingDisabled ? "not-allowed" : "pointer",
            }}
            title={
              codingModelInfo && !codingModelInfo.reasoning
                ? "coding model has no reasoning"
                : undefined
            }
          >
            {chat.codingAvailableThinkingLevels.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>
      </header>

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
        {chat.messages.length === 0 && (
          <div style={{ color: "#9ca3af", fontSize: 12 }}>send a message to start.</div>
        )}
        {chat.messages.map((m) => {
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
        {chat.busy && (
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
