// D14 naming rules: feature folder is ONE sanitized path component; the doc
// keeps its repo-relative subpath under it. Paths are the public addressing
// scheme of the web app (?doc=<repo>/<featureDir>/<subpath...>).
var DH_PATHS = (function () {
  function featureDir(feature) {
    return String(feature).replace(/[\/\\]/g, '--').replace(/[:*?"<>|]/g, '-');
  }
  function docPath(repo, feature, pathInRepo) {
    return [repo, featureDir(feature)].concat(String(pathInRepo).split('/')).join('/');
  }
  function parseDocPath(path) {
    var segs = String(path || '').split('/').filter(function (s) { return s.length; });
    if (segs.length < 3) throw new Error('invalid doc path: ' + path);
    for (var i = 0; i < segs.length; i++) {
      if (segs[i] === '.' || segs[i] === '..') throw new Error('invalid doc path: ' + path);
    }
    return { repo: segs[0], featureDir: segs[1], segments: segs.slice(2),
      fileName: segs[segs.length - 1] };
  }
  function companionName(fileName) { return fileName + '.comments'; }
  return { featureDir: featureDir, docPath: docPath, parseDocPath: parseDocPath,
    companionName: companionName };
})();
if (typeof module !== 'undefined') module.exports = DH_PATHS;
