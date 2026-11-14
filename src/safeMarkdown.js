// A deliberately small Markdown renderer. Remote text never enters innerHTML.
function inline(parent, text) {
  const tokens =
    /(\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\))/g;
  let offset = 0,
    match;
  while ((match = tokens.exec(text))) {
    parent.append(document.createTextNode(text.slice(offset, match.index)));
    const node = document.createElement(
      match[2] ? "strong" : match[3] ? "code" : "a",
    );
    node.textContent = match[2] || match[3] || match[4];
    if (match[5]) {
      try {
        const url = new URL(match[5]);
        if (!["https:", "http:"].includes(url.protocol)) throw Error();
        node.href = url.href;
        node.target = "_blank";
        node.rel = "noopener noreferrer";
      } catch {
        node.removeAttribute("href");
      }
    }
    parent.append(node);
    offset = tokens.lastIndex;
  }
  parent.append(document.createTextNode(text.slice(offset)));
}
export function renderSafeMarkdown(target, text) {
  target.replaceChildren();
  let list = null,
    pre = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith("```")) {
      if (pre) pre = null;
      else {
        pre = document.createElement("pre");
        target.append(pre);
      }
      continue;
    }
    if (pre) {
      pre.textContent += line + "\n";
      continue;
    }
    if (!line.trim()) {
      list = null;
      continue;
    }
    const heading = line.match(/^#{1,4}\s+(.+)$/),
      bullet = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/);
    if (bullet) {
      if (!list) {
        list = document.createElement("ul");
        target.append(list);
      }
      const li = document.createElement("li");
      inline(li, bullet[1]);
      list.append(li);
      continue;
    }
    list = null;
    const node = document.createElement(heading ? "h4" : "p");
    inline(node, heading ? heading[1] : line);
    target.append(node);
  }
}
