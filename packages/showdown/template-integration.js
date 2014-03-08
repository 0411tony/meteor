if (Package.ui) {
  var UI = Package.ui.UI;
  var HTML = Package.htmljs.HTML; // implied by `ui`
  Package.ui.Handlebars.registerHelper('markdown', UI.block(function () {
    var self = this;
    return UI.Live(function () {
      var text = UI.toRawText(self.__content, self /*parentComponent*/);
      var converter = new Showdown.converter();
      return HTML.Raw(converter.makeHtml(text));
    });
  }));
}
