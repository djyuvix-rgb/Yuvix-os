import { Fragment, type ReactNode } from "react";

/**
 * Small markdown renderer for agent output.
 *
 * Deliberately not a full parser: the agent writes headings, lists, bold, code
 * and links, and rendering exactly that — with no dangerouslySetInnerHTML — keeps
 * model output from ever becoming markup in this app.
 */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s<>)]+)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${i++}`;

    if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("[")) {
      const [, label, href] = token.match(/\[([^\]]+)\]\(([^)]+)\)/) ?? [];
      nodes.push(
        <a key={key} href={href} target="_blank" rel="noopener noreferrer">{label}</a>,
      );
    } else {
      nodes.push(
        <a key={key} href={token} target="_blank" rel="noopener noreferrer">{token}</a>,
      );
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  let ordered = false;

  const flushList = (key: string) => {
    if (list.length === 0) return;
    const items = list.map((item, i) => <li key={i}>{inline(item, `${key}-${i}`)}</li>);
    blocks.push(ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
    list = [];
  };

  lines.forEach((raw, index) => {
    const line = raw.trimEnd();
    const key = `b${index}`;

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);

    if (bullet) {
      if (ordered) flushList(`${key}-x`);
      ordered = false;
      list.push(bullet[1]);
      return;
    }
    if (numbered) {
      if (!ordered) flushList(`${key}-x`);
      ordered = true;
      list.push(numbered[1]);
      return;
    }

    flushList(`${key}-l`);

    if (!line.trim()) return;
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const content = inline(heading[2], key);
      blocks.push(
        level <= 1 ? <h1 key={key}>{content}</h1>
          : level === 2 ? <h2 key={key}>{content}</h2>
            : <h3 key={key}>{content}</h3>,
      );
      return;
    }
    if (/^\s*(-{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={key} />);
      return;
    }
    blocks.push(<p key={key}>{inline(line, key)}</p>);
  });

  flushList("tail");
  return <div className="prose-agent">{blocks.map((b, i) => <Fragment key={i}>{b}</Fragment>)}</div>;
}
