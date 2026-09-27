import { useEffect, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { defaultEditorAssetUrls } from "tldraw";
import { PietMark, type PietMarkDetail } from "../PietMark.tsx";
import { PietWordmark } from "../PietWordmark.tsx";

type Theme = "light" | "dark";

type PaletteToken = "blue" | "yellow" | "red" | "black" | "ground" | "white";

type Palette = Record<PaletteToken, string>;

const DEFAULT_PALETTE: Palette = {
  blue: "#1d3f91",
  yellow: "#f7c928",
  red: "#c8392b",
  black: "#000000",
  ground: "#f7f5ef",
  white: "#ffffff",
};

const PALETTE_ROLES: Record<PaletteToken, string> = {
  blue: "Primary field, user bubbles, done",
  yellow: "Running, active tab, highlights",
  red: "Error, recording",
  black: "Grid lines, borders, shadows",
  ground: "Canvas and panels",
  white: "Branch lines, nodes, text on color",
};

const PALETTE_TOKENS: PaletteToken[] = ["blue", "yellow", "red", "black", "ground", "white"];

const MARK_DETAILS: { detail: PietMarkDetail; label: string; use: string }[] = [
  { detail: "simple", label: "Simple", use: "Favicon, inline marks under 24px" },
  { detail: "grid", label: "Grid", use: "Controls, headers, splash" },
];

const WORDMARK_SIZES = [16, 20, 26, 40, 72];

const MARK_SIZES = [16, 20, 24, 32, 48, 64, 128];

const UI_FONTS: { role: string; family: string; className: string; sample: string }[] = [
  {
    role: "Body · 12–14px",
    family: "System UI (SF Pro, Segoe UI)",
    className: "sg-type__body",
    sample:
      "Hold to talk, release to send. Piet reads what's on the canvas and answers where you're looking.",
  },
  {
    role: "Labels · mono 10–11px caps",
    family: "UI Monospace (SF Mono, Menlo, Consolas)",
    className: "piet-inspector__section-title",
    sample: "request history",
  },
  {
    role: "Output · mono 10px",
    family: "UI Monospace (SF Mono, Menlo, Consolas)",
    className: "piet-inspector-task__output",
    sample: "Reading repository · 12 files · 3 matches",
  },
];

const CANVAS_FONTS: { style: string; family: string; face: string; sample: string }[] = [
  {
    style: "draw",
    family: "Shantell Sans Informal",
    face: "tldraw_draw",
    sample: "Login → API → Token store",
  },
  {
    style: "sans",
    family: "IBM Plex Sans Medium",
    face: "tldraw_sans",
    sample: "Login → API → Token store",
  },
  {
    style: "serif",
    family: "IBM Plex Serif Medium",
    face: "tldraw_serif",
    sample: "Login → API → Token store",
  },
  {
    style: "mono",
    family: "IBM Plex Mono Medium",
    face: "tldraw_mono",
    sample: "POST /oauth/token 200",
  },
];

/** Registers tldraw's canvas font faces so specimens render outside the editor. */
const useCanvasFonts = (): void => {
  useEffect(() => {
    const urls = defaultEditorAssetUrls.fonts ?? {};

    CANVAS_FONTS.forEach(({ face }) => {
      const url = urls[face];

      if (!url) return;
      const font = new FontFace(face, `url(${url})`);
      document.fonts.add(font);
      void font.load().catch(() => undefined);
    });
  }, []);
};

const TASK_STATUSES = ["queued", "running", "done", "error", "cancelled"] as const;

const VOICE_PHASES: {
  phase: string;
  pressed: boolean;
  disabled: boolean;
  label: string;
  note: string;
}[] = [
  { phase: "idle", pressed: false, disabled: false, label: "Idle", note: "Blue · hold to talk" },
  {
    phase: "connecting",
    pressed: false,
    disabled: false,
    label: "Connecting",
    note: "Yellow · waiting for mic",
  },
  {
    phase: "recording",
    pressed: true,
    disabled: false,
    label: "Recording",
    note: "Red · pressed in · outline breathes",
  },
  {
    phase: "finishing",
    pressed: false,
    disabled: true,
    label: "Finishing",
    note: "Yellow · transcribing",
  },
  {
    phase: "idle",
    pressed: false,
    disabled: true,
    label: "Disconnected",
    note: "Flat and muted",
  },
];

type PaletteStyle = CSSProperties & Record<`--piet-${PaletteToken}`, string>;

const paletteStyle = (palette: Palette): PaletteStyle => ({
  "--piet-blue": palette.blue,
  "--piet-yellow": palette.yellow,
  "--piet-red": palette.red,
  "--piet-black": palette.black,
  "--piet-ground": palette.ground,
  "--piet-white": palette.white,
});

const paletteCss = (palette: Palette): string =>
  [":root {", ...PALETTE_TOKENS.map((token) => `  --piet-${token}: ${palette[token]};`), "}"].join(
    "\n",
  );

const Section = ({
  id,
  index,
  title,
  lede,
  accent,
  children,
}: {
  id: string;
  index: number;
  title: string;
  lede: string;
  accent: "blue" | "yellow" | "red";
  children: ReactNode;
}): ReactElement => (
  <section className="sg-section" id={id} aria-labelledby={`${id}-title`}>
    <header className="sg-section__header">
      <span className={`sg-section__index sg-fill--${accent}`}>
        {String(index).padStart(2, "0")}
      </span>
      <div>
        <h2 className="sg-section__title" id={`${id}-title`}>
          {title}
        </h2>
        <p className="sg-section__lede">{lede}</p>
      </div>
    </header>
    {children}
  </section>
);

const Specimen = ({
  label,
  note,
  children,
  wide = false,
}: {
  label: string;
  note?: string;
  children: ReactNode;
  wide?: boolean;
}): ReactElement => (
  <figure className={wide ? "sg-specimen sg-specimen--wide" : "sg-specimen"}>
    <div className="sg-specimen__stage">{children}</div>
    <figcaption>
      <strong>{label}</strong>
      {note && <span>{note}</span>}
    </figcaption>
  </figure>
);

/** The concept artwork: a Mondrian grid with a git branch running along its lines. */
const ConceptComposition = ({ animate }: { animate: boolean }): ReactElement => (
  <svg className="sg-concept" viewBox="0 0 372 392" role="img" aria-label="Concept composition">
    <rect width="372" height="392" fill="var(--piet-black)" />
    <rect x="6" y="6" width="156" height="110" fill="var(--piet-blue)" />
    <rect x="170" y="6" width="88" height="70" fill="var(--piet-yellow)" />
    <rect x="170" y="84" width="88" height="32" fill="var(--piet-red)" />
    <rect x="266" y="6" width="100" height="70" fill="var(--piet-yellow)" />
    <rect x="266" y="84" width="100" height="32" fill="var(--piet-ground)" />
    <rect x="6" y="124" width="156" height="42" fill="var(--piet-ground)" />
    <rect x="170" y="124" width="88" height="42" fill="var(--piet-ground)" />
    <rect x="266" y="124" width="100" height="42" fill="var(--piet-ground)" />
    <rect x="6" y="174" width="156" height="132" fill="var(--piet-blue)" />
    <rect x="170" y="174" width="88" height="132" fill="var(--piet-blue)" />
    <rect x="266" y="174" width="100" height="132" fill="var(--piet-blue)" />
    <rect x="6" y="314" width="156" height="78" fill="var(--piet-yellow)" />
    <rect x="170" y="314" width="88" height="78" fill="var(--piet-ground)" />
    <rect x="266" y="314" width="20" height="78" fill="var(--piet-ground)" />
    <rect x="294" y="314" width="72" height="78" fill="var(--piet-red)" />
    <path
      className={animate ? "sg-concept__branch sg-concept__branch--live" : "sg-concept__branch"}
      d="M166 170V310M166 256h96v54"
    />
    <circle className="sg-concept__node" cx="166" cy="170" r="17" />
    <circle className="sg-concept__node" cx="166" cy="256" r="7" />
    <circle className="sg-concept__node" cx="166" cy="310" r="15" />
    <circle className="sg-concept__node" cx="262" cy="310" r="15" />
  </svg>
);

const VoiceButton = ({
  phase,
  pressed,
  disabled,
}: {
  phase: string;
  pressed: boolean;
  disabled: boolean;
}): ReactElement => (
  <button
    className="piet-button piet-voice__record"
    type="button"
    aria-label={`Voice button, ${phase}`}
    aria-pressed={pressed}
    data-phase={phase}
    disabled={disabled}
  >
    <svg className="piet-voice__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="9" y="2.5" width="6" height="11.5" rx="3" />
      <path d="M5.5 10.5a6.5 6.5 0 0 0 13 0M12 17v4M8 21h8" />
    </svg>
  </button>
);

const AnswerIndicator = ({ animate }: { animate: boolean }): ReactElement => (
  <div className={animate ? "sg-indicator-stage" : "sg-indicator-stage sg-paused"}>
    <div className="piet-answer-indicators">
      <div
        className="piet-answer-indicator"
        role="status"
        aria-label="Answer will appear here"
        style={{ transform: "translate(40px, 34px)" }}
      >
        <span className="piet-answer-indicator__cell piet-answer-indicator__cell--red" />
        <span className="piet-answer-indicator__cell piet-answer-indicator__cell--yellow" />
        <span className="piet-answer-indicator__cell piet-answer-indicator__cell--black" />
        <span className="piet-answer-indicator__cell piet-answer-indicator__cell--blue" />
      </div>
    </div>
  </div>
);

const RequestCard = ({
  title,
  activity,
  active,
  animate,
}: {
  title: string;
  activity: string;
  active: boolean;
  animate: boolean;
}): ReactElement => (
  <article
    className="piet-request-card"
    aria-label={title}
    data-status={active ? "working" : "error"}
  >
    <div className="piet-request-card__heading">
      <PietMark
        size={18}
        detail="simple"
        active={active && animate}
        className="piet-request-card__mark"
      />
      <strong title={title}>{title}</strong>
      <button className="piet-icon-button" type="button" aria-label={`Dismiss ${title}`}>
        ×
      </button>
    </div>
    <div className="piet-request-card__activity" role="status">
      {activity}
    </div>
    {!active && (
      <button className="piet-window-button" type="button">
        Retry {title}
      </button>
    )}
    <details className="piet-request-card__details">
      <summary>Details</summary>
      <div className="piet-request-card__task">
        <strong>{title}</strong>
        <span>response · {active ? "running" : "error"}</span>
        <p>{activity}</p>
      </div>
    </details>
  </article>
);

const HistoryTask = ({
  title,
  kind,
  status,
  output,
}: {
  title: string;
  kind: string;
  status: (typeof TASK_STATUSES)[number];
  output: string;
}): ReactElement => (
  <article className="piet-inspector-task">
    <div className="piet-inspector-task__heading">
      <div>
        <strong>{title}</strong>
        <span className="piet-inspector-task__kind">{kind}</span>
      </div>
      <span className={`piet-status piet-status--${status}`}>
        {status === "running" ? "working" : status}
      </span>
    </div>
    <div className="piet-inspector-task__output">{output}</div>
    <div className="piet-inspector-task__actions">
      <button className="piet-window-button" type="button">
        focus origin
      </button>
      <button className="piet-window-button piet-window-button--quiet" type="button">
        dismiss
      </button>
    </div>
  </article>
);

const BranchHistory = ({ animate }: { animate: boolean }): ReactElement => (
  <div className={animate ? "piet-inspector__tasks" : "piet-inspector__tasks sg-paused"}>
    <details className="piet-request-history" data-status="working" open>
      <summary>
        <span className="piet-request-history__node" aria-hidden="true" />
        <strong>Explain the auth flow</strong>
        <span className="piet-request-history__status">working</span>
      </summary>
      <HistoryTask
        title="Explain the auth flow"
        kind="response"
        status="running"
        output="Reading repository"
      />
      <HistoryTask
        title="Research OAuth PKCE"
        kind="research"
        status="done"
        output="PKCE prevents authorization code interception."
      />
    </details>
    <details className="piet-request-history" data-status="error">
      <summary>
        <span className="piet-request-history__node" aria-hidden="true" />
        <strong>Diagram the pipeline</strong>
        <span className="piet-request-history__status">error</span>
      </summary>
      <HistoryTask
        title="Diagram the pipeline"
        kind="response"
        status="error"
        output="Canvas repair limit reached"
      />
    </details>
    <details className="piet-request-history" data-status="cancelled">
      <summary>
        <span className="piet-request-history__node" aria-hidden="true" />
        <strong>Sketch a gopher</strong>
        <span className="piet-request-history__status">cancelled</span>
      </summary>
      <HistoryTask
        title="Sketch a gopher"
        kind="response"
        status="cancelled"
        output="Cancelled by user"
      />
    </details>
    <details className="piet-request-history" data-status="done">
      <summary>
        <span className="piet-request-history__node" aria-hidden="true" />
        <strong>Summarize the meeting notes</strong>
        <span className="piet-request-history__status">done</span>
      </summary>
      <HistoryTask
        title="Summarize the meeting notes"
        kind="response"
        status="done"
        output="Three decisions, two follow-ups."
      />
    </details>
  </div>
);

const ChatBubbles = (): ReactElement => (
  <div className="piet-inspector__messages">
    <article className="piet-message piet-message--user">
      <div className="piet-message__role">you</div>
      <div>How does the login flow work? Draw it next to the API box.</div>
    </article>
    <article className="piet-message piet-message--assistant">
      <div className="piet-message__role">pi</div>
      <div>I'll trace the auth flow and sketch it next to your diagram.</div>
    </article>
    <article className="piet-message piet-message--tool">
      <div className="piet-message__role">tool</div>
      <div>canvas.create_shapes · 6 shapes</div>
    </article>
    <article className="piet-message piet-message--system">
      <div className="piet-message__role">system</div>
      <div>Transcription service unavailable</div>
    </article>
  </div>
);

const InspectorPanel = ({ animate }: { animate: boolean }): ReactElement => (
  <div className="sg-inspector-stage">
    <div className="sg-inspector-stage__canvas">
      <RequestCard
        title="Explain the auth flow"
        activity="Reading repository"
        active
        animate={animate}
      />
      <AnswerIndicator animate={animate} />
    </div>
    <aside className="piet-inspector" aria-label="Inspector preview">
      <header className="piet-inspector__header">
        <PietMark size={40} active={animate} />
        <div className="piet-inspector__title">
          <PietWordmark />
          <div className="piet-inspector__status">
            <span className="piet-status-dot piet-status-dot--ready" />
            main working
          </div>
        </div>
        <button className="piet-icon-button" type="button" aria-label="Close inspector">
          ×
        </button>
      </header>
      <nav className="piet-inspector__tabs" aria-label="Inspector sections">
        <button className="piet-tab piet-tab--active" type="button">
          history
        </button>
        <button className="piet-tab" type="button">
          settings
        </button>
      </nav>
      <div className="piet-inspector__body">
        <div className="piet-inspector__section-heading">
          <h3 className="piet-inspector__section-title">request history</h3>
          <span>4</span>
        </div>
        <BranchHistory animate={animate} />
        <h3 className="piet-inspector__section-title">main history</h3>
        <ChatBubbles />
      </div>
    </aside>
  </div>
);

/** Living styleguide rendered with the app's own stylesheets and brand components. */
export const Styleguide = (): ReactElement => {
  useCanvasFonts();
  const [theme, setTheme] = useState<Theme>("light");
  const [animate, setAnimate] = useState(true);
  const [palette, setPalette] = useState<Palette>(DEFAULT_PALETTE);
  const [copied, setCopied] = useState(false);
  const [toggleOpen, setToggleOpen] = useState(false);

  const setToken = (token: PaletteToken, value: string): void =>
    setPalette((current) => ({ ...current, [token]: value }));

  const copyPalette = (): void => {
    void navigator.clipboard.writeText(paletteCss(palette)).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };

  return (
    <div className="piet-app sg">
      <div className={`tl-theme__${theme} sg-theme`} style={paletteStyle(palette)}>
        <header className="sg-toolbar" aria-label="Styleguide controls">
          <div className="sg-toolbar__brand">
            <PietMark size={28} active={animate} />
            <PietWordmark />
            <span className="sg-toolbar__tag">styleguide</span>
          </div>
          <div className="sg-toolbar__controls">
            <div className="piet-inspector__tabs sg-segmented" role="group" aria-label="Theme">
              {(["light", "dark"] as const).map((option) => (
                <button
                  key={option}
                  className={theme === option ? "piet-tab piet-tab--active" : "piet-tab"}
                  type="button"
                  aria-pressed={theme === option}
                  onClick={() => setTheme(option)}
                >
                  {option}
                </button>
              ))}
            </div>
            <button
              className={animate ? "piet-tab piet-tab--active" : "piet-tab"}
              type="button"
              aria-pressed={animate}
              onClick={() => setAnimate((value) => !value)}
            >
              motion {animate ? "on" : "off"}
            </button>
          </div>
        </header>

        <main className="sg-main">
          <section className="sg-hero" aria-label="Piet">
            <div className="sg-hero__mark">
              <PietMark size={220} active={animate} />
            </div>
            <div className="sg-hero__copy">
              <h1 className="sg-hero__title">
                <PietWordmark className="sg-hero__wordmark" />
              </h1>
              <p className="sg-hero__lede">
                A canvas you talk to. Three ideas carry the identity: a <b>Mondrian grid</b> for the
                canvas, a <b>git branch</b> for parallel agent work, and a <b>chat bubble</b> for
                the conversation. Pair two at most; never all three in one element.
              </p>
              <ul className="sg-hero__pillars">
                <li>
                  <span className="sg-fill--blue" /> Grid + bubble · the mark
                </li>
                <li>
                  <span className="sg-fill--yellow" /> Grid + branch · history
                </li>
                <li>
                  <span className="sg-fill--red" /> Bubble · conversation
                </li>
              </ul>
            </div>
          </section>

          <Section
            id="references"
            index={1}
            title="References"
            lede="The icon and the concept artwork everything is derived from. Both redraw from the live palette."
            accent="blue"
          >
            <div className="sg-grid sg-grid--2">
              <Specimen label="Icon" note="Bubble-shaped grid; yellow and white on the right.">
                <PietMark size={200} detail="grid" active={false} />
              </Specimen>
              <Specimen
                label="Concept"
                note="Branch nodes sit on grid intersections; the branch forks along grid lines."
              >
                <ConceptComposition animate={animate} />
              </Specimen>
            </div>
          </Section>

          <Section
            id="palette"
            index={2}
            title="Palette"
            lede="Primary colors on a warm ground, separated by black. Edit a swatch to restyle this whole page, then copy the tokens."
            accent="yellow"
          >
            <div className="sg-palette">
              {PALETTE_TOKENS.map((token) => (
                <label className="sg-swatch" key={token}>
                  <span className="sg-swatch__chip" style={{ background: palette[token] }}>
                    <input
                      type="color"
                      value={palette[token]}
                      onChange={(event) => setToken(token, event.target.value)}
                      aria-label={`${token} color`}
                    />
                  </span>
                  <span className="sg-swatch__name">--piet-{token}</span>
                  <span className="sg-swatch__value">{palette[token]}</span>
                  <span className="sg-swatch__role">{PALETTE_ROLES[token]}</span>
                </label>
              ))}
            </div>
            <div className="sg-row">
              <button className="piet-window-button" type="button" onClick={copyPalette}>
                {copied ? "copied" : "copy tokens"}
              </button>
              <button
                className="piet-window-button"
                type="button"
                onClick={() => setPalette(DEFAULT_PALETTE)}
              >
                reset
              </button>
            </div>
            <div className="sg-proportions" aria-label="Color proportions">
              <span className="sg-fill--blue" style={{ flex: 6 }}>
                blue · field
              </span>
              <span className="sg-fill--ground" style={{ flex: 5 }}>
                ground · space
              </span>
              <span className="sg-fill--yellow" style={{ flex: 2 }}>
                yellow
              </span>
              <span className="sg-fill--red" style={{ flex: 1 }}>
                red
              </span>
            </div>
          </Section>

          <Section
            id="marks"
            index={3}
            title="Mark hierarchy"
            lede="Two marks, never with the branch. Both share one bubble outline and tail. Cells keep the same proportions at every size, and the simple mark's white cell matches the grid mark's yellow and white block. Only line weight changes: heavier at 32px and below. Marks animate while work is in progress."
            accent="red"
          >
            <div className="sg-marks">
              {MARK_DETAILS.map(({ detail, label, use }) => (
                <div className="sg-marks__row" key={detail}>
                  <div className="sg-marks__label">
                    <strong>{label}</strong>
                    <span>{use}</span>
                  </div>
                  <div className="sg-marks__sizes">
                    {MARK_SIZES.map((size) => (
                      <div className="sg-marks__size" key={size}>
                        <PietMark size={size} detail={detail} active={false} />
                        <span>{size}</span>
                      </div>
                    ))}
                    <div className="sg-marks__size sg-marks__size--working">
                      <PietMark size={64} detail={detail} active={animate} />
                      <span>working</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="sg-grid sg-grid--2">
              <Specimen label="Favicon" note="Shipped as /favicon.svg">
                <img src="/favicon.svg" width={64} height={64} alt="Piet favicon" />
              </Specimen>
            </div>
          </Section>

          <Section
            id="wordmark"
            index={4}
            title="Wordmark"
            lede="Lowercase piet in Outfit 800 by Rodrigo Fuenzalida (SIL Open Font License 1.1), turned into outlines so no font loads at runtime and it renders the same everywhere."
            accent="blue"
          >
            <figure className="sg-specimen sg-specimen--wide">
              <div className="sg-specimen__stage sg-wordmark-stage">
                <PietWordmark className="sg-wordmark-large" />
              </div>
              <figcaption>
                <strong>Construction</strong>
                <span>
                  font kerning (harfbuzz) · tracking −0.025em · e–t opened +32 units so the crossbar
                  clears the e · height 0.939em, size with font-size · fills with currentColor
                </span>
              </figcaption>
            </figure>
            <div className="sg-marks">
              <div className="sg-marks__row">
                <div className="sg-marks__label">
                  <strong>Sizes</strong>
                  <span>font-size in px</span>
                </div>
                <div className="sg-marks__sizes">
                  {WORDMARK_SIZES.map((size) => (
                    <div className="sg-marks__size" key={size}>
                      <span className="sg-wordmark-sizebox" style={{ fontSize: size }}>
                        <PietWordmark className="sg-wordmark-size" />
                      </span>
                      <span>{size}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="sg-grid sg-grid--3">
              <Specimen label="Opener" note="30px mark · 20px wordmark">
                <span className="piet-inspector-toggle sg-static">
                  <PietMark size={30} active={false} />
                  <PietWordmark />
                </span>
              </Specimen>
              <Specimen label="Header" note="40px mark · 26px wordmark">
                <div className="sg-lockup sg-lockup--header">
                  <PietMark size={40} active={false} />
                  <PietWordmark />
                </div>
              </Specimen>
              <Specimen label="Lockup" note="48px mark · 40px wordmark">
                <div className="sg-lockup">
                  <PietMark size={48} active={false} />
                  <PietWordmark />
                </div>
              </Specimen>
            </div>
          </Section>

          <Section
            id="type"
            index={5}
            title="Typography"
            lede="Interface: the outlined Outfit wordmark, the system sans for reading, and the system mono for labels, status, and machine output."
            accent="blue"
          >
            <div className="sg-type">
              <div className="sg-type__row">
                <div className="sg-type__meta">
                  <strong>Wordmark</strong>
                  <span>Outfit 800, outlined SVG (see Wordmark)</span>
                </div>
                <PietWordmark className="sg-type__wordmark" />
              </div>
              {UI_FONTS.map(({ role, family, className, sample }) => (
                <div className="sg-type__row" key={role}>
                  <div className="sg-type__meta">
                    <strong>{role}</strong>
                    <span>{family}</span>
                  </div>
                  <div className={className}>{sample}</div>
                </div>
              ))}
            </div>
            <h3 className="sg-subheading">Canvas</h3>
            <p className="sg-section__lede">
              Shapes and text on the canvas use tldraw's four font styles. Piet draws with them; the
              UI around the canvas never does.
            </p>
            <div className="sg-type">
              {CANVAS_FONTS.map(({ style, family, face, sample }) => (
                <div className="sg-type__row" key={style}>
                  <div className="sg-type__meta">
                    <strong>{style}</strong>
                    <span>{family}</span>
                  </div>
                  <div className="sg-type__canvas" style={{ fontFamily: `${face}, sans-serif` }}>
                    {sample}
                  </div>
                </div>
              ))}
            </div>
          </Section>

          <Section
            id="controls"
            index={6}
            title="Controls"
            lede="Square corners, 2px black borders, hard offset shadows. Hover fills with yellow; pressed pushes into the page."
            accent="yellow"
          >
            <div className="sg-grid sg-grid--3">
              <Specimen label="Inspector opener" note="Click to toggle the pressed state">
                <button
                  className="piet-inspector-toggle"
                  type="button"
                  aria-pressed={toggleOpen}
                  onClick={() => setToggleOpen((open) => !open)}
                >
                  <PietMark size={30} active={false} />
                  <PietWordmark />
                </button>
              </Specimen>
              <Specimen label="Window buttons" note="Default, disabled, quiet">
                <div className="sg-row">
                  <button className="piet-window-button" type="button">
                    focus origin
                  </button>
                  <button className="piet-window-button" type="button" disabled>
                    retry
                  </button>
                  <button className="piet-window-button piet-window-button--quiet" type="button">
                    dismiss
                  </button>
                </div>
              </Specimen>
              <Specimen label="Tabs and icon button">
                <div className="sg-row">
                  <nav className="piet-inspector__tabs sg-segmented" aria-label="Example tabs">
                    <button className="piet-tab piet-tab--active" type="button">
                      history
                    </button>
                    <button className="piet-tab" type="button">
                      settings
                    </button>
                  </nav>
                  <button className="piet-icon-button" type="button" aria-label="Close">
                    ×
                  </button>
                </div>
              </Specimen>
              <Specimen label="Primary button">
                <div className="sg-row">
                  <button className="piet-button piet-button--primary sg-pad" type="button">
                    Send
                  </button>
                  <button
                    className="piet-button piet-button--primary sg-pad"
                    type="button"
                    disabled
                  >
                    Send
                  </button>
                </div>
              </Specimen>
              <Specimen label="Status" note="Task lifecycle">
                <div className="sg-row">
                  {TASK_STATUSES.map((status) => (
                    <span key={status} className={`piet-status piet-status--${status}`}>
                      {status}
                    </span>
                  ))}
                </div>
              </Specimen>
              <Specimen label="Select" note="Model controls">
                <div className="piet-role-controls sg-fill-width">
                  <label className="piet-inspector-label" htmlFor="sg-model">
                    main model
                  </label>
                  <select id="sg-model" defaultValue="opus">
                    <option value="opus">Claude Opus 5.5 (anthropic)</option>
                    <option value="sonnet">Claude Sonnet 5 (anthropic)</option>
                  </select>
                </div>
              </Specimen>
            </div>
          </Section>

          <Section
            id="voice"
            index={7}
            title="Voice"
            lede="Talk or type. One solid square with one glyph; its color reports the phase. Hold to talk: it presses into the page and a red outline slowly breathes while it listens. The field below shows the live transcript, and takes typed or externally dictated text the rest of the time."
            accent="red"
          >
            <div className="sg-grid sg-grid--5">
              {VOICE_PHASES.map(({ phase, pressed, disabled, label, note }) => (
                <Specimen key={label} label={label} note={note}>
                  <VoiceButton phase={phase} pressed={pressed} disabled={disabled} />
                </Specimen>
              ))}
            </div>
            <Specimen label="Composer hints" wide>
              <div className="sg-stack">
                <div className="piet-composer__hint">
                  Hold to talk · release to send, or type and press Enter.
                </div>
                <textarea
                  className="piet-voice__transcript"
                  aria-label="Canvas request, empty"
                  placeholder="Type or dictate a request…"
                  rows={1}
                />
                <textarea
                  className="piet-voice__transcript"
                  aria-label="Canvas request, live transcript"
                  rows={1}
                  readOnly
                  value="How does the login flow work? Draw it…"
                />
                <div className="piet-composer__hint">2 tasks running</div>
              </div>
            </Specimen>
          </Section>

          <Section
            id="progress"
            index={8}
            title="Progress on the canvas"
            lede="Where an answer will land, and what is still running. Cells fill in turn, like the mark."
            accent="blue"
          >
            <div className="sg-grid sg-grid--3">
              <Specimen label="Answer indicator" note="Screen-sized, pinned to a canvas point">
                <AnswerIndicator animate={animate} />
              </Specimen>
              <Specimen label="Request card · working">
                <RequestCard
                  title="Explain the auth flow"
                  activity="Reading repository"
                  active
                  animate={animate}
                />
              </Specimen>
              <Specimen label="Request card · error">
                <RequestCard
                  title="Diagram the pipeline"
                  activity="Canvas repair limit reached"
                  active={false}
                  animate={animate}
                />
              </Specimen>
            </div>
          </Section>

          <Section
            id="branch"
            index={9}
            title="Branches and bubbles"
            lede="History reads like a commit graph: requests on the main line, agent tasks branch off. Conversation reads like chat."
            accent="yellow"
          >
            <div className="sg-grid sg-grid--2">
              <Specimen
                label="Request history"
                note="Node: yellow working · red error · dashed cancelled · white done"
              >
                <div className="sg-fill-width">
                  <BranchHistory animate={animate} />
                </div>
              </Specimen>
              <Specimen label="Messages" note="You on the right in blue; pi on the left">
                <div className="sg-fill-width">
                  <ChatBubbles />
                </div>
              </Specimen>
            </div>
          </Section>

          <Section
            id="inspector"
            index={10}
            title="Inspector"
            lede="Everything together in the side panel."
            accent="red"
          >
            <InspectorPanel animate={animate} />
          </Section>
        </main>
      </div>
    </div>
  );
};
