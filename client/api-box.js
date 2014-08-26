Template.autoApiBox.helpers({
  apiData: function () {
    var longname = this;
    var root = DocsData;

    _.each(longname.split("."), function (pathSegment) {
      root = root[pathSegment];
    });

    return root;
  },
  typeNames: function (nameList) {
    // change names if necessary
    nameList = _.map(nameList, function (name) {
      if (name === "function") {
        return "Function";
      }

      return name;
    });

    return nameList.join(" | ");
  },
  paramsSentence: function () {
    var params = this.params;

    var paramNames = _.map(params, function (param) {
      if (param.optional) {
        return "[" + param.name + "]";
      }

      return param.name;
    });

    return paramNames.join(", ");
  },
  link: function () {
    return this.longname.replace(".", "_").toLowerCase();
  },
  paramsNoOptions: function () {
    return _.reject(this.params, function (param) {
      return param.name === "options";
    });
  }
});