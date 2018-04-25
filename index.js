const {traverse} = require("estraverse");
const MagicString = require("magic-string");
const ecmaVariableScope = require("ecma-variable-scope");
// const scopeAnalyzer = require("scope-analyzer");

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

function getDeclareExport(node) {
  if (node.declarations.length !== 1) {
    return;
  }
  const dec = node.declarations[0];
  if (dec.id.type !== "Identifier" || dec.init.type !== "AssignmentExpression") {
    return;
  }
  const exported = getExportInfo(dec.init);
  if (!exported) {
    return;
  }
  if (exported.name === dec.id.name) {
    return {
      kind: node.kind,
      exported
    };
  }
}

function getDeclareImport(node) {
  if (node.declarations.length !== 1) {
    return;
  }
  const dec = node.declarations[0];
  if (dec.init.type !== "CallExpression") {
    return;
  }
  const required = getRequireInfo(dec.init);
  if (!required) {
    return;
  }
  let object;
  if (dec.id.type === "ObjectPattern") {
    object = getObjectInfo(dec.id, true);
    if (!object) {
      return;
    }
  } else if (dec.id.type !== "Identifier") {
    return;
  }
  return {
    object,
    left: dec.id,
    right: dec.init,
    required
  };
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

function getObjectInfo(node, checkValueType) {
  if (!node.properties.length) {
    return;
  }
  const properties = [];
  for (const prop of node.properties) {
    if (prop.key.type !== "Identifier") {
      return;
    }
    if (checkValueType && prop.value.type !== "Identifier") {
      return;
    }
    if (prop.method) {
      properties.push({
        name: prop.key.name,
        method: true,
        generator: prop.value.generator,
        key: prop.key,
        value: prop.value
      });
    } else {
      // note that if prop.shorthand == true then prop.key == prop.value
      properties.push({
        name: prop.key.name,
        key: prop.key,
        value: prop.value
      });
    }
  }
  return {
    start: node.start,
    end: node.end,
    properties
  };
}

function transformExportAssign({s, node}) {
  const exported = getExportInfo(node);
  if (!exported) {
    return;
  }
  if (exported.type === "named") {
    if (exported.value.type === "Identifier") {
      // exports.foo = foo
      s.overwrite(
        node.start,
        exported.value.start,
        "export {"
      );
      s.appendLeft(
        exported.value.end,
        exported.value.name === exported.name ?
          "}" : ` as ${exported.name}}`
      );
    } else {
      // exports.foo = "not an identifier"
      s.overwrite(
        node.start,
        exported.left.end,
        `const _export_${exported.name}_`
      );
      s.appendLeft(node.end, `;\nexport {_export_${exported.name}_ as ${exported.name}}`);
    }
  } else {
    if (exported.value.type !== "ObjectExpression") {
      // module.exports = ...
      s.overwrite(
        node.start,
        exported.value.start,
        "export default "
      );
    } else {
      // module.exports = {...}
      const objMap = getObjectInfo(exported.value);
      if (objMap) {
        const overwrite = (start, property, newLine, semi) => {
          if (property.value.type === "Identifier") {
            // foo: bar
            s.overwrite(start, property.value.start, `${newLine ? "\n" : ""}export {`);
            s.appendLeft(
              property.value.end,
              `${
                property.value.name === property.name ?
                  "" : ` as ${property.name}`
              }}${semi ? ";" : ""}`
            );
          } else {
            // foo: "not an identifier"
            s.overwrite(
              start,
              property.value.start,
              `${newLine ? "\n" : ""}const _export_${property.name}_ = ${
                property.method ?
                  `function${property.generator ? "*" : ""} ` : ""
              }`
            );
            s.appendLeft(
              property.value.end,
              `;\nexport {_export_${property.name}_ as ${property.name}}${semi ? ";" : ""}`
            );
          }
        };
        // module.exports = { ...
        let start = node.start;
        for (let i = 0; i < objMap.properties.length; i++) {
          overwrite(
            start,
            objMap.properties[i],
            i > 0,
            i < objMap.properties.length - 1
          );
          start = objMap.properties[i].value.end;
        }
        // , ... }
        s.remove(start, node.end);
      }
    }
  }
}

function transformExportDeclare({s, node}) {
  const declared = getDeclareExport(node);
  if (!declared) {
    return;
  }
  // const foo = exports.foo = ...
  s.overwrite(
    node.start,
    declared.exported.left.end,
    `export ${declared.kind} ${declared.exported.name}`
  );
}

function transformImportDeclare({s, node, code}) {
  const declared = getDeclareImport(node);
  if (!declared) {
    return;
  }
  if (!declared.object) {
    // const foo = require("foo")
    const rx = /.+\/\/.+\b(all|import\b.\ball)\b/y;
    rx.lastIndex = declared.required.end;
    if (rx.test(code)) {
      // import all
      s.overwrite(
        node.start,
        declared.left.start,
        "import * as "
      );
    } else {
      // import default
      s.overwrite(
        node.start,
        declared.left.start,
        "import "
      );
    }
  } else {
    // const {foo, bar}
    s.overwrite(
      node.start,
      declared.object.start,
      "import "
    );
    // foo: bar
    for (const prop of declared.object.properties) {
      if (prop.key.end < prop.value.start) {
        s.overwrite(
          prop.key.end,
          prop.value.start,
          " as "
        );
      }
    }
  }
  s.overwrite(
    declared.left.end,
    declared.required.start,
    " from "
  );
  s.remove(declared.required.end, declared.right.end);
}

function transformImportDynamic({s, node}) {
  const imported = getDynamicImport(node);
  if (!imported) {
    return;
  }
  s.overwrite(
    imported.start,
    imported.required.start,
    "import("
  );
  s.overwrite(
    imported.required.end,
    imported.end,
    ")"
  );
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

function createExportTransformer({s, code, topLevel}) {
  let moduleDeclarePos;
  let exportDeclarePos;
  let isExportDeclared = false;
  let isModuleDeclared = false;
  return {
    transformExport,
    transformModule,
    transformModuleAssign,
    writeDeclare,
    writeExport
  };
  
  function transformModule(node) {
    if (node.name !== "module" || !node.scopeInfo || node.scopeInfo.type !== "undeclared") {
      return;
    }
    if (!isModuleDeclared) {
      moduleDeclarePos = topLevel.get().start;
      // s.appendRight(
        // topLevel.get().start,
        // "const _module_ = {exports: {}};\n"
      // );
      isModuleDeclared = true;
    }
    s.overwrite(node.start, node.end, "_module_", {contentOnly: true});
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
      // s.appendRight(
        // topLevel.get().start,
        // "let _exports_ = {};\n"
      // );
      isExportDeclared = true;
    }
    s.overwrite(node.start, node.end, "_exports_", {contentOnly: true});
  }
  
  function writeDeclare() {
    if (isExportDeclared && isModuleDeclared && moduleDeclarePos < exportDeclarePos) {
      exportDeclarePos = moduleDeclarePos;
    }
    if (isExportDeclared) {
      s.appendRight(exportDeclarePos, "let _exports_ = {};\n");
    }
    if (isModuleDeclared) {
      if (isExportDeclared) {
        s.appendRight(moduleDeclarePos, "const _module_ = {exports: _exports_};\n");
      } else {
        s.appendRight(moduleDeclarePos, "const _module_ = {exports: {}};\n");
      }
    }
  }
  
  function writeExport() {
    if (isModuleDeclared) {
      s.appendRight(topLevel.get().end, "\nmodule.exports = _module_.exports;");
    } else if (isExportDeclared) {
      s.appendRight(topLevel.get().end, "\nmodule.exports = _exports_;");
    }
  }
}

function createImportTransformer({s, code, topLevel}) {
  const imports = new Map;
  return {transform};
  
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
  }
}

function transform({parse, code, sourceMap = false, ignoreDynamicRequire = true} = {}) {
  const s = new MagicString(code);
  const ast = parse(code);
  ecmaVariableScope(ast);
  const topLevel = createTopLevelAnalyzer();
  const exportTransformer = createExportTransformer({s, code, topLevel});
  const importTransformer = createImportTransformer({s, code, topLevel});
  traverse(ast, {enter(node, parent) {
    topLevel.enter({node, parent});
    if (node.type === "Identifier") {
      exportTransformer.transformExport(node);
      exportTransformer.transformModule(node);
      // if (node.name === "exports" && node.scopeInfo && node.scopeInfo.type === "undeclared") {
        // rewrite this
      // }
      // debugger;
    } else if (node.type === "VariableDeclaration" && parent.type === "Program") {
      // transformImportDeclare({s, node, code});
      // transformExportDeclare({s, node});
    } else if (node.type === "AssignmentExpression" && parent.topLevel) {
      exportTransformer.transformModuleAssign(node, () => this.skip());
      // transformExportAssign({s, node});
    } else if (node.type === "CallExpression" && getDynamicImport(node) && ignoreDynamicRequire) {
      this.skip();
    } else if (node.type === "CallExpression") {
      importTransformer.transform(node);
    }
  }});
  exportTransformer.writeDeclare();
  exportTransformer.writeExport();
  return {
    code: s.toString(),
    map: sourceMap && s.generateMap()
  };
}

module.exports = {transform};
