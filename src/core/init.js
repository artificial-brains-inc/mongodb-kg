// Initializes a global context for the SDK.  Since Mongoose
// models are typically singletons, we keep a single context
// per application.  Consumers should call kgInit once at
// application start.

let _ctx = {
  nodesModel: null,
  edgesModel: null,
  repos: {},
  options: {}
};

/**
 * Initialise the knowledge‑graph context.  Must be called before
 * using createNode/createEdge/bulkSync or binding any models.
 *
 * @param {Object} params
 * @param {mongoose.Model} params.nodesModel - Mongoose model to store nodes
 * @param {mongoose.Model} params.edgesModel - Mongoose model to store edges
 * @param {Object} [params.repos] - Additional repositories accessible in edge functions
 * @param {Object} [params.options] - Reserved for future use
 */
function kgInit({ nodesModel, edgesModel, repos = {}, options = {} }) {
  if (!nodesModel || !edgesModel) {
    throw new Error('kgInit requires both nodesModel and edgesModel');
  }
  _ctx = {
    nodesModel,
    edgesModel,
    repos,
    options
  };
}

/**
 * Access the current context.  Used internally by the SDK and
 * available to consumer edge functions via the second argument
 * passed to `edges(doc, ctx)`.
 * @returns {Object}
 */
function getCtx() {
  return _ctx;
}

module.exports = {
  kgInit,
  getCtx
};