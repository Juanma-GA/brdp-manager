// A browser-like DOMParser / XMLSerializer for the Node tests, built on
// @xmldom/xmldom, with just what the generators use: parse errors as a
// <parsererror> element (what checkWellFormed and parseRuleFragment read),
// querySelector / querySelectorAll for the selectors of the BREX 4.2
// assembler ("tag", "[attr]", "tag:not([attr])", "tag[attr]"), and
// firstElementChild. Lets scripts run generateBREX (4.2), which assembles
// with the DOM, outside the browser.
//
//   import { installNodeDom } from './lib/nodeDom.mjs';
//   installNodeDom();   // sets globalThis.DOMParser / XMLSerializer
import { DOMParser as XmldomParser, XMLSerializer as XmldomSerializer } from '@xmldom/xmldom';

function matcher(selector) {
  const m = /^([A-Za-z_][\w.:-]*)?(?:\[([\w.:-]+)\])?(?::not\(\[([\w.:-]+)\]\))?$/.exec(selector.trim());
  if (!m) throw new Error(`nodeDom: unsupported selector ${selector}`);
  const [, tag, has, hasNot] = m;
  return (el) =>
    el.nodeType === 1 &&
    (!tag || el.nodeName === tag) &&
    (!has || el.hasAttribute(has)) &&
    (!hasNot || !el.hasAttribute(hasNot));
}

function descendants(node, out = []) {
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1) {
      out.push(c);
      descendants(c, out);
    }
  }
  return out;
}

let installed = false;

export function installNodeDom() {
  if (installed) return;
  installed = true;
  const probe = new XmldomParser().parseFromString('<a/>', 'text/xml');
  const docProto = Object.getPrototypeOf(probe);
  const elProto = Object.getPrototypeOf(probe.documentElement);
  for (const proto of [docProto, elProto]) {
    proto.querySelectorAll = function querySelectorAll(selector) {
      const test = matcher(selector);
      return descendants(this).filter(test);
    };
    proto.querySelector = function querySelector(selector) {
      if (selector === 'parsererror' && this.__parseError) return { textContent: this.__parseError };
      return this.querySelectorAll(selector)[0] ?? null;
    };
  }
  Object.defineProperty(elProto, 'firstElementChild', {
    configurable: true,
    get() {
      for (let c = this.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) return c;
      return null;
    },
  });

  globalThis.DOMParser = class NodeDOMParser {
    parseFromString(text) {
      const messages = [];
      const doc = new XmldomParser({ errorHandler: (level, msg) => level !== 'warning' && messages.push(msg) }).parseFromString(text, 'text/xml');
      if (messages.length) doc.__parseError = messages[0];
      return doc;
    }
  };
  globalThis.XMLSerializer = XmldomSerializer;
}
