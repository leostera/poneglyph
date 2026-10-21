// Monaco editor for authoring facts as typed object literals. Loaded lazily so
// the query tab never pays for Monaco or the TypeScript worker. Workers are
// bundled same-origin (CSP worker-src 'self').
import * as monaco from "./monaco.ts";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import TypeScriptWorker from "monaco-editor/languages/features/typescript/ts.worker.js?worker";
import { useEffect, useRef } from "react";
import { FACT_TYPES } from "./facts-source.ts";

self.MonacoEnvironment = {
  getWorker: (_id: string, label: string) => (label === "typescript" || label === "javascript" ? new TypeScriptWorker() : new EditorWorker()),
};
monaco.typescriptDefaults.setCompilerOptions({ target: 99, module: 99, strict: true, noEmit: true, lib: ["es2022"], allowNonTsExtensions: true });
monaco.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false });
monaco.typescriptDefaults.addExtraLib(FACT_TYPES, "file:///poneglyph-facts.d.ts");

const MODEL_URI = monaco.Uri.parse("file:///transaction.ts");
const themeFor = () => (document.documentElement.dataset.mode === "dark" ? "vs-dark" : "vs");

export type EditorProblems = { errors: number; first?: string };

/** Uncontrolled: the editor owns its text. `reset.nonce` changes replace it (undoably). */
export default function FactsEditor({ reset, onChange, onCommit, onProblems }: {
  reset: { text: string; nonce: number }; onChange: (value: string) => void; onCommit: () => void; onProblems: (problems: EditorProblems) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const appliedReset = useRef(reset.nonce);
  const callbacks = useRef({ onChange, onCommit, onProblems });
  callbacks.current = { onChange, onCommit, onProblems };

  useEffect(() => {
    const model = monaco.editor.getModel(MODEL_URI) ?? monaco.editor.createModel(reset.text, "typescript", MODEL_URI);
    model.setValue(reset.text);
    appliedReset.current = reset.nonce;
    const instance = monaco.editor.create(host.current!, {
      model, theme: themeFor(), automaticLayout: true, minimap: { enabled: false }, fontSize: 13, lineHeight: 21,
      fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace", scrollBeyondLastLine: false,
      renderLineHighlight: "line", tabSize: 2, wordWrap: "on", wrappingIndent: "indent", padding: { top: 12, bottom: 12 }, fixedOverflowWidgets: true,
      quickSuggestions: { strings: true, other: true, comments: false }, suggestOnTriggerCharacters: true, wordBasedSuggestions: "off",
      overviewRulerLanes: 0, scrollbar: { alwaysConsumeMouseWheel: false }, stickyScroll: { enabled: false },
    });
    editor.current = instance;
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => callbacks.current.onCommit());
    const changes = model.onDidChangeContent(() => callbacks.current.onChange(model.getValue()));
    const markers = monaco.editor.onDidChangeMarkers(uris => {
      if (!uris.some(uri => uri.toString() === MODEL_URI.toString())) return;
      const errors = monaco.editor.getModelMarkers({ resource: MODEL_URI }).filter(marker => marker.severity === monaco.MarkerSeverity.Error);
      const first = errors[0];
      callbacks.current.onProblems({ errors: errors.length, ...(first ? { first: `Line ${first.startLineNumber}: ${first.message}` } : {}) });
    });
    const modes = new MutationObserver(() => monaco.editor.setTheme(themeFor()));
    modes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode"] });
    return () => { modes.disconnect(); markers.dispose(); changes.dispose(); instance.dispose(); editor.current = null; };
    // The model is created once per mount; resets apply below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const model = editor.current?.getModel();
    if (!model || reset.nonce === appliedReset.current) return;
    appliedReset.current = reset.nonce;
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: reset.text }], () => null);
  }, [reset]);

  return <div ref={host} className="h-[22rem] overflow-hidden rounded-lg border border-kumo-line" />;
}
