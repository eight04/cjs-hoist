const {traverse} = require("estraverse");
const MagicString = require("magic-string");
const ecmaVariableScope = require("ecma-variable-scope");

function getExportInfo(node) {
  if (node.left.type === "MemberExpression") {
    if (node.left.object.name === "module" && node.left.property.name === "exports") {
      return {
        type: "default",
        left: node.left,
        value: node.right
      };
    }
    if (
      node.left.object.type === "MemberExpression" &&
      node.left.object.object.name === "module" &&
      node.left.object.property.name === "exports"
    ) {
      return {
        type: "named",
        name: node.left.property.name,
        left: node.left,
        value: node.right
      };
    }
    if (node.left.object.name === "exports") {
      return {
        type: "named",
        name: node.left.property.name,
        left: node.left,
        value: node.right
      };
    }
  }
}

function getDynamicImport(node) {
  if (
    node.callee.type !== "MemberExpression" ||
    node.callee.object.name !== "Promise" ||
    node.callee.property.name !== "resolve"
  ) {
    return;
  }
  if (
    node.arguments.length !== 1 ||
    node.arguments[0].type !== "CallExpression"
  ) {
    return;
  }
  const required = getRequireInfo(node.arguments[0]);
  if (required) {
    return {
      start: node.start,
      end: node.end,
      required
    };
  }
}

function getRequireInfo(node) {
  if (
    node.callee.name === "require" &&
    node.arguments.length === 1 &&
    node.arguments[0].type === "Literal"
  ) {
    return node.arguments[0];
  }
}

function createTopLevelAnalyzer() {
  const nodes = [];
  return {enter, get};
  
  function enter({node, parent}) {
    if (parent && parent.type === "Program") {
      node.topLevel = true;
      nodes.push(node);
    }
  }
  
  function get() {
    return nodes[nodes.length - 1];
  }
}

function createExportTransformer({s, topLevel}) {
  let moduleDeclarePos;
  let exportDeclarePos;
  let isExportDeclared = false;
  let isModuleDeclared = false;
  let isTouched = false;
  
  return {
    transformExport,
    transformModule,
    transformModuleAssign,
    writeDeclare,
    writeExport,
    isTouched: () => isTouched
  };
  
  function transformModule(node) {
    if (node.name !== "module" || !node.scopeInfo || node.scopeInfo.type !== "undeclared") {
      return;
    }
    if (!isModuleDeclared) {
      moduleDeclarePos = topLevel.get().start;
      isModuleDeclared = true;
    }
    s.overwrite(node.start, node.end, "_module_", {contentOnly: true});
    isTouched = true;
  }
  
  function transformModuleAssign(node, skip) {
    if (!isModuleDeclared && getExportInfo(node)) {
      skip(); // ignore bare exports
    }
  }
  
  function transformExport(node) {
    if (node.name !== "exports" || !node.scopeInfo || node.scopeInfo.type !== "undeclared") {
      return;
    }
    if (!isExportDeclared) {
      exportDeclarePos = topLevel.get().start;
      isExportDeclared = true;
    }
    s.overwrite(node.start, node.end, "_exports_", {contentOnly: true});
    isTouched = true;
  }
  
  function writeDeclare() {
    if (isExportDeclared && isModuleDeclared && moduleDeclarePos < exportDeclarePos) {
      exportDeclarePos = moduleDeclarePos;
    }
    if (isExportDeclared) {
      s.appendRight(exportDeclarePos, "let _exports_ = {};\n");
      isTouched = true;
    }
    if (isModuleDeclared) {
      if (isExportDeclared) {
        s.appendRight(moduleDeclarePos, "const _module_ = {exports: _exports_};\n");
      } else {
        s.appendRight(moduleDeclarePos, "const _module_ = {exports: {}};\n");
      }
      isTouched = true;
    }
  }
  
  function writeExport() {
    if (isModuleDeclared) {
      s.appendRight(topLevel.get().end, "\nmodule.exports = _module_.exports;");
      isTouched = true;
    } else if (isExportDeclared) {
      s.appendRight(topLevel.get().end, "\nmodule.exports = _exports_;");
      isTouched = true;
    }
  }
}

function createImportTransformer({s, topLevel}) {
  const imports = new Map;
  let isTouched = false;
  
  return {
    transform,
    transformDynamic,
    isTouched: () => isTouched
  };
  
  function transformDynamic(node, skip) {
    if (getDynamicImport(node)) {
      skip();
    }
  }
  
  function transform(node) {
    const required = getRequireInfo(node);
    if (!required || node.callee.scopeInfo.type !== "undeclared") {
      return;
    }
    if (!imports.has(required.value)) {
      const name = `_require_${required.value.replace(/[\W_]/g, c => {
        if (c == "/" || c == "\\") {
          return "$";
        }
        if (c == "_") {
          return "__";
        }
        return "_";
      })}_`;
      imports.set(required.value, name);
      s.appendRight(
        topLevel.get().start,
        `const ${name} = require(${JSON.stringify(required.value)});\n`
      );
    }
    const name = imports.get(required.value);
    s.overwrite(node.start, node.end, name);
    isTouched = true;
  }
}

function transform({parse, code, sourceMap = false, ignoreDynamicRequire = true} = {}) {
  const s = new MagicString(code);
  const ast = parse(code);
  ecmaVariableScope(ast);
  const topLevel = createTopLevelAnalyzer();
  const exportTransformer = createExportTransformer({s, topLevel});
  const importTransformer = createImportTransformer({s, topLevel});
  traverse(ast, {enter(node, parent) {
    topLevel.enter({node, parent});
    if (node.type === "Identifier") {
      exportTransformer.transformExport(node);
      exportTransformer.transformModule(node);
    } else if (node.type === "AssignmentExpression" && parent.topLevel) {
      exportTransformer.transformModuleAssign(node, () => this.skip());
    } else if (node.type === "CallExpression") {
      if (ignoreDynamicRequire) {
        importTransformer.transformDynamic(node, () => this.skip());
      }
      importTransformer.transform(node);
    }
  }});
  exportTransformer.writeDeclare();
  exportTransformer.writeExport();
  const isTouched = importTransformer.isTouched() || exportTransformer.isTouched();
  return {
    code: isTouched ? s.toString() : code,
    map: sourceMap && s.generateMap(),
    isTouched
  };
}

module.exports = {transform};
