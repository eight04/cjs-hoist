const _module_ = {exports: {}};
function test() {
  _module_
}
_module_.exports = "foo";
module.exports = _module_.exports;
