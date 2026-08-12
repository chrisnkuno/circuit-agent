import { useState } from "react";
import { splitSegments } from "../lib/transcript";

/** Copies text and says so, because a button that gives no feedback gets pressed twice. */
function CopyButton(props: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="btn ghost copy"
      type="button"
      aria-label={props.label ?? "Copy to clipboard"}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(props.text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        } catch {
          // A clipboard the platform refuses is not worth an error dialog; the text is selectable.
        }
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export type MessageRole = "user" | "assistant" | "system" | "tool";

export function Message(props: { role: MessageRole; content: string; streaming?: boolean }) {
  // Only assistant output is parsed for code. A tool line is already a fixed shape, and running a
  // user's own message through a fence parser would reformat what they typed back at them.
  const segments = props.role === "assistant" ? splitSegments(props.content) : [{ kind: "text" as const, text: props.content }];

  return (
    <div className={`msg ${props.role}${props.streaming ? " streaming" : ""}`}>
      {segments.map((segment, index) =>
        segment.kind === "code" ? (
          <figure className="code-block" key={index}>
            <figcaption>
              <span>{segment.language ?? "code"}</span>
              <CopyButton text={segment.code} label="Copy code" />
            </figcaption>
            <pre><code>{segment.code}</code></pre>
          </figure>
        ) : (
          <p className="msg-text" key={index}>{segment.text}</p>
        ),
      )}
      {props.role === "assistant" && !props.streaming && props.content.trim() ? (
        <div className="msg-tools"><CopyButton text={props.content} label="Copy message" /></div>
      ) : null}
    </div>
  );
}
