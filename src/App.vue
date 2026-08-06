<script setup lang="ts">
import loader from "@monaco-editor/loader";
import libCellMLModule from "libcellml.js";
import libCellMLWasmUrl from "libcellml.js/libcellml.wasm?url";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

type EditorSubview = "xml" | "simulation" | "math";

interface SimulationSettings {
  startTime: number;
  endTime: number;
  stepSize: number;
  method: "euler" | "rk4";
  absoluteTolerance: number;
  relativeTolerance: number;
}

interface ModelTab {
  id: string;
  name: string;
  xml: string;
  activeSubview: EditorSubview;
  simulation: SimulationSettings;
  mathReadable: string[];
  validationMessage: string;
}

interface Disposable {
  dispose: () => void;
}

interface MonacoEditor {
  layout: () => void;
  getValue: () => string;
  setValue: (value: string) => void;
  dispose: () => void;
  updateOptions: (options: Record<string, unknown>) => void;
  onDidChangeModelContent: (listener: () => void) => Disposable;
}

const tabs = ref<ModelTab[]>([]);
const activeTabId = ref<string | null>(null);
const dragActive = ref(false);
const statusMessage = ref("Drop CellML files here to open them in tabs.");

const fileInput = ref<HTMLInputElement | null>(null);
const xmlEditorHost = ref<HTMLElement | null>(null);

const libCellmlState = ref<"idle" | "loading" | "ready" | "error">("idle");
const libCellmlError = ref<string | null>(null);
const libCellmlApi = ref<any>(null);

const activeTab = computed(() => tabs.value.find((tab) => tab.id === activeTabId.value) ?? null);

let monacoEditor: MonacoEditor | null = null;
let monacoSubscription: Disposable | null = null;
let boundEditorTabId: string | null = null;
let syncingEditorFromModel = false;

const monacoTheme = {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "", foreground: "E8EEF5", background: "0E2230" },
    { token: "tag", foreground: "61DAFB" },
    { token: "attribute.name", foreground: "FFD98E" },
    { token: "attribute.value", foreground: "B4F8C8" },
  ],
  colors: {
    "editor.background": "#0E2230",
    "editor.foreground": "#E8EEF5",
    "editorLineNumber.foreground": "#4A6A7E",
    "editorCursor.foreground": "#F68E5F",
    "editor.selectionBackground": "#1B5A754D",
  },
};

const updateStatusFromTabs = () => {
  statusMessage.value = tabs.value.length
    ? `${tabs.value.length} model tab${tabs.value.length === 1 ? "" : "s"} open.`
    : "Drop CellML files here to open them in tabs.";
};

const ensureLibCellml = async () => {
  if (libCellmlState.value === "ready" || libCellmlState.value === "loading") {
    return;
  }

  libCellmlState.value = "loading";
  libCellmlError.value = null;

  try {
    const factory = libCellMLModule as unknown as (options?: Record<string, unknown>) => Promise<any>;
    const options = {
      locateFile: (path: string) => (path.endsWith(".wasm") ? libCellMLWasmUrl : path),
    };

    try {
      libCellmlApi.value = await factory(options);
    } catch {
      libCellmlApi.value = await new (libCellMLModule as any)(options);
    }

    libCellmlState.value = "ready";

    for (const tab of tabs.value) {
      tab.validationMessage = validateWithLibCellml(tab.xml);
    }
  } catch (error) {
    libCellmlState.value = "error";
    libCellmlError.value = String(error);
  }
};

const validateWithLibCellml = (xml: string) => {
  if (libCellmlState.value !== "ready") {
    return "Validation pending until libCellML is ready.";
  }

  try {
    const parserCtor = libCellmlApi.value?.Parser;

    if (typeof parserCtor !== "function") {
      return "libCellML loaded, but parser API was not found.";
    }

    const parser = new parserCtor();

    if (typeof parser.parseModel === "function") {
      parser.parseModel(xml);
    }

    const issueCount = typeof parser.issueCount === "function" ? Number(parser.issueCount()) : 0;

    if (issueCount <= 0) {
      return "No parser issues detected by libCellML.";
    }

    const issueLines: string[] = [];

    for (let index = 0; index < issueCount; index += 1) {
      if (typeof parser.issue !== "function") {
        break;
      }

      const issue = parser.issue(index);
      const issueDescription =
        typeof issue?.description === "function" ? String(issue.description()) : String(issue ?? "Unknown issue");
      issueLines.push(`Issue ${index + 1}: ${issueDescription}`);

      if (issueLines.length >= 4) {
        break;
      }
    }

    return `${issueCount} parser issue${issueCount === 1 ? "" : "s"} detected.\n${issueLines.join("\n")}`;
  } catch (error) {
    return `Unable to validate with libCellML: ${String(error)}`;
  }
};

const stripNamespaces = (value: string) =>
  value
    .replace(/<\/?math[^>]*>/gi, "")
    .replace(/xmlns(:[a-z0-9_-]+)?=\"[^\"]*\"/gi, "")
    .trim();

const operatorSymbolByName: Record<string, string> = {
  plus: "+",
  minus: "-",
  times: "*",
  divide: "/",
  power: "^",
  eq: "=",
  lt: "<",
  gt: ">",
  leq: "<=",
  geq: ">=",
};

const renderMathNode = (node: Element): string => {
  const nodeName = node.localName.toLowerCase();

  if (nodeName === "ci" || nodeName === "cn") {
    return (node.textContent ?? "").trim();
  }

  if (nodeName === "apply") {
    const elements = Array.from(node.children);

    if (!elements.length) {
      return "";
    }

    const operator = elements[0]?.localName.toLowerCase() ?? "";
    const operands = elements.slice(1).map((child) => renderMathNode(child)).filter(Boolean);

    if (operator in operatorSymbolByName) {
      if (operands.length === 1 && operator === "minus") {
        return `(-${operands[0]})`;
      }

      return `(${operands.join(` ${operatorSymbolByName[operator]} `)})`;
    }

    if (operator === "diff") {
      const bvar = elements.find((child) => child.localName.toLowerCase() === "bvar");
      const wrt = bvar?.querySelector("ci")?.textContent?.trim() ?? "t";
      const expr = operands.length ? operands[operands.length - 1] : "?";
      return `d(${expr})/d${wrt}`;
    }

    return `${operator}(${operands.join(", ")})`;
  }

  if (nodeName === "piecewise") {
    return "piecewise(...)";
  }

  if (node.children.length) {
    const children = Array.from(node.children).map((child) => renderMathNode(child)).filter(Boolean);
    return `${nodeName}(${children.join(", ")})`;
  }

  return (node.textContent ?? "").trim();
};

const buildMathReadable = (xml: string) => {
  const blocks = Array.from(xml.matchAll(/<math[\s\S]*?<\/math>/gi)).map((match) => match[0]);

  if (!blocks.length) {
    return ["No MathML <math> blocks found in this model."];
  }

  const lines: string[] = [];

  blocks.forEach((block, index) => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(block, "application/xml");
    const parseError = doc.querySelector("parsererror");

    lines.push(`Math block ${index + 1}`);

    if (parseError) {
      lines.push(stripNamespaces(block));
      lines.push("");
      return;
    }

    const mathRoot = doc.documentElement;
    const expressionRoot = mathRoot.firstElementChild;

    if (!expressionRoot) {
      lines.push("(empty math block)");
      lines.push("");
      return;
    }

    lines.push(renderMathNode(expressionRoot));
    lines.push("");
  });

  return lines;
};

const createDefaultSimulationSettings = (): SimulationSettings => ({
  startTime: 0,
  endTime: 100,
  stepSize: 0.1,
  method: "rk4",
  absoluteTolerance: 1e-8,
  relativeTolerance: 1e-6,
});

const createTabFromContent = (name: string, xml: string): ModelTab => ({
  id: `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
  name,
  xml,
  activeSubview: "xml",
  simulation: createDefaultSimulationSettings(),
  mathReadable: buildMathReadable(xml),
  validationMessage: validateWithLibCellml(xml),
});

const openCellmlFiles = async (fileList: FileList | File[]) => {
  const files = Array.from(fileList);
  const cellmlFiles = files.filter((file) => file.name.toLowerCase().endsWith(".cellml"));

  if (!cellmlFiles.length) {
    statusMessage.value = "No .cellml files detected in dropped selection.";
    return;
  }

  for (const file of cellmlFiles) {
    const xml = await file.text();
    const tab = createTabFromContent(file.name, xml);
    tabs.value.push(tab);
    activeTabId.value = tab.id;
  }

  updateStatusFromTabs();
  await nextTick();
  syncEditorWithActiveTab();
};

const onDropContainer = async (event: DragEvent) => {
  event.preventDefault();
  dragActive.value = false;

  if (event.dataTransfer?.files?.length) {
    await openCellmlFiles(event.dataTransfer.files);
  }
};

const onDragOverContainer = (event: DragEvent) => {
  event.preventDefault();
  dragActive.value = true;
};

const onDragLeaveContainer = () => {
  dragActive.value = false;
};

const promptFileDialog = () => {
  fileInput.value?.click();
};

const onFileInputChanged = async (event: Event) => {
  const input = event.target as HTMLInputElement;

  if (input.files?.length) {
    await openCellmlFiles(input.files);
  }

  input.value = "";
};

const closeTab = (tabId: string) => {
  const currentIndex = tabs.value.findIndex((tab) => tab.id === tabId);

  if (currentIndex < 0) {
    return;
  }

  tabs.value.splice(currentIndex, 1);

  if (activeTabId.value === tabId) {
    const fallbackTab = tabs.value[Math.max(currentIndex - 1, 0)] ?? tabs.value[0] ?? null;
    activeTabId.value = fallbackTab?.id ?? null;
  }

  if (!tabs.value.length) {
    boundEditorTabId = null;
  }

  updateStatusFromTabs();
};

const switchSubview = (view: EditorSubview) => {
  if (!activeTab.value) {
    return;
  }

  activeTab.value.activeSubview = view;
};

const ensureMonacoEditor = async () => {
  if (monacoEditor || !xmlEditorHost.value) {
    return;
  }

  const monaco = await loader.init();

  monaco.editor.defineTheme("cellmlforge-theme", monacoTheme as any);

  monacoEditor = monaco.editor.create(xmlEditorHost.value, {
    value: "",
    language: "xml",
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    lineHeight: 22,
    wordWrap: "on",
    scrollBeyondLastLine: false,
    theme: "cellmlforge-theme",
    tabSize: 2,
  }) as unknown as MonacoEditor;

  monacoSubscription = monacoEditor.onDidChangeModelContent(() => {
    if (syncingEditorFromModel || !activeTab.value || !monacoEditor) {
      return;
    }

    activeTab.value.xml = monacoEditor.getValue();
    activeTab.value.mathReadable = buildMathReadable(activeTab.value.xml);
    activeTab.value.validationMessage = validateWithLibCellml(activeTab.value.xml);
  });
};

const syncEditorWithActiveTab = async () => {
  const tab = activeTab.value;

  if (!tab || tab.activeSubview !== "xml") {
    return;
  }

  await ensureMonacoEditor();

  if (!monacoEditor) {
    return;
  }

  if (boundEditorTabId !== tab.id || monacoEditor.getValue() !== tab.xml) {
    syncingEditorFromModel = true;
    monacoEditor.setValue(tab.xml);
    syncingEditorFromModel = false;
    boundEditorTabId = tab.id;
  }

  monacoEditor.layout();
};

const onWindowResize = () => {
  monacoEditor?.layout();
};

watch(
  () => [activeTabId.value, activeTab.value?.activeSubview],
  async () => {
    await nextTick();
    await syncEditorWithActiveTab();
  },
  { immediate: true }
);

onMounted(async () => {
  window.addEventListener("resize", onWindowResize);
  await ensureLibCellml();
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", onWindowResize);
  monacoSubscription?.dispose();
  monacoEditor?.dispose();
});
</script>

<template>
  <div class="page-shell" @drop="onDropContainer" @dragover="onDragOverContainer" @dragleave="onDragLeaveContainer">
    <header class="app-banner">
      <div class="brand-wrap">
        <img src="/branding/cellmlforge-logo.png" alt="CellMLForge logo" class="brand-logo" />
        <div class="brand-copy">
          <h1>CellMLForge Editor</h1>
          <p>Single-page CellML editing workspace for GitHub Pages hosting.</p>
        </div>
      </div>
      <div class="banner-status">
        <p class="status-pill" :class="`state-${libCellmlState}`">libCellML.js: {{ libCellmlState }}</p>
        <p v-if="libCellmlError" class="status-detail">{{ libCellmlError }}</p>
        <button class="upload-button" type="button" @click="promptFileDialog">Open .cellml file</button>
      </div>
    </header>

    <main class="editor-stage" :class="{ 'is-dragging': dragActive }">
      <input ref="fileInput" type="file" accept=".cellml,text/xml,application/xml" multiple class="hidden-input" @change="onFileInputChanged" />

      <section class="tabs-area">
        <div class="tab-strip" role="tablist" aria-label="Model tabs">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            class="top-tab"
            :class="{ active: tab.id === activeTabId }"
            type="button"
            @click="activeTabId = tab.id"
          >
            <span>{{ tab.name }}</span>
            <span class="tab-close" title="Close tab" @click.stop="closeTab(tab.id)">x</span>
          </button>
        </div>

        <div v-if="activeTab" class="tab-content-frame">
          <nav class="subview-nav" aria-label="Editor views">
            <button
              class="subview-button"
              :class="{ active: activeTab.activeSubview === 'xml' }"
              @click="switchSubview('xml')"
              type="button"
            >
              Raw XML
            </button>
            <button
              class="subview-button"
              :class="{ active: activeTab.activeSubview === 'simulation' }"
              @click="switchSubview('simulation')"
              type="button"
            >
              Simulation Setup
            </button>
            <button
              class="subview-button"
              :class="{ active: activeTab.activeSubview === 'math' }"
              @click="switchSubview('math')"
              type="button"
            >
              Math View
            </button>
          </nav>

          <section class="subview-body">
            <div v-show="activeTab.activeSubview === 'xml'" class="xml-editor-pane">
              <div ref="xmlEditorHost" class="monaco-host"></div>
            </div>

            <div v-show="activeTab.activeSubview === 'simulation'" class="simulation-pane">
              <h2>Simulation Experiment Configuration</h2>
              <p>These settings are lightweight metadata for the experiment intent of the current model.</p>
              <div class="grid-form">
                <label>
                  Start time
                  <input v-model.number="activeTab.simulation.startTime" type="number" step="0.01" />
                </label>
                <label>
                  End time
                  <input v-model.number="activeTab.simulation.endTime" type="number" step="0.01" />
                </label>
                <label>
                  Step size
                  <input v-model.number="activeTab.simulation.stepSize" type="number" step="0.001" min="0.000001" />
                </label>
                <label>
                  Method
                  <select v-model="activeTab.simulation.method">
                    <option value="euler">Euler</option>
                    <option value="rk4">RK4</option>
                  </select>
                </label>
                <label>
                  Absolute tolerance
                  <input v-model.number="activeTab.simulation.absoluteTolerance" type="number" step="0.00000001" min="0" />
                </label>
                <label>
                  Relative tolerance
                  <input v-model.number="activeTab.simulation.relativeTolerance" type="number" step="0.00000001" min="0" />
                </label>
              </div>
              <pre class="sim-preview">{{ JSON.stringify(activeTab.simulation, null, 2) }}</pre>
            </div>

            <div v-show="activeTab.activeSubview === 'math'" class="math-pane">
              <h2>Human-Readable Mathematics</h2>
              <p>
                Mathematical blocks are extracted from MathML and rendered into a concise readable form to support quick
                model review.
              </p>
              <pre class="math-readable">{{ activeTab.mathReadable.join('\n') }}</pre>
            </div>
          </section>

          <aside class="validation-panel">
            <h3>libCellML Parser Notes</h3>
            <pre>{{ activeTab.validationMessage }}</pre>
          </aside>
        </div>

        <div v-else class="empty-state">
          <img src="/branding/compact-mark.png" alt="CellMLForge compact mark" />
          <h2>Drop a CellML model to begin</h2>
          <p>Each dropped file opens in its own tab, with XML, simulation, and math views ready for editing.</p>
        </div>
      </section>
    </main>

    <footer class="app-footer">
      <p>{{ statusMessage }}</p>
      <p>Tip: drag one or more .cellml files directly onto this page.</p>
    </footer>
  </div>
</template>
