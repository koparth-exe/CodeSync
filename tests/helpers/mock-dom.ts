/**
 * Lightweight Zero-Dependency Mock DOM for Platform Adapter Security Testing
 *
 * Implements tree querying (querySelector, querySelectorAll, closest, getAttribute)
 * and HTML snippet parsing without requiring external npm dependencies like jsdom.
 */

export interface MockElementOptions {
  tagName?: string | undefined;
  textContent?: string | undefined;
  value?: string | undefined;
  attributes?: Record<string, string> | undefined;
  children?: MockElementOptions[] | undefined;
  selectedOptions?: Array<{ textContent?: string; value?: string }> | undefined;
}

export class MockElement {
  readonly tagName: string;
  private _textContent?: string | undefined;
  value?: string | undefined;
  selectedOptions?: Array<{ textContent?: string; value?: string }> | undefined;
  readonly attributes: Record<string, string>;
  readonly children: MockElement[] = [];
  parentElement: MockElement | null = null;

  constructor(options: MockElementOptions = {}) {
    this.tagName = (options.tagName ?? "div").toUpperCase();
    this._textContent = options.textContent;
    this.value = options.value;
    this.selectedOptions = options.selectedOptions;
    this.attributes = { ...(options.attributes ?? {}) };

    if (options.children) {
      for (const childOpt of options.children) {
        const child = new MockElement(childOpt);
        this.appendChild(child);
      }
    }
  }

  get textContent(): string {
    if (this._textContent !== undefined) {
      return this._textContent;
    }
    if (this.children.length === 0) {
      return "";
    }
    return this.children.map((c) => c.textContent).join("");
  }

  set textContent(val: string) {
    this._textContent = val;
  }

  appendChild(child: MockElement): void {
    child.parentElement = this;
    this.children.push(child);
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  setAttribute(name: string, val: string): void {
    this.attributes[name] = val;
  }

  matches(selector: string): boolean {
    const parts = selector.split(",").map((s) => s.trim());
    return parts.some((part) => this.matchesComplex(part));
  }

  private matchesComplex(sel: string): boolean {
    const parts = sel.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return false;
    const firstPart = parts[0];
    if (parts.length === 1 && firstPart) return this.matchesSingle(firstPart);

    // Rightmost part must match this element
    const rightmost = parts[parts.length - 1];
    if (!rightmost || !this.matchesSingle(rightmost)) return false;

    // Ancestor chain check
    let currentElem: MockElement | null = this.parentElement;
    for (let i = parts.length - 2; i >= 0; i--) {
      const ancestorPart = parts[i];
      if (!ancestorPart) continue;
      let matchedAncestor = false;
      while (currentElem) {
        if (currentElem.matchesSingle(ancestorPart)) {
          matchedAncestor = true;
          currentElem = currentElem.parentElement;
          break;
        }
        currentElem = currentElem.parentElement;
      }
      if (!matchedAncestor) return false;
    }
    return true;
  }

  matchesSingle(sel: string): boolean {
    // Tag name matching
    const tagMatch = sel.match(/^[a-zA-Z0-9]+/);
    if (tagMatch && this.tagName !== tagMatch[0].toUpperCase()) {
      return false;
    }

    // ID matching (#id)
    const idMatch = sel.match(/#([a-zA-Z0-9_-]+)/);
    const expectedId = idMatch?.[1];
    if (expectedId && this.attributes["id"] !== expectedId) {
      return false;
    }

    // Class matching (.class)
    const classMatches = Array.from(sel.matchAll(/\.([a-zA-Z0-9_-]+)/g));
    for (const cm of classMatches) {
      const clsName = cm[1];
      if (!clsName) continue;
      const cls = this.attributes["class"] ?? "";
      if (!cls.split(/\s+/).includes(clsName)) {
        return false;
      }
    }

    // Attribute matching [attr], [attr="val"], [attr*="val"], [attr^="val"], [attr$="val"]
    const attrMatches = Array.from(
      sel.matchAll(
        /\[([a-zA-Z0-9_-]+)(?:([*~|^$]?=)(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/g,
      ),
    );
    for (const am of attrMatches) {
      const attrName = am[1];
      if (!attrName) continue;
      const operator = am[2];
      const attrVal = am[3] ?? am[4] ?? am[5] ?? "";

      const currentVal = this.attributes[attrName];
      if (currentVal === undefined) {
        return false;
      }
      if (operator === "=" && currentVal !== attrVal) {
        return false;
      }
      if (operator === "*=" && !currentVal.includes(attrVal)) {
        return false;
      }
      if (operator === "^=" && !currentVal.startsWith(attrVal)) {
        return false;
      }
      if (operator === "$=" && !currentVal.endsWith(attrVal)) {
        return false;
      }
    }

    return true;
  }

  closest(selector: string): MockElement | null {
    if (this.matches(selector)) {
      return this;
    }
    return this.parentElement ? this.parentElement.closest(selector) : null;
  }

  querySelector(selector: string): MockElement | null {
    for (const child of this.children) {
      if (child.matches(selector)) {
        return child;
      }
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  querySelectorAll(selector: string): MockElement[] {
    const results: MockElement[] = [];
    for (const child of this.children) {
      if (child.matches(selector)) {
        results.push(child);
      }
      results.push(...child.querySelectorAll(selector));
    }
    return results;
  }
}

export class MockDocument {
  readonly body: MockElement;

  constructor(children: MockElementOptions[] = []) {
    this.body = new MockElement({ tagName: "body", children });
  }

  querySelector(selector: string): MockElement | null {
    if (this.body.matches(selector)) return this.body;
    return this.body.querySelector(selector);
  }

  querySelectorAll(selector: string): MockElement[] {
    const results: MockElement[] = [];
    if (this.body.matches(selector)) results.push(this.body);
    results.push(...this.body.querySelectorAll(selector));
    return results;
  }

  createElement(tagName: string): MockElement {
    return new MockElement({ tagName });
  }
}

function unescapeHTML(str: string): string {
  return str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

const VOID_ELEMENTS = new Set([
  "AREA",
  "BASE",
  "BR",
  "COL",
  "EMBED",
  "HR",
  "IMG",
  "INPUT",
  "LINK",
  "META",
  "PARAM",
  "SOURCE",
  "TRACK",
  "WBR",
]);

/**
 * Parses a simple HTML snippet into a lightweight MockDocument.
 */
export function parseHTML(html: string): MockDocument {
  const doc = new MockDocument();
  const root = doc.body;

  const tagRegex =
    /<!--[\s\S]*?-->|<(\/?)([a-zA-Z0-9_-]+)((?:\s+[a-zA-Z0-9_-]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;

  const stack: MockElement[] = [root];
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(html)) !== null) {
    const [
      fullMatch,
      isClosing,
      tagName,
      attrString,
      isSelfClosing,
      textContent,
    ] = match;

    if (fullMatch.startsWith("<!--")) {
      continue;
    }

    if (textContent !== undefined) {
      const trimmed = textContent.trim();
      if (trimmed) {
        const top = stack[stack.length - 1];
        if (top) {
          const unescaped = unescapeHTML(textContent);
          if (top.tagName === "TEXTAREA") {
            top.value = (top.value ?? "") + unescaped;
            top.textContent = (top.textContent ?? "") + unescaped;
          } else {
            const textNode = new MockElement({
              tagName: "span",
              textContent: unescaped,
            });
            top.appendChild(textNode);
          }
        }
      }
      continue;
    }

    if (tagName) {
      const upperTag = tagName.toUpperCase();
      if (
        upperTag === "!DOCTYPE" ||
        upperTag === "HTML" ||
        upperTag === "HEAD" ||
        upperTag === "BODY"
      ) {
        continue;
      }

      if (isClosing) {
        for (let i = stack.length - 1; i >= 1; i--) {
          const item = stack[i];
          if (item && item.tagName === upperTag) {
            stack.splice(i, stack.length - i);
            break;
          }
        }
      } else {
        const attrs: Record<string, string> = {};
        if (attrString) {
          const attrRegex =
            /([a-zA-Z0-9_-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
          let attrMatch: RegExpExecArray | null;
          while ((attrMatch = attrRegex.exec(attrString)) !== null) {
            const name = attrMatch[1];
            if (name) {
              const val = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? "";
              attrs[name] = unescapeHTML(val);
            }
          }
        }

        const elem = new MockElement({
          tagName: upperTag,
          attributes: attrs,
        });

        if (attrs["value"] !== undefined) {
          elem.value = attrs["value"];
        }

        const top = stack[stack.length - 1];
        if (top) {
          top.appendChild(elem);

          if (upperTag === "OPTION" && "selected" in attrs) {
            if (top.tagName === "SELECT") {
              top.value = attrs["value"] ?? "";
              top.selectedOptions = [
                {
                  textContent: elem.textContent,
                  value: elem.value ?? elem.textContent,
                },
              ];
            }
          }
        }

        const isVoid = VOID_ELEMENTS.has(upperTag) || isSelfClosing === "/";
        if (!isVoid) {
          stack.push(elem);
        }
      }
    }
  }

  return doc;
}
