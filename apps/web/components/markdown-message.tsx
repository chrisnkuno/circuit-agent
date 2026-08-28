"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { parseMarkdown, type Span } from "@/lib/markdown";

function Spans({ spans }: { spans: Span[] }) {
  return <>{spans.map((span, index) => {
    if (span.type === "code") return <code key={index}>{span.text}</code>;
    if (span.type === "strong") return <strong key={index}>{span.text}</strong>;
    if (span.type === "em") return <em key={index}>{span.text}</em>;
    if (span.type === "link") return <a key={index} href={span.href} target="_blank" rel="noreferrer noopener">{span.text}</a>;
    return <span key={index}>{span.text}</span>;
  })}</>;
}

function CodeBlock({ language, text }: { language?: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return <figure className="code-block">
    <figcaption>
      <span>{language ?? "code"}</span>
      <button
        type="button"
        aria-label="Copy code"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1_600);
          } catch {
            // Clipboard access is denied in some contexts; the code is still selectable.
          }
        }}
      >{copied ? <Check /> : <Copy />}{copied ? "Copied" : "Copy"}</button>
    </figcaption>
    <pre><code>{text}</code></pre>
  </figure>;
}

/** Renders a model reply as elements — never as HTML, so output cannot inject markup. */
export function MarkdownMessage({ content }: { content: string }) {
  return <div className="markdown">
    {parseMarkdown(content).map((block, index) => {
      switch (block.type) {
        case "code": return <CodeBlock key={index} language={block.language} text={block.text} />;
        case "heading": {
          const Tag = (["h3", "h4", "h5"] as const)[block.level - 1];
          return <Tag key={index}><Spans spans={block.spans} /></Tag>;
        }
        case "list": return block.ordered
          ? <ol key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}><Spans spans={item} /></li>)}</ol>
          : <ul key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}><Spans spans={item} /></li>)}</ul>;
        case "quote": return <blockquote key={index}><Spans spans={block.spans} /></blockquote>;
        case "rule": return <hr key={index} />;
        default: return <p key={index}><Spans spans={block.spans} /></p>;
      }
    })}
  </div>;
}
