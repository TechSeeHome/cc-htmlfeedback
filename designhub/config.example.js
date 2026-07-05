// DesignHub deployment configuration TEMPLATE (committed). Copy to
// designhub/gas/config.js and fill in the real ids from
// docs/designhub/plans/environment.local.md. gas/config.js is gitignored: the
// ids are not secrets (access is enforced by Drive ACLs), but they are
// org-specific and this fork stays generic. clasp pushes gas/config.js from
// disk regardless of git. Keep this template OUT of gas/: two files assigning
// DH_CONFIG in the same clasp-pushed directory is fragile and load-order
// dependent (whichever loses would silently overwrite the other's values).
var DH_CONFIG = {
  rootFolderId: '<DH_ROOT_FOLDER_ID>',                  // DesignHub (prod root)
  assets: {
    marked: '<DH_MARKED_BUNDLE_ID>',                    // marked 15 min bundle
    mermaid: '<DH_MERMAID_BUNDLE_ID>'                   // mermaid 11 min bundle
  },
  reconcilerEveryHours: 1                                // D19 reconciler cadence
};
if (typeof module !== 'undefined') module.exports = DH_CONFIG;
