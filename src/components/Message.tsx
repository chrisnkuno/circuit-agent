import { useState, type ReactNode } from "react";
import { isSafeHref, parseMarkdown, type Block, type Inline } from "../lib/markdown";

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

/**
 * Inline nodes as elements.
 *
 * Every leaf is a React text node, so its content is escaped by React rather than by anything
 * written here — the reason `markdown.ts` returns a tree instead of an HTML string.
 */
function renderInline(nodes: readonly Inline[], keyPrefix = ""): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}${index}`;
    switch (node.kind) {
      case "text": return <span key={key}>{node.text}</span>;
      case "code": return <code className="inline-code" key={key}>{node.text}</code>;
      case "strong": return <strong key={key}>{renderInline(node.children, `${key}-`)}</strong>;
      case "em": return <em key={key}>{renderInline(node.children, `${key}-`)}</em>;
      case "link":
        // An unsafe scheme renders as its own text: a `javascript:` URL in model output is script
        // execution one click away, and silently dropping the link entirely would hide the content.
        return isSafeHref(node.href)
          ? <a href={node.href} key={key} target="_blank" rel="noreferrer noopener">{renderInline(node.children, `${key}-`)}</a>
          : <span key={key}>{renderInline(node.children, `${key}-`)}</span>;
      default: return null;
    }
  });
}

function renderBlock(block: Block, key: string): ReactNode {
  switch (block.kind) {
    case "heading": {
      // Clamped to h3-h6 inside a message: a message is not a document, and an `h1` per answer
      // wrecks the page outline for a screen reader moving by heading level.
      const Tag = `h${Math.min(6, block.level + 2)}` as "h3";
      return <Tag className="msg-heading" key={key}>{renderInline(block.children)}</Tag>;
    }
    case "list":
      return block.ordered
        ? <ol className="msg-list" key={key}>{block.items.map((item, index) => <li key={index}>{renderInline(item)}</li>)}</ol>
        : <ul className="msg-list" key={key}>{block.items.map((item, index) => <li key={index}>{renderInline(item)}</li>)}</ul>;
    case "quote":
      return <blockquote className="msg-quote" key={key}>{renderInline(block.children)}</blockquote>;
    case "rule":
      return <hr className="msg-rule" key={key} />;
    case "table":
      return (
        <div className="msg-table-wrap" key={key}>
          <table className="msg-table">
            <thead><tr>{block.header.map((cell, index) => <th key={index}>{renderInline(cell)}</th>)}</tr></thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{renderInline(cell)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "code":
      return (
        <figure className="code-block" key={key}>
          <figcaption>
            <span>{block.language ?? "code"}</span>
            <CopyButton text={block.text} label="Copy code" />
          </figcaption>
          <pre><code>{block.text}</code></pre>
        </figure>
      );
    default:
      return <p className="msg-text" key={key}>{renderInline(block.children)}</p>;
  }
}

export type MessageRole = "user" | "assistant" | "system" | "tool";

export function Message(props: { role: MessageRole; content: string; streaming?: boolean }) {
  // Only assistant output is parsed as markdown. A tool line is already a fixed shape, and running
  // a user's own message through a markdown parser would reformat what they typed back at them —
  // someone who wrote `*` meaning a literal asterisk should see one.
  const blocks = props.role === "assistant" ? parseMarkdown(props.content) : null;

  return (
    <div className={`msg ${props.role}${props.streaming ? " streaming" : ""}`}>
      {blocks
        ? blocks.map((block, index) => renderBlock(block, String(index)))
        : <p className="msg-text">{props.content}</p>}
      {props.role === "assistant" && !props.streaming && props.content.trim() ? (
        <div className="msg-tools"><CopyButton text={props.content} label="Copy message" /></div>
      ) : null}
    </div>
  );
}
