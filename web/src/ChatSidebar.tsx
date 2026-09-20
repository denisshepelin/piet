import * as React from "react";
import { useEditor } from "tldraw";
import type { AgentRole, ModelRef } from "@piet/protocol";
import type { AgentChat, ChatMessage } from "./useAgentSocket.ts";
import type { RunSnapshot } from "@piet/protocol";
import { canvasTaskOutput, isCanvasTaskActive } from "./canvasTasks.ts";
import { groupCanvasRequests } from "./canvasRequestGroups.ts";

const { useState } = React;

type ReactElement = React.ReactElement;

type Props = {
  chat: AgentChat;
  onClose: () => void;
};

const AGENT_ROLES: AgentRole[] = ["main", "research"];

const roleLabel = (role: ChatMessage["role"]): string => {
  if (role === "user") return "you";

  if (role === "assistant") return "pi";

  if (role === "tool") return "tool";

  return "system";
};

const encodeModel = (model: ModelRef): string => `${model.provider}/${model.id}`;

const decodeModel = (value: string): ModelRef | null => {
  const [provider, ...rest] = value.split("/");
  const id = rest.join("/");

  return provider && id ? { provider, id } : null;
};

/** Model and thinking-level pickers for one agent role in inspector settings. */
const RoleControls = ({ chat, role }: { chat: AgentChat; role: AgentRole }): ReactElement => {
  const { current, thinkingLevel, availableThinkingLevels } = chat.roles[role];

  const modelInfo = chat.models.find(
    (model) => model.provider === current?.provider && model.id === current?.id,
  );

  const thinkingDisabled = !chat.ready || availableThinkingLevels.length <= 1;

  return (
    <div className="piet-role-controls">
      <label className="piet-inspector-label" htmlFor={`piet-model-${role}`}>
        {role} model
      </label>
      <select
        id={`piet-model-${role}`}
        value={current ? encodeModel(current) : ""}
        onChange={(event) => {
          const selection = decodeModel(event.target.value);

          if (selection) chat.setModel(role, selection);
        }}
        disabled={!chat.ready || chat.models.length === 0}
      >
        {current === null && (
          <option value="" disabled>
            {chat.models.length === 0 ? "no models available" : "select model"}
          </option>
        )}
        {chat.models.map((model) => (
          <option key={encodeModel(model)} value={encodeModel(model)}>
            {model.name} ({model.provider})
          </option>
        ))}
      </select>
      <label className="piet-inspector-label" htmlFor={`piet-thinking-${role}`}>
        {role} thinking
      </label>
      <select
        id={`piet-thinking-${role}`}
        value={thinkingLevel}
        onChange={(event) => {
          const level = availableThinkingLevels.find(
            (candidate) => candidate === event.target.value,
          );

          if (level !== undefined) chat.setThinking(role, level);
        }}
        disabled={thinkingDisabled}
        title={modelInfo && !modelInfo.reasoning ? `${role} model has no reasoning` : undefined}
      >
        {availableThinkingLevels.map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
      </select>
    </div>
  );
};

const taskStatusLabel = (task: RunSnapshot): string => {
  if (task.status === "queued") return "queued";

  if (task.status === "running") return "working";

  if (task.status === "done") return "done";

  if (task.status === "error") return "error";

  return "cancelled";
};

const TaskInspectorRow = ({ task, chat }: { task: RunSnapshot; chat: AgentChat }): ReactElement => {
  const editor = useEditor();
  const active = isCanvasTaskActive(task);
  const terminal = !active;

  return (
    <article className="piet-inspector-task">
      <div className="piet-inspector-task__heading">
        <div>
          <strong>{task.title}</strong>
          <span className="piet-inspector-task__kind">{task.kind}</span>
        </div>
        <span className={`piet-status piet-status--${task.status}`}>{taskStatusLabel(task)}</span>
      </div>
      <div className="piet-inspector-task__output">{canvasTaskOutput(task) || "no output"}</div>
      <div className="piet-inspector-task__actions">
        <button
          className="piet-window-button"
          type="button"
          onClick={() => {
            const page = editor.getPages().find(({ id }) => id === task.pageId);

            if (!page) return;

            if (page.id !== editor.getCurrentPageId()) editor.setCurrentPage(page);
            window.requestAnimationFrame(() => editor.centerOnPoint(task.anchor));
          }}
        >
          focus origin
        </button>
        {active && (
          <button
            className="piet-window-button"
            type="button"
            onClick={() => chat.cancelRun(task.runId)}
            disabled={!chat.ready}
          >
            cancel
          </button>
        )}
        {!active && (task.status === "error" || task.status === "cancelled") && (
          <button
            className="piet-window-button"
            type="button"
            onClick={() => chat.retryRun(task.runId)}
            disabled={!chat.ready}
          >
            retry
          </button>
        )}
        {terminal && (
          <button
            className="piet-window-button piet-window-button--quiet"
            type="button"
            onClick={() => chat.dismissRun(task.runId)}
          >
            dismiss
          </button>
        )}
      </div>
    </article>
  );
};

/** Keeps request history and settings off the canvas, including automatically archived completions. */
export const ChatSidebar = ({ chat, onClose }: Props): ReactElement => {
  const editor = useEditor();
  const [section, setSection] = useState<"history" | "settings">("history");
  const requests = groupCanvasRequests(chat.runs);
  const visibleMessages = chat.messages.filter((message) => message.role !== "thinking");
  const status = chat.ready ? (chat.busy ? "main working" : "ready") : "disconnected";

  return (
    <aside
      className="piet-inspector"
      aria-label="Piet inspector"
      onPointerDown={(event) => {
        editor.markEventAsHandled(event);
        event.stopPropagation();
      }}
      onPointerUp={(event) => {
        editor.markEventAsHandled(event);
        event.stopPropagation();
      }}
      onWheel={(event) => {
        editor.markEventAsHandled(event);
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        editor.markEventAsHandled(event);
        event.stopPropagation();
      }}
      onKeyUp={(event) => {
        editor.markEventAsHandled(event);
        event.stopPropagation();
      }}
    >
      <header className="piet-inspector__header">
        <div>
          <strong>inspector</strong>
          <div className="piet-inspector__status">
            <span className={`piet-status-dot${chat.ready ? " piet-status-dot--ready" : ""}`} />
            {chat.ready ? status : "Disconnected — reload to reconnect"}
            {!chat.ready && (
              <button
                className="piet-window-button"
                type="button"
                onClick={() => window.location.reload()}
              >
                reload
              </button>
            )}
          </div>
        </div>
        <button
          className="piet-icon-button"
          type="button"
          onClick={onClose}
          aria-label="Close inspector"
        >
          ×
        </button>
      </header>
      <nav className="piet-inspector__tabs" aria-label="Inspector sections">
        <button
          className={section === "history" ? "piet-tab piet-tab--active" : "piet-tab"}
          type="button"
          onClick={() => setSection("history")}
        >
          history
        </button>
        <button
          className={section === "settings" ? "piet-tab piet-tab--active" : "piet-tab"}
          type="button"
          onClick={() => setSection("settings")}
        >
          settings
        </button>
      </nav>
      <div className="piet-inspector__body">
        {section === "settings" ? (
          <section aria-labelledby="piet-settings-heading">
            <h2 id="piet-settings-heading" className="piet-inspector__section-title">
              model controls
            </h2>
            <p className="piet-inspector__copy">
              Main and research use the same available role controls.
            </p>
            {AGENT_ROLES.map((role) => (
              <RoleControls key={role} chat={chat} role={role} />
            ))}
          </section>
        ) : (
          <>
            <section aria-labelledby="piet-tasks-heading">
              <div className="piet-inspector__section-heading">
                <h2 id="piet-tasks-heading" className="piet-inspector__section-title">
                  request history
                </h2>
                <span>{requests.length}</span>
              </div>
              {chat.runs.length === 0 ? (
                <p className="piet-inspector__empty">Completed requests will appear here.</p>
              ) : (
                <div className="piet-inspector__tasks">
                  {[...requests].reverse().map((request) => (
                    <details className="piet-request-history" key={request.promptId}>
                      <summary>
                        <strong>{request.title}</strong>
                        <span>
                          {request.activeRuns.length > 0
                            ? "working"
                            : request.runs.some((run) => run.status === "error")
                              ? "error"
                              : request.runs.some((run) => run.status === "cancelled")
                                ? "cancelled"
                                : "done"}
                        </span>
                      </summary>
                      {request.runs.map((task) => (
                        <TaskInspectorRow key={task.runId} task={task} chat={chat} />
                      ))}
                    </details>
                  ))}
                </div>
              )}
            </section>
            <section aria-labelledby="piet-history-heading">
              <h2 id="piet-history-heading" className="piet-inspector__section-title">
                main history
              </h2>
              {visibleMessages.length === 0 ? (
                <p className="piet-inspector__empty">No messages yet.</p>
              ) : (
                <div className="piet-inspector__messages">
                  {visibleMessages.map((message) => (
                    <article
                      className={`piet-message piet-message--${message.role}`}
                      key={message.id}
                    >
                      <div className="piet-message__role">{roleLabel(message.role)}</div>
                      <div>{message.text}</div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </aside>
  );
};
