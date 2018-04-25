const _module_ = {};
function test() {
  _module_;
}
_module_.exports = "foo";
module.exports = _module_.exports;
