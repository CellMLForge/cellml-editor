<script setup lang="ts">
import loader from "@monaco-editor/loader";
import libCellMLModule from "libcellml.js";
import libCellMLWasmUrl from "libcellml.js/libcellml.wasm?url";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

type EditorSubview = "xml" | "simulation";

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
  validationMessage: string;
}

interface MonacoPosition {
  lineNumber: number;
  column: number;
}

interface Disposable {
  dispose: () => void;
}

interface MonacoEditor {
  layout: () => void;
  getValue: () => string;
  setValue: (value: string) => void;
  getPosition: () => MonacoPosition | null;
  dispose: () => void;
  updateOptions: (options: Record<string, unknown>) => void;
  onDidChangeModelContent: (listener: () => void) => Disposable;
  onDidChangeCursorPosition: (listener: (event: { position: MonacoPosition }) => void) => Disposable;
}

interface MathPreview {
  statusMessage: string;
  rawApply: string | null;
  presentationMathMl: string | null;
}

const ISSUE_TRACKER_URL = "https://github.com/CellMLForge/cellml-editor/issues/new/choose";
const PREVIEW_WIDTH_STORAGE_KEY = "cellmlforge.equation-preview-width";

const tabs = ref<ModelTab[]>([]);
const activeTabId = ref<string | null>(null);
const dragActive = ref(false);
const statusMessage = ref("Drop CellML files here to open them in tabs.");

const fileInput = ref<HTMLInputElement | null>(null);
const xmlEditorHost = ref<HTMLElement | null>(null);
const subviewBody = ref<HTMLElement | null>(null);
const xmlEditorPane = ref<HTMLElement | null>(null);

const libCellmlState = ref<"idle" | "loading" | "ready" | "error">("idle");
const libCellmlError = ref<string | null>(null);
const libCellmlApi = ref<any>(null);
const libCellmlVersion = ref<string | null>(null);
const mathPreview = ref<MathPreview>({
  statusMessage: "Move the cursor inside a MathML apply element to preview an equation.",
  rawApply: null,
  presentationMathMl: null,
});
const equationPreviewWidth = ref(360);
const resizingPreview = ref(false);
const exportingXml = ref(false);
const exportingCellml2 = ref(false);

const activeTab = computed(() => tabs.value.find((tab) => tab.id === activeTabId.value) ?? null);
const libCellmlTooltipText = computed(() => {
  const details: string[] = [];

  if (libCellmlVersion.value) {
    details.push(`libCellML version: ${libCellmlVersion.value}`);
  }

  details.push(`State: ${libCellmlState.value}`);

  if (libCellmlError.value) {
    details.push(`Error: ${libCellmlError.value}`);
  }

  return details.join("\n");
});

let monacoEditor: MonacoEditor | null = null;
let monacoSubscription: Disposable | null = null;
let monacoCursorSubscription: Disposable | null = null;
let boundEditorTabId: string | null = null;
let syncingEditorFromModel = false;
let creatingMonacoEditorPromise: Promise<void> | null = null;
let resizeStartX = 0;
let resizeStartWidth = 0;

const resetMonacoEditor = () => {
  monacoSubscription?.dispose();
  monacoSubscription = null;
  monacoCursorSubscription?.dispose();
  monacoCursorSubscription = null;
  monacoEditor?.dispose();
  monacoEditor = null;
  boundEditorTabId = null;
};

const MATHML_NAMESPACE = "http://www.w3.org/1998/Math/MathML";
const GREEK_SYMBOL_BY_NAME: Record<string, string> = {
  alpha: "\u03b1",
  beta: "\u03b2",
  gamma: "\u03b3",
  delta: "\u03b4",
  epsilon: "\u03b5",
  varepsilon: "\u03f5",
  zeta: "\u03b6",
  eta: "\u03b7",
  theta: "\u03b8",
  vartheta: "\u03d1",
  iota: "\u03b9",
  kappa: "\u03ba",
  lambda: "\u03bb",
  mu: "\u03bc",
  nu: "\u03bd",
  xi: "\u03be",
  pi: "\u03c0",
  varpi: "\u03d6",
  rho: "\u03c1",
  varrho: "\u03f1",
  sigma: "\u03c3",
  varsigma: "\u03c2",
  tau: "\u03c4",
  upsilon: "\u03c5",
  phi: "\u03c6",
  varphi: "\u03d5",
  chi: "\u03c7",
  psi: "\u03c8",
  omega: "\u03c9",
  alpha_upper: "\u0391",
  beta_upper: "\u0392",
  gamma_upper: "\u0393",
  delta_upper: "\u0394",
  epsilon_upper: "\u0395",
  zeta_upper: "\u0396",
  eta_upper: "\u0397",
  theta_upper: "\u0398",
  iota_upper: "\u0399",
  kappa_upper: "\u039a",
  lambda_upper: "\u039b",
  mu_upper: "\u039c",
  nu_upper: "\u039d",
  xi_upper: "\u039e",
  omicron_upper: "\u039f",
  pi_upper: "\u03a0",
  rho_upper: "\u03a1",
  sigma_upper: "\u03a3",
  tau_upper: "\u03a4",
  upsilon_upper: "\u03a5",
  phi_upper: "\u03a6",
  chi_upper: "\u03a7",
  psi_upper: "\u03a8",
  omega_upper: "\u03a9",
};

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

    const versionGetter = libCellmlApi.value?.versionString;
    libCellmlVersion.value =
      typeof versionGetter === "function" ? String(versionGetter.call(libCellmlApi.value)) : null;

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

    // Use non-strict parsing to support CellML 1.0/1.1 inputs.
    const parser = new parserCtor(false);

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

const getLocalTagName = (name: string) => {
  const parts = name.split(":");
  return parts[parts.length - 1]?.toLowerCase() ?? "";
};

const offsetFromPosition = (text: string, position: MonacoPosition) => {
  let offset = 0;
  let currentLine = 1;

  while (currentLine < position.lineNumber && offset < text.length) {
    const nextLineBreak = text.indexOf("\n", offset);
    if (nextLineBreak < 0) {
      offset = text.length;
      break;
    }
    offset = nextLineBreak + 1;
    currentLine += 1;
  }

  return Math.min(offset + Math.max(position.column - 1, 0), text.length);
};

const findMatchingTagEnd = (text: string, startIndex: number, localTagName: string) => {
  const tagPattern = /<\/?([a-zA-Z_][\w.-]*:)?([a-zA-Z_][\w.-]*)\b[^>]*>/g;
  tagPattern.lastIndex = startIndex;

  let depth = 0;
  let started = false;

  for (;;) {
    const match = tagPattern.exec(text);
    if (!match) {
      return -1;
    }

    const fullTag = match[0];
    const isClosingTag = fullTag.startsWith("</");
    const isSelfClosingTag = fullTag.endsWith("/>");
    const matchedLocalName = getLocalTagName(match[2] ?? "");

    if (matchedLocalName !== localTagName) {
      continue;
    }

    if (!isClosingTag) {
      depth += 1;
      started = true;

      if (isSelfClosingTag) {
        depth -= 1;
      }
    } else {
      depth -= 1;
    }

    if (started && depth === 0) {
      return match.index + fullTag.length;
    }
  }
};

const findEnclosingTagRange = (text: string, targetOffset: number, localTagName: string) => {
  const openTagPattern = new RegExp(`<([a-zA-Z_][\\w.-]*:)?${localTagName}\\b[^>]*>`, "gi");
  const candidateStarts: number[] = [];

  for (;;) {
    const match = openTagPattern.exec(text);
    if (!match || match.index > targetOffset) {
      break;
    }

    if (!match[0].endsWith("/>") && match.index <= targetOffset) {
      candidateStarts.push(match.index);
    }
  }

  for (let index = candidateStarts.length - 1; index >= 0; index -= 1) {
    const start = candidateStarts[index];
    if (start === undefined) {
      continue;
    }

    const end = findMatchingTagEnd(text, start, localTagName);
    if (end > start && targetOffset <= end) {
      return { start, end };
    }
  }

  return null;
};

const findDirectChildApplyRanges = (mathSource: string) => {
  const tagPattern = /<\/?([a-zA-Z_][\w.-]*:)?([a-zA-Z_][\w.-]*)\b[^>]*>/g;
  const ranges: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let foundMathRoot = false;

  for (;;) {
    const match = tagPattern.exec(mathSource);
    if (!match) {
      break;
    }

    const fullTag = match[0];
    const localName = getLocalTagName(match[2] ?? "");
    const isClosingTag = fullTag.startsWith("</");
    const isSelfClosingTag = fullTag.endsWith("/>");

    if (!foundMathRoot && !isClosingTag && localName === "math") {
      foundMathRoot = true;
      depth = isSelfClosingTag ? 0 : 1;
      continue;
    }

    if (!foundMathRoot) {
      continue;
    }

    if (!isClosingTag) {
      if (localName === "apply" && depth === 1 && !isSelfClosingTag) {
        const end = findMatchingTagEnd(mathSource, match.index, "apply");
        if (end > match.index) {
          ranges.push({ start: match.index, end });
        }
      }

      if (!isSelfClosingTag) {
        depth += 1;
      }
    } else {
      depth = Math.max(depth - 1, 0);
      if (localName === "math" && depth === 0) {
        break;
      }
    }
  }

  return ranges;
};

const createMathElement = (doc: XMLDocument, name: string, text?: string) => {
  const element = doc.createElementNS(MATHML_NAMESPACE, name);
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
};

const wrapWithParentheses = (doc: XMLDocument, content: Element) => {
  const row = createMathElement(doc, "mrow");
  row.appendChild(createMathElement(doc, "mo", "("));
  row.appendChild(content);
  row.appendChild(createMathElement(doc, "mo", ")"));
  return row;
};

const mapIdentifierToPresentationSymbol = (identifier: string) => {
  const trimmed = identifier.trim();
  if (!trimmed) {
    return trimmed;
  }

  const lower = trimmed.toLowerCase();
  if (GREEK_SYMBOL_BY_NAME[lower]) {
    return GREEK_SYMBOL_BY_NAME[lower] ?? trimmed;
  }

  const firstUpper = trimmed[0] === trimmed[0]?.toUpperCase() && trimmed[0] !== trimmed[0]?.toLowerCase();
  if (firstUpper) {
    const key = `${lower}_upper`;
    if (GREEK_SYMBOL_BY_NAME[key]) {
      return GREEK_SYMBOL_BY_NAME[key] ?? trimmed;
    }
  }

  return trimmed;
};

const getApplyOperatorName = (applyNode: Element) => {
  const firstChild = applyNode.children[0];
  if (!firstChild) {
    return "";
  }
  return getLocalTagName(firstChild.tagName);
};

const getOperatorPrecedence = (operator: string) => {
  if (["eq", "lt", "gt", "leq", "geq"].includes(operator)) {
    return 0;
  }
  if (["plus", "minus"].includes(operator)) {
    return 1;
  }
  if (["times", "divide"].includes(operator)) {
    return 2;
  }
  if (["power"].includes(operator)) {
    return 3;
  }
  if (["diff"].includes(operator)) {
    return 4;
  }
  return 5;
};

const renderOperandForOperator = (
  doc: XMLDocument,
  operand: Element,
  parentOperator: string,
  position: "left" | "right" | "middle"
) => {
  const rendered = convertContentNodeToPresentation(doc, operand);

  if (getLocalTagName(operand.tagName) !== "apply") {
    return rendered;
  }

  const childOperator = getApplyOperatorName(operand);
  const childPrecedence = getOperatorPrecedence(childOperator);
  const parentPrecedence = getOperatorPrecedence(parentOperator);

  let needsParentheses = childPrecedence < parentPrecedence;

  if (parentOperator === "divide" && position === "right") {
    needsParentheses = childPrecedence <= parentPrecedence;
  }

  if (parentOperator === "minus" && position === "right") {
    needsParentheses = childPrecedence <= parentPrecedence;
  }

  if (parentOperator === "power" && position === "left") {
    needsParentheses = childPrecedence <= 2;
  }

  if (parentOperator === "power" && position === "right") {
    needsParentheses = childPrecedence <= parentPrecedence;
  }

  return needsParentheses ? wrapWithParentheses(doc, rendered) : rendered;
};

const buildInfixRow = (doc: XMLDocument, operands: Element[], symbol: string) => {
  const operatorNameBySymbol: Record<string, string> = {
    "+": "plus",
    "-": "minus",
    "·": "times",
    "=": "eq",
    "<": "lt",
    ">": "gt",
    "<=": "leq",
    ">=": "geq",
    "∧": "and",
    "∨": "or",
    "⊕": "xor",
    "≠": "neq",
  };
  const parentOperator = operatorNameBySymbol[symbol] ?? "";
  const row = createMathElement(doc, "mrow");
  operands.forEach((operand, index) => {
    if (index > 0) {
      row.appendChild(createMathElement(doc, "mo", symbol));
    }
    const position = index === 0 ? "left" : "right";
    row.appendChild(renderOperandForOperator(doc, operand, parentOperator, position));
  });
  return row;
};

const createTextElement = (doc: XMLDocument, text: string, style?: string) => {
  const element = createMathElement(doc, "mtext", text);
  if (style) {
    element.setAttribute("fontstyle", style);
  }
  return element;
};

const createMathSpace = (doc: XMLDocument, width = "0.45em") => {
  const element = createMathElement(doc, "mspace");
  element.setAttribute("width", width);
  return element;
};

const buildFunctionCallRow = (doc: XMLDocument, operands: Element[], functionName: string) => {
  const row = createMathElement(doc, "mrow");
  row.appendChild(createTextElement(doc, functionName));
  row.appendChild(createMathElement(doc, "mo", "("));
  operands.forEach((operand, index) => {
    if (index > 0) {
      row.appendChild(createMathElement(doc, "mo", ","));
    }
    row.appendChild(renderOperandForOperator(doc, operand, functionName, "middle"));
  });
  row.appendChild(createMathElement(doc, "mo", ")"));
  return row;
};

const buildWrappedRow = (doc: XMLDocument, operand: Element | null, leftSymbol: string, rightSymbol: string) => {
  const row = createMathElement(doc, "mrow");
  row.appendChild(createMathElement(doc, "mo", leftSymbol));
  if (operand) {
    row.appendChild(renderOperandForOperator(doc, operand, "abs", "middle"));
  }
  row.appendChild(createMathElement(doc, "mo", rightSymbol));
  return row;
};

const convertPiecewiseToPresentation = (doc: XMLDocument, piecewiseNode: Element): Element => {
  const rows: Element[] = [];

  Array.from(piecewiseNode.children).forEach((child) => {
    const localName = getLocalTagName(child.tagName);

    if (localName === "piece") {
      const condition = child.children[0];
      const value = child.children[1];
      const row = createMathElement(doc, "mrow");
      if (condition) {
        row.appendChild(convertContentNodeToPresentation(doc, condition));
      }
      row.appendChild(createMathSpace(doc, "0.35em"));
      row.appendChild(createTextElement(doc, "if"));
      row.appendChild(createMathSpace(doc, "0.35em"));
      if (value) {
        row.appendChild(convertContentNodeToPresentation(doc, value));
      }
      rows.push(row);
    } else if (localName === "otherwise") {
      const value = child.children[0];
      const row = createMathElement(doc, "mrow");
      if (value) {
        row.appendChild(convertContentNodeToPresentation(doc, value));
      }
      row.appendChild(createMathSpace(doc, "0.35em"));
      row.appendChild(createTextElement(doc, "otherwise"));
      rows.push(row);
    }
  });

  if (!rows.length) {
    return createMathElement(doc, "mtext", "piecewise expression");
  }

  const container = createMathElement(doc, "mrow");
  const brace = createMathElement(doc, "mo", "{");
  brace.setAttribute("stretchy", "true");
  brace.setAttribute("fence", "true");
  container.appendChild(brace);

  const table = createMathElement(doc, "mtable");
  table.setAttribute("columnalign", "left");
  table.setAttribute("rowspacing", "0.35em");

  rows.forEach((row) => {
    const tableRow = createMathElement(doc, "mtr");
    const tableCell = createMathElement(doc, "mtd");
    tableCell.appendChild(row);
    tableRow.appendChild(tableCell);
    table.appendChild(tableRow);
  });

  container.appendChild(table);
  return container;
};

const convertApplyToPresentation = (doc: XMLDocument, applyNode: Element): Element => {
  const children = Array.from(applyNode.children);
  if (!children.length) {
    return createMathElement(doc, "mrow");
  }

  const operator = getLocalTagName(children[0]?.tagName ?? "");
  const operands = children.slice(1);

  if (operator === "plus") {
    return buildInfixRow(doc, operands, "+");
  }

  if (operator === "minus") {
    if (operands.length === 1 && operands[0]) {
      const row = createMathElement(doc, "mrow");
      row.appendChild(createMathElement(doc, "mo", "-"));
      row.appendChild(renderOperandForOperator(doc, operands[0], "minus", "right"));
      return row;
    }
    return buildInfixRow(doc, operands, "-");
  }

  if (operator === "times") {
    return buildInfixRow(doc, operands, "·");
  }

  if (operator === "divide" && operands[0] && operands[1]) {
    const frac = createMathElement(doc, "mfrac");
    frac.appendChild(renderOperandForOperator(doc, operands[0], "divide", "left"));
    frac.appendChild(renderOperandForOperator(doc, operands[1], "divide", "right"));
    return frac;
  }

  if (["and", "or", "xor"].includes(operator)) {
    const symbolByOperator: Record<string, string> = {
      and: "∧",
      or: "∨",
      xor: "⊕",
    };
    return buildInfixRow(doc, operands, symbolByOperator[operator] ?? "∧");
  }

  if (operator === "not") {
    const row = createMathElement(doc, "mrow");
    row.appendChild(createMathElement(doc, "mo", "¬"));
    if (operands[0]) {
      row.appendChild(renderOperandForOperator(doc, operands[0], "not", "right"));
    }
    return row;
  }

  if (operator === "neq") {
    return buildInfixRow(doc, operands, "≠");
  }

  if (operator === "abs" && operands[0]) {
    return buildWrappedRow(doc, operands[0], "|", "|");
  }

  if (operator === "floor" && operands[0]) {
    return buildWrappedRow(doc, operands[0], "⌊", "⌋");
  }

  if (operator === "ceiling" && operands[0]) {
    return buildWrappedRow(doc, operands[0], "⌈", "⌉");
  }

  if (operator === "power" && operands[0] && operands[1]) {
    const sup = createMathElement(doc, "msup");
    sup.appendChild(renderOperandForOperator(doc, operands[0], "power", "left"));
    sup.appendChild(renderOperandForOperator(doc, operands[1], "power", "right"));
    return sup;
  }

  if (["eq", "lt", "gt", "leq", "geq"].includes(operator)) {
    const symbolByOperator: Record<string, string> = {
      eq: "=",
      lt: "<",
      gt: ">",
      leq: "≤",
      geq: "≥",
    };
    return buildInfixRow(doc, operands, symbolByOperator[operator] ?? "=");
  }

  if (["sin", "cos", "tan", "sinh", "cosh", "tanh", "exp", "log", "ln", "min", "max"].includes(operator)) {
    return buildFunctionCallRow(doc, operands, operator);
  }

  if (operator === "root") {
    const radicand = operands.find((operand) => getLocalTagName(operand.tagName) !== "degree") ?? operands[0];
    const degree = operands.find((operand) => getLocalTagName(operand.tagName) === "degree");

    if (radicand && degree) {
      const root = createMathElement(doc, "mroot");
      root.appendChild(renderOperandForOperator(doc, radicand, "root", "middle"));
      root.appendChild(convertContentNodeToPresentation(doc, degree));
      return root;
    }

    if (radicand) {
      const root = createMathElement(doc, "msqrt");
      root.appendChild(renderOperandForOperator(doc, radicand, "root", "middle"));
      return root;
    }
  }

  if (operator === "diff") {
    const row = createMathElement(doc, "mrow");
    const withRespectTo =
      children.find((child) => getLocalTagName(child.tagName) === "bvar")?.querySelector("ci")?.textContent?.trim() ??
      "t";
    const targetOperand =
      children.find((child, index) => index > 0 && getLocalTagName(child.tagName) !== "bvar") ?? operands[0];

    const numerator = createMathElement(doc, "mrow");
    numerator.appendChild(createMathElement(doc, "mo", "d"));
    if (targetOperand) {
      numerator.appendChild(renderOperandForOperator(doc, targetOperand, "diff", "right"));
    }

    const denominator = createMathElement(doc, "mrow");
    denominator.appendChild(createMathElement(doc, "mo", "d"));
    denominator.appendChild(createMathElement(doc, "mi", withRespectTo));

    const frac = createMathElement(doc, "mfrac");
    frac.appendChild(numerator);
    frac.appendChild(denominator);
    row.appendChild(frac);
    return row;
  }

  const fallback = createMathElement(doc, "mrow");
  fallback.appendChild(createMathElement(doc, "mi", operator || "f"));
  fallback.appendChild(createMathElement(doc, "mo", "("));
  operands.forEach((operand, index) => {
    if (index > 0) {
      fallback.appendChild(createMathElement(doc, "mo", ","));
    }
    fallback.appendChild(renderOperandForOperator(doc, operand, operator || "", "middle"));
  });
  fallback.appendChild(createMathElement(doc, "mo", ")"));
  return fallback;
};

const convertContentNodeToPresentation = (doc: XMLDocument, node: Element): Element => {
  const localName = getLocalTagName(node.tagName);

  if (localName === "ci") {
    const identifier = mapIdentifierToPresentationSymbol((node.textContent ?? "").trim());
    const element = createMathElement(doc, "mi", identifier);
    element.setAttribute("class", "math-identifier");
    return element;
  }

  if (localName === "cn") {
    // CellML often carries a units attribute on cn; preview intentionally ignores units for now.
    return createMathElement(doc, "mn", (node.textContent ?? "").trim());
  }

  if (localName === "apply") {
    return convertApplyToPresentation(doc, node);
  }

  if (localName === "piecewise") {
    return convertPiecewiseToPresentation(doc, node);
  }

  const children = Array.from(node.children);
  if (!children.length) {
    return createMathElement(doc, "mi", (node.textContent ?? "").trim());
  }

  const row = createMathElement(doc, "mrow");
  children.forEach((child) => row.appendChild(convertContentNodeToPresentation(doc, child)));
  return row;
};

const convertContentApplyToPresentationMathMl = (applyXml: string) => {
  const parser = new DOMParser();
  // Strip units attributes (e.g. cellml:units) so preview parsing does not depend on CellML namespace declarations.
  const sanitizedApplyXml = applyXml.replace(/\s+[a-zA-Z_][\w.-]*:units\s*=\s*"[^"]*"/g, "");
  const wrappedSource = `<math xmlns="${MATHML_NAMESPACE}">${sanitizedApplyXml}</math>`;
  const parsedDoc = parser.parseFromString(wrappedSource, "application/xml");

  if (parsedDoc.querySelector("parsererror")) {
    return null;
  }

  const applyNode = Array.from(parsedDoc.documentElement.children).find(
    (child) => getLocalTagName(child.tagName) === "apply"
  );
  if (!applyNode) {
    return null;
  }

  const outputDoc = document.implementation.createDocument(MATHML_NAMESPACE, "math", null);
  const mathRoot = outputDoc.documentElement;
  mathRoot.setAttribute("display", "block");
  mathRoot.appendChild(convertContentNodeToPresentation(outputDoc, applyNode));

  return new XMLSerializer().serializeToString(mathRoot);
};

const updateMathPreviewForCursor = (position?: MonacoPosition | null) => {
  if (!monacoEditor) {
    return;
  }

  const xml = monacoEditor.getValue();
  const cursor = position ?? monacoEditor.getPosition();

  if (!cursor) {
    mathPreview.value = {
      statusMessage: "Cursor position unavailable.",
      rawApply: null,
      presentationMathMl: null,
    };
    return;
  }

  const cursorOffset = offsetFromPosition(xml, cursor);
  const mathRange = findEnclosingTagRange(xml, cursorOffset, "math");

  if (!mathRange || cursorOffset < mathRange.start || cursorOffset > mathRange.end) {
    mathPreview.value = {
      statusMessage: "Cursor is not inside a MathML <math> element.",
      rawApply: null,
      presentationMathMl: null,
    };
    return;
  }

  const mathSource = xml.slice(mathRange.start, mathRange.end);
  const relativeCursorOffset = cursorOffset - mathRange.start;
  const directChildApplyRanges = findDirectChildApplyRanges(mathSource);
  const applyRangeInMath = directChildApplyRanges.find(
    (range) => relativeCursorOffset >= range.start && relativeCursorOffset <= range.end
  );

  if (!applyRangeInMath) {
    mathPreview.value = {
      statusMessage:
        "Cursor is inside <math>, but not within an equation apply that is a direct child of that math element.",
      rawApply: null,
      presentationMathMl: null,
    };
    return;
  }

  const applyXml = mathSource.slice(applyRangeInMath.start, applyRangeInMath.end);
  const presentationMathMl = convertContentApplyToPresentationMathMl(applyXml);

  if (!presentationMathMl) {
    mathPreview.value = {
      statusMessage: "Could not convert this equation to presentation MathML.",
      rawApply: applyXml,
      presentationMathMl: null,
    };
    return;
  }

  mathPreview.value = {
    statusMessage: "Live preview of the selected MathML equation.",
    rawApply: applyXml,
    presentationMathMl,
  };
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const persistPreviewWidth = (width: number) => {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(PREVIEW_WIDTH_STORAGE_KEY, `${width}`);
};

const onPreviewResizeMove = (event: MouseEvent) => {
  if (!resizingPreview.value || !xmlEditorPane.value) {
    return;
  }

  const deltaX = event.clientX - resizeStartX;
  const minPreviewWidth = 220;
  const minEditorWidth = 320;
  const gutterWidth = 12;
  const maxPreviewWidth = Math.max(
    minPreviewWidth,
    xmlEditorPane.value.clientWidth - minEditorWidth - gutterWidth
  );

  equationPreviewWidth.value = clamp(resizeStartWidth - deltaX, minPreviewWidth, maxPreviewWidth);
  persistPreviewWidth(equationPreviewWidth.value);
  monacoEditor?.layout();
};

const stopPreviewResize = () => {
  if (!resizingPreview.value) {
    return;
  }

  persistPreviewWidth(equationPreviewWidth.value);
  resizingPreview.value = false;
  window.removeEventListener("mousemove", onPreviewResizeMove);
  window.removeEventListener("mouseup", stopPreviewResize);
};

const startPreviewResize = (event: MouseEvent) => {
  if (!xmlEditorPane.value) {
    return;
  }

  event.preventDefault();
  resizingPreview.value = true;
  resizeStartX = event.clientX;
  resizeStartWidth = equationPreviewWidth.value;

  window.addEventListener("mousemove", onPreviewResizeMove);
  window.addEventListener("mouseup", stopPreviewResize);
};

const getActiveXmlText = () => {
  if (!activeTab.value) {
    return null;
  }

  if (
    monacoEditor &&
    activeTab.value.activeSubview === "xml" &&
    boundEditorTabId === activeTab.value.id
  ) {
    return monacoEditor.getValue();
  }

  return activeTab.value.xml;
};

const toSafeCellmlFileName = (name: string, suffix = "") => {
  const trimmed = name.trim() || "model";

  if (/\.cellml$/i.test(trimmed)) {
    return trimmed.replace(/\.cellml$/i, `${suffix}.cellml`);
  }

  return `${trimmed}${suffix}.cellml`;
};

const downloadTextFile = (content: string, fileName: string) => {
  const blob = new Blob([content], { type: "application/xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};

const toCellml2Xml = async (xmlSource: string) => {
  if (libCellmlState.value !== "ready") {
    await ensureLibCellml();
  }

  const parserCtor = libCellmlApi.value?.Parser;
  const printerCtor = libCellmlApi.value?.Printer;

  if (typeof parserCtor !== "function" || typeof printerCtor !== "function") {
    throw new Error("libCellML parser/printer APIs are not available.");
  }

  const parser = new parserCtor(false);
  const model = parser.parseModel(xmlSource);

  if (!model) {
    throw new Error("libCellML could not parse the model.");
  }

  const printer = new printerCtor();
  // libcellml.js@0.5.0 expects a second boolean argument.
  const printed = String(printer.printModel(model, false) ?? "").trim();

  if (!printed) {
    throw new Error("libCellML returned an empty CellML 2 serialization.");
  }

  return {
    xml: printed,
    issueCount: typeof parser.issueCount === "function" ? Number(parser.issueCount()) : 0,
  };
};

const exportRawXml = () => {
  if (!activeTab.value || exportingXml.value) {
    return;
  }

  const xmlSource = getActiveXmlText();
  if (!xmlSource) {
    statusMessage.value = "No active model to export.";
    return;
  }

  exportingXml.value = true;
  try {
    downloadTextFile(xmlSource, toSafeCellmlFileName(activeTab.value.name, "-raw"));
    statusMessage.value = "Exported current XML.";
  } finally {
    exportingXml.value = false;
  }
};

const exportCellml2Xml = async () => {
  if (!activeTab.value || exportingCellml2.value) {
    return;
  }

  const xmlSource = getActiveXmlText();
  if (!xmlSource) {
    statusMessage.value = "No active model to export.";
    return;
  }

  exportingCellml2.value = true;
  try {
    const result = await toCellml2Xml(xmlSource);
    downloadTextFile(result.xml, toSafeCellmlFileName(activeTab.value.name, "-cellml2"));
    statusMessage.value =
      result.issueCount > 0
        ? `Exported CellML 2 with ${result.issueCount} parser issue${result.issueCount === 1 ? "" : "s"}.`
        : "Exported CellML 2 model.";
  } catch (error) {
    statusMessage.value = `CellML 2 export failed: ${String(error)}`;
  } finally {
    exportingCellml2.value = false;
  }
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
    resetMonacoEditor();
    mathPreview.value = {
      statusMessage: "Move the cursor inside a MathML apply element to preview an equation.",
      rawApply: null,
      presentationMathMl: null,
    };
  }

  updateStatusFromTabs();
};

const switchSubview = (view: EditorSubview) => {
  if (!activeTab.value) {
    return;
  }

  activeTab.value.activeSubview = view;
  if (subviewBody.value) {
    subviewBody.value.scrollTop = 0;
  }
};

const ensureMonacoEditor = async () => {
  if (monacoEditor || !xmlEditorHost.value) {
    return;
  }

  if (creatingMonacoEditorPromise) {
    await creatingMonacoEditorPromise;
    return;
  }

  creatingMonacoEditorPromise = (async () => {
    const monaco = await loader.init();

    monaco.editor.defineTheme("cellmlforge-theme", monacoTheme as any);

    const host = xmlEditorHost.value;
    if (!host) {
      return;
    }

    // Defensive clear avoids stacked editor DOM if a stale instance was left behind.
    host.replaceChildren();

    monacoEditor = monaco.editor.create(host, {
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
      activeTab.value.validationMessage = validateWithLibCellml(activeTab.value.xml);
      updateMathPreviewForCursor(monacoEditor.getPosition());
    });

    monacoCursorSubscription = monacoEditor.onDidChangeCursorPosition((event) => {
      updateMathPreviewForCursor(event.position);
    });
  })();

  try {
    await creatingMonacoEditorPromise;
  } finally {
    creatingMonacoEditorPromise = null;
  }
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

  updateMathPreviewForCursor(monacoEditor.getPosition());
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
  if (typeof window !== "undefined") {
    const storedWidth = Number.parseFloat(window.localStorage.getItem(PREVIEW_WIDTH_STORAGE_KEY) ?? "");
    if (Number.isFinite(storedWidth)) {
      equationPreviewWidth.value = clamp(storedWidth, 220, 900);
    }
  }

  window.addEventListener("resize", onWindowResize);
  await ensureLibCellml();
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", onWindowResize);
  stopPreviewResize();
  resetMonacoEditor();
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
        <div class="status-tooltip-wrap">
          <button
            class="status-pill"
            :class="`state-${libCellmlState}`"
            type="button"
            :title="libCellmlTooltipText"
            aria-label="libCellML runtime details"
          >
            libCellML.js: {{ libCellmlState }}
          </button>
          <div class="status-tooltip" role="tooltip">
            <p v-if="libCellmlVersion">libCellML version: {{ libCellmlVersion }}</p>
            <p v-else>libCellML version unavailable</p>
            <p>State: {{ libCellmlState }}</p>
            <p v-if="libCellmlError">Error: {{ libCellmlError }}</p>
          </div>
        </div>
        <p v-if="libCellmlError" class="status-detail">{{ libCellmlError }}</p>
        <div class="banner-actions">
          <button class="upload-button" type="button" @click="promptFileDialog">Open .cellml file</button>
          <a
            class="issue-button"
            :href="ISSUE_TRACKER_URL"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Report an issue on GitHub"
          >
            Report Issue
          </a>
        </div>
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
            <div class="subview-tabs">
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
            </div>

            <div v-if="activeTab.activeSubview === 'xml'" class="subview-actions">
              <button
                class="icon-save-button primary"
                type="button"
                :disabled="exportingCellml2"
                :title="exportingCellml2 ? 'Preparing CellML 2...' : 'Save as CellML 2'"
                aria-label="Save as CellML 2"
                @click="exportCellml2Xml"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path
                    d="M5 3h11l3 3v15H5V3zm2 2v4h8V5H7zm0 8v6h10v-6H7zm2 1h6v4H9v-4z"
                    fill="currentColor"
                  />
                </svg>
              </button>
              <button
                class="icon-save-button"
                type="button"
                :disabled="exportingXml"
                :title="exportingXml ? 'Exporting XML...' : 'Save current XML'"
                aria-label="Save current XML"
                @click="exportRawXml"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path
                    d="M12 3l5 5h-3v7h-4V8H7l5-5zm-7 14h14v4H5v-4z"
                    fill="currentColor"
                  />
                </svg>
              </button>
            </div>
          </nav>

          <section ref="subviewBody" class="subview-body">
            <div v-show="activeTab.activeSubview === 'xml'" class="xml-workspace">
              <div
                ref="xmlEditorPane"
                class="xml-editor-pane"
                :style="{ '--equation-preview-width': `${equationPreviewWidth}px` }"
              >
                <div ref="xmlEditorHost" class="monaco-host"></div>
                <div
                  class="pane-divider"
                  :class="{ active: resizingPreview }"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize equation preview"
                  @mousedown="startPreviewResize"
                ></div>
                <aside class="equation-preview-pane">
                  <h2>Equation Preview</h2>
                  <p class="equation-status">{{ mathPreview.statusMessage }}</p>
                  <div v-if="mathPreview.presentationMathMl" class="equation-render" v-html="mathPreview.presentationMathMl"></div>
                  <pre v-if="mathPreview.rawApply" class="equation-source">{{ mathPreview.rawApply }}</pre>
                </aside>
              </div>
            </div>

            <div v-show="activeTab.activeSubview === 'simulation'" class="simulation-pane">
              <h2>Simulation Experiment Configuration</h2>
              <p>TODO: create a simple simulation setup interface and include a link to run directly in OpenCOR. There should also be an option to download the generated OMEX archive.</p>
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

          </section>

          <aside class="validation-panel">
            <h3>libCellML Parser Notes</h3>
            <pre>{{ activeTab.validationMessage }}</pre>
          </aside>
        </div>

        <div v-else class="empty-state">
          <img src="/branding/compact-mark.png" alt="CellMLForge compact mark" />
          <h2>Drop a CellML model to begin</h2>
          <p>Each dropped file opens in its own tab, with XML plus live equation preview and simulation views.</p>
        </div>
      </section>
    </main>

    <footer class="app-footer">
      <p>{{ statusMessage }}</p>
      <p>Tip: drag one or more .cellml files directly onto this page.</p>
    </footer>
  </div>
</template>
