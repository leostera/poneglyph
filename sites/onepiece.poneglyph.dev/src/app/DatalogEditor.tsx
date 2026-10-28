// CodeMirror 6 editor for Poneglyph's Datalog dialect. The tokenizer mirrors
// packages/poneglyph/src/datalog/parser.ts: JSON strings, 'quoted' identifiers,
// URI-ish identifiers ([A-Za-z][A-Za-z0-9:_?+.-]*), signed integers, the
// wildcard `_`, punctuation ( ) , ! and comparison operators. An identifier
// followed by "(" is a predicate (a field URI or builtin); an uppercase one is a
// variable. Highlighting is advisory: the server parser stays authoritative.
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, HighlightStyle, StreamLanguage, syntaxHighlighting, type StringStream } from "@codemirror/language";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExtension } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";

export const BUILTINS = ["eq", "lt", "lte", "gt", "gte", "before", "after", "contains", "startsWith", "endsWith"] as const;
const BUILTIN_SET = new Set<string>(BUILTINS);
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9:_?+.-]*/;

const datalog = StreamLanguage.define<{ depth: number }>({
  name: "poneglyph-datalog",
  startState: () => ({ depth: 0 }),
  token(stream: StringStream, state) {
    if (stream.eatSpace()) return null;
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
    if (stream.match(/^'(?:[^'\\]|\\.)*'?/)) return stream.match(/^\s*\(/, false) ? "propertyName" : "string";
    if (stream.match(/^-?\d+/)) return "number";
    if (stream.match(/^_(?![A-Za-z0-9:_?+.-])/)) return "keyword";
    const identifier = stream.match(IDENTIFIER) as RegExpMatchArray | null;
    if (identifier) {
      const word = identifier[0];
      if (stream.match(/^\s*\(/, false)) return BUILTIN_SET.has(word) ? "keyword" : "propertyName";
      return /^[A-Z]/.test(word) ? "variableName" : "atom";
    }
    if (stream.match(/^(?:<=|>=|<|>|=)/)) return "operator";
    const character = stream.next();
    if (character === "(") { state.depth++; return "paren"; }
    if (character === ")") { state.depth = Math.max(0, state.depth - 1); return "paren"; }
    if (character === ",") return state.depth === 0 ? "separator" : "punctuation";
    if (character === "!") return "operator";
    return "invalid";
  },
  languageData: { closeBrackets: { brackets: ["(", '"', "'"] } },
});

const highlight = HighlightStyle.define([
  { tag: tags.propertyName, class: "dl-predicate" },
  { tag: tags.variableName, class: "dl-variable" },
  { tag: tags.string, class: "dl-string" },
  { tag: tags.number, class: "dl-number" },
  { tag: tags.keyword, class: "dl-keyword" },
  { tag: tags.operator, class: "dl-operator" },
  { tag: tags.atom, class: "dl-atom" },
  { tag: [tags.paren, tags.punctuation, tags.separator], class: "dl-punctuation" },
  { tag: tags.invalid, class: "dl-invalid" },
]);

const theme = EditorView.theme({
  "&": { fontSize: "13px", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace", lineHeight: "1.6" },
  ".cm-content": { padding: "10px 0", caretColor: "var(--color-kumo-brand)" },
  ".cm-line": { padding: "0 12px" },
  ".cm-gutters": { display: "none" },
  ".cm-cursor": { borderLeftColor: "var(--color-kumo-brand)", borderLeftWidth: "2px" },
  ".cm-placeholder": { color: "var(--text-color-kumo-subtle, #8a8a8a)" },
});

function completions(fields: readonly string[]) {
  const options = [
    ...fields.map(field => ({ label: field, type: "property", apply: `${field}(`, detail: "field" })),
    ...BUILTINS.map(name => ({ label: name, type: "keyword", apply: `${name}(`, detail: "builtin" })),
  ];
  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/[A-Za-z][A-Za-z0-9:_?+.-]*/);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    // Uppercase words are variables: don't pop field suggestions over them.
    if (/^[A-Z]/.test(word.text)) return null;
    return { from: word.from, options, validFor: /^[A-Za-z0-9:_?+.-]*$/ };
  };
}

export function DatalogEditor({ value, onChange, onRun, fields, maxLength, label }: {
  value: string; onChange: (value: string) => void; onRun: () => void; fields: readonly string[]; maxLength: number; label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Latest callbacks without rebuilding the editor on every render.
  const callbacks = useRef({ onChange, onRun });
  callbacks.current = { onChange, onRun };

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(), closeBrackets(), bracketMatching(), datalog, syntaxHighlighting(highlight), theme, EditorView.lineWrapping,
          autocompletion({ override: [completions(fields)], icons: false }),
          placeholderExtension('onepiece:name(Who, "Nico Robin")'),
          EditorState.changeFilter.of(transaction => transaction.newDoc.length <= maxLength),
          Prec.highest(keymap.of([{ key: "Mod-Enter", run: () => { callbacks.current.onRun(); return true; } }])),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
          EditorView.updateListener.of(update => { if (update.docChanged) callbacks.current.onChange(update.state.doc.toString()); }),
          EditorView.contentAttributes.of({ "aria-label": label, spellcheck: "false", autocapitalize: "off", autocorrect: "off" }),
        ],
      }),
    });
    view.current = editor;
    return () => { editor.destroy(); view.current = null; };
    // Fields/limits are fixed per session; external value changes sync below.
  }, [fields, maxLength, label]);

  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  }, [value]);

  return (
    <div ref={host} onClick={() => view.current?.focus()}
      className="datalog-editor min-h-[5.5rem] max-h-80 overflow-auto rounded-lg border border-kumo-line bg-kumo-base text-kumo-default transition-colors focus-within:border-kumo-brand focus-within:ring-2 focus-within:ring-kumo-brand/20" />
  );
}
