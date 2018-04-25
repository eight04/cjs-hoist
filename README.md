cjs-hoist
=========

Transform CommonJS module, hoisting `require` and `exports` statements to top-level.

Usage
-----

```js
const {parse} = require("acorn");
const {transform} = require("cjs-hoist");
const {code} = transform({
  parse,
  code: `
if (foo) {
  const bar = require("bar");
}
`
});
/* code -> `
const _require_bar_ = require("bar");
if (foo) {
  const bar = _require_bar_;
}
`
```

API reference
-------------

This module exports following members.

* `transform`: A function which can convert CJS module synax into ES module syntax.

### transform(options?: object): TransformResult object

`options` has following members:

* `parse`: function. A parser function which can parse JavaScript code into ESTree.
* `code`: string. The JavaScript source code.
* `sourceMap?`: boolean. If true then generate the source map. Default: `false`
* `ignoreDynamicRequire?`: boolean. If true then the dynamic require (i.e. `Promise.resolve(require("..."))`) is ignored. Default: `true`

The result object has following members:

* `code`: string. The result JavaScript code.
* `map?`: object. The source map object generated by [`magicString.generateMap`](https://github.com/Rich-Harris/magic-string#sgeneratemap-options-).

Changelog
---------

* 0.1.0 (Apr 26, 2018)

  - Initial release.
