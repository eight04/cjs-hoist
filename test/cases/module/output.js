const _module_ = {exports: {}};
function test() {
  _module_.exports();
}
_module_.exports = () => {};
module.exports = _module_.exports;
