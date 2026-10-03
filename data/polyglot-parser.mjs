import Parser from "web-tree-sitter";
import { fileURLToPath } from "node:url";

let ready;
const parsers = new Map();
const languageFiles = {
  python: new URL("./tree-sitter-python.wasm", import.meta.url),
  go: new URL("./tree-sitter-go.wasm", import.meta.url),
};

async function parserFor(language) {
  ready ??= Parser.init();
  await ready;
  let parser = parsers.get(language);
  if (!parser) {
    const grammar = await Parser.Language.load(fileURLToPath(languageFiles[language]));
    parser = new Parser();
    parser.setLanguage(grammar);
    parsers.set(language, parser);
  }
  return parser;
}

function descendants(node, types, result = []) {
  if (types.has(node.type)) result.push(node);
  for (const child of node.children) descendants(child, types, result);
  return result;
}

function pythonImports(rootNode) {
  const imports = [];
  const source = rootNode.text;
  for (const node of descendants(rootNode, new Set(["import_statement", "import_from_statement"]))) {
    const line = node.startPosition.row + 1;
    if (node.type === "import_statement") {
      for (const item of node.namedChildren) {
        const value = item.type === "aliased_import" ? item.childForFieldName("name") : item.type === "dotted_name" ? item : null;
        if (value) imports.push({ specifier: value.text, line, kind: "import", typeOnly: false });
      }
    } else {
      const moduleNode = node.childForFieldName("module_name");
      if (moduleNode?.text) imports.push({ specifier: moduleNode.text, line, kind: "from-import", typeOnly: false });
    }
  }
  for (const match of source.matchAll(/\b(?:__import__|importlib\.import_module)\s*\(\s*(?:(["'])([^"']+)\1)?/g)) {
    const specifier = match[2] ?? "<动态模块导入>";
    if (!imports.some((item) => item.line === source.slice(0, match.index).split("\n").length && item.specifier === specifier)) {
      imports.push({ specifier, line: source.slice(0, match.index).split("\n").length, kind: "dynamic", typeOnly: false });
    }
  }
  const symbols = descendants(rootNode, new Set(["class_definition", "function_definition"]))
    .map((node) => node.childForFieldName("name")?.text)
    .filter(Boolean).slice(0, 200);
  return { imports, symbols };
}

function unquoteGo(value) {
  if (value.startsWith("`") && value.endsWith("`")) return value.slice(1, -1);
  try { return JSON.parse(value); } catch { return value.slice(1, -1); }
}

function goImports(rootNode) {
  const imports = descendants(rootNode, new Set(["import_spec"])).flatMap((node) => {
    const source = node.childForFieldName("path");
    return source ? [{ specifier: unquoteGo(source.text), line: node.startPosition.row + 1, kind: "package", typeOnly: false }] : [];
  });
  const symbols = descendants(rootNode, new Set(["function_declaration", "method_declaration", "type_spec", "const_spec", "var_spec"]))
    .flatMap((node) => {
      const name = node.childForFieldName("name")?.text;
      if (name) return [name];
      return node.children.flatMap((child) => child.type === "identifier" ? [child.text] : []);
    }).slice(0, 200);
  return { imports, symbols };
}

export async function parsePolyglot(source, filePath, language) {
  const parser = await parserFor(language);
  parser.reset();
  const tree = parser.parse(source);
  if (!tree) return { imports: [], symbols: [], diagnostic: "Tree-sitter 未能解析此文件。" };
  try {
    const parsed = language === "python" ? pythonImports(tree.rootNode) : goImports(tree.rootNode);
    return { ...parsed, ...(tree.rootNode.hasError() ? { diagnostic: `${filePath} 包含语法错误；已尽力提取静态引用。` } : {}) };
  } finally { tree.delete(); }
}
